import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response } from "miniflare";
import { z } from "zod";

// Opt-in smoke only: loads credentials from the caller's environment, sends two
// synthetic spans, and never opens the application database or invokes a model.
const token = process.env.LOGFIRE_TOKEN;
const baseUrl = process.env.LOGFIRE_BASE_URL;
if (!token || !baseUrl) throw new Error("LOGFIRE_TOKEN and LOGFIRE_BASE_URL are required.");
const environment = process.env.LOGFIRE_ENVIRONMENT ?? "development";
if (!["development", "staging", "production"].includes(environment)) {
  throw new Error("LOGFIRE_ENVIRONMENT must be development, staging, or production.");
}
let collectorUrl: URL;
try {
  collectorUrl = new URL(baseUrl);
} catch {
  throw new Error("LOGFIRE_BASE_URL must be a valid HTTPS base URL.");
}
if (
  collectorUrl.protocol !== "https:" ||
  collectorUrl.username ||
  collectorUrl.password ||
  collectorUrl.search ||
  collectorUrl.hash
) {
  throw new Error("LOGFIRE_BASE_URL must be HTTPS without credentials, query, or fragment.");
}
const traceEndpoint = new URL("/v1/traces", collectorUrl).href;
const scope = { workspaceId: crypto.randomUUID(), jobId: crypto.randomUUID() };
const traceIds = new Set<string>();
let collectorStatus: number | undefined;
const tracePayloadSchema = z.object({
  resourceSpans: z.array(
    z.object({
      scopeSpans: z.array(
        z.object({
          spans: z.array(z.object({ traceId: z.string().regex(/^[\da-f]{32}$/i) })),
        }),
      ),
    }),
  ),
});

function isWorkerFetcher(value: unknown): value is { fetch(input: string): Promise<Response> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function"
  );
}

const bundle = await build({
  stdin: {
    contents: `
      import { executionTrace } from "./src/telemetry/execution.ts";
      export default { async fetch(request, env) {
        await executionTrace(env, ${JSON.stringify(scope)}, "diagnostics.execution", () =>
          executionTrace(env, ${JSON.stringify(scope)}, "diagnostics.persistence", () => Promise.resolve()));
        return Response.json({ ok: true });
      }};
    `,
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  conditions: ["workerd"],
  external: ["node:*"],
});
const output = bundle.outputFiles[0];
if (!output) throw new Error("Telemetry smoke bundle was not produced.");
const mf = new Miniflare({
  host: "127.0.0.1",
  port: 0,
  cf: false,
  telemetry: { enabled: false },
  workers: [
    {
      config: {
        name: "voidnote-execution-telemetry-smoke",
        compatibilityDate: "2026-11-13",
        compatibilityFlags: ["nodejs_compat"],
        manifest: {
          mainModule: "worker.js",
          modules: { "worker.js": { type: "esm", contents: output.text } },
        },
        env: {
          LOGFIRE_TOKEN: { type: "text", value: token },
          LOGFIRE_BASE_URL: { type: "text", value: baseUrl },
          LOGFIRE_ENVIRONMENT: { type: "text", value: environment },
        },
      },
      dev: {
        outboundService: {
          type: "fetcher",
          async handler(request) {
            const start = Date.now();
            // Forward only to the selected collector. Read trace IDs only for
            // lookup; never print the OTLP body, response content, or credentials.
            if (request.url !== traceEndpoint) {
              throw new Error("Unexpected telemetry destination.");
            }
            try {
              const body = await request.text();
              const payload = tracePayloadSchema.parse(JSON.parse(body));
              for (const resource of payload.resourceSpans) {
                for (const instrumentation of resource.scopeSpans) {
                  for (const span of instrumentation.spans) traceIds.add(span.traceId);
                }
              }
              const response = await fetch(request.url, {
                method: "POST",
                headers: Object.fromEntries(request.headers),
                body,
                signal: AbortSignal.timeout(5_000),
              });
              collectorStatus = response.status;
              console.log({ collectorStatus, durationMs: Date.now() - start });
              await response.body?.cancel();
              return new Response(null, { status: response.status });
            } catch {
              collectorStatus = 502;
              console.log({ collectorStatus: "unavailable", durationMs: Date.now() - start });
              return new Response(null, { status: 502 });
            }
          },
        },
      },
    },
  ],
});
try {
  const worker = await mf.getWorker("voidnote-execution-telemetry-smoke");
  if (!isWorkerFetcher(worker)) {
    throw new Error("Miniflare did not expose the smoke worker fetcher.");
  }
  const response = await worker.fetch("https://app.test/telemetry-smoke");
  await response.body?.cancel();
  if (
    !response.ok ||
    collectorStatus === undefined ||
    collectorStatus < 200 ||
    collectorStatus >= 300
  ) {
    throw new Error(
      "Synthetic telemetry export failed; collector acknowledgement was not successful.",
    );
  }
  if (traceIds.size !== 1) {
    throw new Error("Synthetic telemetry export did not produce exactly one trace ID.");
  }
  console.log({
    syntheticSmoke: true,
    ingestionVerified: false,
    environment,
    collectorStatus,
    traceId: [...traceIds][0],
    ...scope,
    at: new Date().toISOString(),
  });
} finally {
  await mf.dispose();
}
