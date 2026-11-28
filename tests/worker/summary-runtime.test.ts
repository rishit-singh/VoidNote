import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { before, test, type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response, type Request } from "miniflare";
import { z } from "zod";

import { summaryInputTokenBound } from "../../src/ai/runtime/budget.ts";
import { resolveSummaryPrompt } from "../../src/ai/summary/instructions.ts";

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
const snapshot = {
  schemaVersion: 1,
  snapshotId: jobId,
  workspaceId,
  source,
  noteRevision: 1,
  title: "Release",
  passages: [
    {
      evidenceId,
      segmentId: evidenceId,
      segmentRevision: 0,
      attributionRevision: 0,
      sourceUtteranceId: "10000000-0000-4000-8000-000000000009",
      sequence: 0,
      orderKey: "",
      providerTrackId: "speaker-1",
      assignment: { kind: "unknown" },
      text: "We will ship on Friday. The team has completed the release checklist and reviewed the deployment procedure together before the final review this afternoon.",
      startSeconds: 0,
      endSeconds: 10,
    },
  ],
  people: [],
  agenda: null,
  relatedConversations: [],
  coverage: { complete: true, passageCount: 1 },
};
const draft = {
  claims: [
    { id: "release", text: "Friday release planned.", support: statement.citations },
    {
      id: "checklist",
      text: "Release checklist completed.",
      support: [{ evidenceId, quote: "The team has completed the release checklist" }],
    },
  ],
  quickSummary: ["release"],
  detailedSummary: ["checklist"],
  decisions: [],
  actionCandidates: [
    {
      claimId: "release",
      disposition: "commitment",
      commitmentEvidence: statement.citations,
      ownerPersonId: null,
      ownerEvidence: [],
      dueDate: "Friday",
      dueDateEvidence: statement.citations,
    },
  ],
  keywords: ["release"],
  keyMoments: [],
  uncertainties: [],
};
let script: string;

void test(
  "v5 runs one evidence-first step and publishes the public projection once",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t, draft, { draftOutput: true });
    await worker.dispatch("/start");
    const result = await worker.settled();
    assert.equal(result.workflow.status, "complete");
    const request = modelRequestSchema.parse(worker.modelCalls[0]);
    assert.deepEqual(
      request.tools.map((tool) => tool.name),
      ["think_final_answer"],
    );
    assert.ok(request.tools[0]?.inputSchema.required.includes("claims"));
    assert.ok(!request.tools[0]?.inputSchema.required.includes("memoryCandidates"));
    assert.ok(
      JSON.stringify(request.prompt).includes(
        JSON.stringify(resolveSummaryPrompt("summary-v5").system).slice(1, -1),
      ),
    );
    const output = z
      .object({
        quickSummary: z.array(z.object({ text: z.string() })),
        nextSteps: z.array(z.object({ dueDate: z.string().nullable() })),
        memoryCandidates: z.array(z.unknown()),
      })
      .parse(worker.publications[0]?.[3]);
    assert.equal(output.quickSummary[0]?.text, "Friday release planned.");
    assert.equal(output.nextSteps[0]?.dueDate, "Friday");
    assert.deepEqual(output.memoryCandidates, []);
    await worker.dispatch("/start");
    assert.equal(worker.modelCalls.length, 1);
    assert.equal(worker.publications.length, 1);
  },
);

void test(
  "v5 schema-valid drafts with missing evidence never publish or trigger repair inference",
  { timeout: 30_000 },
  async (t) => {
    const invalid = structuredClone(draft);
    invalid.actionCandidates[0]!.commitmentEvidence = [];
    const worker = startWorker(t, invalid, { draftOutput: true });
    await worker.dispatch("/start");
    const result = await worker.settled();
    assert.equal(result.workflow.status, "errored");
    assert.equal(worker.jobStatus(), "failed");
    assert.equal(worker.publications.length, 0);
    await worker.dispatch("/recover");
    await worker.dispatch("/start");
    assert.equal(worker.modelCalls.length, 1);
  },
);

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
    pendingUsage: z
      .object({ inputTokens: z.number(), outputTokens: z.number() })
      .nullable()
      .optional(),
    failureEvidence: z
      .object({
        kind: z.string(),
        confidence: z.enum(["provider", "inferred"]),
        finishReason: z.string().optional(),
        usage: z.record(z.string(), z.number()).optional(),
      })
      .nullable()
      .optional(),
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

