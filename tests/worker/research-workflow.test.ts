import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ResearchAgentScope,
  ResearchAgentServices,
  ResearchAgentToolContext,
  ResearchAgentToolName,
} from "../../src/contracts/research/execution";
import {
  researchWorkflowCandidateFeedback,
  researchWorkflowCandidateSchema,
} from "../../src/contracts/research/workflow";
import {
  createResearchWorkflowTools,
  researchWorkflowOperationId,
} from "../../src/ai/research/agent/tools";

const scope: ResearchAgentScope = {
  workspaceId: "10000000-0000-4000-8000-000000000001",
  runId: "10000000-0000-4000-8000-000000000002",
  actorId: "10000000-0000-4000-8000-000000000003",
  operationId: "10000000-0000-4000-8000-000000000002",
  question: "Investigate the current status.",
  questions: [
    { id: "10000000-0000-4000-8000-000000000004", question: "What is the status?" },
    { id: "10000000-0000-4000-8000-000000000005", question: "What remains unknown?" },
  ],
  noteId: null,
  personId: null,
  sourceUrls: [],
  discoverSources: true,
  timeframe: { mode: "current" },
};

const reportCandidate = {
  answer: "The status could not be established from available evidence.",
  quality: "insufficient-evidence",
  findings: scope.questions.map((question) => ({
    questionId: question.id,
    outcome: "insufficient-evidence",
    statement: null,
    classification: null,
    explanation: `No retrieved evidence established ${question.question}`,
    citations: [],
  })),
  gaps: ["No sources were retrievable."],
  stopReason: "insufficient-evidence",
};

function testTool<TInput, TResult>(
  value: unknown,
): {
  execute(input: TInput, options: { toolCallId: string }): Promise<TResult>;
} {
  return value as {
    execute(input: TInput, options: { toolCallId: string }): Promise<TResult>;
  };
}

void test("workflow candidate contract excludes failed findings and requires exact admitted-question coverage", () => {
  assert.equal(researchWorkflowCandidateSchema.safeParse(reportCandidate).success, true);

  const failed = {
    ...reportCandidate,
    findings: reportCandidate.findings.map((finding, index) =>
      index === 0 ? { ...finding, outcome: "failed" } : finding,
    ),
  };
  assert.equal(researchWorkflowCandidateSchema.safeParse(failed).success, false);

  const missing = {
    ...reportCandidate,
    findings: reportCandidate.findings.slice(0, 1),
  };
  const parsed = researchWorkflowCandidateSchema.parse(missing);
  assert.deepEqual(researchWorkflowCandidateFeedback(scope, parsed), [
    "Missing a finding for admitted question 10000000-0000-4000-8000-000000000005: What remains unknown?",
  ]);
});

void test("batched searches use stable child receipts, preserve result order, and expose no publication tool", async () => {
  const operations: Array<{ name: string; input: unknown; operationId: string }> = [];
  const services = {
    executeTool: async (
      name: ResearchAgentToolName,
      input: unknown,
      context: ResearchAgentToolContext,
    ) => {
      operations.push({ name, input, operationId: context.operationId });
      return await Promise.resolve({ query: (input as { query: string }).query });
    },
  } as unknown as ResearchAgentServices;
  const tools = createResearchWorkflowTools(services, scope);
  const search = testTool<{ queries: string[] }, Array<{ query: string }>>(tools.search_sources);

  const results = await search.execute(
    { queries: ["first focused query", "second focused query", "third focused query"] },
    { toolCallId: "native-tool-call-17" },
  );

  assert.deepEqual(results, [
    { query: "first focused query" },
    { query: "second focused query" },
    { query: "third focused query" },
  ]);
  assert.deepEqual(
    operations
      .map(({ input }) => input)
      .sort((left, right) =>
        (left as { query: string }).query.localeCompare((right as { query: string }).query),
      ),
    [
      { query: "second focused query" },
      { query: "first focused query" },
      { query: "third focused query" },
    ].sort((left, right) => left.query.localeCompare(right.query)),
  );
  assert.equal(new Set(operations.map(({ operationId }) => operationId)).size, 3);
  for (const [index, query] of [
    "first focused query",
    "second focused query",
    "third focused query",
  ].entries()) {
    const operation = operations.find(({ input }) => (input as { query: string }).query === query);

    assert.equal(
      operation?.operationId,
      await researchWorkflowOperationId([
        "research-workflow-v3-tool",
        scope.workspaceId,
        scope.runId,
        "native-tool-call-17",
        index,
      ]),
    );
  }
  assert.equal("publish_report" in tools, false);
});

void test("search and retrieval batches share one two-operation external concurrency bound", async () => {
  let active = 0;
  let maximumActive = 0;
  const services = {
    executeTool: async (_name: ResearchAgentToolName, input: unknown) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      active -= 1;

      return input;
    },
  } as unknown as ResearchAgentServices;
  const tools = createResearchWorkflowTools(services, scope);
  const search = testTool<{ queries: string[] }, unknown[]>(tools.search_sources);
  const retrieve = testTool<{ urls: string[] }, unknown[]>(tools.retrieve_sources);

  await Promise.all([
    search.execute(
      { queries: ["first search query", "second search query", "third search query"] },
      { toolCallId: "search-batch" },
    ),
    retrieve.execute(
      {
        urls: ["https://example.com/one", "https://example.com/two", "https://example.com/three"],
      },
      { toolCallId: "retrieve-batch" },
    ),
  ]);

  assert.equal(maximumActive, 2);
});

void test("evidence reads preserve offsets while withholding text beyond the cumulative budget", async () => {
  const services = {
    executeTool: () =>
      Promise.resolve({
        ok: true,
        source: { sourceId: "10000000-0000-4000-8000-000000000006" },
        startOffset: 10,
        endOffset: 16,
        nextOffset: null,
        truncated: false,
        totalLength: 20,
        text: "abcdef",
      }),
  } as unknown as ResearchAgentServices;
  const tools = createResearchWorkflowTools(services, scope, undefined, undefined, (text) =>
    Promise.resolve(text.slice(0, 3)),
  );
  const read = testTool<
    { reads: Array<{ sourceId: string; startOffset: number; limit: number }> },
    Array<{
      text: string;
      startOffset: number;
      endOffset: number;
      nextOffset: number;
      truncated: boolean;
      evidenceBudgetExhausted: boolean;
    }>
  >(tools.evidence_read);
  const results = await read.execute(
    {
      reads: [
        {
          sourceId: "10000000-0000-4000-8000-000000000006",
          startOffset: 10,
          limit: 100,
        },
      ],
    },
    { toolCallId: "bounded-read" },
  );

  assert.deepEqual(results[0], {
    ok: true,
    source: { sourceId: "10000000-0000-4000-8000-000000000006" },
    startOffset: 10,
    endOffset: 13,
    nextOffset: 13,
    truncated: true,
    totalLength: 20,
    text: "abc",
    evidenceBudgetExhausted: true,
  });
});
