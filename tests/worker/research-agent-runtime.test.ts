import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { before, test, type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

import { build } from "esbuild";
import { Miniflare, Response, type Request } from "miniflare";
import { z } from "zod";
import { researchRunPolicySchema } from "../../src/config/research-runs.ts";

let script: string;
const root = fileURLToPath(new URL("../../", import.meta.url));
const workspaceId = "10000000-0000-4000-8000-000000000001";
const runId = "10000000-0000-4000-8000-000000000002";
const fixtureScope = {
  workspaceId,
  runId,
  actorId: "10000000-0000-4000-8000-000000000003",
  operationId: "accepted-operation",
  question: "Investigate the latest status across the four admitted questions.",
  questions: [
    { id: "10000000-0000-4000-8000-000000000004", question: "Latest status" },
    { id: "10000000-0000-4000-8000-000000000007", question: "What evidence supports it?" },
    { id: "10000000-0000-4000-8000-000000000008", question: "What remains uncertain?" },
    { id: "10000000-0000-4000-8000-000000000009", question: "What is the next milestone?" },
  ],
  noteId: null,
  personId: null,
  sourceUrls: [],
  discoverSources: true,
  timeframe: { mode: "current" },
};
const fixturePolicy = researchRunPolicySchema.parse({
  version: "research-v1",
  promptVersion: "research-extract-v2",
  provider: "workers-ai",
  model: "@cf/fixture/research-agent",
  budgetId: "10000000-0000-4000-8000-000000000005",
  rateVersionId: "10000000-0000-4000-8000-000000000006",
  executionVersion: "research-agent-v2",
  maxEvidenceBytes: 4_000,
  maxModelSteps: 8,
  deadlineMs: 60_000,
});

before(async () => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["tests/worker/research-agent-runtime.fixture.ts"],
    tsconfig: "tsconfig.worker-tests.json",
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd"],
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    plugins: [
      {
        name: "node-builtins",
        setup(builder) {
          builder.onResolve({ filter: /^[a-z_]+$/ }, (args) =>
            builtinModules.includes(args.path)
              ? { path: `node:${args.path}`, external: true }
              : undefined,
          );
        },
      },
    ],
  });
  assert.ok(result.outputFiles[0]);
  script = result.outputFiles[0].text;
});

type ToolChoice = { name: string; input: unknown; id: string };

