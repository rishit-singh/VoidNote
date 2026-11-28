import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { and, eq } from "drizzle-orm";

import type {
  CreateAssistantArtifact,
  RememberAssistantMemory,
} from "../../src/contracts/assistant";
import { WorkspaceError } from "../../src/contracts/workspace";
import { createAssistantRepository } from "../../src/db/assistant";
import { createContactRepository } from "../../src/db/contacts";
import {
  assistantArtifactPublications,
  assistantArtifacts,
  assistantMessages,
  assistantMemoryRevisions,
  assistantOperationReceipts,
  assistantTurns,
} from "../../src/db/assistant-schema";
import * as schema from "../../src/db/schema";
import {
  db,
  failInsert,
  note,
  person,
  repository,
  setupDatabase,
  sql,
  teardownDatabase,
  workspace,
} from "./fixture";

// The reconciler owns this shared fixture's migration lifecycle. Run this suite
// alone against its dedicated empty test database, never application data.
before(setupDatabase);
after(teardownDatabase);

const assistant = createAssistantRepository(db);
const policy = { version: 1, model: "test-only", maxSteps: 3 };
const output = { text: "Saved answer", tools: [], sources: [] };
const code = (expected: WorkspaceError["code"]) => (error: unknown) =>
  error instanceof WorkspaceError && error.code === expected;

async function fixture() {
  const owner = await workspace();
  const saved = await repository.saveNote(owner.principal, owner.workspaceId, note());
  const thread = await assistant.openThread(
    owner.principal,
    owner.workspaceId,
    randomUUID(),
    saved.id,
  );
  return { ...owner, note: saved, thread };
}

function memoryInput(overrides: Partial<RememberAssistantMemory> = {}): RememberAssistantMemory {
  return {
    operationId: randomUUID(),
    subjectId: null,
    kind: "preference",
    content: "Keep meeting summaries concise",
    provenance: "user-stated",
    sources: [],
    expiresAt: null,
    ...overrides,
  };
}

function artifactInput(overrides: Partial<CreateAssistantArtifact> = {}): CreateAssistantArtifact {
  return {
    operationId: randomUUID(),
    kind: "file",
    noteId: null,
    name: "Follow-up",
    mediaType: "text/markdown",
    content: "Authored content, not recorded speech.",
    sources: [],
    ...overrides,
  };
}

