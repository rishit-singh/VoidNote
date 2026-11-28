import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { before, test, type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

import { build } from "esbuild";
import { Miniflare, Response, type Request } from "miniflare";
import { z } from "zod";

let script: string;
const root = fileURLToPath(new URL("../../", import.meta.url));
const runId = "10000000-0000-4000-8000-000000000002";
const workspaceId = "10000000-0000-4000-8000-000000000001";
const firstQuestionId = "10000000-0000-4000-8000-000000000004";
const secondQuestionId = "10000000-0000-4000-8000-000000000005";

const completeCandidate = {
  answer: "The available evidence did not establish either requested fact.",
  quality: "insufficient-evidence",
  findings: [
    {
      questionId: firstQuestionId,
      outcome: "insufficient-evidence",
      statement: null,
      classification: null,
      explanation: "No retrieved source established the current status.",
      citations: [],
    },
    {
      questionId: secondQuestionId,
      outcome: "insufficient-evidence",
      statement: null,
      classification: null,
      explanation: "No retrieved source established what remains unverified.",
      citations: [],
    },
  ],
  gaps: ["The available source did not contain enough information."],
  stopReason: "insufficient-evidence",
};

before(async () => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["tests/worker/research-workflow-runtime.fixture.ts"],
    tsconfig: "tsconfig.worker-tests.json",
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    mainFields: ["browser", "module", "main"],
    conditions: ["workerd", "react-server"],
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    plugins: [
      {
        name: "native-research-operations-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^[a-z_]+$/ }, (args) =>
            builtinModules.includes(args.path)
              ? { path: `node:${args.path}`, external: true }
              : undefined,
          );
          builder.onResolve({ filter: /server\/research\/worker/ }, (args) => {
            if (args.importer.includes("/src/ai/research/agent/")) {
              return { path: `${root}tests/worker/research-workflow-runtime.fixture.ts` };
            }

            return undefined;
          });
        },
      },
    ],
  });

  assert.ok(result.outputFiles[0]);
  script = result.outputFiles[0].text;
});

function modelResponse(modelOrdinal: number) {
  if (modelOrdinal === 1) {
    return {
      toolName: "evidence_lookup",
      toolCallId: "native-evidence-lookup-1",
      input: { query: "current status", limit: 2 },
    };
  }

  if (modelOrdinal === 2) {
    return {
      toolName: "think_final_answer",
      toolCallId: "think-answer-incomplete",
      input: {
        ...completeCandidate,
        findings: completeCandidate.findings.slice(0, 1),
        answer: "The status remains uncertain.",
      },
    };
  }

  if (modelOrdinal === 3) {
    return {
      toolName: "think_final_answer",
      toolCallId: "think-answer-corrected",
      input: completeCandidate,
    };
  }

  throw new Error(`Unexpected model request ${modelOrdinal}.`);
}