function startWorker(
  t: TestContext,
  options: {
    noPublish?: boolean;
    holdSecondModel?: boolean;
    rejectFirstPublication?: boolean;
    throwFirstPublication?: boolean;
    evidenceBudget?: boolean;
    parallelUncertainTools?: boolean;
    throwFirstTool?: boolean;
    insufficientEvidenceRepair?: boolean;
  } = {},
) {
  const modelCalls: unknown[] = [];
  const admitted: unknown[] = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const savedSourceTexts: string[] = [];
  const publications: unknown[] = [];
  const failures: unknown[] = [];
  const unexpected: string[] = [];
  const secondModelStarted = Promise.withResolvers<void>();
  const firstPublicationStarted = Promise.withResolvers<void>();
  const releaseSecondModel = Promise.withResolvers<void>();
  if (!options.holdSecondModel) releaseSecondModel.resolve();
  let status = "queued";
  let modelOrdinal = 0;
  let publishAttempts = 0;

  async function outbound(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== "https://research-agent-service.test" || request.method !== "POST") {
      unexpected.push(request.url);
      return new Response("Unexpected outbound request", { status: 502 });
    }

    if (url.pathname === "/model") {
      const params = await request.json();
      modelCalls.push(params);
      modelOrdinal += 1;
      if (options.holdSecondModel && modelOrdinal === 2) {
        secondModelStarted.resolve();
        await releaseSecondModel.promise;
      }

      const transcript = JSON.stringify(params);
      if (options.insufficientEvidenceRepair && modelOrdinal === 1) {
        return Response.json({
          tool: {
            name: "record_findings",
            id: "tool-record-failed-findings",
            input: {
              findings: [
                {
                  questionId: "10000000-0000-4000-8000-000000000004",
                  outcome: "failed",
                  statement: null,
                  classification: null,
                  explanation: "The source could not be retrieved.",
                  citations: [],
                },
                {
                  questionId: "10000000-0000-4000-8000-000000000007",
                  outcome: "failed",
                  statement: null,
                  classification: null,
                  explanation: "The source could not be retrieved.",
                  citations: [],
                },
                {
                  questionId: "10000000-0000-4000-8000-000000000008",
                  outcome: "failed",
                  statement: null,
                  classification: null,
                  explanation: "The source could not be retrieved.",
                  citations: [],
                },
                {
                  questionId: "10000000-0000-4000-8000-000000000009",
                  outcome: "insufficient-evidence",
                  statement: null,
                  classification: null,
                  explanation: "No retrievable source established this milestone.",
                  citations: [],
                },
              ],
              gaps: ["The source retrieval failed, so the claims remain unverified."],
            },
          },
        });
      }
      if (options.insufficientEvidenceRepair && modelOrdinal === 2) {
        return Response.json({
          tool: {
            name: "publish_report",
            id: "tool-publish-failed-findings",
            input: {
              answer:
                "The research could not verify the admitted questions because retrieval failed.",
              quality: "insufficient-evidence",
              findings: [
                {
                  questionId: "10000000-0000-4000-8000-000000000004",
                  outcome: "failed",
                  statement: null,
                  classification: null,
                  explanation: "The source could not be retrieved.",
                  citations: [],
                },
                {
                  questionId: "10000000-0000-4000-8000-000000000007",
                  outcome: "failed",
                  statement: null,
                  classification: null,
                  explanation: "The source could not be retrieved.",
                  citations: [],
                },
                {
                  questionId: "10000000-0000-4000-8000-000000000008",
                  outcome: "failed",
                  statement: null,
                  classification: null,
                  explanation: "The source could not be retrieved.",
                  citations: [],
                },
                {
                  questionId: "10000000-0000-4000-8000-000000000009",
                  outcome: "insufficient-evidence",
                  statement: null,
                  classification: null,
                  explanation: "No retrievable source established this milestone.",
                  citations: [],
                },
              ],
              gaps: ["The source retrieval failed, so the claims remain unverified."],
              stopReason: "insufficient-evidence",
            },
          },
        });
      }
      if (options.insufficientEvidenceRepair && modelOrdinal === 3) {
        return Response.json({
          tool: {
            name: "publish_report",
            id: "tool-publish-insufficient-report",
            input: {
              answer:
                "The research could not verify the admitted questions because retrieval failed.",
              quality: "insufficient-evidence",
              findings: [
                "Latest status",
                "What evidence supports it?",
                "What remains uncertain?",
                "What is the next milestone?",
              ].map((question, index) => ({
                questionId: [
                  "10000000-0000-4000-8000-000000000004",
                  "10000000-0000-4000-8000-000000000007",
                  "10000000-0000-4000-8000-000000000008",
                  "10000000-0000-4000-8000-000000000009",
                ][index],
                outcome: "insufficient-evidence",
                statement: null,
                classification: null,
                explanation: `No retrievable source established: ${question}`,
                citations: [],
              })),
              gaps: ["The source retrieval failed, so the claims remain unverified."],
              stopReason: "insufficient-evidence",
            },
          },
        });
      }
      if (options.parallelUncertainTools) {
        return Response.json(
          modelOrdinal === 1
            ? {
                tools: [
                  {
                    name: "search_sources",
                    id: "tool-search-first",
                    input: { query: "latest status source one" },
                  },
                  {
                    name: "search_sources",
                    id: "tool-search-second",
                    input: { query: "latest status source two" },
                  },
                ],
              }
            : {
                tool: {
                  name: "publish_report",
                  id: "tool-publish-after-uncertain",
                  input: {
                    answer: "The search outcome is uncertain.",
                    quality: "partial",
                    findings: [],
                    gaps: ["A source search outcome is uncertain."],
                    stopReason: "insufficient-evidence",
                  },
                },
              },
        );
      }
      const tool: ToolChoice | null = options.noPublish
        ? null
        : options.evidenceBudget && modelOrdinal <= 2
          ? {
              name: "evidence_read",
              id: `tool-evidence-read-${modelOrdinal}`,
              input: {
                sourceId: "10000000-0000-4000-8000-000000000007",
                startOffset: 0,
                limit: 3_000,
              },
            }
          : options.evidenceBudget
            ? {
                name: "publish_report",
                id: "tool-publish-budget",
                input: {
                  answer:
                    "The saved source was available, but its text exceeded the model evidence budget.",
                  quality: "partial",
                  findings: [],
                  gaps: ["The second source passage was withheld by the evidence budget."],
                  stopReason: "insufficient-evidence",
                },
              }
            : transcript.toLowerCase().includes("report citations did not validate")
              ? {
                  name: "publish_report",
                  id: "tool-publish-repair",
                  input: {
                    answer: "The corrected report preserves the citation limitation.",
                    quality: "partial",
                    findings: [],
                    gaps: ["The candidate has not yet been retrieved."],
                    stopReason: "insufficient-evidence",
                  },
                }
              : transcript.includes("candidate confirms the latest status")
                ? {
                    name: "publish_report",
                    id: "tool-publish",
                    input: {
                      answer: "A candidate source was found, but the claim remains limited.",
                      quality: "partial",
                      findings: [],
                      gaps: ["The candidate has not yet been retrieved."],
                      stopReason: "evidence-sufficient",
                    },
                  }
                : transcript.includes("saved evidence is insufficient; search for latest status")
                  ? {
                      name: "search_sources",
                      id: "tool-search",
                      input: { query: "latest status primary source" },
                    }
                  : {
                      name: "evidence_lookup",
                      id: "tool-evidence-lookup",
                      input: { query: "latest status", limit: 4 },
                    };

      return Response.json(
        options.noPublish ? { text: "The answer is probably current." } : { tool },
      );
    }

    const args = z.array(z.unknown()).parse(await request.json());
    switch (url.pathname) {
      case "/execution":
        return Response.json({ status, scope: fixtureScope, policy: fixturePolicy });
      case "/beginRun":
        status = "running";
        return Response.json(true);
      case "/isCancelled":
        return Response.json(false);
      case "/executeTool": {
        const [name, input] = args as [string, unknown];
        toolCalls.push({ name, input });
        if (options.throwFirstTool && toolCalls.length === 1) {
          return new Response("Tool acknowledgement unavailable.", { status: 503 });
        }
        if (name === "evidence_read") {
          const text = "e".repeat(3_000);
          savedSourceTexts.push(text);
          return Response.json({
            ok: true,
            source: { sourceId: "10000000-0000-4000-8000-000000000007" },
            text,
            totalLength: text.length,
          });
        }
        return Response.json(
          name === "evidence_lookup"
            ? { observation: "saved evidence is insufficient; search for latest status" }
            : { observation: "candidate confirms the latest status" },
        );
      }
      case "/publishReport":
        publications.push(args);
        publishAttempts += 1;
        firstPublicationStarted.resolve();
        if (options.insufficientEvidenceRepair && publishAttempts === 1) {
          return Response.json({
            published: false,
            reason: "invalid-citations",
            feedback: "Unresolved questions require an explained insufficient-evidence finding.",
          });
        }
        if (options.throwFirstPublication && publishAttempts === 1) {
          return new Response("Publication acknowledgement unavailable.", { status: 503 });
        }
        if (options.rejectFirstPublication && publishAttempts === 1) {
          return Response.json({ published: false, reason: "invalid-citations" });
        }
        status = "completed";
        return Response.json({ published: true, receiptId: "fixture-publication-receipt" });
      case "/failRun":
        failures.push(args);
        status = "failed";
        return Response.json(null);
      case "/admitModelRequest":
        admitted.push(args);
        return Response.json(null);
      default:
        unexpected.push(request.url);
        return new Response("Unexpected fixture service operation", { status: 502 });
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
          name: "research-agent-runtime-test",
          compatibilityDate: "2026-11-13",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: script } },
          },
          exports: {
            ResearchAgent: { type: "durable-object", storage: "sqlite" },
          },
          env: {
            RESEARCH_AGENT: {
              type: "durable-object",
              worker: "research-agent-runtime-test",
              exportName: "ResearchAgent",
            },
          },
        },
        dev: { outboundService: { type: "fetcher", handler: outbound } },
      },
    ],
  });

  t.after(async () => {
    releaseSecondModel.resolve();
    await mf.dispose();
    assert.deepEqual(unexpected, [], "All runtime I/O stays in injected fixture services.");
  });

  return {
    modelCalls,
    admitted,
    toolCalls,
    savedSourceTexts,
    publications,
    failures,
    secondModelStarted: secondModelStarted.promise,
    firstPublicationStarted: firstPublicationStarted.promise,
    releaseSecondModel: () => releaseSecondModel.resolve(),
    async dispatch(path: string, expectedStatus = 200) {
      const response = await mf.dispatchFetch(`https://fixture.test${path}`);
      const body: unknown = await response.json();
      assert.equal(response.status, expectedStatus, JSON.stringify(body));
      return body;
    },
    async settled() {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const inspected = (await this.dispatch("/inspect")) as {
          state: {
            publicationReceiptId: string | null;
            cancelled: boolean;
            evidenceBytes: number;
          };
          submissions: Array<{ status: string; submissionId: string }>;
        };
        const terminal = inspected.submissions.at(-1)?.status;
        if (terminal === "completed" || terminal === "error" || terminal === "aborted") {
          return inspected;
        }
        await setTimeout(10);
      }
      throw new Error("Research Agent submission did not reach a terminal status.");
    },
  };
}

