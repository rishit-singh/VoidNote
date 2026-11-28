import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createResearchAgentServices } from "../../src/ai/research/agent-services";
import type { ResearchRunEnvironment } from "../../src/ai/research/runs/environment";
import { pinResearchRunPolicy } from "../../src/config/research-runs";
import { createInferenceRepository } from "../../src/db/inference";
import { inferenceBudgets, inferenceRates } from "../../src/db/inference-schema";
import { createResearchRunsRepository } from "../../src/db/research/runs";
import { db, setupDatabase, teardownDatabase, workspace } from "./fixture";

before(setupDatabase);
after(teardownDatabase);

void test("real service adapters revise draft findings, publish cited evidence, and replay the receipt", async () => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const url = new URL(connectionString);
  const env: ResearchRunEnvironment = {
    RESEARCH_ENABLED: "true",
    RESEARCH_AGENT_ENABLED: "true",
    HYPERDRIVE: {
      connectionString,
      host: url.hostname,
      ip: "127.0.0.1",
      port: Number(url.port || 5432),
      user: url.username,
      password: url.password,
      database: url.pathname.slice(1),
      connect() {
        throw new Error("This test uses the Postgres connection-string adapter.");
      },
    },
  };
  const member = await workspace();
  const runs = createResearchRunsRepository(db);
  const policy = pinResearchRunPolicy(
    {
      version: "research-v1",
      promptVersion: "research-extract-v2",
      provider: "workers-ai",
      model: "isolated-test-model",
      budgetId: randomUUID(),
      rateVersionId: randomUUID(),
    },
    "research-agent-v2",
  );
  const sourceUrl = "https://example.org/primary";
  const run = await runs.request(
    member.principal,
    {
      workspaceId: member.workspaceId,
      commandId: randomUUID(),
      question: "When did the program launch?",
      subquestions: [],
      sourceUrls: [sourceUrl],
      discoverSources: false,
    },
    policy,
  );
  const key = { workspaceId: member.workspaceId, runId: run.id };
  const services = createResearchAgentServices(env);
  assert.equal(await services.beginRun(key), true);
  const { scope } = await services.execution(key);
  await db.insert(inferenceRates).values({
    id: policy.rateVersionId,
    provider: "workers-ai",
    model: policy.model,
    currency: "USD",
    inputMicroUsdPerMillionTokens: 1_000_000,
    outputMicroUsdPerMillionTokens: 1_000_000,
  });
  await db.insert(inferenceBudgets).values({
    workspaceId: member.workspaceId,
    id: policy.budgetId,
    rateVersionId: policy.rateVersionId,
    limitMicroUsd: 100_000,
    approvedAt: new Date(),
  });
  const admission = { ...scope, requestId: randomUUID(), inputTokenBound: 100 };
  await services.admitModelRequest(admission, policy);
  const availability = await createInferenceRepository(db).getBudgetAvailability({
    workspaceId: member.workspaceId,
    budgetId: policy.budgetId,
  });
  assert.equal(availability?.reservedMicroUsd, 100 + policy.maxOutputTokens);
  await assert.rejects(services.admitModelRequest(admission, policy), /cannot be resubmitted/);
  const questionId = scope.questions[0]!.id;
  const draft = {
    questionId,
    outcome: "insufficient-evidence",
    statement: null,
    classification: null,
    explanation: "The launch date still needs primary evidence.",
    citations: [],
  };
  const recorded = await services.executeTool(
    "record_findings",
    { findings: [draft], gaps: ["Need a launch date."] },
    { ...scope, operationId: randomUUID() },
  );
  assert.deepEqual(recorded, { ok: true, recorded: 1, gaps: 1 });
  assert.equal((await runs.loadWork(key))!.findings.length, 0);

  const text = "The program launched on 12 November 2026.";
  const source = {
    id: randomUUID(),
    requestedUrl: sourceUrl,
    url: sourceUrl,
    retrievedAt: new Date().toISOString(),
    digest: createHash("sha256").update(text).digest("hex"),
    text,
  };
  assert.equal(await runs.saveSource(key, source), true);
  const report = {
    answer: text,
    quality: "answered",
    stopReason: "evidence-sufficient",
    gaps: [],
    findings: [
      {
        questionId,
        outcome: "supported",
        statement: text,
        classification: "direct-evidence",
        explanation: "The primary source states the launch date.",
        citations: [
          {
            sourceId: source.id,
            url: sourceUrl,
            retrievedAt: source.retrievedAt,
            startOffset: 0,
            endOffset: text.length,
            excerpt: text,
          },
        ],
      },
    ],
  };
  const operationId = randomUUID();
  const receipt = await services.publishReport(scope, report, operationId);
  assert.deepEqual(receipt, { published: true, receiptId: operationId });
  assert.deepEqual(await services.publishReport(scope, report, operationId), receipt);
  const saved = await runs.get(member.principal, member.workspaceId, run.id);
  assert.equal(saved.status, "completed");
  assert.equal(saved.report?.answer, text);
  assert.equal(saved.report?.findings[0]?.citations[0]?.excerpt, text);
});

