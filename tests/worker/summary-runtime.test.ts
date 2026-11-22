import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { before, test, type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response, type Request } from "miniflare";
import { z } from "zod";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workspaceId = "10000000-0000-4000-8000-000000000001";
const jobId = "10000000-0000-4000-8000-000000000002";
const summaryId = "10000000-0000-4000-8000-000000000003";
const evidenceId = "10000000-0000-4000-8000-000000000004";
const workflowId = `summary-${workspaceId}-${jobId}`;
const source = {
  noteId: "10000000-0000-4000-8000-000000000005",
  recordingId: "10000000-0000-4000-8000-000000000006",
  runId: "10000000-0000-4000-8000-000000000007",
  generation: 1,
};
const reference = {
  snapshotId: jobId,
  objectKey: "fixture/context.json",
  checksum: "a".repeat(64),
  source,
  noteRevision: 1,
  profiles: [],
};
const policy = {
  version: "summary-proof-v1",
  model: "@cf/fixture/local-only",
  promptVersion: "summary-v1",
  schemaVersion: "summary-v1",
  maxContextBytes: 64_000,
  maxPassages: 1000,
  maxOutputBytes: 128_000,
  maxSteps: 1,
  maxOutputTokens: 8192,
  timeoutMs: 10_000,
  promptTimeoutMs: 15_000,
};
const statement = {
  text: "The team will ship on Friday.",
  citations: [{ evidenceId, quote: "We will ship on Friday." }],
};
const analysis = {
  quickSummary: [statement],
  detailedSummary: [statement],
  keywords: ["release"],
  decisions: [statement],
  nextSteps: [],
  keyMoments: [],
  participants: [],
  engagement: { observations: [], limitations: ["No audio assessment."] },
  agendaAssessment: [],
  memoryCandidates: [],
  overlapFindings: [],
  uncertainties: [],
};
let script: string;

before(async () => {
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ["tests/worker/summary-runtime.fixture.ts"],
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
        name: "summary-service-boundary",
        setup(build) {
          build.onResolve({ filter: /^[a-z_]+$/ }, (args) => {
            if (builtinModules.includes(args.path)) {
              return { path: `node:${args.path}`, external: true };
            }
            return undefined;
          });
          build.onResolve({ filter: /^\.\/service$/ }, (args) => {
            if (
              args.importer.endsWith("/src/ai/summary/agent.ts") ||
              args.importer.endsWith("/src/ai/summary/workflow.ts")
            ) {
              return { path: `${root}tests/worker/summary-service.fixture.ts` };
            }
            return undefined;
          });
        },
      },
    ],
  });
  assert.equal(bundle.outputFiles.length, 1);
  assert.ok(bundle.outputFiles[0]);
  script = bundle.outputFiles[0].text;
});