void describe("assistant persistence and execution fences", () => {
  void it("owns threads per principal even when both users are workspace members", async () => {
    const f = await fixture();
    const peer = await workspace();
    await db.insert(schema.workspaceMemberships).values({
      workspaceId: f.workspaceId,
      userId: peer.principal.id,
    });
    assert.deepEqual(await assistant.listThreads(peer.principal, f.workspaceId), []);
    await assert.rejects(
      assistant.history(peer.principal, f.workspaceId, f.thread.id),
      code("not_found"),
    );
    await assert.rejects(
      assistant.openThread(peer.principal, f.workspaceId, f.thread.id, f.note.id),
      code("not_found"),
    );
    await assert.rejects(
      assistant.openThread(f.principal, f.workspaceId, f.thread.id, null),
      code("command_reused"),
    );
    await assert.rejects(
      assistant.openThread(peer.principal, peer.workspaceId, randomUUID(), f.note.id),
      code("not_found"),
    );
  });

  void it("accepts one turn and user message under concurrent exact retries; disabled replay retains policy", async () => {
    const f = await fixture();
    const turnId = randomUUID();
    const accepted = await Promise.all(
      Array.from({ length: 4 }, () =>
        assistant.requestTurn(f.principal, f.workspaceId, f.thread.id, turnId, "Question", policy),
      ),
    );
    assert.ok(accepted.every((turn) => turn.id === turnId && turn.status === "queued"));
    const replay = await assistant.requestTurn(
      f.principal,
      f.workspaceId,
      f.thread.id,
      turnId,
      "Question",
      null,
    );
    assert.equal(replay.id, turnId);
    assert.deepEqual((await assistant.execution(f.workspaceId, turnId))?.policy, policy);
    assert.equal(
      (await assistant.history(f.principal, f.workspaceId, f.thread.id)).messages.length,
      1,
    );
    await assert.rejects(
      assistant.requestTurn(f.principal, f.workspaceId, f.thread.id, turnId, "Changed", policy),
      code("command_reused"),
    );
    await assert.rejects(
      assistant.requestTurn(f.principal, f.workspaceId, f.thread.id, randomUUID(), "New", policy),
      code("conflict"),
    );
    await assistant.cancelTurn(f.principal, f.workspaceId, turnId);
    await assert.rejects(
      assistant.requestTurn(f.principal, f.workspaceId, f.thread.id, randomUUID(), "New", null),
      code("service_unavailable"),
    );
  });

  void it("allows only one concurrent execution claim and one immutable output", async () => {
    const f = await fixture();
    const turnId = randomUUID();
    await assistant.requestTurn(
      f.principal,
      f.workspaceId,
      f.thread.id,
      turnId,
      "Question",
      policy,
    );
    const claims = await Promise.all([
      assistant.beginTurn(f.workspaceId, turnId),
      assistant.beginTurn(f.workspaceId, turnId),
    ]);
    assert.deepEqual(claims.sort(), [false, true]);
    const outputs = await Promise.all([
      assistant.completeTurn(f.workspaceId, turnId, output),
      assistant.completeTurn(f.workspaceId, turnId, output),
    ]);
    assert.ok(outputs.every((turn) => turn?.status === "succeeded"));
    await assert.rejects(
      assistant.completeTurn(f.workspaceId, turnId, { ...output, text: "Changed" }),
      code("command_reused"),
    );
    const history = await assistant.history(f.principal, f.workspaceId, f.thread.id);
    assert.deepEqual(
      history.messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(history.activeTurn, null);
    assert.equal(new Set(history.messages.map((message) => message.id)).size, 2);
  });

  void it("paginates stable chronological messages without losing a same-millisecond pair", async () => {
    const f = await fixture();
    for (let index = 0; index < 3; index += 1) {
      const turnId = randomUUID();
      await assistant.requestTurn(
        f.principal,
        f.workspaceId,
        f.thread.id,
        turnId,
        `Question ${index}`,
        policy,
      );
      await assistant.beginTurn(f.workspaceId, turnId);
      await assistant.completeTurn(f.workspaceId, turnId, { ...output, text: `Answer ${index}` });
    }
    await db
      .update(assistantMessages)
      .set({ createdAt: new Date("2026-11-25T00:00:00.000Z") })
      .where(eq(assistantMessages.workspaceId, f.workspaceId));
    const first = await assistant.history(f.principal, f.workspaceId, f.thread.id, undefined, 3);
    assert.ok(first.nextCursor);
    const second = await assistant.history(
      f.principal,
      f.workspaceId,
      f.thread.id,
      first.nextCursor,
      3,
    );
    assert.equal(second.nextCursor, null);
    assert.deepEqual(
      [...second.messages, ...first.messages].map((message) => message.text),
      ["Question 0", "Answer 0", "Question 1", "Answer 1", "Question 2", "Answer 2"],
    );
    const other = await assistant.openThread(f.principal, f.workspaceId, randomUUID(), null);
    await assert.rejects(
      assistant.history(f.principal, f.workspaceId, other.id, first.nextCursor, 3),
      code("invalid_cursor"),
    );
  });

  void it("cancellation fences output and tool writes and cancels pending file publication", async () => {
    const f = await fixture();
    const turnId = randomUUID();
    await assistant.requestTurn(
      f.principal,
      f.workspaceId,
      f.thread.id,
      turnId,
      "Question",
      policy,
    );
    await assistant.beginTurn(f.workspaceId, turnId);
    const artifact = await assistant.createArtifact(f.principal, f.workspaceId, artifactInput(), {
      turnId,
    });
    await assistant.cancelTurn(f.principal, f.workspaceId, turnId);
    assert.equal(
      (await assistant.completeTurn(f.workspaceId, turnId, output))?.status,
      "cancelled",
    );
    assert.equal(
      (await assistant.history(f.principal, f.workspaceId, f.thread.id)).messages.length,
      1,
    );
    await assert.rejects(
      assistant.createArtifact(f.principal, f.workspaceId, artifactInput(), { turnId }),
      code("conflict"),
    );
    await assert.rejects(
      assistant.remember(f.principal, f.workspaceId, memoryInput(), { turnId }),
      code("conflict"),
    );
    const [publication] = await db
      .select()
      .from(assistantArtifactPublications)
      .where(eq(assistantArtifactPublications.artifactId, artifact.id));
    assert.ok(publication?.cancelledAt);
    await assistant.acknowledgeCancellation(f.workspaceId, turnId);
    const [turn] = await db
      .select()
      .from(assistantTurns)
      .where(and(eq(assistantTurns.workspaceId, f.workspaceId), eq(assistantTurns.id, turnId)));
    assert.ok(turn?.cancellationDispatchedAt);
  });

  void it("rechecks membership and note deletion before publication and retires inaccessible work", async () => {
    const f = await fixture();
    const turnId = randomUUID();
    await assistant.requestTurn(
      f.principal,
      f.workspaceId,
      f.thread.id,
      turnId,
      "Question",
      policy,
    );
    await assistant.beginTurn(f.workspaceId, turnId);
    await repository.deleteNote(f.principal, f.workspaceId, {
      id: f.note.id,
      expectedRevision: f.note.revision,
      commandId: randomUUID(),
    });
    assert.equal(await assistant.completeTurn(f.workspaceId, turnId, output), null);
    const [turn] = await db.select().from(assistantTurns).where(eq(assistantTurns.id, turnId));
    assert.equal(turn?.status, "interrupted");
    assert.deepEqual(await assistant.listThreads(f.principal, f.workspaceId), []);

    const revoked = await fixture();
    const revokedTurn = randomUUID();
    await assistant.requestTurn(
      revoked.principal,
      revoked.workspaceId,
      revoked.thread.id,
      revokedTurn,
      "Question",
      policy,
    );
    await db
      .update(schema.workspaceMemberships)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.workspaceMemberships.workspaceId, revoked.workspaceId),
          eq(schema.workspaceMemberships.userId, revoked.principal.id),
        ),
      );
    assert.equal(await assistant.beginTurn(revoked.workspaceId, revokedTurn), false);
    await assert.rejects(
      assistant.history(revoked.principal, revoked.workspaceId, revoked.thread.id),
      code("forbidden"),
    );
    await assert.rejects(
      assistant.contextHistory(revoked.workspaceId, revoked.thread.id),
      code("forbidden"),
    );
    await assert.rejects(assistant.contextHistory(f.workspaceId, f.thread.id), code("not_found"));
  });

  void it("rotates failed dispatch attempts and keeps cancelled work until acknowledgement", async () => {
    // Other tests leave accepted work; isolate this scan using its actual initial
    // pending count and retire the test's own turns at the end.
    const f = await fixture();
    const firstId = randomUUID();
    await assistant.requestTurn(f.principal, f.workspaceId, f.thread.id, firstId, "First", policy);
    await assistant.cancelTurn(f.principal, f.workspaceId, firstId);
    const secondId = randomUUID();
    await assistant.requestTurn(
      f.principal,
      f.workspaceId,
      f.thread.id,
      secondId,
      "Second",
      policy,
    );
    const batch = await assistant.pendingTurns(100);
    assert.ok(batch.some((item) => item.turnId === firstId && item.status === "cancelled"));
    assert.ok(batch.some((item) => item.turnId === secondId && item.status === "queued"));
    const [first] = await db.select().from(assistantTurns).where(eq(assistantTurns.id, firstId));
    assert.ok(first?.dispatchCheckedAt);
    await assistant.acknowledgeCancellation(f.workspaceId, firstId);
    assert.ok(!(await assistant.pendingTurns(100)).some((item) => item.turnId === firstId));
    await assistant.failTurn(f.workspaceId, secondId, "interrupted", "Test complete");
  });

  void it("reports the latest terminal turn separately from the active turn", async () => {
    const f = await fixture();
    assert.equal(
      (await assistant.history(f.principal, f.workspaceId, f.thread.id)).latestTurn,
      null,
    );
    const first = randomUUID();
    await assistant.requestTurn(f.principal, f.workspaceId, f.thread.id, first, "First", policy);
    await assistant.failTurn(f.workspaceId, first, "failed", "Provider unavailable");
    const failed = await assistant.history(f.principal, f.workspaceId, f.thread.id);
    assert.equal(failed.activeTurn, null);
    assert.equal(failed.latestTurn?.id, first);
    assert.equal(failed.latestTurn?.error, "Provider unavailable");
    const second = randomUUID();
    await assistant.requestTurn(f.principal, f.workspaceId, f.thread.id, second, "Second", policy);
    const running = await assistant.history(f.principal, f.workspaceId, f.thread.id);
    assert.equal(running.activeTurn?.id, second);
    assert.equal(running.latestTurn?.id, second);
    await assistant.cancelTurn(f.principal, f.workspaceId, second);
    const cancelled = await assistant.history(f.principal, f.workspaceId, f.thread.id);
    assert.equal(cancelled.activeTurn, null);
    assert.equal(cancelled.latestTurn?.status, "cancelled");
  });

  void it("preserves authorized historical contact replies with their original evidence revisions", async () => {
    const f = await fixture();
    const contacts = createContactRepository(db);
    const subject = await repository.savePerson(f.principal, f.workspaceId, person());
    await contacts.save(f.principal, {
      workspaceId: f.workspaceId,
      personId: subject.id,
      expectedRevision: 0,
      operationId: randomUUID(),
      fields: { organization: "Example", role: "Engineer", links: [] },
    });
    const source = { kind: "person" as const, id: subject.id, label: "Contact" };
    for (const location of ["message", "tool"] as const) {
      const turnId = randomUUID();
      await assistant.requestTurn(
        f.principal,
        f.workspaceId,
        f.thread.id,
        turnId,
        `Historical question: ${location}`,
        policy,
      );
      await assistant.beginTurn(f.workspaceId, turnId);
      await assistant.completeTurn(f.workspaceId, turnId, {
        text: "The contact is an Engineer.",
        sources: location === "message" ? [source] : [],
        tools:
          location === "tool"
            ? [
                {
                  id: "contact-details",
                  name: "contacts_get",
                  status: "succeeded",
                  summary: "Read the contact's role",
                  sources: [source],
                },
              ]
            : [],
      });
    }
    const raw = await assistant.history(f.principal, f.workspaceId, f.thread.id);
    assert.equal(raw.messages.length, 4);
    assert.deepEqual(await assistant.contextHistory(f.workspaceId, f.thread.id), raw.messages);
    assert.equal(raw.messages[1]?.sources[0]?.contactRevision, 1);
    assert.equal(raw.messages[3]?.tools[0]?.sources[0]?.contactRevision, 1);
    await contacts.save(f.principal, {
      workspaceId: f.workspaceId,
      personId: subject.id,
      expectedRevision: 1,
      operationId: randomUUID(),
      fields: { organization: "Example", role: "Manager", links: [] },
    });
    const hydrated = await assistant.contextHistory(f.workspaceId, f.thread.id);
    assert.deepEqual(hydrated, raw.messages);
    assert.equal(hydrated[1]?.sources[0]?.contactRevision, 1);
    assert.equal(hydrated[3]?.tools[0]?.sources[0]?.contactRevision, 1);
    assert.deepEqual(
      (await assistant.history(f.principal, f.workspaceId, f.thread.id)).messages,
      raw.messages,
    );
    // Historical context preserves what was said; it does not authorize the
    // predecessor contact revision as evidence for another published answer.
    const nextTurnId = randomUUID();
    await assistant.requestTurn(
      f.principal,
      f.workspaceId,
      f.thread.id,
      nextTurnId,
      "What is their current role?",
      policy,
    );
    await assistant.beginTurn(f.workspaceId, nextTurnId);
    await assert.rejects(
      assistant.completeTurn(f.workspaceId, nextTurnId, {
        text: "The contact is still an Engineer.",
        sources: hydrated[1].sources,
        tools: [],
      }),
      code("conflict"),
    );
  });

  void it("preserves authorized historical replies after memory invalidation or source-note deletion", async () => {
    const f = await fixture();
    const sourceNote = await repository.saveNote(f.principal, f.workspaceId, note());
    const memory = await assistant.remember(f.principal, f.workspaceId, memoryInput());
    for (const source of [
      { kind: "note" as const, id: sourceNote.id, label: "Source note" },
      { kind: "memory" as const, id: memory.id, label: "Recorded preference" },
    ]) {
      const turnId = randomUUID();
      await assistant.requestTurn(
        f.principal,
        f.workspaceId,
        f.thread.id,
        turnId,
        `Use ${source.kind}`,
        policy,
      );
      await assistant.beginTurn(f.workspaceId, turnId);
      await assistant.completeTurn(f.workspaceId, turnId, { ...output, sources: [source] });
    }
    const original = await assistant.contextHistory(f.workspaceId, f.thread.id);
    assert.equal(original.length, 4);
    await assistant.invalidateMemory(
      f.principal,
      f.workspaceId,
      memory.id,
      memory.revision,
      "No longer current",
      randomUUID(),
    );
    await repository.deleteNote(f.principal, f.workspaceId, {
      id: sourceNote.id,
      expectedRevision: sourceNote.revision,
      commandId: randomUUID(),
    });
    const hydrated = await assistant.contextHistory(f.workspaceId, f.thread.id);
    assert.deepEqual(hydrated, original);
    assert.equal(hydrated.filter((message) => message.role === "assistant").length, 2);
    assert.deepEqual(
      (await assistant.history(f.principal, f.workspaceId, f.thread.id)).messages,
      original,
    );
  });
});

