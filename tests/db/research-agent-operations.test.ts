import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { researchPolicySchema } from "../../src/config/research";
import { pinResearchRunPolicy } from "../../src/config/research-runs";
import type { RequestResearchRun } from "../../src/contracts/research/runs";
import { createResearchAgentOperationsRepository } from "../../src/db/research/agent-operations";
import { publishResearchAgentReport } from "../../src/db/research/agent-publication";
import { createResearchRunsRepository } from "../../src/db/research/runs";
import { db, setupDatabase, teardownDatabase, workspace } from "./fixture";

const runs = createResearchRunsRepository(db);
const operations = createResearchAgentOperationsRepository(db);
const policy = pinResearchRunPolicy(
  researchPolicySchema.parse({
    version: "research-v1",
    promptVersion: "research-extract-v2",
    provider: "workers-ai",
    model: "isolated-research-agent-test-model",
    budgetId: randomUUID(),
    rateVersionId: randomUUID(),
  }),
);

async function activeRun() {
  const scope = await workspace();
  const input: RequestResearchRun = {
    workspaceId: scope.workspaceId,
    commandId: randomUUID(),
    question: "What evidence supports this claim?",
    subquestions: [],
    sourceUrls: ["https://example.org"],
    discoverSources: false,
  };
  const run = await runs.request(scope.principal, input, policy);
  const key = { workspaceId: scope.workspaceId, runId: run.id };
  assert.equal(await runs.claim(key), true);
  return { ...scope, run, key };
}

before(setupDatabase);
after(teardownDatabase);

void describe("research agent operation receipts", () => {
  void it("rolls back partial publication and replays the committed report receipt exactly", async () => {
    const fixture = await activeRun();
    const key = { ...fixture.key, operationId: randomUUID() };
    const work = await runs.loadWork(key);
    const question = work!.questions[0]!;
    const finding = {
      id: question.id,
      questionId: question.id,
      question: question.question,
      outcome: "insufficient-evidence" as const,
      statement: null,
      classification: null,
      explanation: "The available evidence does not answer this question.",
      citations: [],
    };
    const report = {
      version: "research-report-v1" as const,
      answer: "Evidence is insufficient.",
      quality: "insufficient-evidence" as const,
      findings: [finding],
      gaps: [finding.explanation],
    };
    await assert.rejects(
      publishResearchAgentReport(db, key, {
        ...report,
        findings: [finding, { ...finding, id: randomUUID(), questionId: randomUUID() }],
      }),
    );
    assert.equal(await operations.get(key), null);
    const afterFailure = await runs.loadWork(key);
    assert.equal(afterFailure!.status, "running");
    assert.equal(afterFailure!.findings.length, 0);

    const receipt = await publishResearchAgentReport(db, key, report);
    assert.equal(receipt.published, true);
    assert.equal((await runs.loadWork(key))!.status, "completed");
    assert.deepEqual(await publishResearchAgentReport(db, key, report), receipt);
    await assert.rejects(
      publishResearchAgentReport(db, key, { ...report, answer: "Changed payload" }),
    );
  });

  void it("claims once, rejects payload reuse, and keeps late receipts after cancellation", async () => {
    const fixture = await activeRun();
    const key = { ...fixture.key, operationId: randomUUID() };
    const payload = { model: "pinned-model", request: { prompt: "inspect evidence" } };
    await operations.prepare(key, { kind: "model", payload });
    await assert.rejects(
      operations.prepare(key, { kind: "model", payload: { ...payload, model: "other-model" } }),
      (error: { code?: string }) => error.code === "conflict",
    );

    const claims = await Promise.all([operations.claim(key), operations.claim(key)]);
    assert.equal(claims.filter((claim) => claim.status === "claimed").length, 1);
    assert.equal(claims.filter((claim) => claim.status === "blocked").length, 1);

    await runs.cancel(fixture.principal, fixture.workspaceId, fixture.run.id);
    const receipt = await operations.complete(key, {
      result: { text: "late response" },
      usage: { inputTokens: 30, outputTokens: 12 },
    });
    assert.equal(receipt?.state, "completed");
    assert.equal((await operations.claim(key)).status, "completed");
    assert.equal(await operations.markUsageSettled(key), true);
    assert.equal(await operations.markUsageSettled(key), false);
    assert.deepEqual(await operations.pendingSettlement(10), []);
  });

  void it("retains unknown outcomes as non-reclaimable until a late receipt arrives", async () => {
    const fixture = await activeRun();
    const key = { ...fixture.key, operationId: randomUUID() };
    await operations.prepare(key, {
      kind: "tool",
      payload: { toolCallId: randomUUID(), tool: "search_sources", query: "primary evidence" },
    });
    assert.equal((await operations.claim(key)).status, "claimed");
    assert.equal((await operations.markUncertain(key))?.state, "uncertain");
    assert.equal((await operations.claim(key)).status, "uncertain");
    assert.equal(
      (
        await operations.complete(key, {
          result: { candidates: [] },
          usage: { provider: "firecrawl", creditsUsed: 0, route: "search" },
        })
      )?.state,
      "completed",
    );
  });

  void it("rotates unsettled receipts so repeated failed batches cannot starve later work", async () => {
    const fixture = await activeRun();
    const keys = Array.from({ length: 3 }, () => ({
      ...fixture.key,
      operationId: randomUUID(),
    }));

    for (const key of keys) {
      await operations.prepare(key, {
        kind: "model",
        payload: { requestId: key.operationId },
      });
      assert.equal((await operations.claim(key)).status, "claimed");
      await operations.complete(key, {
        result: { responseId: key.operationId },
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    }

    const firstBatch = await operations.pendingSettlement(2);
    assert.equal(firstBatch.length, 2);

    const nextBatch = await operations.pendingSettlement(2);
    assert.equal(nextBatch.length, 2);
    assert.ok(
      nextBatch.some((receipt) => receipt.operationId === keys[2]?.operationId),
      "the third receipt must rotate into the next batch even when the first batch remains unsettled",
    );
  });
});