const agentInspectionSchema = z.object({
  name: z.literal(`summary:${workspaceId}:${jobId}`),
  state: z.object({
    workflowAttempted: z.boolean(),
    workflowConfirmed: z.boolean(),
    submissionId: z.string().nullable(),
    inferenceStarted: z.boolean(),
    inferenceUncertain: z.boolean(),
    cancelled: z.boolean(),
  }),
  submissions: z.array(
    z.object({
      submissionId: z.string(),
      idempotencyKey: z.string().nullable(),
      status: z.string(),
      error: z.string().nullable().optional(),
    }),
  ),
});
const inspectionSchema = z.object({
  workflow: z.object({
    status: z.string(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
  }),
  agent: agentInspectionSchema,
});
const modelRequestSchema = z.object({
  tools: z.array(
    z.object({
      type: z.literal("function"),
      name: z.string(),
      inputSchema: z.object({ required: z.array(z.string()) }),
    }),
  ),
  toolChoice: z.object({
    type: z.literal("tool"),
    toolName: z.literal("think_final_answer"),
  }),
  prompt: z.array(z.unknown()),
});

function startWorker(t: TestContext, output: unknown, holdModel = false) {
  const unexpected: string[] = [];
  const publications: unknown[][] = [];
  const failures: unknown[][] = [];
  const modelCalls: unknown[] = [];
  const modelStarted = Promise.withResolvers<void>();
  const releaseModel = Promise.withResolvers<void>();
  let status = "running";
  let persistenceUnavailable = false;
  if (!holdModel) releaseModel.resolve();

  async function outbound(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== "https://summary-service.test" || request.method !== "POST") {
      unexpected.push(request.url);
      return new Response("Unexpected outbound request", { status: 502 });
    }
    if (url.pathname === "/model") {
      modelCalls.push(await request.json());
      modelStarted.resolve();
      await releaseModel.promise;
      return Response.json(output);
    }
    const args = z.array(z.unknown()).parse(await request.json());
    assert.deepEqual(args.slice(0, 2), [workspaceId, jobId]);
    switch (url.pathname) {
      case "/execution":
        return Response.json({ id: jobId, workspaceId, status, policy });
      case "/prepare":
        return Response.json(reference);
      case "/prompt":
        assert.deepEqual(args[2], reference);
        return Response.json(
          `Authorized fixture snapshot ${jobId}: ${evidenceId}: We will ship on Friday.`,
        );
      case "/publish":
        assert.deepEqual(args[2], reference);
        publications.push(args);
        status = "succeeded";
        return Response.json({ id: summaryId });
      case "/fail":
        failures.push(args);
        if (persistenceUnavailable) {
          return new Response("Persistence unavailable", {
            status: 503,
            headers: { "x-fixture-terminal-outage": "true" },
          });
        }
        status = "failed";
        return Response.json(null);
      default:
        unexpected.push(request.url);
        return new Response("Unexpected service operation", { status: 502 });
    }
  }

  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "summary-runtime-test",
          compatibilityDate: "2026-11-13",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: script } },
          },
          exports: {
            SummaryAgent: { type: "durable-object", storage: "sqlite" },
            SummaryWorkflow: { type: "workflow", name: "summary-runtime-workflow" },
          },
          env: {
            SUMMARY_ENABLED: { type: "text", value: "true" },
            SUMMARY_AGENT: {
              type: "durable-object",
              worker: "summary-runtime-test",
              exportName: "SummaryAgent",
            },
            SUMMARY_WORKFLOW: {
              type: "workflow",
              name: "summary-runtime-workflow",
              worker: "summary-runtime-test",
              exportName: "SummaryWorkflow",
            },
          },
        },
        dev: { outboundService: { type: "fetcher", handler: outbound } },
      },
    ],
  });
  t.after(async () => {
    releaseModel.resolve();
    await mf.dispose();
    assert.deepEqual(unexpected, [], "All outbound requests must stay inside test boundaries");
  });

  async function dispatch(path: string, expectedStatus = 200) {
    const response = await mf.dispatchFetch(
      `https://fixture.test${path}?workspaceId=${workspaceId}&jobId=${jobId}`,
    );
    const body: unknown = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(body));
    return body;
  }
  async function settled() {
    let latest;
    for (let attempt = 0; attempt < 400; attempt++) {
      latest = inspectionSchema.parse(await dispatch("/inspect"));
      if (["complete", "errored", "terminated"].includes(latest.workflow.status)) return latest;
      await setTimeout(25);
    }
    assert.fail(`Workflow did not settle: ${JSON.stringify(latest)}`);
  }
  return {
    dispatch,
    settled,
    publications,
    failures,
    modelCalls,
    modelStarted: modelStarted.promise,
    releaseModel: () => releaseModel.resolve(),
    jobStatus: () => status,
    setPersistenceUnavailable(value: boolean) {
      persistenceUnavailable = value;
    },
  };
}

void test(
  "fresh raw namespace RPC initializes production Think and publishes once across duplicate starts",
  {
    timeout: 30_000,
  },
  async (t) => {
    const worker = startWorker(t, analysis, true);
    assert.deepEqual(await worker.dispatch("/start"), { workflowId });
    await worker.modelStarted;
    assert.deepEqual(await worker.dispatch("/start"), { workflowId });
    assert.equal(worker.modelCalls.length, 1);
    const modelRequest = modelRequestSchema.parse(worker.modelCalls[0]);
    assert.deepEqual(
      modelRequest.tools.map((tool) => tool.name),
      ["think_final_answer"],
    );
    assert.ok(modelRequest.tools[0]?.inputSchema.required.includes("quickSummary"));
    assert.ok(modelRequest.tools[0]?.inputSchema.required.includes("detailedSummary"));
    assert.match(JSON.stringify(modelRequest.prompt), /We will ship on Friday/);
    worker.releaseModel();

    const result = await worker.settled();
    assert.equal(result.workflow.status, "complete", JSON.stringify(result));
    assert.deepEqual(result.workflow.output, { status: "succeeded", summaryId });
    assert.equal(result.agent.state.workflowConfirmed, true);
    assert.equal(result.agent.state.inferenceStarted, true);
    assert.equal(result.agent.submissions.length, 1);
    assert.equal(result.agent.submissions[0]?.status, "completed");
    assert.equal(
      result.agent.submissions[0]?.idempotencyKey,
      `think-workflow:SUMMARY_WORKFLOW:${workflowId}:summarize`,
    );
    assert.deepEqual(worker.publications, [[workspaceId, jobId, reference, analysis]]);
    assert.deepEqual(worker.failures, []);
    assert.deepEqual(await worker.dispatch("/start"), { workflowId: null });
    assert.equal(worker.modelCalls.length, 1);
    assert.equal(worker.publications.length, 1);
  },
);

