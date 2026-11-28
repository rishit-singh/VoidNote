import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { researchPolicySchema } from "../../src/config/research";
import { pinResearchRunPolicy } from "../../src/config/research-runs";
import type { ResearchRunDetail, RequestResearchRun } from "../../src/contracts/research/runs";
import { createResearchRunsRepository } from "../../src/db/research/runs";
import { createAssistantRepository } from "../../src/db/assistant";
import { applicationEvents, eventDeliveries } from "../../src/db/activity-schema";
import { researchRunCommands } from "../../src/db/research-runs-schema";
import { workspaceMemberships } from "../../src/db/schema";
import {
  db,
  note,
  person,
  repository as workspaceRepository,
  setupDatabase,
  sql,
  teardownDatabase,
  workspace,
} from "./fixture";

const runs = createResearchRunsRepository(db);

const directPolicy = pinResearchRunPolicy(
  researchPolicySchema.parse({
    version: "research-v1",
    promptVersion: "research-extract-v2",
    provider: "workers-ai",
    model: "isolated-research-test-model",
    budgetId: randomUUID(),
    rateVersionId: randomUUID(),
  }),
);

const discoveryPolicy = pinResearchRunPolicy(
  researchPolicySchema.parse({
    ...directPolicy,
    sourceProvider: "firecrawl",
    serviceBudgetId: randomUUID(),
    searchUnitBound: 10,
  }),
);

function request(
  workspaceId: string,
  overrides: Partial<RequestResearchRun> = {},
): RequestResearchRun {
  return {
    workspaceId,
    commandId: randomUUID(),
    question: "What evidence supports the requested claim?",
    subquestions: [],
    sourceUrls: ["https://example.org/evidence"],
    discoverSources: false,
    ...overrides,
  };
}

function report(
  answer: string,
  findings: ResearchRunDetail["findings"] = [],
): NonNullable<ResearchRunDetail["report"]> {
  return {
    version: "research-report-v1",
    answer,
    quality: findings.length ? "answered" : "insufficient-evidence",
    findings,
    gaps: [],
  };
}

async function acceptedRun(
  overrides: Partial<RequestResearchRun> = {},
  policy = directPolicy,
  existingScope?: Awaited<ReturnType<typeof workspace>>,
) {
  const scope = existingScope ?? (await workspace());
  const input = request(scope.workspaceId, overrides);
  const accepted = await runs.request(scope.principal, input, policy);
  return {
    ...scope,
    input,
    accepted,
    key: { workspaceId: scope.workspaceId, runId: accepted.id },
  };
}

before(setupDatabase);
after(teardownDatabase);

