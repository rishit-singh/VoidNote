import { assistantOutputResponse } from "../../src/ai/assistant-output";
import {
  ASSISTANT_OUTPUT_LEASE_MS,
  type AssistantOutputScope,
} from "../../src/contracts/assistant/output";

async function event(value: Record<string, unknown>) {
  const response = await fetch("https://output-bridge-fixture.test/event", {
    method: "POST",
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error("Fixture event delivery failed.");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const caseId = request.headers.get("x-fixture-case") ?? "default";

    if (url.pathname !== "/api/assistant/output") {
      return new Response("Not found.", { status: 404 });
    }

    const mode = request.headers.get("x-fixture-mode") ?? "hold";
    const fakeNamespace = {
      idFromName(name: string) {
        return name;
      },
      get(name: string) {
        return {
          async openAcceptedTurnOutput(input: AssistantOutputScope & { ticket: string }) {
            await event({ type: "rpc", caseId, name, input });
            if (mode === "reject") {
              throw new Error(`Private RPC rejection: ${JSON.stringify(input)}`);
            }

            const chunks: unknown = JSON.parse(
              decodeURIComponent(request.headers.get("x-fixture-chunks") ?? "[]"),
            );
            if (!Array.isArray(chunks) || !chunks.every((chunk) => typeof chunk === "string")) {
              throw new Error("Invalid fixture chunks.");
            }

            const sourceChunks: string[] = chunks;
            if (mode === "oversized-chunk") sourceChunks.push("x".repeat(512_001));
            if (mode === "oversized-pending") {
              sourceChunks.push("x".repeat(300_000), "x".repeat(300_000));
            }
            if (mode === "overlong-text") {
              sourceChunks.push(
                `${JSON.stringify({
                  type: "snapshot",
                  turnId: input.turnId,
                  text: "x".repeat(64_001),
                })}\n`,
              );
            }

            if (mode === "lease-budget") {
              for (let index = 0; index < 40; index++) {
                sourceChunks.push(
                  `${JSON.stringify({
                    type: "snapshot",
                    turnId: input.turnId,
                    text: String(index).padStart(2, "0") + "x".repeat(63_998),
                  })}\n`,
                );
              }
            }

            return new ReadableStream<Uint8Array>({
              start(controller) {
                const encoder = new TextEncoder();
                for (const chunk of sourceChunks) controller.enqueue(encoder.encode(chunk));
                if (mode === "finite") controller.close();
              },
              cancel() {
                // Keep test telemetry alive after the socket itself disconnects.
                const notification = event({ type: "cancel", caseId });
                ctx.waitUntil(notification);
                return notification;
              },
            });
          },
        };
      },
    };

    // Observe the actual bridge timer registration and expose its callback to the
    // test driver. The production delay is unchanged; no wall-clock sleep is used.
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = new Proxy(originalSetTimeout, {
      apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        if (
          mode === "manual-deadline" &&
          args[1] === ASSISTANT_OUTPUT_LEASE_MS &&
          typeof callback === "function"
        ) {
          ctx.waitUntil(
            (async () => {
              await fetch("https://output-bridge-fixture.test/deadline", {
                method: "POST",
                body: JSON.stringify({ caseId, delay: args[1] }),
              });
              void Reflect.apply(callback, undefined, args.slice(2));
            })(),
          );
        }
        return Reflect.apply(target, receiver, args) as ReturnType<typeof setTimeout>;
      },
    });

    try {
      return await assistantOutputResponse(
        request.headers.has("x-fixture-method")
          ? new Request(request, { method: request.headers.get("x-fixture-method")! })
          : request,
        {
          APP_URL: request.headers.get("x-fixture-app-url") ?? env.APP_URL,
          ASSISTANT_AGENT: fakeNamespace,
        } as unknown as Parameters<typeof assistantOutputResponse>[1],
        ctx,
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  },
} satisfies ExportedHandler<{ APP_URL: string }>;