void test(
  "native Think chooses tools from evidence, publishes once, and inspects the same submission after lost acknowledgement",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t);
    const lost = await worker.dispatch("/start-lost-ack", 503);
    assert.deepEqual(lost, { acknowledgementLost: true });
    const retry = await worker.dispatch("/start");
    assert.equal((retry as { submissionId: string }).submissionId, runId);

    const inspected = await worker.settled();
    assert.equal(inspected.submissions.length, 1);
    assert.equal(inspected.submissions[0]?.submissionId, runId);
    assert.equal(inspected.submissions[0]?.status, "completed");
    assert.equal(inspected.state.publicationReceiptId, "fixture-publication-receipt");
    assert.deepEqual(
      worker.toolCalls.map(({ name }) => name),
      ["evidence_lookup", "search_sources"],
    );
    assert.equal(worker.publications.length, 1);
    assert.equal(worker.admitted.length, 3);
    assert.equal(worker.modelCalls.length, 3, "Publication stops the native model loop.");
    assert.ok(
      JSON.stringify(worker.modelCalls[1]).includes(
        "saved evidence is insufficient; search for latest status",
      ),
      "The next native model request received the actual evidence tool result.",
    );
    assert.ok(JSON.stringify(worker.modelCalls[0]).includes("Latest status"));
    assert.ok(JSON.stringify(worker.modelCalls[0]).includes("maxSearchCalls"));
    assert.ok(
      JSON.stringify(worker.modelCalls[2]).includes("candidate confirms the latest status"),
      "The following decision was based on the source-search result.",
    );

    const duplicate = await worker.dispatch("/start");
    assert.equal(duplicate, null);
    assert.equal(worker.modelCalls.length, 3);
    assert.equal(worker.publications.length, 1);
  },
);