function startWorker(
  t: TestContext,
  output: unknown,
  options: {
    holdModel?: boolean;
    holdReservation?: boolean;
    usageAccounting?: boolean;
    missingUsage?: boolean;
    draftOutput?: boolean;
    promptVersion?: "summary-v8";
    outputLimit?: boolean;
  } = {},
) {
  const executionPolicy = {
    ...policy,
    ...(options.usageAccounting
      ? {
          ...policy,
          model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
          budgetId: "10000000-0000-4000-8000-000000000008",
          budgetAccounting: "request-usage-v1",
          promptVersion: "summary-v4",
        }
      : {}),
    ...(options.draftOutput ? { promptVersion: "summary-v5" } : {}),
    ...(options.promptVersion ? { promptVersion: options.promptVersion } : {}),
  };
  const unexpected: string[] = [];
  const publications: unknown[][] = [];
  const failures: unknown[][] = [];
  const reservations: unknown[][] = [];
  const settlements: unknown[][] = [];
  const inferenceEvents: string[] = [];
  const modelCalls: unknown[] = [];
  const modelStarted = Promise.withResolvers<void>();
  const releaseModel = Promise.withResolvers<void>();
  const reservationStarted = Promise.withResolvers<void>();
  const releaseReservation = Promise.withResolvers<void>();
  let status = "running";
  let persistenceUnavailable = false;
  let reservationRejected = false;
  let settlementUnavailable = false;
  if (!options.holdModel) releaseModel.resolve();
  if (!options.holdReservation) releaseReservation.resolve();

  async function outbound(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== "https://summary-service.test" || request.method !== "POST") {
      unexpected.push(request.url);
      return new Response("Unexpected outbound request", { status: 502 });
    }
    if (url.pathname === "/model") {
      inferenceEvents.push("model");
      modelCalls.push(await request.json());
      modelStarted.resolve();
      await releaseModel.promise;
      return Response.json(output, {
        headers: {
          "x-fixture-missing-usage": String(options.missingUsage ?? false),
          "x-fixture-output-limit": String(options.outputLimit ?? false),
        },
      });
    }
    const args = z.array(z.unknown()).parse(await request.json());
    assert.deepEqual(args.slice(0, 2), [workspaceId, jobId]);
    switch (url.pathname) {
      case "/execution":
        return Response.json({ id: jobId, workspaceId, status, policy: executionPolicy });
      case "/reserve":
        assert.deepEqual(args[2], executionPolicy);
        reservations.push(args);
        inferenceEvents.push("reservation-started");
        reservationStarted.resolve();
        await releaseReservation.promise;
        if (reservationRejected) {
          inferenceEvents.push("reservation-rejected");
          return new Response("Summary inference allowance unavailable", { status: 503 });
        }
        inferenceEvents.push("reservation-accepted");
        return Response.json(null);
      case "/settle":
        settlements.push(args);
        if (settlementUnavailable) return new Response("Unavailable", { status: 503 });
        return Response.json(null);
      case "/prepare":
        return Response.json(reference);
      case "/context":
        return Response.json(snapshot);
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
        if (status === "queued" || status === "running") {
          status = z.enum(["failed", "blocked", "superseded"]).parse(args[2]);
        }
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
    releaseReservation.resolve();
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
    reservations,
    settlements,
    executionPolicy,
    inferenceEvents,
    modelCalls,
    reservationStarted: reservationStarted.promise,
    releaseReservation: () => releaseReservation.resolve(),
    modelStarted: modelStarted.promise,
    releaseModel: () => releaseModel.resolve(),
    jobStatus: () => status,
    setPersistenceUnavailable(value: boolean) {
      persistenceUnavailable = value;
    },
    setReservationRejected(value: boolean) {
      reservationRejected = value;
    },
    setSettlementUnavailable(value: boolean) {
      settlementUnavailable = value;
    },
  };
}