void test("real service publishes an honest four-question report without retrieved evidence", async () => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const url = new URL(connectionString);
  const env: ResearchRunEnvironment = {
    RESEARCH_ENABLED: "true",
    RESEARCH_AGENT_ENABLED: "true",
    HYPERDRIVE: {
      connectionString,
      host: url.hostname,
      ip: "127.0.0.1",
      port: Number(url.port || 5432),
      user: url.username,
      password: url.password,
      database: url.pathname.slice(1),
      connect() {
        throw new Error("This test uses the Postgres connection-string adapter.");
      },
    },
  };
  const member = await workspace();
  const runs = createResearchRunsRepository(db);
  const policy = pinResearchRunPolicy(
    {
      version: "research-v1",
      promptVersion: "research-extract-v2",
      provider: "workers-ai",
      model: "isolated-test-model",
      budgetId: randomUUID(),
      rateVersionId: randomUUID(),
    },
    "research-agent-v2",
  );
  const run = await runs.request(
    member.principal,
    {
      workspaceId: member.workspaceId,
      commandId: randomUUID(),
      question: "Investigate the program status and evidence limits.",
      subquestions: [
        "What is the latest status?",
        "What evidence supports it?",
        "What remains uncertain?",
      ],
      sourceUrls: ["https://example.org/unavailable-primary"],
      discoverSources: false,
    },
    policy,
  );
  const key = { workspaceId: member.workspaceId, runId: run.id };
  const services = createResearchAgentServices(env);
  assert.equal(await services.beginRun(key), true);
  const { scope } = await services.execution(key);
  assert.equal(scope.questions.length, 4);

  const report = {
    answer: "The available evidence was insufficient to establish the requested facts.",
    quality: "insufficient-evidence" as const,
    stopReason: "insufficient-evidence" as const,
    gaps: ["The attempted source retrieval failed, so no supporting evidence is available."],
    findings: scope.questions.map((question) => ({
      questionId: question.id,
      outcome: "insufficient-evidence" as const,
      statement: null,
      classification: null,
      explanation: `No retrieved source established an answer for: ${question.question}`,
      citations: [],
    })),
  };
  const failedDraft = {
    ...report,
    findings: report.findings.map((finding, index) => ({
      ...finding,
      outcome: index < 3 ? ("failed" as const) : finding.outcome,
      explanation:
        index < 3
          ? "The source retrieval failed before this question could be established."
          : finding.explanation,
    })),
  };
  const rejected = await services.publishReport(scope, failedDraft, randomUUID());
  assert.deepEqual(rejected, {
    published: false,
    reason: "invalid-citations",
    feedback: "Unresolved questions require an explained insufficient-evidence finding.",
  });

  const operationId = randomUUID();

  assert.deepEqual(await services.publishReport(scope, report, operationId), {
    published: true,
    receiptId: operationId,
  });

  const saved = await runs.get(member.principal, member.workspaceId, run.id);
  assert.equal(saved.status, "completed");
  assert.equal(saved.report?.quality, "insufficient-evidence");
  assert.equal(saved.report?.findings.length, 4);
  assert.ok(saved.report?.findings.every((finding) => finding.citations.length === 0));
  assert.equal(saved.report?.gaps[0], report.gaps[0]);
});
