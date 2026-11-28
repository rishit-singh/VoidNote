import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";

import { and, eq, inArray, sql as expression } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";

import type { AssistantSource } from "../../src/contracts/assistant";
import {
  buildConversationSummaryPrompt,
  type ConversationSummaryPolicy,
  conversationSummaryPolicySchema,
} from "../../src/contracts/conversation-summaries";
import { WorkspaceError } from "../../src/contracts/workspace";
import { createAssistantRepository } from "../../src/db/assistant";
import {
  assistantMemories,
  assistantMessages,
  assistantTurns,
} from "../../src/db/assistant-schema";
import { createContactRepository } from "../../src/db/contacts";
import { createConversationSummaryRepository, type Key } from "../../src/db/conversation-summaries";
import { createInferenceRepository } from "../../src/db/inference";
import { inferenceBudgets, inferenceRates } from "../../src/db/inference-schema";
import {
  conversationSummaryJobs,
  conversationSummaryScans,
} from "../../src/db/conversation-summary-schema";
import { workspaceMemberships, workspaces } from "../../src/db/schema";
import * as schema from "../../src/db/schema";
import {
  db,
  note,
  person,
  repository,
  setupDatabase,
  sql,
  teardownDatabase,
  workspace,
} from "./fixture";

before(setupDatabase);
after(teardownDatabase);

const assistant = createAssistantRepository(db);
const summaries = createConversationSummaryRepository(db);
const policy = conversationSummaryPolicySchema.parse({
  version: "conversation-summary-v1",
  promptVersion: "conversation-summary-v1",
  model: "test-only",
  budgetId: randomUUID(),
  rateVersionId: randomUUID(),
});
const fixtureWorkspaces: string[] = [];
const code = (expected: WorkspaceError["code"]) => (error: unknown) =>
  error instanceof WorkspaceError && error.code === expected;

// These fixture rows belong exclusively to this isolated suite. Retire each
// test's work so later bounded global dispatcher scans exercise only their cases.
afterEach(async () => {
  const ids = fixtureWorkspaces.splice(0);
  if (ids.length === 0) return;
  await db
    .update(conversationSummaryJobs)
    .set({
      status: "failed",
      error: "Fixture complete",
      completedAt: new Date(),
    })
    .where(
      and(
        inArray(conversationSummaryJobs.workspaceId, ids),
        inArray(conversationSummaryJobs.status, ["queued", "running"]),
      ),
    );
  await db.update(workspaces).set({ deletedAt: new Date() }).where(inArray(workspaces.id, ids));
});

async function fixture() {
  const owner = await workspace();
  fixtureWorkspaces.push(owner.workspaceId);
  const saved = await repository.saveNote(owner.principal, owner.workspaceId, note());
  const thread = await assistant.openThread(
    owner.principal,
    owner.workspaceId,
    randomUUID(),
    saved.id,
  );
  return { ...owner, note: saved, thread };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function messages(
  f: Fixture,
  count: number,
  options: { at?: Date; sources?: AssistantSource[]; text?: string } = {},
) {
  const at = options.at ?? new Date(Date.now() - policy.idleMs - 60_000);
  const [current] = await db
    .select({
      sequence: expression<number>`coalesce(max(${assistantMessages.sequence}), 0)::int`,
    })
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.workspaceId, f.workspaceId),
        eq(assistantMessages.threadId, f.thread.id),
      ),
    );
  const offset = current?.sequence ?? 0;
  const turns: (typeof assistantTurns.$inferInsert)[] = [];
  const rows: (typeof assistantMessages.$inferInsert)[] = [];
  for (let index = 0; index < count; index += 2) {
    const turnId = randomUUID();
    turns.push({
      workspaceId: f.workspaceId,
      threadId: f.thread.id,
      id: turnId,
      actorId: f.principal.id,
      status: index + 1 < count ? "succeeded" : "failed",
      text: "Fixture question",
      policy: { fixture: true },
      fingerprint: "0".repeat(64),
      createdAt: at,
      updatedAt: at,
    });
    for (let roleOffset = 0; roleOffset < 2 && index + roleOffset < count; roleOffset += 1) {
      const sequence = offset + index + roleOffset + 1;
      const role = roleOffset === 0 ? "user" : "assistant";
      rows.push({
        workspaceId: f.workspaceId,
        threadId: f.thread.id,
        turnId,
        id: randomUUID(),
        role,
        sequence,
        text: options.text ?? `Historical ${role} message ${sequence}`,
        sources: role === "assistant" ? (options.sources ?? []) : [],
        createdAt: at,
      });
    }
  }
  await db.insert(assistantTurns).values(turns);
  await db.insert(assistantMessages).values(rows);
}

