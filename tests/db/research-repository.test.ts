import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { researchPolicySchema } from "../../src/config/research";
import type { RequestResearch, ResearchBatch, ResearchFinding } from "../../src/contracts/research";
import { WorkspaceError } from "../../src/contracts/workspace";
import { createAssistantRepository } from "../../src/db/assistant";
import { createContactRepository } from "../../src/db/contacts";
import { createResearchRepository } from "../../src/db/research";
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

const repo = createResearchRepository(db);
const contacts = createContactRepository(db);
const assistant = createAssistantRepository(db);
const policy = researchPolicySchema.parse({
  version: "research-v1",
  promptVersion: "research-extract-v1",
  provider: "workers-ai",
  model: "isolated-test-model",
  budgetId: randomUUID(),
  rateVersionId: randomUUID(),
});

async function requestFixture(count = 1) {
  const scope = await workspace();
  const selected = [];
  for (let i = 0; i < count; i++) {
    const profile = await workspaceRepository.savePerson(
      scope.principal,
      scope.workspaceId,
      person(),
    );
    selected.push({
      personId: profile.id,
      expectedProfileRevision: profile.revision,
      requestedFacts: [{ key: "role", question: "What is this person's professional role?" }],
      sourceUrls: ["https://public-source.org/person"],
    });
  }
  const input: RequestResearch = {
    workspaceId: scope.workspaceId,
    requestId: randomUUID(),
    people: selected,
  };
  const key = {
    workspaceId: scope.workspaceId,
    batchId: input.requestId,
    personId: selected[0]!.personId,
    generation: 1,
  };
  return { ...scope, input, key };
}

async function assistantRequestFixture(running = true) {
  const fixture = await requestFixture();
  const savedNote = await workspaceRepository.saveNote(
    fixture.principal,
    fixture.workspaceId,
    note(),
  );
  const thread = await assistant.openThread(
    fixture.principal,
    fixture.workspaceId,
    randomUUID(),
    savedNote.id,
  );
  const turnId = randomUUID();
  await assistant.requestTurn(
    fixture.principal,
    fixture.workspaceId,
    thread.id,
    turnId,
    "Research this selected person.",
    { version: 1, model: "test-only", maxSteps: 1 },
  );
  if (running) {
    assert.equal(await assistant.beginTurn(fixture.workspaceId, turnId), true);
  }
  return { ...fixture, thread, context: { turnId } };
}

