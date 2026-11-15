import assert from "node:assert/strict";
import { before, test, type TestContext } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response, type Request } from "miniflare";
import { z } from "zod";

const root = fileURLToPath(new URL("../../", import.meta.url));
const token = "test-only-logfire-token";
const collectorUrl = "https://collector.test/v1/traces";
let script: string;

before(async () => {
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ["tests/worker/telemetry.fixture.ts"],
    tsconfig: "tsconfig.worker-tests.json",
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    mainFields: ["browser", "module", "main"],
    // Resolve the server-only marker's published server export, not a test mock.
    conditions: ["workerd", "react-server"],
    external: ["node:*"],
    target: "es2022",
  });
  assert.equal(bundle.outputFiles.length, 1);
  const output = bundle.outputFiles[0];
  assert.ok(output);
  script = output.text;
});

const attributes = z.array(
  z.object({ key: z.string(), value: z.object({ stringValue: z.string() }) }),
);
const spanSchema = z.object({
  name: z.string(),
  traceId: z.string().regex(/^[\da-f]{32}$/i),
  spanId: z.string().regex(/^[\da-f]{16}$/i),
  parentSpanId: z.string().optional(),
  attributes,
  events: z.array(z.unknown()).optional(),
  links: z.array(z.unknown()).optional(),
});
const payloadSchema = z.object({
  resourceSpans: z.array(
    z.object({
      resource: z.object({
        attributes: z.array(
          z.object({
            key: z.string(),
            value: z.object({ stringValue: z.string().optional() }),
          }),
        ),
      }),
      scopeSpans: z.array(z.object({ spans: z.array(spanSchema) })),
    }),
  ),
});
const healthSchema = z.object({
  status: z.literal("ok"),
  requestId: z.uuid(),
  activeSpanId: z.string().optional(),
});
type Capture = { url: string; method: string; authorization: string | null; body: string };

function startWorker(
  t: TestContext,
  options: {
    token?: string;
    exportResponse?: () => Promise<Response>;
    barrier?: (caseId: string) => Promise<void>;
  } = {},
) {
  const captures: Capture[] = [];
  const completions = new Map<string, PromiseWithResolvers<void>>();
  const unexpected: string[] = [];

  async function outbound(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.url === collectorUrl) {
      captures.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      });
      return options.exportResponse ? options.exportResponse() : Response.json({});
    }
    if (url.origin === "https://fixture.test" && url.pathname.startsWith("/done/")) {
      const completion = completions.get(url.pathname.slice("/done/".length));
      assert.ok(completion, "Unknown lifecycle notification");
      try {
        const results = z.array(z.literal("fulfilled")).parse(await request.json());
        assert.ok(results.length > 0, "SDK must register waitUntil work");
        completion.resolve();
      } catch (error) {
        completion.reject(error);
      }
      return new Response(null, { status: 204 });
    }
    if (url.origin === "https://fixture.test" && url.pathname.startsWith("/barrier/")) {
      assert.ok(options.barrier);
      await options.barrier(url.pathname.slice("/barrier/".length));
      return new Response("released");
    }
    // No passthrough: every outbound request stays in this local process.
    unexpected.push(request.url);
    return new Response(null, { status: 502 });
  }

  // Miniflare 5's installed types define this manifest and fetcher interceptor.
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "telemetry-test",
          compatibilityDate: "2026-11-13",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: script } },
          },
          env: {
            LOGFIRE_BASE_URL: { type: "text", value: "https://collector.test" },
            ...(options.token
              ? { LOGFIRE_TOKEN: { type: "text" as const, value: options.token } }
              : {}),
          },
        },
        dev: { outboundService: { type: "fetcher", handler: outbound } },
      },
    ],
  });
  t.after(async () => {
    await mf.dispose();
    assert.deepEqual(unexpected, [], "No unexpected outbound requests");
  });

  function dispatch(caseId: string, path = "/api/health", body?: string) {
    const completion = Promise.withResolvers<void>();
    completions.set(caseId, completion);
    const response = mf.dispatchFetch(`https://app.test${path}?secret=caller-query-secret`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-test-case": caseId,
        "x-request-id": "caller-request-id-secret",
        authorization: "Bearer caller-authorization-secret",
        cookie: "session=caller-cookie-secret",
        traceparent: `00-${"c".repeat(32)}-${"d".repeat(16)}-01`,
        tracestate: "caller=caller-tracestate-secret",
      },
      ...(body === undefined ? {} : { body }),
    });
    return { response, finished: completion.promise };
  }
  return { captures, dispatch };
}