function own(keys: Key[], f: Fixture) {
  return keys.filter((key) => key.workspaceId === f.workspaceId && key.threadId === f.thread.id);
}

async function enqueue(f: Fixture, selected: ConversationSummaryPolicy = policy) {
  const [key] = own(await summaries.enqueueIdle(selected, 100), f);
  assert.ok(key);
  return key;
}

async function allowance(f: Fixture) {
  const selected = { ...policy, budgetId: randomUUID(), rateVersionId: randomUUID() };
  await db.insert(inferenceRates).values({
    id: selected.rateVersionId,
    provider: "test-only",
    model: selected.model,
    currency: "USD",
    inputMicroUsdPerMillionTokens: 1_000_000,
    outputMicroUsdPerMillionTokens: 1_000_000,
  });
  await db.insert(inferenceBudgets).values({
    workspaceId: f.workspaceId,
    id: selected.budgetId,
    rateVersionId: selected.rateVersionId,
    limitMicroUsd: 1_000_000,
    approvedAt: new Date(),
  });
  return selected;
}

void describe("derived idle conversation summaries", () => {
  void it("requires twenty new messages, five idle minutes, and no queued or running turn", async () => {
    const tooFew = await fixture();
    await messages(tooFew, 19);
    const recent = await fixture();
    await messages(recent, 20, { at: new Date(Date.now() - 60_000) });
    const busy = await fixture();
    await messages(busy, 20);
    const turnId = randomUUID();
    await assistant.requestTurn(
      busy.principal,
      busy.workspaceId,
      busy.thread.id,
      turnId,
      "Still active",
      { fixture: true },
    );
    await db
      .update(assistantMessages)
      .set({
        createdAt: new Date(Date.now() - policy.idleMs - 60_000),
      })
      .where(eq(assistantMessages.workspaceId, busy.workspaceId));
    assert.deepEqual(await summaries.enqueueIdle(policy, 100), []);
    await assistant.beginTurn(busy.workspaceId, turnId);
    assert.deepEqual(await summaries.enqueueIdle(policy, 100), []);
    await assistant.cancelTurn(busy.principal, busy.workspaceId, turnId);
    const keys = await summaries.enqueueIdle(policy, 100);
    assert.equal(own(keys, busy).length, 1);
    assert.equal(own(keys, tooFew).length, 0);
    assert.equal(own(keys, recent).length, 0);
    const latest = await summaries.latest(busy.principal, busy.workspaceId, busy.thread.id);
    assert.equal(latest?.throughSequence, 21);
    assert.equal(latest?.messageCount, 21);
  });

  void it("deduplicates concurrent acceptance and execution while pinning the exact snapshot and policy", async () => {
    const f = await fixture();
    await messages(f, 20);
    const accepted = await Promise.all([
      summaries.enqueueIdle(policy, 100),
      summaries.enqueueIdle({ ...policy, model: "other-model" }, 100),
    ]);
    const keys = accepted.flat().filter((key) => key.workspaceId === f.workspaceId);
    assert.equal(keys.length, 1);
    const key = keys[0]!;
    const execution = await summaries.load(key);
    assert.ok(execution);
    assert.equal(execution.messages.length, 20);
    assert.deepEqual(
      execution.sources.map((source) => source.id),
      execution.messages.map((message) => message.id),
    );
    assert.ok(execution.sources.every((source) => source.kind === "message"));
    assert.ok(execution.messages.some((message) => message.role === "user"));
    assert.ok(
      new TextEncoder().encode(
        JSON.stringify({
          messages: execution.messages,
          sources: execution.sources,
        }),
      ).byteLength <= execution.policy.maxInputBytes,
    );
    const claims = await Promise.all([summaries.begin(key), summaries.begin(key)]);
    assert.deepEqual(claims.sort(), [false, true]);
    assert.deepEqual(await summaries.load(key), execution);
    await summaries.publish(key, "A derived conversation summary.");
    await summaries.publish(key, "A derived conversation summary.");
    await assert.rejects(summaries.publish(key, "Different result"), code("command_reused"));
    const latest = await summaries.latest(f.principal, f.workspaceId, f.thread.id);
    assert.equal(latest?.status, "succeeded");
    assert.equal(latest?.fromSequence, 1);
    assert.equal(latest?.throughSequence, 20);
    assert.equal(latest?.messageCount, 20);
    assert.deepEqual(await summaries.contextSummary(f.workspaceId, f.thread.id), latest);
    assert.equal(await summaries.load(key), null);
    assert.equal(await summaries.begin(key), false);
    assert.deepEqual(await summaries.enqueueIdle(policy, 100), []);
    const memories = await db
      .select()
      .from(assistantMemories)
      .where(eq(assistantMemories.workspaceId, f.workspaceId));
    assert.equal(memories.length, 0);
  });

  void it("counts failed accepted cutoffs and does not automatically retry their range", async () => {
    const f = await fixture();
    await messages(f, 20);
    const first = await enqueue(f);
    await summaries.fail(first, "Provider unavailable");
    assert.equal(
      (await summaries.latest(f.principal, f.workspaceId, f.thread.id))?.status,
      "failed",
    );
    assert.deepEqual(own(await summaries.enqueueIdle(policy, 100), f), []);
    await messages(f, 19);
    assert.deepEqual(own(await summaries.enqueueIdle(policy, 100), f), []);
    await messages(f, 1);
    const second = await enqueue(f);
    assert.notEqual(second.jobId, first.jobId);
    assert.equal(
      (await summaries.latest(f.principal, f.workspaceId, f.thread.id))?.throughSequence,
      40,
    );
    assert.equal(await summaries.begin(first), false);
    await assert.rejects(summaries.publish(first, "Late old output"), code("conflict"));
  });

  void it("rotates pending attempts and includes running work for uncertain-runtime reconciliation", async () => {
    const first = await fixture();
    const second = await fixture();
    await messages(first, 20);
    await messages(second, 20);
    const keys = await summaries.enqueueIdle(policy, 100);
    assert.equal(keys.length, 2);
    await db
      .update(conversationSummaryJobs)
      .set({
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      })
      .where(inArray(conversationSummaryJobs.workspaceId, [first.workspaceId, second.workspaceId]));
    const [a] = await summaries.pending(1);
    assert.ok(a);
    await summaries.begin(a);
    const [b] = await summaries.pending(1);
    assert.ok(b);
    assert.notEqual(a.jobId, b.jobId);
    const pending = await summaries.pending(100);
    assert.ok(pending.some((key) => key.jobId === a.jobId));
    assert.ok(pending.some((key) => key.jobId === b.jobId));
    const [checked] = await db
      .select()
      .from(conversationSummaryJobs)
      .where(eq(conversationSummaryJobs.id, a.jobId));
    assert.ok(checked?.dispatchCheckedAt);
  });

  void it("filters stale assistant context and explicitly retains every included user-message source", async () => {
    const f = await fixture();
    const subject = await repository.savePerson(f.principal, f.workspaceId, person());
    await messages(f, 20, {
      sources: [
        {
          kind: "person",
          id: subject.id,
          label: "Contact",
          revision: subject.revision,
          contactRevision: 0,
        },
      ],
    });
    await createContactRepository(db).save(f.principal, {
      workspaceId: f.workspaceId,
      personId: subject.id,
      expectedRevision: 0,
      operationId: randomUUID(),
      fields: { organization: "Example", role: "Changed", links: [] },
    });
    const key = await enqueue(f);
    const execution = await summaries.load(key);
    assert.ok(execution);
    assert.equal(execution.messages.length, 10);
    assert.ok(execution.messages.every((message) => message.role === "user"));
    assert.deepEqual(
      execution.sources.map((source) => source.id),
      execution.messages.map((message) => message.id),
    );
    const latest = await summaries.latest(f.principal, f.workspaceId, f.thread.id);
    assert.equal(latest?.fromSequence, 1);
    assert.equal(latest?.throughSequence, 20);
    assert.equal(latest?.messageCount, 10);
  });

  void it("rejects stale publication but preserves already published historical summaries on read", async () => {
    const f = await fixture();
    const source = await repository.saveNote(f.principal, f.workspaceId, note());
    await messages(f, 20, {
      sources: [{ kind: "note", id: source.id, revision: source.revision, label: "Source" }],
    });
    const key = await enqueue(f);
    await summaries.begin(key);
    await repository.deleteNote(f.principal, f.workspaceId, {
      id: source.id,
      expectedRevision: source.revision,
      commandId: randomUUID(),
    });
    const [beforeRead] = await db
      .select()
      .from(conversationSummaryJobs)
      .where(eq(conversationSummaryJobs.id, key.jobId));
    assert.equal(
      (await summaries.latest(f.principal, f.workspaceId, f.thread.id))?.status,
      "running",
    );
    const [afterRead] = await db
      .select()
      .from(conversationSummaryJobs)
      .where(eq(conversationSummaryJobs.id, key.jobId));
    assert.deepEqual(afterRead, beforeRead, "Reading active status must not mutate the job");
    await assert.rejects(summaries.publish(key, "Obsolete source claim"), code("conflict"));
    const stale = await summaries.latest(f.principal, f.workspaceId, f.thread.id);
    assert.equal(stale?.status, "stale");
    assert.equal(stale?.text, null);
    assert.equal(await summaries.load(key), null);
    assert.deepEqual(own(await summaries.enqueueIdle(policy, 100), f), []);

    const fresh = await fixture();
    const subject = await repository.savePerson(fresh.principal, fresh.workspaceId, person());
    await messages(fresh, 20, {
      sources: [
        {
          kind: "person",
          id: subject.id,
          revision: subject.revision,
          contactRevision: 0,
          label: "Contact",
        },
      ],
    });
    const completed = await enqueue(fresh);
    await summaries.begin(completed);
    await summaries.publish(completed, "Originally valid derived text");
    const original = await summaries.latest(fresh.principal, fresh.workspaceId, fresh.thread.id);
    await createContactRepository(db).save(fresh.principal, {
      workspaceId: fresh.workspaceId,
      personId: subject.id,
      expectedRevision: 0,
      operationId: randomUUID(),
      fields: { organization: "Example", role: "Changed", links: [] },
    });
    const hydrated = await summaries.contextSummary(fresh.workspaceId, fresh.thread.id);
    assert.deepEqual(hydrated, original);
    assert.equal(hydrated?.status, "succeeded");
    assert.equal(hydrated?.text, "Originally valid derived text");
    const [audit] = await db
      .select()
      .from(conversationSummaryJobs)
      .where(eq(conversationSummaryJobs.id, completed.jobId));
    assert.equal(audit?.text, "Originally valid derived text");
    assert.equal(audit?.status, "succeeded");
  });

  void it("reads queued status without checking evidence, leaving invalidation to execution", async () => {
    const f = await fixture();
    const source = await repository.saveNote(f.principal, f.workspaceId, note());
    await messages(f, 20, {
      sources: [{ kind: "note", id: source.id, revision: source.revision, label: "Source" }],
    });
    const key = await enqueue(f);
    const original = await summaries.latest(f.principal, f.workspaceId, f.thread.id);
    assert.equal(original?.status, "queued");
    await repository.deleteNote(f.principal, f.workspaceId, {
      id: source.id,
      expectedRevision: source.revision,
      commandId: randomUUID(),
    });
    assert.deepEqual(await summaries.latest(f.principal, f.workspaceId, f.thread.id), original);
    assert.deepEqual(await summaries.contextSummary(f.workspaceId, f.thread.id), original);
    assert.equal(await summaries.begin(key), false);
    assert.equal(
      (await summaries.latest(f.principal, f.workspaceId, f.thread.id))?.status,
      "stale",
    );
  });

  void it("rechecks owner, membership, scoped job keys and the current thread note", async () => {
    const f = await fixture();
    const peer = await fixture();
    await messages(f, 20);
    const key = await enqueue(f);
    await db.insert(workspaceMemberships).values({
      workspaceId: f.workspaceId,
      userId: peer.principal.id,
    });
    await assert.rejects(
      summaries.latest(peer.principal, f.workspaceId, f.thread.id),
      code("not_found"),
    );
    assert.equal(await summaries.load({ ...key, threadId: peer.thread.id }), null);
    assert.equal(await summaries.begin({ ...key, workspaceId: peer.workspaceId }), false);
    await repository.deleteNote(f.principal, f.workspaceId, {
      id: f.note.id,
      expectedRevision: f.note.revision,
      commandId: randomUUID(),
    });
    assert.equal(await summaries.load(key), null);
    assert.equal(await summaries.contextSummary(f.workspaceId, f.thread.id), null);
    await assert.rejects(
      summaries.latest(f.principal, f.workspaceId, f.thread.id),
      code("not_found"),
    );
    const revoked = await fixture();
    await messages(revoked, 20);
    const revokedKey = await enqueue(revoked);
    await db
      .update(workspaceMemberships)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, revoked.workspaceId),
          eq(workspaceMemberships.userId, revoked.principal.id),
        ),
      );
    assert.equal(await summaries.begin(revokedKey), false);
    assert.equal(await summaries.contextSummary(revoked.workspaceId, revoked.thread.id), null);
  });

  void it("bounds the actual source snapshot by bytes and fifty messages without mutating saved message text", async () => {
    const f = await fixture();
    await messages(f, 60);
    const key = await enqueue(f, { ...policy, maxMessages: 100 });
    const execution = await summaries.load(key);
    assert.ok(execution);
    assert.equal(execution.messages.length, 50);
    assert.equal(execution.sources.length, 50);
    const latest = await summaries.latest(f.principal, f.workspaceId, f.thread.id);
    assert.equal(latest?.fromSequence, 11);
    assert.equal(latest?.throughSequence, 60);
    const bounded = await fixture();
    await messages(bounded, 20, { text: "Unchanged content ".repeat(40) });
    const boundedKey = await enqueue(bounded, { ...policy, maxMessages: 20, maxInputBytes: 4000 });
    const boundedExecution = await summaries.load(boundedKey);
    assert.ok(boundedExecution);
    assert.ok(boundedExecution.messages.length > 0 && boundedExecution.messages.length < 20);
    assert.ok(
      boundedExecution.messages.every(
        (message) => message.text === "Unchanged content ".repeat(40),
      ),
    );
    assert.ok(
      new TextEncoder().encode(
        JSON.stringify({
          messages: boundedExecution.messages,
          sources: boundedExecution.sources,
        }),
      ).byteLength <= 4000,
    );
  });

  void it("rotates a candidate that cannot fit any valid snapshot instead of starving later idle threads", async () => {
    const oversized = await fixture();
    const healthy = await fixture();
    await messages(oversized, 20, {
      at: new Date(Date.now() - 7_200_000),
      text: "x".repeat(5000),
    });
    await messages(healthy, 20, { at: new Date(Date.now() - 3_600_000) });
    const bounded = { ...policy, maxInputBytes: 4000 };
    const accepted: Key[] = [];
    // Discovery now pages all thread identities instead of globally aggregating
    // eligible histories. One complete bounded sweep must reach the healthy row.
    const [threadCount] = await sql`select count(*)::int as count from assistant_threads`;
    for (let index = 0; index < Number(threadCount?.count); index += 1) {
      accepted.push(...(await summaries.enqueueIdle(bounded, 1)));
    }
    assert.equal(own(accepted, healthy).length, 1);
    assert.equal(own(accepted, oversized).length, 0);
    const [scan] = await db
      .select()
      .from(conversationSummaryScans)
      .where(eq(conversationSummaryScans.threadId, oversized.thread.id));
    assert.ok(scan?.checkedAt);
    assert.equal(
      await summaries.latest(oversized.principal, oversized.workspaceId, oversized.thread.id),
      null,
    );
  });

  void it("commits attempt rotation through a genuine late SQL failure and continues healthy candidates", async () => {
    const fixtures = [await fixture(), await fixture()].sort((left, right) =>
      left.workspaceId.localeCompare(right.workspaceId),
    );
    const broken = fixtures[0]!;
    const healthy = fixtures[1]!;
    await messages(broken, 20);
    await messages(healthy, 20);
    // Reset only this isolated suite's scheduling cursor so the failing identity
    // precedes the healthy one in the first index-ordered discovery page.
    await db.delete(conversationSummaryScans);
    const name = `conversation_candidate_fault_${randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(`create function public.${name}() returns trigger language plpgsql as $$
      begin
        if NEW.workspace_id = '${broken.workspaceId}'::uuid then
          raise exception 'injected candidate insert failure' using errcode = 'P0001';
        end if;
        return NEW;
      end $$`);
    try {
      await sql.unsafe(`create trigger ${name} before insert on public.conversation_summary_jobs
        for each row execute function public.${name}()`);
      const accepted = await summaries.enqueueIdle(policy, 100);
      assert.equal(own(accepted, healthy).length, 1);
      assert.equal(own(accepted, broken).length, 0);
      const [attempt] = await db
        .select()
        .from(conversationSummaryScans)
        .where(
          and(
            eq(conversationSummaryScans.workspaceId, broken.workspaceId),
            eq(conversationSummaryScans.threadId, broken.thread.id),
          ),
        );
      assert.ok(attempt?.checkedAt, "rotation survives rollback of the candidate transaction");
      assert.equal(
        await summaries.latest(broken.principal, broken.workspaceId, broken.thread.id),
        null,
      );
    } finally {
      await sql.unsafe(`drop trigger if exists ${name} on public.conversation_summary_jobs`);
      await sql.unsafe(`drop function public.${name}()`);
    }
    const recovered = await enqueue(broken);
    assert.ok(recovered.jobId);
  });

  void it("uses bounded identity pages and indexed, explicitly scoped eligibility reads", async () => {
    const f = await fixture();
    await messages(f, 60);
    const queries: Array<{ query: string; params: unknown[] }> = [];
    const observed = createConversationSummaryRepository(
      drizzle(sql, {
        schema,
        logger: {
          logQuery(query, params) {
            queries.push({ query, params });
          },
        },
      }),
    );
    assert.equal(own(await observed.enqueueIdle(policy, 100), f).length, 1);
    assert.ok(!queries.some(({ query }) => /\bgroup by\b/i.test(query)));
    const historyReads = queries.filter(({ query }) => query.includes('from "assistant_messages"'));
    assert.ok(historyReads.length > 0);
    assert.ok(
      historyReads.every(
        ({ query }) =>
          query.includes('"assistant_messages"."workspace_id" =') && /\blimit\b/i.test(query),
      ),
    );
    const eligibility = historyReads.find(
      ({ query }) =>
        query.startsWith('select "sequence", "created_at"') && query.includes('"thread_id" ='),
    );
    assert.ok(eligibility, "new-message eligibility must be one scoped, limited index read");
    assert.ok(eligibility.params.includes(f.workspaceId));
    assert.ok(eligibility.params.includes(f.thread.id));
    assert.equal(eligibility.params.at(-1), policy.minNewMessages);
    const snapshotRead = historyReads.find(({ query }) => query.includes("octet_length"));
    assert.ok(snapshotRead);
    assert.ok(
      !snapshotRead.query.slice(snapshotRead.query.indexOf(" where ")).includes("octet_length"),
    );
    assert.equal(snapshotRead.params.at(-1), policy.maxMessages);
    const params = eligibility.params.map((value) => {
      assert.ok(typeof value === "string" || typeof value === "number");
      return value;
    });
    await sql.begin(async (tx) => {
      await tx`set local enable_seqscan=off`;
      const result = await tx.unsafe(`explain (format json) ${eligibility.query}`, params);
      const plan: unknown = result[0]?.["QUERY PLAN"];
      const rendered = JSON.stringify(plan);
      assert.ok(rendered);
      assert.match(rendered, /assistant_messages_thread_sequence/);
      assert.match(rendered, /Index Cond/);
    });
  });

  void it("admits the actual escaped model prompt including system instructions, not just source JSON", async () => {
    const f = await fixture();
    const text = '\\"'.repeat(200) + "a".repeat(200);
    await messages(f, 50, { text });
    const rows = await db
      .select({
        id: assistantMessages.id,
        role: assistantMessages.role,
        text: assistantMessages.text,
        sequence: assistantMessages.sequence,
      })
      .from(assistantMessages)
      .where(eq(assistantMessages.workspaceId, f.workspaceId))
      .orderBy(assistantMessages.sequence);
    const original = {
      messages: rows.map(({ id, role, text: content }) => ({ id, role, text: content })),
      sources: rows.map((row) => ({
        kind: "message",
        id: row.id,
        label: `Conversation message ${row.sequence}`,
      })),
    };
    assert.ok(new TextEncoder().encode(JSON.stringify(original)).byteLength < policy.maxInputBytes);
    assert.ok(
      buildConversationSummaryPrompt({ policy, messages: original.messages }).inputBytes >
        policy.maxInputBytes,
    );
    const key = await enqueue(f);
    const execution = await summaries.load(key);
    assert.ok(execution);
    assert.ok(execution.messages.length > 0 && execution.messages.length < 50);
    assert.ok(execution.messages.every((message) => message.text === text));
    const rendered = buildConversationSummaryPrompt(execution);
    assert.ok(rendered.inputBytes <= policy.maxInputBytes);
    const [job] = await db
      .select()
      .from(conversationSummaryJobs)
      .where(eq(conversationSummaryJobs.id, key.jobId));
    assert.equal(job?.inputBytes, rendered.inputBytes);
  });

  void it("retains terminal accounting recovery only for a matching unsettled pinned reservation", async () => {
    const ledger = createInferenceRepository(db);
    for (const status of ["stale", "failed", "succeeded"] as const) {
      const f = await fixture();
      const source = await repository.saveNote(f.principal, f.workspaceId, note());
      await messages(f, 20, {
        sources: [{ kind: "note", id: source.id, revision: source.revision, label: "Source" }],
      });
      const selected = await allowance(f);
      const key = await enqueue(f, selected);
      await summaries.begin(key);
      await ledger.reserve({
        workspaceId: f.workspaceId,
        requestId: key.jobId,
        budgetId: selected.budgetId,
        rateVersionId: selected.rateVersionId,
        model: selected.model,
        inputTokenBound: 2000,
        maxOutputTokens: selected.maxOutputTokens,
      });
      if (status === "stale") {
        await repository.deleteNote(f.principal, f.workspaceId, {
          id: source.id,
          expectedRevision: source.revision,
          commandId: randomUUID(),
        });
        assert.equal(await summaries.load(key), null);
        assert.equal(
          (await summaries.latest(f.principal, f.workspaceId, f.thread.id))?.status,
          "stale",
        );
      } else if (status === "failed") {
        await summaries.fail(key, "Terminal rejection before accounting recovered");
      } else {
        await summaries.publish(key, "Completed result with deferred settlement");
      }
      assert.equal(await summaries.load(key), null);
      assert.equal(
        (await summaries.pending(100)).find((pending) => pending.jobId === key.jobId)?.recoveryOnly,
        true,
      );
      await ledger.settle({
        workspaceId: f.workspaceId,
        requestId: key.jobId,
        inputTokens: 1000,
        outputTokens: 100,
      });
      assert.ok(!(await summaries.pending(100)).some((pending) => pending.jobId === key.jobId));

      const otherBudget = randomUUID();
      await db.insert(inferenceBudgets).values({
        workspaceId: f.workspaceId,
        id: otherBudget,
        rateVersionId: selected.rateVersionId,
        limitMicroUsd: 1_000_000,
        approvedAt: new Date(),
      });
      await messages(f, 20);
      const mismatch = await enqueue(f, selected);
      await ledger.reserve({
        workspaceId: f.workspaceId,
        requestId: mismatch.jobId,
        budgetId: otherBudget,
        rateVersionId: selected.rateVersionId,
        model: selected.model,
        inputTokenBound: 2000,
        maxOutputTokens: selected.maxOutputTokens,
      });
      await summaries.fail(mismatch, "Different pinned budget");
      assert.ok(
        !(await summaries.pending(100)).some((pending) => pending.jobId === mismatch.jobId),
      );
      await ledger.settle({
        workspaceId: f.workspaceId,
        requestId: mismatch.jobId,
        inputTokens: 0,
        outputTokens: 0,
      });
    }
  });

  void it("reserves active dispatch capacity while independently rotating unknown terminal holds", async () => {
    const ledger = createInferenceRepository(db);
    const held: Key[] = [];
    for (let index = 0; index < 4; index += 1) {
      const f = await fixture();
      await messages(f, 20);
      const selected = await allowance(f);
      const key = await enqueue(f, selected);
      await summaries.begin(key);
      await ledger.reserve({
        workspaceId: f.workspaceId,
        requestId: key.jobId,
        budgetId: selected.budgetId,
        rateVersionId: selected.rateVersionId,
        model: selected.model,
        inputTokenBound: 2000,
        maxOutputTokens: selected.maxOutputTokens,
      });
      await summaries.fail(key, "Uncertain usage remains held");
      held.push(key);
    }
    await db
      .update(conversationSummaryJobs)
      .set({
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      })
      .where(
        inArray(
          conversationSummaryJobs.id,
          held.map((key) => key.jobId),
        ),
      );
    const activeKeys: Key[] = [];
    for (let index = 0; index < 3; index += 1) {
      const f = await fixture();
      await messages(f, 20);
      activeKeys.push(await enqueue(f));
    }
    const [single] = await summaries.pending(1);
    assert.ok(single && activeKeys.some((key) => key.jobId === single.jobId));
    assert.equal(single.recoveryOnly, undefined);
    const activeSeen = new Set<string>();
    const heldSeen = new Set<string>();
    for (let index = 0; index < 2; index += 1) {
      const batch = await summaries.pending(4);
      assert.equal(batch.filter((key) => !key.recoveryOnly).length, 2);
      assert.equal(batch.filter((key) => key.recoveryOnly).length, 2);
      for (const key of batch) {
        (key.recoveryOnly ? heldSeen : activeSeen).add(key.jobId);
      }
    }
    assert.equal(activeSeen.size, activeKeys.length);
    assert.equal(heldSeen.size, held.length);
    for (const key of activeKeys) await summaries.fail(key, "Fixture complete");
    const [fallback] = await summaries.pending(1);
    assert.equal(fallback?.recoveryOnly, true);
    for (const key of held) {
      await ledger.settle({
        workspaceId: key.workspaceId,
        requestId: key.jobId,
        inputTokens: 0,
        outputTokens: 0,
      });
    }
    assert.deepEqual(await summaries.pending(100), []);
  });
});