void test(
  "deterministic citation rejection is returned as repair feedback without replaying inference",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t, { rejectFirstPublication: true });
    await worker.dispatch("/start");

    const inspected = await worker.settled();
    assert.equal(inspected.submissions[0]?.status, "completed");
    assert.equal(inspected.state.publicationReceiptId, "fixture-publication-receipt");
    assert.equal(worker.publications.length, 2);
    assert.equal(worker.modelCalls.length, 4);
    assert.ok(
      JSON.stringify(worker.modelCalls[3])
        .toLowerCase()
        .includes("report citations did not validate"),
    );
  },
);

void test(
  "cumulative evidence text budget withholds excess read output without changing saved sources",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t, { evidenceBudget: true });
    await worker.dispatch("/start");

    const inspected = await worker.settled();
    assert.equal(inspected.submissions[0]?.status, "completed");
    assert.equal(inspected.state.evidenceBytes, 3_000);
    assert.deepEqual(
      worker.toolCalls.map(({ name }) => name),
      ["evidence_read", "evidence_read"],
    );
    assert.deepEqual(
      worker.savedSourceTexts.map((text) => text.length),
      [3_000, 3_000],
    );
    assert.ok(JSON.stringify(worker.modelCalls[0]).includes("4000 cumulative UTF-8 bytes"));
    assert.ok(JSON.stringify(worker.modelCalls[1]).includes("e".repeat(3_000)));
    const overBudgetTurn = JSON.stringify(worker.modelCalls[2]);
    assert.ok(overBudgetTurn.includes("evidence-budget-exhausted"));
    assert.equal(overBudgetTurn.split("e".repeat(3_000)).length - 1, 1);
    assert.equal(worker.publications.length, 1);
  },
);