void test(
  "fresh raw namespace RPC initializes production Think and publishes once across duplicate starts",
  {
    timeout: 30_000,
  },
  async (t) => {
    const worker = startWorker(t, analysis, { holdModel: true });
    assert.deepEqual(await worker.dispatch("/start"), { workflowId });
    await worker.modelStarted;
    assert.deepEqual(await worker.dispatch("/start"), { workflowId });
    assert.equal(worker.modelCalls.length, 1);
    assert.deepEqual(worker.reservations, [[workspaceId, jobId, policy, null]]);
    const modelRequest = modelRequestSchema.parse(worker.modelCalls[0]);
    assert.deepEqual(
      modelRequest.tools.map((tool) => tool.name),
      ["think_final_answer"],
    );
    assert.ok(modelRequest.tools[0]?.inputSchema.required.includes("quickSummary"));
    assert.ok(modelRequest.tools[0]?.inputSchema.required.includes("detailedSummary"));
    assert.match(JSON.stringify(modelRequest.prompt), /We will ship on Friday/);
    assert.ok(
      JSON.stringify(modelRequest.prompt).includes(
        JSON.stringify(resolveSummaryPrompt(policy.promptVersion).system).slice(1, -1),
      ),
      "The exact pinned instructions reach the provider boundary",
    );
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
    assert.equal(worker.reservations.length, 1);
    assert.equal(worker.publications.length, 1);
  },
);

void test(
  "reservation must complete before inference admission and provider execution",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t, analysis, { holdModel: true, holdReservation: true });
    assert.deepEqual(await worker.dispatch("/start"), { workflowId });
    await worker.reservationStarted;
    const pending = agentInspectionSchema.parse(await worker.dispatch("/agent"));
    assert.equal(pending.state.inferenceStarted, false);
    assert.deepEqual(worker.modelCalls, []);
    assert.deepEqual(worker.inferenceEvents, ["reservation-started"]);

    worker.releaseReservation();
    await worker.modelStarted;
    const admitted = agentInspectionSchema.parse(await worker.dispatch("/agent"));
    assert.equal(admitted.state.inferenceStarted, true);
    assert.deepEqual(worker.inferenceEvents, [
      "reservation-started",
      "reservation-accepted",
      "model",
    ]);
    worker.releaseModel();
    const result = await worker.settled();
    assert.equal(result.workflow.status, "complete", JSON.stringify(result));
    assert.deepEqual(worker.reservations, [[workspaceId, jobId, policy, null]]);
    assert.equal(worker.modelCalls.length, 1);
  },
);

void test(
  "budget rejection fails without provider execution or another reservation on exact replay",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t, analysis);
    worker.setReservationRejected(true);
    assert.deepEqual(await worker.dispatch("/start"), { workflowId });
    const result = await worker.settled();
    assert.equal(result.workflow.status, "errored", JSON.stringify(result));
    assert.equal(result.agent.state.inferenceStarted, false);
    assert.equal(worker.jobStatus(), "blocked");
    assert.deepEqual(worker.reservations, [[workspaceId, jobId, policy, null]]);
    assert.deepEqual(worker.inferenceEvents, ["reservation-started", "reservation-rejected"]);
    assert.deepEqual(worker.modelCalls, []);
    assert.deepEqual(worker.publications, []);
    assert.ok(worker.failures.length >= 1);
    assert.equal(worker.failures[0]?.[2], "blocked");

    worker.setReservationRejected(false);
    assert.deepEqual(await worker.dispatch("/start"), { workflowId: null });
    assert.equal(worker.reservations.length, 1);
    assert.deepEqual(worker.modelCalls, []);
  },
);

void test(
  "request-sized admission measures final tools and settles only reported usage",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t, analysis, { usageAccounting: true });
    await worker.dispatch("/start");
    const result = await worker.settled();
    assert.equal(result.workflow.status, "complete");
    const request = modelRequestSchema.parse(worker.modelCalls[0]);
    assert.equal(
      worker.reservations[0]?.[3],
      summaryInputTokenBound(worker.modelCalls[0] as { prompt: unknown; tools: unknown }),
    );
    assert.ok(
      Number(worker.reservations[0]?.[3]) > summaryInputTokenBound({ prompt: request.prompt }),
    );
    assert.deepEqual(worker.settlements, [
      [workspaceId, jobId, { inputTokens: 20, outputTokens: 30 }],
    ]);
    assert.equal(result.agent.state.pendingUsage, null);
    await worker.dispatch("/reconcile-usage");
    await worker.dispatch("/start");
    assert.equal(worker.modelCalls.length, 1);
    assert.equal(worker.settlements.length, 1);
  },
);