async function waitForBlockedBackend(blockerPid: number) {
  const deadline = Date.now() + 2000;
  do {
    const [waiter] = await sql<{ pid: number }[]>`
      select pid from pg_stat_activity where datname = current_database()
      and ${blockerPid}::int = any(pg_blocking_pids(pid))`;
    if (waiter) return waiter.pid;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail("Expected research/cancellation lock contention was not observed.");
}

const finding: ResearchFinding = {
  key: "role",
  question: "What is this person's professional role?",
  status: "not-found",
  answer: null,
  explanation: "The bounded supplied source does not establish the role.",
  citations: [],
};

void describe("research repository recovery and authorization", () => {
  before(setupDatabase);
  after(teardownDatabase);

  void it("rejects direct-only discovery before acceptance but preserves prior exact receipts", async () => {
    const fixture = await requestFixture();
    const input: RequestResearch = {
      ...fixture.input,
      people: fixture.input.people.map((item) => ({ ...item, discoverSources: true })),
    };
    await assert.rejects(repo.request(fixture.principal, input, policy), /discovery/i);
    await assert.rejects(
      repo.get(fixture.principal, fixture.workspaceId, input.requestId),
      /not found/i,
    );
    const discoveryPolicy = researchPolicySchema.parse({
      ...policy,
      sourceProvider: "firecrawl",
      serviceBudgetId: randomUUID(),
      searchUnitBound: 10,
    });
    const accepted = await repo.request(fixture.principal, input, discoveryPolicy);
    const replay = await repo.request(fixture.principal, input, policy);
    assert.equal(replay.id, accepted.id);
  });
  void it("accepts concurrent exact retries once and refuses payload reuse", async () => {
    const { principal, input } = await requestFixture(2);
    const [first, replay] = await Promise.all([
      repo.request(principal, input, policy),
      repo.request(principal, input, policy),
    ]);
    assert.deepEqual(replay, first);
    assert.equal(first.items.length, 2);
    assert.equal(first.id, input.requestId);
    assert.deepEqual(await repo.request(principal, input, null), first);
    await assert.rejects(
      repo.request(
        principal,
        {
          ...input,
          people: input.people.map((item) => ({
            ...item,
            requestedFacts: [{ key: "different", question: "What is the organization?" }],
          })),
        },
        policy,
      ),
      /different payload/,
    );
  });

  void it("authorizes the entire batch atomically and isolates status/results", async () => {
    const owner = await requestFixture();
    const other = await requestFixture();
    await assert.rejects(
      repo.request(
        owner.principal,
        {
          ...owner.input,
          people: [...owner.input.people, other.input.people[0]!],
        },
        policy,
      ),
      /changed or was deleted/,
    );
    await assert.rejects(
      repo.get(owner.principal, owner.workspaceId, owner.input.requestId),
      /not found/,
    );
    await repo.request(owner.principal, owner.input, policy);
    await assert.rejects(
      repo.get(other.principal, owner.workspaceId, owner.input.requestId),
      /access denied/,
    );
    await assert.rejects(
      repo.cancel(other.principal, owner.workspaceId, owner.input.requestId),
      /access denied/,
    );
  });

  void it("preserves fact identities on an exact per-item retry and leaves siblings unchanged", async () => {
    const { principal, input, key } = await requestFixture(2);
    await repo.request(principal, input, policy);
    const initial = await repo.execution.load(key);
    assert.ok(initial);
    await repo.execution.finish(key, "failed", "Source failed before inference.");
    const retry = {
      workspaceId: key.workspaceId,
      batchId: key.batchId,
      personId: key.personId,
      expectedGeneration: 1,
      requestId: randomUUID(),
    };
    const [accepted, replay] = await Promise.all([
      repo.retry(principal, retry),
      repo.retry(principal, retry),
    ]);
    assert.deepEqual(accepted, replay);
    assert.equal(accepted.items.find((item) => item.personId === key.personId)!.generation, 2);
    assert.equal(accepted.items.find((item) => item.personId !== key.personId)!.generation, 1);
    assert.equal(await repo.execution.load(key), null);
    const resumed = await repo.execution.load({ ...key, generation: 2 });
    assert.deepEqual(resumed!.facts, initial.facts);
    await assert.rejects(
      repo.retry(principal, { ...retry, requestId: randomUUID() }),
      /cannot be retried safely/,
    );
  });

  void it("blocks retries of an uncertain paid extraction even when runtime records failure", async () => {
    const { principal, input, key } = await requestFixture();
    await repo.request(principal, input, policy);
    assert.equal(await repo.execution.claimFact(key, "role"), true);
    assert.equal(await repo.execution.claimFact(key, "role"), false);
    await repo.execution.finish(key, "failed", "Runtime interrupted.");
    const batch = await repo.get(principal, key.workspaceId, key.batchId);
    assert.equal(batch.items[0]!.retryable, false);
    await assert.rejects(
      repo.retry(principal, {
        workspaceId: key.workspaceId,
        batchId: key.batchId,
        personId: key.personId,
        expectedGeneration: 1,
        requestId: randomUUID(),
      }),
      /cannot be retried safely/,
    );
  });

  void it("cancellation fences late results and leaves durable cleanup pending until acknowledged", async () => {
    const { principal, input, key } = await requestFixture();
    await repo.request(principal, input, policy);
    await repo.execution.start(key);
    await repo.execution.claimFact(key, "role");
    const batch = await repo.cancel(principal, key.workspaceId, key.batchId);
    assert.equal(batch.status, "cancelled");
    assert.equal(await repo.execution.saveFinding(key, "role", finding, null), false);
    assert.equal(await repo.execution.load(key), null);
    const pending = await repo.pendingDispatch(100);
    assert.ok(pending.some((item) => item.batchId === key.batchId && item.status === "cancelled"));
    await repo.acknowledgeCleanup(key);
    assert.ok(!(await repo.pendingDispatch(100)).some((item) => item.batchId === key.batchId));
    assert.equal((await repo.request(principal, input, null)).status, "cancelled");
  });

  void it("pins professional fields and fences publication after contact details change", async () => {
    const { principal, input, key } = await requestFixture();
    const details = await contacts.save(principal, {
      workspaceId: key.workspaceId,
      personId: key.personId,
      operationId: randomUUID(),
      expectedRevision: 0,
      fields: { organization: "Analytical Engines", role: "Researcher", links: [] },
    });
    input.people[0]!.expectedContactRevision = details.revision;
    await repo.request(principal, input, policy);
    const execution = await repo.execution.load(key);
    assert.equal(execution!.person.professional.organization, "Analytical Engines");
    assert.equal(execution!.person.professional.revision, details.revision);
    await repo.execution.claimFact(key, "role");
    await contacts.save(principal, {
      workspaceId: key.workspaceId,
      personId: key.personId,
      operationId: randomUUID(),
      expectedRevision: details.revision,
      fields: { organization: "New employer", role: "Director", links: [] },
    });
    assert.equal(await repo.execution.saveFinding(key, "role", finding, null), false);
    assert.equal(
      await repo.execution.saveRejectedFailure(key, "role", "unknown_source", {
        inputTokens: 42,
        outputTokens: 17,
      }),
      true,
    );
    assert.equal(
      (await repo.pendingUsage()).find((item) => item.batchId === key.batchId)?.factKey,
      "role",
    );
    const after = await repo.get(principal, key.workspaceId, key.batchId);
    assert.equal(after.items[0]!.status, "needs-input");
    assert.deepEqual(after.items[0]!.findings, []);
  });

  void it("retains known usage for reconciliation after cancellation without replaying extraction", async () => {
    const { principal, input, key } = await requestFixture();
    await repo.request(principal, input, policy);
    await repo.execution.claimFact(key, "role");
    const usage = { inputTokens: 42, outputTokens: 17 };
    await repo.execution.saveFinding(key, "role", finding, usage);
    await repo.cancel(principal, key.workspaceId, key.batchId);
    const receipt = (await repo.pendingUsage()).find((item) => item.batchId === key.batchId);
    assert.ok(receipt);
    assert.deepEqual(receipt.usage, usage);
    await repo.execution.markSettled(key, "role");
    assert.ok(!(await repo.pendingUsage()).some((item) => item.batchId === key.batchId));
    const batch = await repo.get(principal, key.workspaceId, key.batchId);
    assert.equal(batch.status, "cancelled");
    assert.deepEqual(batch.items[0]!.findings, [finding]);
  });

  void it("durably records rejected output usage and reconciles it after cancellation", async () => {
    const { principal, input, key } = await requestFixture();
    await repo.request(principal, input, policy);
    await repo.execution.claimFact(key, "role");
    const usage = { inputTokens: 66, outputTokens: 19 };
    await repo.cancel(principal, key.workspaceId, key.batchId);
    await assert.rejects(async () => {
      assert.equal(
        await repo.execution.saveRejectedFailure(key, "role", "unknown_source", usage),
        true,
      );
      throw new Error("simulated lost database acknowledgement");
    }, /simulated lost database acknowledgement/);
    assert.equal(await repo.execution.claimFact(key, "role"), false);

    const [stored] = await sql<{ facts: unknown }[]>`
      select facts from public.research_items
      where workspace_id = ${key.workspaceId}
        and batch_id = ${key.batchId}
        and person_id = ${key.personId}
    `;
    assert.ok(Array.isArray(stored?.facts));
    const [checkpoint] = stored.facts as Array<{
      state: string;
      failureCode?: string | null;
      usage: unknown;
      finding: unknown;
      settled: boolean;
    }>;
    assert.ok(checkpoint);
    assert.equal(checkpoint.state, "rejected");
    assert.equal(checkpoint.failureCode, "unknown_source");
    assert.deepEqual(checkpoint.usage, usage);
    assert.equal(checkpoint.finding, null);
    assert.equal(checkpoint.settled, false);

    const pending = (await repo.pendingUsage()).find((item) => item.batchId === key.batchId);
    assert.ok(pending);
    assert.deepEqual(pending.usage, usage);
    await repo.execution.markSettled(key, "role");
    assert.ok(!(await repo.pendingUsage()).some((item) => item.batchId === key.batchId));

    const batch = await repo.get(principal, key.workspaceId, key.batchId);
    assert.equal(batch.status, "cancelled");
    assert.deepEqual(batch.items[0]!.findings, []);
  });

  void it("deleted people cannot receive late generated facts", async () => {
    const { principal, input, key } = await requestFixture();
    await repo.request(principal, input, policy);
    await repo.execution.claimFact(key, "role");
    await workspaceRepository.deletePerson(principal, key.workspaceId, {
      commandId: randomUUID(),
      id: key.personId,
      expectedRevision: 1,
    });
    assert.equal(await repo.execution.saveFinding(key, "role", finding, null), false);
    assert.equal(
      (await repo.get(principal, key.workspaceId, key.batchId)).items[0]!.status,
      "needs-input",
    );
  });

  void it("does not persist rejected diagnostics after the submitting account loses workspace access", async () => {
    const { principal, workspaceId, input, key } = await requestFixture();
    await repo.request(principal, input, policy);
    await repo.execution.claimFact(key, "role");
    await sql`
      update public.workspace_memberships
      set revoked_at = now()
      where workspace_id = ${workspaceId} and user_id = ${principal.id}
    `;

    assert.equal(
      await repo.execution.saveRejectedFailure(key, "role", "unknown_source", {
        inputTokens: 42,
        outputTokens: 17,
      }),
      false,
    );
  });

  void it("rejects new research from queued/cancelled turns and another member's turn", async () => {
    const fixture = await assistantRequestFixture(false);
    const { principal, workspaceId, input, context } = fixture;
    await assert.rejects(repo.request(principal, input, policy, context), /no longer running/);
    await assistant.cancelTurn(principal, workspaceId, context.turnId);
    await assert.rejects(repo.request(principal, input, policy, context), /no longer running/);
    await assert.rejects(repo.get(principal, workspaceId, input.requestId), /not found/);

    const peer = await workspace();
    await db.insert(workspaceMemberships).values({ workspaceId, userId: peer.principal.id });
    await assert.rejects(
      repo.request(peer.principal, { ...input, requestId: randomUUID() }, policy, context),
      /turn not found/,
    );
  });

  void it("replays accepted research after turn cancellation but cannot change its turn provenance", async () => {
    const { principal, workspaceId, input, context } = await assistantRequestFixture();
    const accepted = await repo.request(principal, input, policy, context);
    await assistant.cancelTurn(principal, workspaceId, context.turnId);
    assert.deepEqual(await repo.request(principal, input, null, context), accepted);
    await assert.rejects(repo.request(principal, input, null), /different payload/);

    const nextThread = await assistant.openThread(principal, workspaceId, randomUUID(), null);
    const nextTurnId = randomUUID();
    await assistant.requestTurn(
      principal,
      workspaceId,
      nextThread.id,
      nextTurnId,
      "Different origin.",
      { version: 1, model: "test-only" },
    );
    await assistant.beginTurn(workspaceId, nextTurnId);
    await assert.rejects(
      repo.request(principal, input, policy, { turnId: nextTurnId }),
      /different payload/,
    );
  });

  void it("rechecks turn status after a concurrent cancellation wins the thread lock", async () => {
    const { principal, workspaceId, input, context, thread } = await assistantRequestFixture();
    let outcome: Promise<PromiseSettledResult<ResearchBatch>[]> = Promise.resolve([]);
    await sql
      .begin(async (holder) => {
        const [lock] = await holder<{ pid: number }[]>`
        select pg_backend_pid() as pid from assistant_threads
        where workspace_id = ${workspaceId} and id = ${thread.id} for update`;
        assert.ok(lock);

        outcome = Promise.allSettled([repo.request(principal, input, policy, context)]);
        await waitForBlockedBackend(lock.pid);
        // Same serialization boundary as cancelTurn: update the turn while its
        // thread is exclusively locked, then release the waiting research request.
        await holder`
        update assistant_turns set status = 'cancelled'
        where workspace_id = ${workspaceId} and id = ${context.turnId}`;
      })
      .finally(async () => {
        await outcome;
      });

    const result = (await outcome)[0];
    assert.ok(result);
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof WorkspaceError);
      assert.equal(result.reason.code, "conflict");
    }
    await assert.rejects(repo.get(principal, workspaceId, input.requestId), /not found/);
  });

  void it("holds turn authority through acceptance commit when research wins cancellation", async () => {
    const { principal, workspaceId, input, context, key } = await assistantRequestFixture();
    let accepted: Promise<PromiseSettledResult<ResearchBatch>[]> = Promise.resolve([]);
    let cancelled: Promise<PromiseSettledResult<unknown>[]> = Promise.resolve([]);
    await sql
      .begin(async (holder) => {
        const [lock] = await holder<{ pid: number }[]>`
        select pg_backend_pid() as pid from people
        where workspace_id = ${workspaceId} and id = ${key.personId} for update`;
        assert.ok(lock);

        accepted = Promise.allSettled([repo.request(principal, input, policy, context)]);
        const acceptingPid = await waitForBlockedBackend(lock.pid);
        cancelled = Promise.allSettled([
          assistant.cancelTurn(principal, workspaceId, context.turnId),
        ]);
        await waitForBlockedBackend(acceptingPid);
      })
      .finally(async () => {
        await Promise.all([accepted, cancelled]);
      });

    const result = (await accepted)[0];
    assert.ok(result);
    assert.equal(result.status, "fulfilled");
    assert.equal((await cancelled)[0]?.status, "fulfilled");
    if (result.status === "fulfilled") {
      assert.deepEqual(await repo.request(principal, input, null, context), result.value);
    }
  });
});