void test(
  "bounded publication feedback repairs failed findings into an honest four-question insufficiency report",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t, { insufficientEvidenceRepair: true });
    await worker.dispatch("/start");
    const inspected = await worker.settled();

    assert.equal(inspected.submissions[0]?.status, "completed");
    assert.equal(inspected.state.publicationReceiptId, "fixture-publication-receipt");
    assert.equal(worker.modelCalls.length, 3);
    assert.equal(worker.publications.length, 2);

    const rejected = worker.publications[0] as [
      unknown,
      {
        findings: Array<{ outcome: string; citations: unknown[] }>;
      },
    ];
    assert.deepEqual(
      rejected[1].findings.map(({ outcome }) => outcome),
      ["failed", "failed", "failed", "insufficient-evidence"],
    );

    const corrected = worker.publications[1] as [
      unknown,
      {
        quality: string;
        findings: Array<{ outcome: string; explanation: string; citations: unknown[] }>;
        gaps: string[];
        stopReason: string;
      },
    ];
    assert.equal(corrected[1].quality, "insufficient-evidence");
    assert.equal(corrected[1].stopReason, "insufficient-evidence");
    assert.deepEqual(
      corrected[1].findings.map(({ outcome }) => outcome),
      [
        "insufficient-evidence",
        "insufficient-evidence",
        "insufficient-evidence",
        "insufficient-evidence",
      ],
    );
    assert.ok(
      corrected[1].findings.every(
        ({ explanation, citations }) => explanation && citations.length === 0,
      ),
    );
    assert.deepEqual(corrected[1].gaps, [
      "The source retrieval failed, so the claims remain unverified.",
    ]);
    assert.ok(
      JSON.stringify(worker.modelCalls[2]).includes(
        "Unresolved questions require an explained insufficient-evidence finding.",
      ),
    );
  },
);

void test(
  "queued parallel mutations recheck uncertainty after the serialized predecessor fails",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t, {
      parallelUncertainTools: true,
      throwFirstTool: true,
    });
    await worker.dispatch("/start");
    await worker.settled();

    assert.equal(worker.toolCalls.length, 1);
    assert.equal(worker.toolCalls[0]?.name, "search_sources");
    assert.ok(worker.modelCalls.length <= fixturePolicy.maxModelSteps);
    assert.equal(worker.publications.length, 0);
  },
);

void test(
  "uncertain publication survives a failed native turn and reconciles the exact operation without inference",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t, { throwFirstPublication: true });
    await worker.dispatch("/start");
    await worker.firstPublicationStarted;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (worker.modelCalls.length === 3) break;
      await setTimeout(10);
    }

    const beforeReconcile = (await worker.dispatch("/inspect")) as {
      state: {
        pendingPublication: { operationId: string; input: unknown } | null;
        publicationReceiptId: string | null;
      };
    };
    assert.ok(beforeReconcile.state.pendingPublication);
    assert.equal(beforeReconcile.state.publicationReceiptId, null);
    assert.deepEqual(worker.failures, []);
    assert.equal(worker.modelCalls.length, 3);

    await worker.dispatch("/reconcile");

    const afterReconcile = (await worker.dispatch("/inspect")) as {
      state: {
        pendingPublication: unknown;
        publicationReceiptId: string | null;
      };
    };
    assert.equal(afterReconcile.state.pendingPublication, null);
    assert.equal(afterReconcile.state.publicationReceiptId, "fixture-publication-receipt");
    assert.equal(worker.publications.length, 2);
    assert.deepEqual(worker.publications[1], worker.publications[0]);
    assert.equal(worker.modelCalls.length, 3, "Publication reconciliation never reruns inference.");
    assert.deepEqual(worker.failures, []);
  },
);

void test(
  "cancellation fences a selected tool call before its service operation",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t, { holdSecondModel: true });
    await worker.dispatch("/start");
    await worker.secondModelStarted;
    await worker.dispatch("/cancel");
    worker.releaseSecondModel();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (worker.toolCalls.length === 1) break;
      await setTimeout(10);
    }

    assert.deepEqual(
      worker.toolCalls.map(({ name }) => name),
      ["evidence_lookup"],
    );
    assert.deepEqual(worker.publications, []);
    assert.ok(worker.modelCalls.length <= 2);
  },
);

void test(
  "a completed natural-language turn without publish_report fails without publishing",
  { timeout: 30_000 },
  async (t) => {
    const worker = startWorker(t, { noPublish: true });
    await worker.dispatch("/start");
    await worker.settled();

    assert.equal(worker.modelCalls.length, 1);
    assert.equal(worker.publications.length, 0);
    assert.equal(worker.failures.length, 1);
  },
);
