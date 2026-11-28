import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response } from "miniflare";

// Opt-in smoke only: loads credentials from the caller's environment, sends two
// synthetic spans, and never opens the application database or invokes a model.
const token = process.env.LOGFIRE_TOKEN;
const baseUrl = process.env.LOGFIRE_BASE_URL;
if (!token || !baseUrl) throw new Error("LOGFIRE_TOKEN and LOGFIRE_BASE_URL are required.");
const scope = { workspaceId: crypto.randomUUID(), jobId: crypto.randomUUID() };
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
          LOGFIRE_ENVIRONMENT: { type: "text", value: "development" },
        },
      },
      dev: {
        outboundService: {
          type: "fetcher",
          async handler(request) {
            const start = Date.now();
            // Forward only to the selected collector. Never print response
            // content, headers or credentials; ingestion is checked separately.
            if (request.url !== new URL("/v1/traces", baseUrl).href) {
              throw new Error("Unexpected telemetry destination.");
            }
            try {
              const response = await fetch(request.url, {
                method: "POST",
                headers: Object.fromEntries(request.headers),
                body: await request.text(),
                signal: AbortSignal.timeout(5_000),
              });
              console.log({ collectorStatus: response.status, durationMs: Date.now() - start });
              await response.body?.cancel();
              return new Response(null, { status: response.status });
            } catch {
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
  const response = await mf.dispatchFetch("https://local.test/telemetry-smoke");
  console.log({ status: response.status, ...scope, at: new Date().toISOString() });
} finally {
  await mf.dispose();
}