void describe("assistant memory and authored artifacts", () => {
  void it("recovers committed tool receipts after success, failure or cancellation without new effects", async () => {
    for (const terminal of ["succeeded", "failed", "cancelled"] as const) {
      const f = await fixture();
      const turnId = randomUUID();
      const context = { turnId };
      await assistant.requestTurn(f.principal, f.workspaceId, f.thread.id, turnId, "Work", policy);
      await assistant.beginTurn(f.workspaceId, turnId);
      const artifactCommand = artifactInput();
      const artifact = await assistant.createArtifact(
        f.principal,
        f.workspaceId,
        artifactCommand,
        context,
      );
      const memoryCommand = memoryInput();
      const memory = await assistant.remember(f.principal, f.workspaceId, memoryCommand, context);
      const revisionCommand = randomUUID();
      await assistant.reviseMemory(
        f.principal,
        f.workspaceId,
        memory.id,
        1,
        "Revised claim",
        [],
        "Correction",
        revisionCommand,
        context,
      );
      const invalidationCommand = randomUUID();
      const invalidated = await assistant.invalidateMemory(
        f.principal,
        f.workspaceId,
        memory.id,
        2,
        "Superseded",
        invalidationCommand,
        context,
      );

      if (terminal === "succeeded") {
        await assistant.completeTurn(f.workspaceId, turnId, output);
      } else if (terminal === "failed") {
        await assistant.failTurn(f.workspaceId, turnId, "failed", "Failed after committed tools");
      } else {
        await assistant.cancelTurn(f.principal, f.workspaceId, turnId);
      }

      assert.deepEqual(
        await assistant.createArtifact(f.principal, f.workspaceId, artifactCommand, context),
        artifact,
      );
      assert.deepEqual(
        await assistant.remember(f.principal, f.workspaceId, memoryCommand, context),
        invalidated,
      );
      assert.deepEqual(
        await assistant.reviseMemory(
          f.principal,
          f.workspaceId,
          memory.id,
          1,
          "Revised claim",
          [],
          "Correction",
          revisionCommand,
          context,
        ),
        invalidated,
      );
      assert.deepEqual(
        await assistant.invalidateMemory(
          f.principal,
          f.workspaceId,
          memory.id,
          2,
          "Superseded",
          invalidationCommand,
          context,
        ),
        invalidated,
      );
      await assert.rejects(
        assistant.createArtifact(f.principal, f.workspaceId, artifactInput(), context),
        code("conflict"),
      );
      const [counts] = await sql`
        select
          (select count(*)::int from assistant_artifacts where workspace_id=${f.workspaceId}) as artifacts,
          (select count(*)::int from assistant_memories where workspace_id=${f.workspaceId}) as memories,
          (select count(*)::int from assistant_operation_receipts where workspace_id=${f.workspaceId}) as receipts,
          (select count(*)::int from assistant_memory_revisions where workspace_id=${f.workspaceId}) as revisions`;
      assert.deepEqual({ ...counts }, { artifacts: 1, memories: 1, receipts: 4, revisions: 3 });
    }
  });

  void it("pins independent contact revisions including absent details and filters stale role evidence", async () => {
    const f = await fixture();
    const contacts = createContactRepository(db);
    const subject = await repository.savePerson(f.principal, f.workspaceId, person());
    const source = { kind: "person" as const, id: subject.id, label: "Contact" };
    const initial = await assistant.remember(
      f.principal,
      f.workspaceId,
      memoryInput({
        provenance: "source-supported",
        sources: [source],
      }),
    );
    assert.equal(initial.sources[0]?.contactRevision, 0);
    await contacts.save(f.principal, {
      workspaceId: f.workspaceId,
      personId: subject.id,
      expectedRevision: 0,
      operationId: randomUUID(),
      fields: { organization: "Example", role: "Engineer", links: [] },
    });
    assert.deepEqual(await assistant.recall(f.principal, f.workspaceId, ""), []);
    const roleMemory = await assistant.remember(
      f.principal,
      f.workspaceId,
      memoryInput({
        content: "The contact is an Engineer",
        provenance: "source-supported",
        sources: [source],
      }),
    );
    assert.equal(roleMemory.sources[0]?.revision, subject.revision);
    assert.equal(roleMemory.sources[0]?.contactRevision, 1);
    const artifact = await assistant.createArtifact(
      f.principal,
      f.workspaceId,
      artifactInput({ sources: [source] }),
    );
    const pending = (await assistant.pendingArtifactPublications(100)).find(
      (item) => item.artifactId === artifact.id,
    );
    assert.ok(pending);
    await contacts.save(f.principal, {
      workspaceId: f.workspaceId,
      personId: subject.id,
      expectedRevision: 1,
      operationId: randomUUID(),
      fields: { organization: "Example", role: "Manager", links: [] },
    });
    assert.deepEqual(await assistant.recall(f.principal, f.workspaceId, ""), []);
    assert.equal(
      await assistant.acknowledgeArtifactPublication(f.workspaceId, artifact.id, pending.checksum),
      false,
    );
    await assert.rejects(
      assistant.remember(
        f.principal,
        f.workspaceId,
        memoryInput({
          provenance: "source-supported",
          sources: [{ ...source, contactRevision: 1 }],
        }),
      ),
      code("conflict"),
    );
  });

  void it("revises memory idempotently with an immutable audit and current projection replay", async () => {
    const f = await fixture();
    const subject = await repository.savePerson(f.principal, f.workspaceId, person());
    const memory = await assistant.remember(
      f.principal,
      f.workspaceId,
      memoryInput({ subjectId: subject.id }),
    );
    const operationId = randomUUID();
    const revisions = await Promise.all([
      assistant.reviseMemory(
        f.principal,
        f.workspaceId,
        memory.id,
        1,
        "Prefer detailed action items",
        [],
        "User corrected their preference",
        operationId,
      ),
      assistant.reviseMemory(
        f.principal,
        f.workspaceId,
        memory.id,
        1,
        "Prefer detailed action items",
        [],
        "User corrected their preference",
        operationId,
      ),
    ]);
    assert.equal(revisions[0].revision, 2);
    assert.deepEqual(revisions[0], revisions[1]);
    assert.equal(revisions[0].provenance, memory.provenance);
    const audit = await db
      .select()
      .from(assistantMemoryRevisions)
      .where(
        and(
          eq(assistantMemoryRevisions.workspaceId, f.workspaceId),
          eq(assistantMemoryRevisions.memoryId, memory.id),
        ),
      )
      .orderBy(assistantMemoryRevisions.revision);
    assert.equal(audit.length, 2);
    assert.equal(audit[1]?.before?.content, memory.content);
    assert.equal(audit[1]?.after.content, "Prefer detailed action items");
    assert.equal(audit[1]?.operationId, operationId);
    await assert.rejects(
      assistant.reviseMemory(
        f.principal,
        f.workspaceId,
        memory.id,
        1,
        "Stale update",
        [],
        "Stale",
        randomUUID(),
      ),
      code("conflict"),
    );
    await assert.rejects(
      assistant.reviseMemory(
        f.principal,
        f.workspaceId,
        memory.id,
        1,
        "Different payload",
        [],
        "User corrected their preference",
        operationId,
      ),
      code("command_reused"),
    );
    await assistant.reviseMemory(
      f.principal,
      f.workspaceId,
      memory.id,
      2,
      "Most recent preference",
      [],
      "New edit",
      randomUUID(),
    );
    const replay = await assistant.reviseMemory(
      f.principal,
      f.workspaceId,
      memory.id,
      1,
      "Prefer detailed action items",
      [],
      "User corrected their preference",
      operationId,
    );
    assert.equal(replay.revision, 3);
    assert.equal(replay.content, "Most recent preference");
    await assert.rejects(
      assistant.reviseMemory(
        f.principal,
        f.workspaceId,
        memory.id,
        3,
        "Circular claim",
        [{ kind: "memory", id: memory.id, label: "Self" }],
        "Circular",
        randomUUID(),
      ),
      code("conflict"),
    );
    const [unchangedPerson] = await db
      .select()
      .from(schema.people)
      .where(and(eq(schema.people.workspaceId, f.workspaceId), eq(schema.people.id, subject.id)));
    assert.equal(unchangedPerson?.revision, subject.revision);
    assert.equal(unchangedPerson?.description, subject.description);
  });

  void it("replays immutable operations, fences stale invalidations, and never resurrects active memory", async () => {
    const f = await fixture();
    const input = memoryInput();
    const copies = await Promise.all([
      assistant.remember(f.principal, f.workspaceId, input),
      assistant.remember(f.principal, f.workspaceId, input),
    ]);
    assert.equal(copies[0].id, copies[1].id);
    await assert.rejects(
      assistant.remember(f.principal, f.workspaceId, { ...input, content: "Changed" }),
      code("command_reused"),
    );
    const invalidationId = randomUUID();
    const invalidated = await assistant.invalidateMemory(
      f.principal,
      f.workspaceId,
      copies[0].id,
      1,
      "Corrected by the user",
      invalidationId,
    );
    assert.equal(invalidated.revision, 2);
    assert.equal(
      (
        await assistant.invalidateMemory(
          f.principal,
          f.workspaceId,
          copies[0].id,
          1,
          "Corrected by the user",
          invalidationId,
        )
      ).revision,
      2,
    );
    assert.equal(
      (await assistant.remember(f.principal, f.workspaceId, input)).status,
      "invalidated",
    );
    assert.deepEqual(await assistant.recall(f.principal, f.workspaceId, ""), []);
    await assert.rejects(
      assistant.invalidateMemory(
        f.principal,
        f.workspaceId,
        copies[0].id,
        1,
        "Stale",
        randomUUID(),
      ),
      code("conflict"),
    );
  });

  void it("filters expired/inferred memory and escapes literal search while enforcing private ownership", async () => {
    const f = await fixture();
    await assistant.remember(
      f.principal,
      f.workspaceId,
      memoryInput({ content: "Use 100% accuracy" }),
    );
    await assistant.remember(
      f.principal,
      f.workspaceId,
      memoryInput({ content: "Something else" }),
    );
    await assistant.remember(
      f.principal,
      f.workspaceId,
      memoryInput({
        content: "Expired",
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    const inferred = await assistant.remember(
      f.principal,
      f.workspaceId,
      memoryInput({
        content: "A tentative inference",
        provenance: "agent-inferred",
      }),
    );
    assert.equal(inferred.status, "needs-review");
    assert.equal((await assistant.recall(f.principal, f.workspaceId, "%")).length, 1);
    assert.equal((await assistant.recall(f.principal, f.workspaceId, "")).length, 2);
    const peer = await workspace();
    await db.insert(schema.workspaceMemberships).values({
      workspaceId: f.workspaceId,
      userId: peer.principal.id,
    });
    assert.deepEqual(await assistant.recall(peer.principal, f.workspaceId, ""), []);
  });

  void it("validates local source scope and source revision before memory and artifact writes", async () => {
    const f = await fixture();
    const foreign = await fixture();
    await assert.rejects(
      assistant.remember(
        f.principal,
        f.workspaceId,
        memoryInput({
          provenance: "source-supported",
          sources: [{ kind: "note", id: foreign.note.id, label: "Foreign note" }],
        }),
      ),
      code("not_found"),
    );
    await assert.rejects(
      assistant.createArtifact(
        f.principal,
        f.workspaceId,
        artifactInput({
          sources: [{ kind: "note", id: f.note.id, label: "Note", revision: 99 }],
        }),
      ),
      code("conflict"),
    );
    const subject = await repository.savePerson(f.principal, f.workspaceId, person());
    const saved = await assistant.remember(
      f.principal,
      f.workspaceId,
      memoryInput({
        subjectId: subject.id,
        provenance: "source-supported",
        sources: [{ kind: "note", id: f.note.id, label: "Note" }],
      }),
    );
    assert.equal(saved.sources[0]?.revision, f.note.revision);
    assert.equal(
      (await assistant.recall(f.principal, f.workspaceId, "", subject.id))[0]?.id,
      saved.id,
    );
    await assistant.remember(
      f.principal,
      f.workspaceId,
      memoryInput({
        subjectId: subject.id,
        provenance: "source-supported",
        sources: [{ kind: "memory", id: saved.id, label: "Derived from recorded memory" }],
      }),
    );
    await repository.saveNote(f.principal, f.workspaceId, {
      commandId: randomUUID(),
      id: f.note.id,
      expectedRevision: f.note.revision,
      content: { title: "Changed source", transcript: f.note.transcript },
    });
    assert.deepEqual(await assistant.recall(f.principal, f.workspaceId, "", subject.id), []);
  });

  void it("creates an actual audited empty-transcript note, with separate authored content and atomic receipt", async () => {
    const f = await fixture();
    const input = artifactInput({ kind: "note" });
    const result = await assistant.createArtifact(f.principal, f.workspaceId, input);
    assert.ok(result.noteId);
    const [authoredNote] = await db
      .select()
      .from(schema.notes)
      .where(eq(schema.notes.id, result.noteId));
    assert.equal(authoredNote?.transcript, "");
    assert.equal(authoredNote?.title, input.name);
    assert.equal(result.content, input.content);
    const [listed] = await assistant.listArtifacts(f.principal, f.workspaceId);
    assert.equal(listed?.id, result.id);
    assert.equal("content" in listed, false);
    assert.deepEqual(await assistant.createArtifact(f.principal, f.workspaceId, input), result);
    const [counts] = await sql`
      select
        (select count(*)::int from domain_events where workspace_id=${f.workspaceId}
          and entity_id=${result.noteId}) as events,
        (select count(*)::int from assistant_artifact_publications
          where workspace_id=${f.workspaceId} and artifact_id=${result.id}) as publications`;
    assert.equal(counts?.events, 1);
    assert.equal(counts?.publications, 1);
    await repository.deleteNote(f.principal, f.workspaceId, {
      id: result.noteId,
      expectedRevision: 1,
      commandId: randomUUID(),
    });
    await assert.rejects(
      assistant.createArtifact(f.principal, f.workspaceId, input),
      code("not_found"),
    );
    assert.deepEqual(await assistant.listArtifacts(f.principal, f.workspaceId), []);
  });

  void it("rolls back authored note, artifact and operation receipt together on a late SQL failure", async () => {
    const f = await fixture();
    const input = artifactInput({ kind: "note" });
    await failInsert("outbox", f.workspaceId, async () => {
      await assert.rejects(assistant.createArtifact(f.principal, f.workspaceId, input));
    });
    assert.deepEqual(await assistant.listArtifacts(f.principal, f.workspaceId), []);
    const receipts = await db
      .select()
      .from(assistantOperationReceipts)
      .where(
        and(
          eq(assistantOperationReceipts.workspaceId, f.workspaceId),
          eq(assistantOperationReceipts.operationId, input.operationId),
        ),
      );
    assert.equal(receipts.length, 0);
    const [counts] =
      await sql`select count(*)::int as count from notes where workspace_id=${f.workspaceId}`;
    assert.equal(counts?.count, 1);
    assert.ok((await assistant.createArtifact(f.principal, f.workspaceId, input)).noteId);
  });

  void it("requires a genuine annotation source and preserves verified transcript/audio identity", async () => {
    const f = await fixture();
    await assert.rejects(
      assistant.createArtifact(
        f.principal,
        f.workspaceId,
        artifactInput({
          kind: "annotation",
          noteId: f.note.id,
        }),
      ),
      code("conflict"),
    );
    const recordingId = randomUUID();
    const runId = randomUUID();
    const utteranceId = randomUUID();
    await db.insert(schema.recordings).values({
      workspaceId: f.workspaceId,
      id: recordingId,
      noteId: f.note.id,
      actorId: f.principal.id,
      sha256: "a".repeat(64),
      bytes: 20,
      mimeType: "audio/webm",
      durationSeconds: 20,
      objectKey: `${f.workspaceId}/assistant-test-recording`,
      status: "ready",
    });
    await db.insert(schema.processingRuns).values({
      workspaceId: f.workspaceId,
      id: runId,
      noteId: f.note.id,
      recordingId,
      actorId: f.principal.id,
      status: "succeeded",
      transcriptGeneration: 1,
      config: { model: "test", transcriptionModel: "test" },
    });
    await db.insert(schema.transcriptUtterances).values({
      workspaceId: f.workspaceId,
      id: utteranceId,
      runId,
      sequence: 0,
      startSeconds: 2,
      endSeconds: 8,
      speakerLabel: "SPEAKER_00",
      text: "A real source passage.",
    });
    const input = artifactInput({
      kind: "annotation",
      noteId: f.note.id,
      sources: [
        {
          kind: "transcript",
          id: utteranceId,
          label: "Recorded passage",
          noteId: f.note.id,
          recordingId,
          runId,
          startSeconds: 2,
          endSeconds: 8,
          revision: 1,
        },
      ],
    });
    const annotation = await assistant.createArtifact(f.principal, f.workspaceId, input);
    assert.deepEqual(annotation.sources, input.sources);
    await assert.rejects(
      assistant.createArtifact(f.principal, f.workspaceId, {
        ...input,
        operationId: randomUUID(),
        sources: [{ ...input.sources[0]!, endSeconds: 12 }],
      }),
      code("conflict"),
    );
    await assert.rejects(
      assistant.createArtifact(f.principal, f.workspaceId, {
        ...input,
        operationId: randomUUID(),
        sources: [{ ...input.sources[0]!, runId: randomUUID() }],
      }),
      code("not_found"),
    );
    const rows = await db
      .select()
      .from(assistantArtifacts)
      .where(eq(assistantArtifacts.workspaceId, f.workspaceId));
    assert.equal(rows.length, 1);
  });

  void it("publishes immutable scoped bytes with checksum acknowledgement and post-I/O cancellation fences", async () => {
    const f = await fixture();
    const artifact = await assistant.createArtifact(
      f.principal,
      f.workspaceId,
      artifactInput({ content: "Unicode content: café ☕" }),
    );
    const firstBatch = await assistant.pendingArtifactPublications(100);
    const first = firstBatch.find((item) => item.artifactId === artifact.id);
    assert.ok(first);
    assert.equal(first.workspaceId, f.workspaceId);
    assert.equal(
      first.objectKey,
      `workspaces/${f.workspaceId}/assistant/artifacts/${artifact.id}/1`,
    );
    assert.equal(
      first.checksum,
      createHash("sha256").update(artifact.content, "utf8").digest("hex"),
    );
    const retried = (await assistant.pendingArtifactPublications(100)).find(
      (item) => item.artifactId === artifact.id,
    );
    assert.deepEqual(retried, first);
    const [publication] = await db
      .select()
      .from(assistantArtifactPublications)
      .where(eq(assistantArtifactPublications.artifactId, artifact.id));
    assert.equal(publication?.attempts, 2);
    await assert.rejects(
      assistant.acknowledgeArtifactPublication(f.workspaceId, artifact.id, "0".repeat(64)),
      code("conflict"),
    );
    assert.equal(
      await assistant.acknowledgeArtifactPublication(f.workspaceId, artifact.id, first.checksum),
      true,
    );
    assert.equal(
      await assistant.acknowledgeArtifactPublication(f.workspaceId, artifact.id, first.checksum),
      true,
    );
    assert.ok(
      !(await assistant.pendingArtifactPublications(100)).some(
        (item) => item.artifactId === artifact.id,
      ),
    );

    const turnId = randomUUID();
    await assistant.requestTurn(f.principal, f.workspaceId, f.thread.id, turnId, "Create", policy);
    await assistant.beginTurn(f.workspaceId, turnId);
    const cancelledArtifact = await assistant.createArtifact(
      f.principal,
      f.workspaceId,
      artifactInput(),
      { turnId },
    );
    const pending = (await assistant.pendingArtifactPublications(100)).find(
      (item) => item.artifactId === cancelledArtifact.id,
    );
    assert.ok(pending);
    await assistant.cancelTurn(f.principal, f.workspaceId, turnId);
    assert.equal(
      await assistant.acknowledgeArtifactPublication(
        f.workspaceId,
        cancelledArtifact.id,
        pending.checksum,
      ),
      false,
    );

    const attachedArtifact = await assistant.createArtifact(
      f.principal,
      f.workspaceId,
      artifactInput({ noteId: f.note.id }),
    );
    const attached = (await assistant.pendingArtifactPublications(100)).find(
      (item) => item.artifactId === attachedArtifact.id,
    );
    assert.ok(attached);
    await repository.deleteNote(f.principal, f.workspaceId, {
      id: f.note.id,
      expectedRevision: f.note.revision,
      commandId: randomUUID(),
    });
    assert.equal(
      await assistant.acknowledgeArtifactPublication(
        f.workspaceId,
        attachedArtifact.id,
        attached.checksum,
      ),
      false,
    );
    const deletions = await assistant.pendingArtifactDeletions(100);
    assert.ok(deletions.some((item) => item.artifactId === cancelledArtifact.id));
    assert.ok(deletions.some((item) => item.artifactId === attachedArtifact.id));
    assert.ok(!deletions.some((item) => item.artifactId === artifact.id));
    // A process loss or uncertain R2 delete never clears the SQL intent. A new
    // repository instance retries the same scoped keys, including after a late put.
    const retryDeletions = await createAssistantRepository(db).pendingArtifactDeletions(100);
    assert.deepEqual(
      retryDeletions.find((item) => item.artifactId === cancelledArtifact.id),
      deletions.find((item) => item.artifactId === cancelledArtifact.id),
    );
    const [cancelledPublication] = await db
      .select()
      .from(assistantArtifactPublications)
      .where(eq(assistantArtifactPublications.artifactId, cancelledArtifact.id));
    assert.ok(cancelledPublication?.cancelledAt);
    assert.equal(cancelledPublication?.publishedAt, null);
  });
});
