import { trace } from "@opentelemetry/api";
import { GET } from "../../src/app/api/health/route";
import { traceHealthRequest, traceHealthService } from "../../src/telemetry/spans";
import { instrumentWorker } from "../../src/telemetry/worker";
import { traceOperation } from "../../src/telemetry/operations";

const worker = instrumentWorker({
  fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/api/health") return GET();
    if (new URL(request.url).pathname === "/application") {
      return traceOperation("worker.fetch", () =>
        traceOperation("trpc.assistant.messages", () =>
          Promise.resolve(Response.json({ ok: true })),
        ),
      );
    }

    const requestId = crypto.randomUUID();
    return traceHealthRequest(requestId, () =>
      traceHealthService(requestId, async () => {
        // Exercise the real export boundary with deliberately unsafe metadata,
        // including content added by another instrumentor, not just HTTP headers.
        const secret = await request.text();
        const span = trace.getActiveSpan();
        if (!span) throw new Error("Service span is not active");
        span.updateName(secret);
        span.setAttribute("fixture.payload", secret);
        span.addEvent(secret, { "fixture.payload": secret });
        span.recordException(new Error(secret));
        span.addLink({
          context: {
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
            traceFlags: 1,
          },
          attributes: { "fixture.payload": secret },
        });
        trace.getTracer("fixture").startSpan(secret).end();

        // The Node-side barrier keeps multiple service spans active across I/O.
        const caseId = request.headers.get("x-test-case") ?? "missing";
        const barrier = await fetch(`https://fixture.test/barrier/${caseId}`);
        await barrier.text();
        return Response.json({
          status: "ok",
          requestId,
          activeSpanId: trace.getActiveSpan()?.spanContext().spanId,
        });
      }),
    );
  },
});

export default {
  async fetch(request, env, ctx) {
    const pending: Promise<unknown>[] = [];
    const trackedContext = new Proxy(ctx, {
      get(target, key) {
        if (key === "waitUntil") {
          return (promise: Promise<unknown>) => {
            pending.push(promise);
            target.waitUntil(promise);
          };
        }
        const value: unknown = Reflect.get(target, key);
        const bound: unknown = typeof value === "function" ? value.bind(target) : value;
        return bound;
      },
    });
    if (!worker.fetch) throw new Error("Missing instrumented fetch handler");
    const response = await worker.fetch(request, env, trackedContext);
    const caseId = request.headers.get("x-test-case") ?? "missing";
    // Observe the actual Worker lifecycle, including the SDK's flush promise.
    // Sending the response does not await exports; tests can hold the collector open.
    ctx.waitUntil(
      Promise.allSettled(pending).then(async (results) => {
        await fetch(`https://fixture.test/done/${caseId}`, {
          method: "POST",
          body: JSON.stringify(results.map((result) => result.status)),
        });
      }),
    );
    return response;
  },
} satisfies ExportedHandler;
