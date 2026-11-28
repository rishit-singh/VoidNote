import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { before, test, type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response, type Request } from "miniflare";
import ts from "typescript";
import { z } from "zod";

const root = fileURLToPath(new URL("../../", import.meta.url));
const variablesSchema = z.object({ NEXT_OTEL_FETCH_DISABLED: z.string().optional() });
const configurationSchema = z.object({
  compatibility_date: z.string(),
  compatibility_flags: z.array(z.string()),
  vars: variablesSchema,
  env: z.object({
    development: z.object({ vars: variablesSchema }),
    staging: z.object({ vars: variablesSchema }),
    production: z.object({ vars: variablesSchema }),
  }),
});
const workflowSchema = z.object({
  status: z.string(),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
});
const key = "offline-provider-key";
const jobId = "offline-provider-job";
let script: string;
let configuration: z.infer<typeof configurationSchema>;

before(async () => {
  const parsed = ts.parseConfigFileTextToJson(
    "wrangler.jsonc",
    await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"),
  );
  assert.equal(parsed.error, undefined);
  configuration = configurationSchema.parse(parsed.config);
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ["tests/worker/recording-provider.fixture.ts"],
    tsconfig: "tsconfig.worker-tests.json",
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    mainFields: ["browser", "module", "main"],
    conditions: ["workerd", "react-server"],
    external: ["node:*", "cloudflare:*"],
    target: "es2022",
    plugins: [
      {
        name: "node-builtins",
        setup(build) {
          build.onResolve({ filter: /^[a-z_]+$/ }, (args) =>
            builtinModules.includes(args.path)
              ? { path: `node:${args.path}`, external: true }
              : undefined,
          );
        },
      },
    ],
  });
  assert.equal(bundle.outputFiles.length, 1);
  const output = bundle.outputFiles[0];
  assert.ok(output);
  script = output.text;
});

function startWorker(t: TestContext, variables: z.infer<typeof variablesSchema>) {
  const submissions: unknown[] = [];
  const observations: string[] = [];
  const unexpected: string[] = [];
  const transportErrors: unknown[] = [];

  async function outbound(request: Request): Promise<Response> {
    try {
      if (request.url === "https://api.pyannote.ai/v1/diarize" && request.method === "POST") {
        submissions.push(await request.json());
        assert.equal(request.headers.get("authorization"), `Bearer ${key}`);
        return Response.json({ jobId, status: "created" });
      }
      if (request.url === `https://api.pyannote.ai/v1/jobs/${jobId}` && request.method === "GET") {
        observations.push(request.url);
        assert.equal(request.headers.get("authorization"), `Bearer ${key}`);
        return Response.json({ jobId, status: "succeeded" });
      }
      unexpected.push(`${request.method} ${request.url}`);
    } catch (error) {
      transportErrors.push(error);
    }
    // Fail closed: no provider, collector or other request can reach the network.
    return new Response(null, { status: 502 });
  }

  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "recording-provider-test",
          compatibilityDate: configuration.compatibility_date,
          compatibilityFlags: configuration.compatibility_flags,
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: script } },
          },
          exports: {
            RecordingProviderWorkflow: {
              type: "workflow",
              name: "recording-provider-workflow",
            },
          },
          env: {
            PYANNOTE_API_KEY: { type: "text", value: key },
            ...(variables.NEXT_OTEL_FETCH_DISABLED === undefined
              ? {}
              : {
                  NEXT_OTEL_FETCH_DISABLED: {
                    type: "text" as const,
                    value: variables.NEXT_OTEL_FETCH_DISABLED,
                  },
                }),
            PROVIDER_WORKFLOW: {
              type: "workflow",
              name: "recording-provider-workflow",
              worker: "recording-provider-test",
              exportName: "RecordingProviderWorkflow",
            },
          },
        },
        dev: { outboundService: { type: "fetcher", handler: outbound } },
      },
    ],
  });
  t.after(async () => {
    await mf.dispose();
    assert.deepEqual(unexpected, [], "Every outbound request must remain inside the fixture");
    assert.deepEqual(transportErrors, [], "Mock provider requests must satisfy their contract");
  });

  async function dispatch(path: string): Promise<unknown> {
    const response = await mf.dispatchFetch(`https://app.fixture.test${path}`);
    assert.equal(response.status, 200);
    return response.json();
  }

  async function execute() {
    const health = z.object({ status: z.literal("ok"), requestId: z.uuid() });
    health.parse(await dispatch("/api/health"));
    assert.deepEqual(await dispatch("/start"), { id: "provider-regression" });
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = workflowSchema.parse(await dispatch("/status"));
      if (["complete", "errored", "terminated"].includes(result.status)) {
        assert.equal(result.status, "complete", JSON.stringify(result));
        return result.output;
      }
      await setTimeout(25);
    }
    assert.fail("Provider Workflow did not settle");
  }

  return { execute, submissions, observations };
}

void test(
  "without the flag, warmed Next tracing makes submission ambiguous before transport",
  { timeout: 20_000 },
  async (t) => {
    const worker = startWorker(t, {});
    assert.deepEqual(await worker.execute(), {
      status: "submission_unknown",
      requestSpanActive: false,
    });
    assert.deepEqual(worker.submissions, []);
    assert.deepEqual(worker.observations, []);
  },
);

for (const environment of ["base", "development", "staging", "production"] as const) {
  void test(
    `${environment} configuration permits one acknowledged provider submission and observation outside HTTP context`,
    { timeout: 20_000 },
    async (t) => {
      // Named Wrangler environments do not inherit vars from the base config.
      const variables =
        environment === "base" ? configuration.vars : configuration.env[environment].vars;
      const worker = startWorker(t, variables);
      assert.deepEqual(await worker.execute(), {
        submission: { status: "submitted", jobId },
        observation: { status: "succeeded", jobId },
        requestSpanActive: false,
      });
      assert.deepEqual(worker.submissions, [
        {
          url: "https://audio.fixture.test/recording",
          webhook: "https://callback.fixture.test/processing",
          webhookStatusOnly: true,
          model: "precision-3",
          transcription: true,
          transcriptionConfig: { model: "parakeet-tdt-0.6b-v3" },
        },
      ]);
      assert.deepEqual(worker.observations, [`https://api.pyannote.ai/v1/jobs/${jobId}`]);
    },
  );
}