function assertTrace(capture: Capture, requestId: string, activeSpanId?: string) {
  assert.equal(capture.url, collectorUrl);
  assert.equal(capture.method, "POST");
  assert.equal(capture.authorization, token);
  const payload = payloadSchema.parse(JSON.parse(capture.body));
  const spans = payload.resourceSpans.flatMap((resource) => {
    assert.ok(
      resource.resource.attributes.some(
        (attribute) =>
          attribute.key === "service.name" && attribute.value.stringValue === "voidnote",
      ),
    );
    return resource.scopeSpans.flatMap((scope) => scope.spans);
  });
  assert.equal(spans.length, 2, "Exactly one request and one service span");
  const request = spans.find((span) => span.name === "GET /api/health");
  const service = spans.find((span) => span.name === "check health");
  assert.ok(request);
  assert.ok(service);
  assert.equal(service.traceId, request.traceId);
  assert.equal(service.parentSpanId, request.spanId);
  assert.notEqual(service.spanId, request.spanId);
  assert.ok(!request.parentSpanId, "Smoke request is a root span");
  assert.notEqual(request.traceId, "c".repeat(32), "Caller trace context is not trusted");
  if (activeSpanId !== undefined) assert.equal(service.spanId, activeSpanId);
  for (const span of spans) {
    assert.deepEqual(span.attributes, [{ key: "request.id", value: { stringValue: requestId } }]);
    assert.deepEqual(span.events ?? [], []);
    assert.deepEqual(span.links ?? [], []);
  }
  assert.doesNotMatch(capture.body, /caller-|fixture-payload-|test-only-logfire-token/);
  return request.traceId;
}

void test(
  "health exports a related request/service pair with its response request ID",
  { timeout: 20_000 },
  async (t) => {
    const worker = startWorker(t, { token });
    const call = worker.dispatch("health");
    const response = await call.response;
    assert.equal(response.status, 200);
    const health = healthSchema.parse(await response.json());
    assert.equal(response.headers.get("x-request-id"), health.requestId);
    assert.equal(response.headers.get("cache-control"), "no-store");
    await call.finished;
    assert.equal(worker.captures.length, 1);
    const capture = worker.captures[0];
    assert.ok(capture);
    assertTrace(capture, health.requestId);
  },
);

void test(
  "overlapping requests retain async context and exclude sensitive span content",
  { timeout: 20_000 },
  async (t) => {
    const arrived = Promise.withResolvers<void>();
    const barriers = new Map<string, PromiseWithResolvers<void>>();
    const worker = startWorker(t, {
      token,
      barrier(caseId) {
        const barrier = Promise.withResolvers<void>();
        barriers.set(caseId, barrier);
        if (barriers.size === 3) arrived.resolve();
        return barrier.promise;
      },
    });
    t.after(() => {
      for (const barrier of barriers.values()) barrier.resolve();
    });
    const calls = [0, 1, 2].map((index) => ({
      caseId: `overlap-${index}`,
      ...worker.dispatch(`overlap-${index}`, "/overlap", `fixture-payload-${index}`),
    }));
    await arrived.promise;
    const traceIds = new Set<string>();
    const requestIds = new Set<string>();
    // Complete in reverse order while other requests remain suspended in I/O.
    for (const call of calls.toReversed()) {
      barriers.get(call.caseId)?.resolve();
      const response = await call.response;
      assert.equal(response.status, 200);
      const health = healthSchema.parse(await response.json());
      assert.ok(health.activeSpanId, "Service context survives awaited I/O");
      await call.finished;
      const capture = worker.captures.find((item) => item.body.includes(health.requestId));
      assert.ok(capture);
      traceIds.add(assertTrace(capture, health.requestId, health.activeSpanId));
      requestIds.add(health.requestId);
    }
    assert.equal(traceIds.size, 3);
    assert.equal(requestIds.size, 3);
    assert.equal(worker.captures.length, 3, "No duplicated providers/exports");
  },
);

void test(
  "a pending exporter and HTTP failure cannot delay or fail health",
  { timeout: 20_000 },
  async (t) => {
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const worker = startWorker(t, {
      token,
      async exportResponse() {
        started.resolve();
        await release.promise;
        return new Response("collector unavailable", { status: 503 });
      },
    });
    const call = worker.dispatch("failed-export");
    const response = await call.response;
    assert.equal(response.status, 200, "Response arrives while the collector is still blocked");
    const health = healthSchema.parse(await response.json());
    await started.promise;
    release.resolve();
    await call.finished;
    assert.equal(worker.captures.length, 1);
    const capture = worker.captures[0];
    assert.ok(capture);
    assertTrace(capture, health.requestId);
  },
);

void test(
  "missing token completes the Worker lifecycle without any export",
  { timeout: 20_000 },
  async (t) => {
    const worker = startWorker(t);
    const call = worker.dispatch("disabled");
    const response = await call.response;
    assert.equal(response.status, 200);
    healthSchema.parse(await response.json());
    await call.finished;
    assert.deepEqual(worker.captures, []);
  },
);