void test(
  "usage settlement outage retains a durable receipt and retries without inference",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t, analysis, { usageAccounting: true });
    worker.setSettlementUnavailable(true);
    await worker.dispatch("/start");
    const result = await worker.settled();
    assert.equal(
      result.workflow.status,
      "complete",
      "Accounting outage must not lose a completed result",
    );
    assert.deepEqual(result.agent.state.pendingUsage, { inputTokens: 20, outputTokens: 30 });
    worker.setSettlementUnavailable(false);
    await worker.dispatch("/reconcile-usage");
    const after = agentInspectionSchema.parse(await worker.dispatch("/agent"));
    assert.equal(after.state.pendingUsage, null);
    assert.deepEqual(worker.settlements, [
      [workspaceId, jobId, { inputTokens: 20, outputTokens: 30 }],
      [workspaceId, jobId, { inputTokens: 20, outputTokens: 30 }],
    ]);
    assert.equal(worker.modelCalls.length, 1);
  },
);

void test(
  "incomplete provider usage leaves the hold outstanding",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t, analysis, { usageAccounting: true, missingUsage: true });
    await worker.dispatch("/start");
    await worker.settled();
    assert.equal(worker.reservations.length, 1);
    assert.equal(worker.modelCalls.length, 1);
    assert.equal(worker.settlements.length, 0);
  },
);

void test(
  "known raw usage at the output cap diagnoses missing final answer without calling it a confirmed provider reason",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t, analysis, { usageAccounting: true, outputLimit: true });
    await worker.dispatch("/start");
    const result = await worker.settled();
    assert.equal(result.workflow.status, "errored");
    assert.equal(worker.modelCalls.length, 1);
    assert.deepEqual(worker.settlements, [
      [workspaceId, jobId, { inputTokens: 20, outputTokens: 8192 }],
    ]);
    assert.equal(result.agent.state.pendingUsage, null);
    assert.equal(result.agent.state.failureEvidence?.kind, "output_limit");
    assert.equal(result.agent.state.failureEvidence?.confidence, "inferred");
    assert.deepEqual(result.agent.state.failureEvidence?.usage, {
      inputTokens: 20,
      outputTokens: 8192,
    });
    assert.match(String(worker.failures.at(-1)?.[3]), /likely reached the provider output limit/);
    assert.doesNotMatch(String(worker.failures.at(-1)?.[3]), /uncertain|interrupted/i);
    await worker.dispatch("/start");
    assert.equal(worker.modelCalls.length, 1);
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
    assert.deepEqual(worker.reservations, []);
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
        {
          holdModel: recovery === "uncertainty-marker",
        },
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
      assert.equal(worker.reservations.length, 1);
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
      assert.equal(worker.reservations.length, 1);
      assert.deepEqual(worker.publications, []);
    },
  );
}

void test(
  "completed v8 inference with an invalid unused claim reports evidence validation without replay",
  { timeout: 30_000 },
  async (t) => {
    const invalidDraft = structuredClone(draft);
    const privateQuote = "we will ship on Friday.";
    invalidDraft.claims.push({
      id: "unused",
      text: "Unused claim remains subject to exact citation validation.",
      support: [{ evidenceId, quote: privateQuote }],
    });
    const worker = startWorker(t, invalidDraft, {
      usageAccounting: true,
      promptVersion: "summary-v8",
    });

    await worker.dispatch("/start");
    const result = await worker.settled();
    assert.equal(result.workflow.status, "errored");
    assert.equal(result.agent.submissions[0]?.status, "completed");
    assert.equal(worker.jobStatus(), "failed");
    assert.equal(worker.modelCalls.length, 1);
    assert.equal(worker.reservations.length, 1);
    assert.equal(worker.settlements.length, 1);
    assert.deepEqual(worker.publications, []);
    assert.ok(worker.failures.length > 0);
    for (const failure of worker.failures) {
      assert.equal(failure[2], "failed");
      assert.equal(
        failure[3],
        "The generated Summary did not pass source-evidence validation. No automatic model retry was issued.",
      );
      assert.ok(!String(failure[3]).includes(privateQuote));
    }
    assert.deepEqual(await worker.dispatch("/start"), { workflowId: null });
    assert.equal(worker.modelCalls.length, 1);
    assert.equal(worker.reservations.length, 1);
    assert.equal(worker.settlements.length, 1);
  },
);

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
    assert.equal(worker.reservations.length, 1);
  },
);