function startWorker(t: TestContext) {
  const modelCalls: unknown[] = [];
  const toolCalls: Array<{ name: string; input: unknown; operationId: string }> = [];
  const admitted: Array<{ requestId: string; inputTokenBound: number }> = [];
  const settledUsage: Array<{ requestId: string; usage: unknown }> = [];
  const publicationAttempts: Array<{ operationId: string; input: unknown }> = [];
  const committedPublications = new Map<string, unknown>();
  const unexpected: string[] = [];
  let runStatus = "queued";

  async function outbound(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.origin !== "https://research-workflow-service.test" || request.method !== "POST") {
      unexpected.push(request.url);
      return new Response("Unexpected fixture outbound request", { status: 502 });
    }

    if (url.pathname === "/model") {
      const params: unknown = await request.json();
      modelCalls.push(params);

      return Response.json(modelResponse(modelCalls.length));
    }

    const args = z.array(z.unknown()).parse(await request.json());

    switch (url.pathname) {
      case "/execution":
        return Response.json({
          status: runStatus,
          scope: {
            workspaceId,
            runId,
            actorId: "10000000-0000-4000-8000-000000000003",
            operationId: runId,
            question: "Investigate the current status and evidence limits.",
            questions: [
              { id: firstQuestionId, question: "What is the current status?" },
              { id: secondQuestionId, question: "What remains unverified?" },
            ],
            noteId: null,
            personId: null,
            sourceUrls: [],
            discoverSources: true,
            timeframe: { mode: "current" },
          },
          policy: {
            version: "research-v1",
            promptVersion: "research-extract-v2",
            provider: "workers-ai",
            sourceProvider: "direct",
            model: "@cf/fixture/research-workflow",
            budgetId: "10000000-0000-4000-8000-000000000006",
            rateVersionId: "10000000-0000-4000-8000-000000000007",
            executionVersion: "research-workflow-v3",
            maxModelSteps: 6,
            maxSearchCalls: 4,
            maxToolCalls: 12,
            scrapeUnitBound: 1,
            reportVersion: "research-report-v1",
            maxQuestions: 4,
            maxSources: 6,
            maxEvidenceBytes: 4_000,
            maxSnapshotAgeDays: 7,
            maxOutputTokens: 1024,
            maxInputTokens: 64_000,
            contextWindowTokens: 128_000,
            deadlineMs: 60_000,
            reasoningEffort: "none",
          },
        });
      case "/beginRun":
        runStatus = "running";
        return Response.json(true);
      case "/isCancelled":
        return Response.json(false);
      case "/executeTool": {
        const [name, input, context] = args as [string, unknown, { operationId: string }];
        toolCalls.push({ name, input, operationId: context.operationId });

        return Response.json({
          ok: true,
          evidence: [{ sourceId: "10000000-0000-4000-8000-000000000008" }],
          observation: "Fixture eligible evidence is available but does not cover both questions.",
        });
      }
      case "/publishReport": {
        const [, input, operationId] = args as [unknown, unknown, string];
        publicationAttempts.push({ operationId, input });

        const priorReceipt = committedPublications.get(operationId);

        if (priorReceipt) {
          return Response.json(priorReceipt);
        }

        const receipt = {
          published: true,
          receiptId: operationId,
        };
        committedPublications.set(operationId, receipt);

        // Simulate the database commit succeeding while the RPC acknowledgement is lost.
        return new Response("Publication acknowledgement was interrupted.", { status: 503 });
      }
      case "/admitModelRequest": {
        const [scope] = args as [{ requestId: string; inputTokenBound: number }];
        admitted.push({ requestId: scope.requestId, inputTokenBound: scope.inputTokenBound });
        return Response.json(null);
      }
      case "/settleUsage": {
        const [scope, usage] = args as [{ requestId: string }, unknown];
        settledUsage.push({ requestId: scope.requestId, usage });
        return Response.json(null);
      }
      case "/failRun":
        runStatus = "failed";
        return Response.json(null);
      default:
        unexpected.push(request.url);
        return new Response("Unexpected service operation", { status: 502 });
    }
  }

  const miniflare = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "research-workflow-runtime-test",
          compatibilityDate: "2026-11-13",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: script } },
          },
          exports: {
            ResearchWorkflowAgent: { type: "durable-object", storage: "sqlite" },
            ResearchInvestigationWorkflow: {
              type: "workflow",
              name: "research-investigation-workflow",
            },
          },
          env: {
            RESEARCH_WORKFLOW_AGENT: {
              type: "durable-object",
              worker: "research-workflow-runtime-test",
              exportName: "ResearchWorkflowAgent",
            },
            RESEARCH_INVESTIGATION_WORKFLOW: {
              type: "workflow",
              name: "research-investigation-workflow",
              worker: "research-workflow-runtime-test",
              exportName: "ResearchInvestigationWorkflow",
            },
          },
        },
        dev: { outboundService: { type: "fetcher", handler: outbound } },
      },
    ],
  });

  t.after(async () => {
    await miniflare.dispose();
    assert.deepEqual(unexpected, [], "Native runtime I/O must stay within fixture services.");
  });

  return {
    modelCalls,
    toolCalls,
    admitted,
    settledUsage,
    publicationAttempts,
    committedPublications,
    async dispatch(path: string) {
      const response = await miniflare.dispatchFetch(`https://fixture.test${path}`);
      const body: unknown = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));

      return body;
    },
    async settled() {
      let last: unknown;

      for (let attempt = 0; attempt < 600; attempt += 1) {
        last = await this.dispatch("/inspect");
        const inspection = last as {
          workflow: { status: string; output?: unknown };
          agent: { submissions: Array<{ status: string }> };
        };
        const workflowStatus = inspection.workflow.status;

        if (["complete", "errored", "terminated"].includes(workflowStatus)) {
          return inspection;
        }

        await setTimeout(25);
      }

      assert.fail(`Research Workflow did not settle: ${JSON.stringify(last)}`);
    },
  };
}

void test(
  "native ThinkWorkflow runs tools, corrects incomplete typed output, and retries publication without inference replay",
  { timeout: 60_000 },
  async (t) => {
    const worker = startWorker(t);

    assert.deepEqual(await worker.dispatch("/start"), { workflowId: runId });

    const result = await worker.settled();

    assert.equal(result.workflow.status, "complete", JSON.stringify(result));
    assert.deepEqual(result.workflow.output, { published: true });
    assert.deepEqual(
      worker.toolCalls.map(({ name }) => name),
      ["evidence_lookup"],
    );
    assert.equal(worker.modelCalls.length, 3);
    assert.equal(worker.admitted.length, 3);
    assert.equal(worker.settledUsage.length, 3);
    assert.deepEqual(
      worker.settledUsage.map(({ requestId }) => requestId).sort(),
      worker.admitted.map(({ requestId }) => requestId).sort(),
    );

    assert.ok(
      JSON.stringify(worker.modelCalls[1]).includes(
        "Fixture eligible evidence is available but does not cover both questions.",
      ),
      "Think's next model call receives the actual result from its executed evidence tool.",
    );
    assert.ok(
      JSON.stringify(worker.modelCalls[2]).includes(
        `Missing a finding for admitted question ${secondQuestionId}: What remains unverified?`,
      ),
      "The correction prompt includes deterministic application coverage feedback.",
    );

    assert.equal(worker.publicationAttempts.length, 2);
    assert.equal(worker.committedPublications.size, 1);
    assert.equal(
      worker.publicationAttempts[0]?.operationId,
      worker.publicationAttempts[1]?.operationId,
      "A transient publication acknowledgement retries the exact application operation.",
    );
    assert.deepEqual(
      worker.publicationAttempts[1]?.input,
      completeCandidate,
      "The corrected typed candidate, not the incomplete draft, is published.",
    );
  },
);