void describe("research-run repository persistence", () => {
  void it("replays exact command receipts and rejects command-ID payload reuse", async () => {
    const fixture = await acceptedRun();
    const replay = await runs.request(fixture.principal, fixture.input, null);

    assert.deepEqual(replay, fixture.accepted);
    await assert.rejects(
      runs.request(
        fixture.principal,
        { ...fixture.input, question: "A different question with the same command ID." },
        directPolicy,
      ),
      (error: { code?: string }) => error.code === "conflict",
    );

    const receipts = await db
      .select()
      .from(researchRunCommands)
      .where(eq(researchRunCommands.workspaceId, fixture.workspaceId));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.runId, fixture.accepted.id);
  });

  void it("reuses one active run for concurrent semantic requests with distinct command IDs", async () => {
    const scope = await workspace();
    const inputs = Array.from({ length: 8 }, () =>
      request(scope.workspaceId, {
        question: "  What evidence supports the requested claim?  ",
      }),
    );

    const accepted = await Promise.all(
      inputs.map((input) => runs.request(scope.principal, input, directPolicy)),
    );
    const runIds = new Set(accepted.map((run) => run.id));

    assert.equal(runIds.size, 1);
    const receipts = await db
      .select()
      .from(researchRunCommands)
      .where(eq(researchRunCommands.workspaceId, scope.workspaceId));
    assert.equal(receipts.length, inputs.length);
    assert.ok(receipts.every((receipt) => receipt.runId === accepted[0]?.id));
  });

  void it("supports person-free runs and keeps saved-source references run-private", async () => {
    const first = await acceptedRun();
    assert.equal(first.accepted.personId, null);
    const firstWork = await runs.loadWork(first.key);
    assert.equal(firstWork?.personName, null);

    const second = await acceptedRun(
      { question: "Can this run access another run's private source?" },
      directPolicy,
      first,
    );
    await runs.claim(first.key);
    await runs.claim(second.key);
    const sourceId = randomUUID();
    const retrievedAt = "2026-11-27T12:00:00.000Z";
    const sourceText = "A private saved source excerpt.";
    assert.equal(
      await runs.saveSource(first.key, {
        id: sourceId,
        requestedUrl: "https://example.org/evidence",
        url: "https://example.org/evidence",
        digest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        retrievedAt,
        text: sourceText,
      }),
      true,
    );

    const foreignCitation = {
      sourceId,
      url: "https://example.org/evidence",
      excerpt: sourceText,
      startOffset: 0,
      endOffset: sourceText.length,
      retrievedAt,
    };
    await assert.rejects(
      runs.finish(second.key, {
        status: "completed",
        report: report("This must not reference the other run's private source.", [
          {
            id: randomUUID(),
            questionId: randomUUID(),
            question: "Which source supports this?",
            outcome: "supported",
            statement: "A source-backed statement.",
            classification: "direct-evidence",
            explanation: "The text is explicitly present.",
            citations: [foreignCitation],
          },
        ]),
      }),
      /invalid source excerpt/i,
    );
    assert.equal(
      (await runs.get(second.principal, second.workspaceId, second.accepted.id)).status,
      "running",
    );
  });

  void it("reuses active work across later assistant requests and lists it in the requesting conversation", async () => {
    const scope = await workspace();
    const assistant = createAssistantRepository(db);
    const acceptedIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const thread = await assistant.openThread(
        scope.principal,
        scope.workspaceId,
        randomUUID(),
        null,
      );
      const turnId = randomUUID();
      await assistant.requestTurn(
        scope.principal,
        scope.workspaceId,
        thread.id,
        turnId,
        "Research the requested claim.",
        { version: 1, model: "fixture", maxSteps: 3 },
      );
      await assistant.beginTurn(scope.workspaceId, turnId);
      const accepted = await runs.request(
        scope.principal,
        request(scope.workspaceId),
        directPolicy,
        turnId,
      );
      acceptedIds.push(accepted.id);
      const tasks = await runs.list(scope.principal, scope.workspaceId, {
        threadId: thread.id,
        status: "active",
        limit: 6,
      });
      assert.ok(tasks.some((task) => task.id === accepted.id));
      await assistant.completeTurn(scope.workspaceId, turnId, {
        text: "Accepted.",
        tools: [],
        sources: [],
      });
    }
    assert.equal(new Set(acceptedIds).size, 1);
  });

  void it("validates assistant artifacts against the exact saved research run, source and URL", async () => {
    const fixture = await acceptedRun();
    await runs.claim(fixture.key);
    const sourceId = randomUUID();
    const url = "https://example.org/saved-evidence";
    await runs.saveSource(fixture.key, {
      id: sourceId,
      requestedUrl: url,
      url,
      text: "A preserved public source.",
      digest: "d".repeat(64),
      retrievedAt: new Date().toISOString(),
    });
    const assistant = createAssistantRepository(db);
    const source = {
      kind: "url" as const,
      id: sourceId,
      researchRunId: fixture.accepted.id,
      url,
      label: "Saved public evidence",
    };
    const input = {
      operationId: randomUUID(),
      kind: "file" as const,
      noteId: null,
      name: "Research evidence",
      mediaType: "text/markdown" as const,
      content: "A preserved public source.",
      sources: [source],
    };
    const saved = await assistant.createArtifact(fixture.principal, fixture.workspaceId, input);
    assert.deepEqual(saved.sources, [source]);
    for (const invalid of [
      { ...source, id: randomUUID() },
      { ...source, researchRunId: randomUUID() },
      { ...source, url: "https://example.org/other-evidence" },
    ]) {
      await assert.rejects(
        assistant.createArtifact(fixture.principal, fixture.workspaceId, {
          ...input,
          operationId: randomUUID(),
          sources: [invalid],
        }),
        /research evidence is unavailable/i,
      );
    }
    const other = await workspace();
    await assert.rejects(
      assistant.createArtifact(other.principal, other.workspaceId, {
        ...input,
        operationId: randomUUID(),
      }),
      /research evidence is unavailable/i,
    );
  });

  void it("bounds reusable snapshots by age, actor scope and bytes", async () => {
    const fixture = await acceptedRun();
    await runs.claim(fixture.key);
    const freshId = randomUUID();
    for (const [id, age, digest] of [
      [freshId, 0, "e"],
      [randomUUID(), 10, "f"],
    ] as const) {
      const url = `https://example.org/snapshot/${id}`;
      await runs.saveSource(fixture.key, {
        id,
        requestedUrl: url,
        url,
        text: "A bounded public evidence snapshot.",
        digest: digest.repeat(64),
        retrievedAt: new Date(Date.now() - age * 86_400_000).toISOString(),
      });
    }
    await runs.finish(fixture.key, { status: "completed", report: report("Saved snapshots") });
    const filter = { maxSnapshotAgeDays: 7, maxBytes: 4000 };
    const fresh = await runs.reusableSources(fixture.principal, fixture.workspaceId, filter);
    assert.deepEqual(
      fresh.map((source) => source.id),
      [freshId],
    );
    assert.deepEqual(
      await runs.reusableSources(fixture.principal, fixture.workspaceId, {
        ...filter,
        maxBytes: 1,
      }),
      [],
    );
    const other = await workspace();
    await assert.rejects(
      runs.reusableSources(other.principal, fixture.workspaceId, filter),
      (error: { code?: string }) => error.code === "forbidden",
    );
    await db.insert(workspaceMemberships).values({
      workspaceId: fixture.workspaceId,
      userId: other.principal.id,
      role: "member",
    });
    assert.deepEqual(await runs.reusableSources(other.principal, fixture.workspaceId, filter), []);
  });

  void it("retains known discovery usage when cancellation commits before provider settlement", async () => {
    const fixture = await acceptedRun({ discoverSources: true, sourceUrls: [] }, discoveryPolicy);
    assert.equal(await runs.claim(fixture.key), true);
    const work = await runs.loadWork(fixture.key);
    const discovery = work?.discoveries[0];
    assert.ok(discovery);
    assert.deepEqual(await runs.claimDiscovery(fixture.key, discovery.ordinal, "primary query"), {
      operationId: discovery.operationId,
    });

    const cancelled = await runs.cancel(
      fixture.principal,
      fixture.workspaceId,
      fixture.accepted.id,
    );
    assert.equal(cancelled.status, "cancelled");
    assert.equal(await runs.markDiscoveryCompleted(fixture.key, discovery.ordinal, 7, []), true);

    const pending = await runs.pendingDiscoverySettlement(50);
    assert.ok(
      pending.some(
        (entry) => entry.operationId === discovery.operationId && entry.creditsUsed === 7,
      ),
    );
    assert.equal(
      (await runs.get(fixture.principal, fixture.workspaceId, fixture.accepted.id)).status,
      "cancelled",
    );
  });

  void it("keeps exact inference receipts recoverable after cancellation without reopening the run", async () => {
    const fixture = await acceptedRun();
    await runs.claim(fixture.key);
    const work = await runs.loadWork(fixture.key);
    const question = work!.questions[0]!;
    const claim = await runs.claimQuestionInference(fixture.key, question.id);
    assert.deepEqual(claim, { id: question.id, operationId: question.operationId });
    await runs.cancel(fixture.principal, fixture.workspaceId, fixture.accepted.id);
    const usage = { inputTokens: 25, outputTokens: 10 };
    assert.equal(
      await runs.saveInferenceResult(
        fixture.key,
        question.id,
        { outcome: "insufficient-evidence" },
        usage,
      ),
      true,
    );
    const pending = await runs.pendingInferenceSettlement(50);
    assert.ok(
      pending.some(
        (entry) => entry.operationId === question.operationId && entry.usage?.inputTokens === 25,
      ),
    );
    assert.equal(await runs.claimQuestionInference(fixture.key, question.id), null);
    await runs.settleQuestionInference(fixture.key, question.id);
    assert.equal(
      (await runs.pendingInferenceSettlement(50)).some(
        (entry) => entry.operationId === question.operationId,
      ),
      false,
    );
    assert.equal(
      (await runs.get(fixture.principal, fixture.workspaceId, fixture.accepted.id)).status,
      "cancelled",
    );
  });

  void it("does not silently substitute an edited person identity during research", async () => {
    const scope = await workspace();
    const profile = await workspaceRepository.savePerson(
      scope.principal,
      scope.workspaceId,
      person(),
    );
    const fixture = await acceptedRun({ personId: profile.id }, directPolicy, scope);
    await runs.claim(fixture.key);
    await workspaceRepository.savePerson(scope.principal, scope.workspaceId, {
      commandId: randomUUID(),
      id: profile.id,
      expectedRevision: profile.revision,
      content: { displayName: "Different identity", description: "" },
    });
    assert.equal(await runs.assertRunnable(fixture.key), false);
    assert.equal(
      await runs.finish(fixture.key, { status: "completed", report: report("Stale identity") }),
      false,
    );
    assert.equal(
      await runs.finish(fixture.key, { status: "failed", error: "identity_changed" }),
      true,
    );
    assert.equal(
      (await runs.get(scope.principal, scope.workspaceId, fixture.accepted.id)).status,
      "failed",
    );
  });

  void it("rechecks revoked membership and deleted-note fences at publication while retaining usage", async () => {
    for (const fence of ["membership", "note"] as const) {
      const scope = await workspace();
      const savedNote = await workspaceRepository.saveNote(
        scope.principal,
        scope.workspaceId,
        note(),
      );
      const fixture = await acceptedRun(
        {
          noteId: savedNote.id,
          discoverSources: true,
          sourceUrls: [],
        },
        discoveryPolicy,
        scope,
      );
      assert.equal(await runs.claim(fixture.key), true);
      const work = await runs.loadWork(fixture.key);
      const discovery = work?.discoveries[0];
      assert.ok(discovery);
      assert.deepEqual(await runs.claimDiscovery(fixture.key, discovery.ordinal, "primary query"), {
        operationId: discovery.operationId,
      });
      assert.equal(await runs.markDiscoveryCompleted(fixture.key, discovery.ordinal, 5, []), true);

      if (fence === "membership") {
        await db
          .update(workspaceMemberships)
          .set({ revokedAt: new Date() })
          .where(eq(workspaceMemberships.userId, scope.principal.id));
      } else {
        await workspaceRepository.deleteNote(scope.principal, scope.workspaceId, {
          commandId: randomUUID(),
          id: savedNote.id,
          expectedRevision: savedNote.revision,
        });
      }

      assert.equal(
        await runs.finish(fixture.key, {
          status: "completed",
          report: report("Fenced publication"),
        }),
        false,
      );
      const pending = await runs.pendingDiscoverySettlement(50);
      assert.ok(
        pending.some(
          (entry) => entry.operationId === discovery.operationId && entry.creditsUsed === 5,
        ),
      );
    }
  });

  void it("commits one immutable report and its notification event atomically", async () => {
    const fixture = await acceptedRun();
    assert.equal(await runs.claim(fixture.key), true);

    const publishedReport = report("A final, source-grounded answer.");
    const functionName = `test_research_event_failure_${randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(`create function public.${functionName}() returns trigger
      language plpgsql as $$
      begin
        if NEW.workspace_id = '${fixture.workspaceId}'::uuid then
          raise exception 'injected research notification failure';
        end if;
        return NEW;
      end $$`);
    await sql.unsafe(
      `create trigger ${functionName} before insert on public.event_deliveries
       for each row execute function public.${functionName}()`,
    );
    try {
      await assert.rejects(
        runs.finish(fixture.key, { status: "completed", report: publishedReport }),
        (error: unknown) =>
          error instanceof Error &&
          String(error.cause).includes("injected research notification failure"),
      );
    } finally {
      await sql.unsafe(`drop trigger if exists ${functionName} on public.event_deliveries`);
      await sql.unsafe(`drop function if exists public.${functionName}()`);
    }

    const afterFailedPublish = await runs.get(
      fixture.principal,
      fixture.workspaceId,
      fixture.accepted.id,
    );
    assert.equal(afterFailedPublish.status, "running");
    assert.equal(afterFailedPublish.report, null);
    assert.equal(
      (
        await db
          .select()
          .from(applicationEvents)
          .where(eq(applicationEvents.workspaceId, fixture.workspaceId))
      ).length,
      0,
    );

    assert.equal(
      await runs.finish(fixture.key, { status: "completed", report: publishedReport }),
      true,
    );
    assert.equal(
      await runs.finish(fixture.key, {
        status: "completed",
        report: report("A conflicting second publication."),
      }),
      false,
    );

    const stored = await runs.get(fixture.principal, fixture.workspaceId, fixture.accepted.id);
    assert.deepEqual(stored.report, publishedReport);

    const events = await db
      .select()
      .from(applicationEvents)
      .where(eq(applicationEvents.workspaceId, fixture.workspaceId));
    const deliveries = await db
      .select()
      .from(eventDeliveries)
      .where(eq(eventDeliveries.workspaceId, fixture.workspaceId));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.id, fixture.accepted.id);
    assert.equal(events[0]?.type, "research.completed");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.eventId, fixture.accepted.id);
    assert.equal(deliveries[0]?.subscriber, "activity-v1");
  });

  void it("returns distinct matching runs when one run has multiple matching findings", async () => {
    const first = await acceptedRun({
      question: "A cardinality regression in saved research.",
      subquestions: [
        "How many duplicate matching findings are present?",
        "Which second statement matches the lookup?",
      ],
    });
    const second = await acceptedRun(
      {
        question: "A separate saved run matching the lookup.",
      },
      directPolicy,
      first,
    );

    for (const fixture of [first, second]) {
      assert.equal(await runs.claim(fixture.key), true);
      const work = await runs.loadWork(fixture.key);
      assert.ok(work);
      const matchingFindings = work.questions.map((question, index) => ({
        id: randomUUID(),
        questionId: question.id,
        question: question.question,
        outcome: "supported" as const,
        statement: `Distinctive cardinality phrase ${index}.`,
        classification: "direct-evidence" as const,
        explanation: "A saved statement matches the test query.",
        citations: [],
      }));
      for (const finding of matchingFindings) {
        assert.equal(
          await runs.saveQuestionFinding(fixture.key, finding.questionId, finding),
          true,
        );
      }
      assert.equal(
        await runs.finish(fixture.key, {
          status: "completed",
          report: report("Saved answer.", matchingFindings),
        }),
        true,
      );
    }

    const results = await runs.lookup(first.principal, first.workspaceId, {
      personIds: [],
      query: "distinctive cardinality phrase",
      limit: 2,
      includeActiveRuns: false,
    });
    assert.equal(results.length, 2);
    assert.deepEqual(
      new Set(results.map((candidate) => candidate.runId)),
      new Set([first.accepted.id, second.accepted.id]),
    );
  });
});