void test(
  "raw cancellation on a fresh Agent prevents later start without inference or Workflow creation",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t, analysis);
    assert.deepEqual(await worker.dispatch("/cancel"), { cancelled: true });
    assert.deepEqual(await worker.dispatch("/start"), { workflowId: null });
    const agent = agentInspectionSchema.parse(await worker.dispatch("/agent"));
    assert.equal(agent.state.cancelled, true);
    assert.equal(agent.state.workflowAttempted, false);
    assert.equal(agent.state.workflowConfirmed, false);
    assert.equal(agent.state.inferenceStarted, false);
    assert.equal(agent.state.submissionId, null);
    assert.deepEqual(agent.submissions, []);
    assert.deepEqual(worker.modelCalls, []);
    assert.deepEqual(worker.publications, []);
  },
);

for (const recovery of ["terminal-workflow", "uncertainty-marker"] as const) {
  void test(
    `reconciles a failed persistence write through ${recovery} without repeating inference`,
    { timeout: 30_000 },
    async (t) => {
      const worker = startWorker(
        t,
        { quickSummary: "invalid schema" },
        recovery === "uncertainty-marker",
      );
      worker.setPersistenceUnavailable(true);
      assert.deepEqual(await worker.dispatch("/start"), { workflowId });
      await worker.modelStarted;
      let initial;
      if (recovery === "uncertainty-marker") {
        assert.deepEqual(await worker.dispatch("/recover"), { continue: false });
        initial = inspectionSchema.parse(await worker.dispatch("/inspect"));
        assert.equal(initial.agent.state.inferenceUncertain, true);
        assert.ok(
          !["complete", "errored", "terminated"].includes(initial.workflow.status),
          "Exercise uncertainty reconciliation before terminal Workflow status can mask it",
        );
      } else {
        initial = await worker.settled();
        assert.equal(initial.workflow.status, "errored", JSON.stringify(initial));
      }
      assert.equal(worker.jobStatus(), "running", "Failed persistence must leave the job active");
      assert.ok(worker.failures.length >= 1);
      assert.equal(worker.modelCalls.length, 1);
      assert.deepEqual(worker.publications, []);

      const failuresBeforeRetry = worker.failures.length;
      await worker.dispatch("/start", 500);
      assert.ok(worker.failures.length > failuresBeforeRetry);
      assert.equal(worker.jobStatus(), "running");
      assert.equal(worker.modelCalls.length, 1);

      worker.setPersistenceUnavailable(false);
      await worker.dispatch("/start");
      assert.equal(worker.jobStatus(), "failed");
      assert.deepEqual(await worker.dispatch("/start"), { workflowId: null });
      worker.releaseModel();
      const reconciled = await worker.settled();
      assert.equal(reconciled.workflow.status, "errored");
      assert.equal(reconciled.agent.submissions.length, 1);
      assert.equal(reconciled.agent.state.submissionId, initial.agent.state.submissionId);
      assert.equal(worker.modelCalls.length, 1);
      assert.deepEqual(worker.publications, []);
    },
  );
}

void test(
  "invalid structured final answer fails the real Think Workflow without publication or retry",
  {
    timeout: 30_000,
  },
  async (t) => {
    const worker = startWorker(t, { quickSummary: "invalid schema" });
    assert.deepEqual(await worker.dispatch("/start"), { workflowId });
    const result = await worker.settled();
    assert.equal(result.workflow.status, "errored", JSON.stringify(result));
    assert.equal(result.agent.submissions.length, 1);
    // Think completed its model turn; the real step.prompt() revalidation
    // rejects this payload before production can call publishSummary().
    assert.equal(result.agent.submissions[0]?.status, "completed");
    assert.equal(worker.modelCalls.length, 1);
    assert.deepEqual(worker.publications, []);
    assert.ok(worker.failures.length >= 1);
    assert.ok(worker.failures.every((args) => args[2] === "failed"));
    assert.deepEqual(await worker.dispatch("/start"), { workflowId: null });
    assert.equal(worker.modelCalls.length, 1);
  },
);
