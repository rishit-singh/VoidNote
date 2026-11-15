import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import {
  WorkspaceError,
  historySchema,
  noteSchema,
  personSchema,
  type ListQuery,
} from "../../src/contracts/workspace";
import {
  counts,
  failInsert,
  note,
  person,
  repository as repo,
  setupDatabase,
  sql,
  teardownDatabase,
  workspace,
} from "./fixture";

const page = { limit: 50 };
const peoplePage = { ...page, q: "" };
function code(expected: WorkspaceError["code"]) {
  return (error: unknown) => error instanceof WorkspaceError && error.code === expected;
}
function pgCode(expected: string) {
  return (error: unknown): boolean => {
    if (!(error instanceof Error)) return false;
    return ("code" in error && error.code === expected) || pgCode(expected)(error.cause);
  };
}

// Fail module loading before registering any mutating test if preflight fails.
// Bun's node:test compatibility layer may continue tests after a failed before hook.
try {
  await setupDatabase();
} catch (error) {
  await teardownDatabase();
  throw error;
}

void describe("workspace repository / real PostgreSQL", { concurrency: false }, () => {
  after(teardownDatabase);

  void it("bootstraps one workspace and membership under concurrent first use", async () => {
    const principal = { id: randomUUID(), email: "concurrent@example.invalid" };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => repo.ensureWorkspace(principal)),
    );
    assert.equal(new Set(results.map((value) => value.id)).size, 1);
    const memberships =
      await sql`select * from workspace_memberships where user_id = ${principal.id}`;
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0]?.role, "owner");
  });

  void it("persists typed notes and people with events, receipts, and outbox entries", async () => {
    const { principal, workspaceId } = await workspace();
    const n = await repo.saveNote(principal, workspaceId, note());
    const p = await repo.savePerson(principal, workspaceId, person());
    assert.deepEqual(noteSchema.parse(n), n);
    assert.deepEqual(personSchema.parse(p), p);
    assert.equal(n.revision, 1);
    assert.equal(p.revision, 1);
    assert.equal(n.workspaceId, workspaceId);
    assert.deepEqual(await repo.getNote(principal, workspaceId, n.id), n);
    assert.deepEqual(await repo.getPerson(principal, workspaceId, p.id), p);
    assert.deepEqual(await counts(workspaceId), {
      notes: 1,
      people: 1,
      events: 2,
      receipts: 2,
      outbox: 2,
    });
    const history = await repo.history(principal, workspaceId, "note", n.id, page);
    historySchema.parse(history);
    assert.equal(history.items[0]?.actorId, principal.id);
    assert.equal(history.items[0]?.entityId, n.id);
  });

  for (const table of ["outbox", "command_receipts"] as const) {
    void it(`rolls back projection, events, receipts and outbox when ${table} insertion fails`, async () => {
      const { principal, workspaceId } = await workspace();
      const create = note();
      const original = await repo.saveNote(principal, workspaceId, create);
      const baseline = await counts(workspaceId);
      const edit = note({
        id: original.id,
        expectedRevision: 1,
        content: { ...create.content, title: "Must roll back" },
      });
      await failInsert(table, workspaceId, async () => {
        await assert.rejects(repo.saveNote(principal, workspaceId, edit), pgCode("P0001"));
        assert.deepEqual(await repo.getNote(principal, workspaceId, original.id), original);
        assert.deepEqual(await counts(workspaceId), baseline);
        await assert.rejects(repo.saveNote(principal, workspaceId, note()), pgCode("P0001"));
        assert.deepEqual(await counts(workspaceId), baseline);
      });
      // The failed command must not leave a poisoned receipt that blocks retry.
      const committed = await repo.saveNote(principal, workspaceId, edit);
      assert.equal(committed.revision, 2);
      assert.equal(committed.title, "Must roll back");
      assert.deepEqual(await counts(workspaceId), {
        notes: 1,
        people: 0,
        events: 2,
        receipts: 2,
        outbox: 2,
      });
    });
  }

  void it("returns the original receipt for retries even after subsequent revisions", async () => {
    const { principal, workspaceId } = await workspace();
    const create = note();
    const original = await repo.saveNote(principal, workspaceId, create);
    const edit = note({
      id: original.id,
      expectedRevision: 1,
      content: { ...create.content, title: "Second revision" },
    });
    const edited = await repo.saveNote(principal, workspaceId, edit);
    await repo.saveNote(principal, workspaceId, note({ id: original.id, expectedRevision: 2 }));
    const baseline = await counts(workspaceId);
    assert.deepEqual(await repo.saveNote(principal, workspaceId, create), original);
    assert.deepEqual(await repo.saveNote(principal, workspaceId, edit), edited);
    assert.deepEqual(await counts(workspaceId), baseline);
    assert.equal((await repo.getNote(principal, workspaceId, original.id)).revision, 3);
  });

  void it("rejects reuse of a command ID with changed content, target, revision, or operation", async () => {
    const { principal, workspaceId } = await workspace();
    const command = note();
    await repo.saveNote(principal, workspaceId, command);
    const baseline = await counts(workspaceId);
    for (const changed of [
      { ...command, content: { ...command.content, title: "Different request" } },
      { ...command, id: randomUUID() },
      { ...command, expectedRevision: 1 },
    ])
      await assert.rejects(repo.saveNote(principal, workspaceId, changed), code("command_reused"));
    await assert.rejects(
      repo.deleteNote(principal, workspaceId, {
        commandId: command.commandId,
        id: command.id,
        expectedRevision: 1,
      }),
      code("command_reused"),
    );
    assert.deepEqual(await counts(workspaceId), baseline);
  });

  void it("serializes concurrent identical command retries into exactly one mutation", async () => {
    const { principal, workspaceId } = await workspace();
    const command = note();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repo.saveNote(principal, workspaceId, command)),
    );
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.deepEqual(await counts(workspaceId), {
      notes: 1,
      people: 0,
      events: 1,
      receipts: 1,
      outbox: 1,
    });
    const edit = note({ id: command.id, expectedRevision: 1 });
    const edits = await Promise.all(
      Array.from({ length: 8 }, () => repo.saveNote(principal, workspaceId, edit)),
    );
    for (const result of edits) assert.deepEqual(result, edits[0]);
    assert.deepEqual(await counts(workspaceId), {
      notes: 1,
      people: 0,
      events: 2,
      receipts: 2,
      outbox: 2,
    });
  });

  void it("allows exactly one of two conflicting edits and reports the winning revision", async () => {
    const { principal, workspaceId } = await workspace();
    const initial = await repo.saveNote(principal, workspaceId, note());
    const results = await Promise.allSettled(
      ["First", "Second"].map((title) =>
        repo.saveNote(
          principal,
          workspaceId,
          note({
            id: initial.id,
            expectedRevision: 1,
            content: { title, transcript: "" },
          }),
        ),
      ),
    );
    const successes = results.filter((value) => value.status === "fulfilled");
    const failures = results.filter((value) => value.status === "rejected");
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(code("conflict")(failures[0]?.reason));
    assert.equal((failures[0]?.reason as WorkspaceError).currentRevision, 2);
    assert.deepEqual(await repo.getNote(principal, workspaceId, initial.id), successes[0]?.value);
    assert.deepEqual(await counts(workspaceId), {
      notes: 1,
      people: 0,
      events: 2,
      receipts: 2,
      outbox: 2,
    });
  });

  void it("denies cross-workspace reads, lists, commands and history", async () => {
    const a = await workspace();
    const b = await workspace();
    const n = await repo.saveNote(a.principal, a.workspaceId, note());
    const p = await repo.savePerson(a.principal, a.workspaceId, person());
    const beforeA = await counts(a.workspaceId);
    const beforeB = await counts(b.workspaceId);
    const attempts = [
      () => repo.getNote(b.principal, a.workspaceId, n.id),
      () => repo.getNote(b.principal, a.workspaceId, n.id, true),
      () => repo.getPerson(b.principal, a.workspaceId, p.id),
      () => repo.getPerson(b.principal, a.workspaceId, p.id, true),
      () => repo.listNotes(b.principal, a.workspaceId, page),
      () => repo.listPeople(b.principal, a.workspaceId, peoplePage),
      () => repo.saveNote(b.principal, a.workspaceId, note({ id: n.id, expectedRevision: 1 })),
      () => repo.savePerson(b.principal, a.workspaceId, person({ id: p.id, expectedRevision: 1 })),
      () =>
        repo.deleteNote(b.principal, a.workspaceId, {
          commandId: randomUUID(),
          id: n.id,
          expectedRevision: 1,
        }),
      () =>
        repo.deletePerson(b.principal, a.workspaceId, {
          commandId: randomUUID(),
          id: p.id,
          expectedRevision: 1,
        }),
      () => repo.history(b.principal, a.workspaceId, "note", n.id, page),
      () => repo.history(b.principal, a.workspaceId, "person", p.id, page),
    ];
    for (const attempt of attempts) await assert.rejects(attempt, code("forbidden"));
    await assert.rejects(repo.getNote(b.principal, b.workspaceId, n.id), code("not_found"));
    await assert.rejects(repo.getPerson(b.principal, b.workspaceId, p.id), code("not_found"));
    await assert.rejects(
      repo.history(b.principal, b.workspaceId, "note", n.id, page),
      code("not_found"),
    );
    await assert.rejects(
      repo.history(b.principal, b.workspaceId, "person", p.id, page),
      code("not_found"),
    );
    await assert.rejects(
      repo.saveNote(b.principal, b.workspaceId, note({ id: n.id, expectedRevision: 1 })),
      code("conflict"),
    );
    await assert.rejects(
      repo.savePerson(b.principal, b.workspaceId, person({ id: p.id, expectedRevision: 1 })),
      code("conflict"),
    );
    assert.deepEqual((await repo.listNotes(b.principal, b.workspaceId, page)).items, []);
    assert.deepEqual((await repo.listPeople(b.principal, b.workspaceId, peoplePage)).items, []);
    assert.deepEqual(await counts(a.workspaceId), beforeA);
    assert.deepEqual(await counts(b.workspaceId), beforeB);
  });

  void it("rejects cross-workspace references at PostgreSQL composite foreign keys", async () => {
    const a = await workspace();
    const b = await workspace();
    const n = await repo.saveNote(a.principal, a.workspaceId, note());
    const p = await repo.savePerson(a.principal, a.workspaceId, person());
    const own = await repo.saveNote(b.principal, b.workspaceId, note());
    const [event] = await sql<
      { id: string }[]
    >`select id from domain_events where workspace_id = ${b.workspaceId} and entity_id = ${own.id}`;
    const [foreignEvent] = await sql<
      { id: string; command_id: string }[]
    >`select id, command_id from domain_events where workspace_id = ${a.workspaceId} and entity_id = ${n.id}`;
    assert.ok(event && foreignEvent);
    await assert.rejects(
      sql`update domain_events set entity_id = ${n.id}, note_id = ${n.id} where workspace_id = ${b.workspaceId} and id = ${event.id}`,
      pgCode("23503"),
    );
    await assert.rejects(
      sql`update domain_events set entity_type = 'person', entity_id = ${p.id}, note_id = null, person_id = ${p.id} where workspace_id = ${b.workspaceId} and id = ${event.id}`,
      pgCode("23503"),
    );
    await assert.rejects(
      sql`update outbox set event_id = ${foreignEvent.id} where workspace_id = ${b.workspaceId}`,
      pgCode("23503"),
    );
    await assert.rejects(
      sql`update command_receipts set actor_id = ${a.principal.id} where workspace_id = ${b.workspaceId}`,
      pgCode("23503"),
    );
    await assert.rejects(
      sql`update domain_events set actor_id = ${a.principal.id} where workspace_id = ${b.workspaceId}`,
      pgCode("23503"),
    );
    await assert.rejects(
      sql`update domain_events set command_id = ${foreignEvent.command_id} where workspace_id = ${b.workspaceId}`,
      pgCode("23503"),
    );
    await assert.rejects(
      sql`update people set account_id = ${b.principal.id} where workspace_id = ${a.workspaceId}`,
      pgCode("23503"),
    );
  });

  void it("keeps note tombstones and history, with repeatable delete receipts", async () => {
    const { principal, workspaceId } = await workspace();
    const created = await repo.saveNote(principal, workspaceId, note());
    const command = { commandId: randomUUID(), id: created.id, expectedRevision: 1 };
    const deleted = await repo.deleteNote(principal, workspaceId, command);
    assert.equal(deleted.revision, 2);
    assert.ok(deleted.deletedAt);
    assert.deepEqual(await repo.deleteNote(principal, workspaceId, command), deleted);
    await assert.rejects(repo.getNote(principal, workspaceId, created.id), code("not_found"));
    assert.deepEqual(await repo.getNote(principal, workspaceId, created.id, true), deleted);
    assert.deepEqual((await repo.listNotes(principal, workspaceId, page)).items, []);
    await assert.rejects(
      repo.saveNote(principal, workspaceId, note({ id: created.id, expectedRevision: 2 })),
    );
    const history = await repo.history(principal, workspaceId, "note", created.id, page);
    assert.deepEqual(history.items.map((event) => event.revision).sort(), [1, 2]);
    const [stored] =
      await sql`select deleted_at, revision from notes where workspace_id = ${workspaceId} and id = ${created.id}`;
    assert.ok(stored?.deleted_at);
    assert.equal(stored?.revision, 2);
    assert.deepEqual(await counts(workspaceId), {
      notes: 1,
      people: 0,
      events: 2,
      receipts: 2,
      outbox: 2,
    });
  });

  void it("applies optimistic revisions, retries and tombstones to people", async () => {
    const { principal, workspaceId } = await workspace();
    const command = person();
    const created = await repo.savePerson(principal, workspaceId, command);
    const edit = person({
      id: created.id,
      expectedRevision: 1,
      content: { displayName: "Grace Hopper", description: "Edited" },
    });
    const updated = await repo.savePerson(principal, workspaceId, edit);
    assert.equal(updated.revision, 2);
    assert.deepEqual(await repo.savePerson(principal, workspaceId, command), created);
    assert.deepEqual(await repo.savePerson(principal, workspaceId, edit), updated);
    await assert.rejects(
      repo.savePerson(principal, workspaceId, person({ id: created.id, expectedRevision: 1 })),
      code("conflict"),
    );
    const remove = { commandId: randomUUID(), id: created.id, expectedRevision: 2 };
    const deleted = await repo.deletePerson(principal, workspaceId, remove);
    assert.ok(deleted.deletedAt);
    assert.equal(deleted.revision, 3);
    assert.deepEqual(await repo.deletePerson(principal, workspaceId, remove), deleted);
    await assert.rejects(repo.getPerson(principal, workspaceId, created.id), code("not_found"));
    assert.deepEqual(await repo.getPerson(principal, workspaceId, created.id, true), deleted);
    await assert.rejects(
      repo.savePerson(principal, workspaceId, person({ id: created.id, expectedRevision: 3 })),
    );
    assert.deepEqual((await repo.listPeople(principal, workspaceId, peoplePage)).items, []);
    const history = await repo.history(principal, workspaceId, "person", created.id, page);
    assert.deepEqual(history.items.map((event) => event.revision).sort(), [1, 2, 3]);
    assert.deepEqual(await counts(workspaceId), {
      notes: 0,
      people: 1,
      events: 3,
      receipts: 3,
      outbox: 3,
    });
  });

  void it("paginates notes with tied timestamps and people without duplicates or omissions", async () => {
    const { principal, workspaceId } = await workspace();
    const noteIds: string[] = [];
    const personIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      noteIds.push((await repo.saveNote(principal, workspaceId, note())).id);
      personIds.push(
        (
          await repo.savePerson(
            principal,
            workspaceId,
            person({ content: { displayName: `Person ${i}`, description: "" } }),
          )
        ).id,
      );
    }
    await sql`update notes set updated_at = '2026-01-01T00:00:00Z' where workspace_id = ${workspaceId}`;
    const notes = await collect((query) => repo.listNotes(principal, workspaceId, query), 2);
    const people = await collect(
      (query) => repo.listPeople(principal, workspaceId, { ...query, q: "" }),
      2,
    );
    assert.deepEqual(notes.map((value) => value.id).sort(), noteIds.sort());
    assert.deepEqual(people.map((value) => value.id).sort(), personIds.sort());
    assert.equal((await repo.listNotes(principal, workspaceId, { limit: 1 })).items.length, 1);
  });

  void it("bounds history pages and rejects invalid or cross-context cursors", async () => {
    const { principal, workspaceId } = await workspace();
    const initial = await repo.saveNote(principal, workspaceId, note());
    for (let revision = 1; revision < 7; revision++) {
      await repo.saveNote(
        principal,
        workspaceId,
        note({ id: initial.id, expectedRevision: revision }),
      );
    }
    const events = await collect(
      (query) => repo.history(principal, workspaceId, "note", initial.id, query),
      2,
    );
    assert.deepEqual(events.map((event) => event.revision).sort(), [1, 2, 3, 4, 5, 6, 7]);
    await assert.rejects(
      repo.listNotes(principal, workspaceId, { limit: 2, cursor: "not-a-cursor" }),
      code("invalid_cursor"),
    );
    await assert.rejects(
      repo.listPeople(principal, workspaceId, { limit: 2, q: "", cursor: "not-a-cursor" }),
      code("invalid_cursor"),
    );
    await assert.rejects(
      repo.history(principal, workspaceId, "note", initial.id, {
        limit: 2,
        cursor: "not-a-cursor",
      }),
      code("invalid_cursor"),
    );
    const history = await repo.history(principal, workspaceId, "note", initial.id, { limit: 2 });
    assert.ok(history.nextCursor);
    const other = await repo.saveNote(principal, workspaceId, note());
    await assert.rejects(
      repo.history(principal, workspaceId, "note", other.id, {
        limit: 2,
        cursor: history.nextCursor,
      }),
      code("invalid_cursor"),
    );
  });

  void it("uses case-insensitive literal prefix search for people", async () => {
    const { principal, workspaceId } = await workspace();
    for (const displayName of [
      "Ada Lovelace",
      "ADAM",
      "Not Ada",
      "A_percent",
      "ABpercent",
      "A%literal",
    ]) {
      await repo.savePerson(
        principal,
        workspaceId,
        person({ content: { displayName, description: "" } }),
      );
    }
    const names = async (q: string) =>
      (await repo.listPeople(principal, workspaceId, { q, limit: 50 })).items
        .map((p) => p.displayName)
        .sort();
    assert.deepEqual(await names("ada"), ["ADAM", "Ada Lovelace"]);
    assert.deepEqual(await names("A_"), ["A_percent"]);
    assert.deepEqual(await names("A%"), ["A%literal"]);
  });

  void it("searches literal title prefixes with bounded query-bound pages and excludes tombstones", async () => {
    const { principal, workspaceId } = await workspace();
    for (const title of [
      "Alpha",
      "ALPINE",
      "Not Alpha",
      "A_percent",
      "ABpercent",
      "A%literal",
      "A\\literal",
    ])
      await repo.saveNote(principal, workspaceId, note({ content: { title, transcript: "" } }));
    const titles = async (q: string) =>
      (await repo.listNotes(principal, workspaceId, { q, limit: 50 })).items
        .map((n) => n.title)
        .sort();
    assert.deepEqual(await titles("alp"), ["ALPINE", "Alpha"]);
    assert.deepEqual(await titles("A_"), ["A_percent"]);
    assert.deepEqual(await titles("A%"), ["A%literal"]);
    assert.deepEqual(await titles("A\\"), ["A\\literal"]);
    const first = await repo.listNotes(principal, workspaceId, { q: "alp", limit: 1 });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const second = await repo.listNotes(principal, workspaceId, {
      q: "alp",
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 1);
    assert.notEqual(first.items[0]?.id, second.items[0]?.id);
    await assert.rejects(
      repo.listNotes(principal, workspaceId, { q: "other", limit: 1, cursor: first.nextCursor }),
      code("invalid_cursor"),
    );
    const removed = first.items[0]!;
    await repo.deleteNote(principal, workspaceId, {
      commandId: randomUUID(),
      id: removed.id,
      expectedRevision: removed.revision,
    });
    assert.equal((await titles("alp")).length, 1);
    await assert.rejects(repo.listNotes(principal, workspaceId, { q: "a".repeat(301), limit: 1 }));
  });

  void it("does not expose or overwrite obsolete legacy data when editing notes", async () => {
    const { principal, workspaceId } = await workspace();
    const initial = await repo.saveNote(principal, workspaceId, note());
    const legacy = [{ speaker: "Old prototype label", text: "Retained historical data" }];
    await sql`update notes set legacy_utterances = ${JSON.stringify(legacy)}::jsonb where workspace_id = ${workspaceId} and id = ${initial.id}`;
    const updated = await repo.saveNote(
      principal,
      workspaceId,
      note({
        id: initial.id,
        expectedRevision: 1,
        content: { title: "Edited", transcript: "New transcript" },
      }),
    );
    assert.equal("legacyUtterances" in updated, false);
    assert.equal(
      "legacyUtterances" in (await repo.getNote(principal, workspaceId, initial.id)),
      false,
    );
    const [stored] =
      await sql`select legacy_utterances from notes where workspace_id = ${workspaceId} and id = ${initial.id}`;
    assert.deepEqual(stored?.legacy_utterances, legacy);
  });

  void it("rolls back people mutations and deletions after a late outbox failure", async () => {
    const { principal, workspaceId } = await workspace();
    const n = await repo.saveNote(principal, workspaceId, note());
    const p = await repo.savePerson(principal, workspaceId, person());
    const baseline = await counts(workspaceId);
    await failInsert("outbox", workspaceId, async () => {
      const attempts = [
        () => repo.savePerson(principal, workspaceId, person()),
        () => repo.savePerson(principal, workspaceId, person({ id: p.id, expectedRevision: 1 })),
        () =>
          repo.deleteNote(principal, workspaceId, {
            id: n.id,
            expectedRevision: 1,
            commandId: randomUUID(),
          }),
        () =>
          repo.deletePerson(principal, workspaceId, {
            id: p.id,
            expectedRevision: 1,
            commandId: randomUUID(),
          }),
      ];
      for (const attempt of attempts) {
        await assert.rejects(attempt, pgCode("P0001"));
        assert.deepEqual(await counts(workspaceId), baseline);
        assert.deepEqual(await repo.getNote(principal, workspaceId, n.id), n);
        assert.deepEqual(await repo.getPerson(principal, workspaceId, p.id), p);
      }
    });
  });

  void it("binds receipts to the actor and rechecks membership before acknowledging retries", async () => {
    const a = await workspace();
    const b = await workspace();
    await sql`insert into workspace_memberships (workspace_id, user_id, role) values (${a.workspaceId}, ${b.principal.id}, 'member')`;
    const command = note();
    const created = await repo.saveNote(a.principal, a.workspaceId, command);
    await assert.rejects(
      repo.saveNote(b.principal, a.workspaceId, command),
      code("command_reused"),
    );
    const otherCommand = note();
    await repo.saveNote(b.principal, a.workspaceId, otherCommand);
    const baseline = await counts(a.workspaceId);
    await sql`update workspace_memberships set revoked_at = now() where workspace_id = ${a.workspaceId} and user_id = ${b.principal.id}`;
    await assert.rejects(
      repo.saveNote(b.principal, a.workspaceId, otherCommand),
      code("forbidden"),
    );
    await assert.rejects(repo.getNote(b.principal, a.workspaceId, created.id), code("forbidden"));
    await assert.rejects(
      repo.history(b.principal, a.workspaceId, "note", created.id, page),
      code("forbidden"),
    );
    assert.deepEqual(await counts(a.workspaceId), baseline);
  });

  void it("rejects unbounded, fractional, and nonpositive page sizes at the repository boundary", async () => {
    const { principal, workspaceId } = await workspace();
    const n = await repo.saveNote(principal, workspaceId, note());
    for (const limit of [0, -1, 1.5, 51, 10000]) {
      const invalidLimit = (error: unknown) => error instanceof Error && error.name === "ZodError";
      await assert.rejects(repo.listNotes(principal, workspaceId, { limit }), invalidLimit);
      await assert.rejects(repo.listPeople(principal, workspaceId, { limit, q: "" }), invalidLimit);
      await assert.rejects(
        repo.history(principal, workspaceId, "note", n.id, { limit }),
        invalidLimit,
      );
    }
  });
});

async function collect<T extends { id: string }>(
  read: (query: ListQuery) => Promise<{ items: T[]; nextCursor: string | null }>,
  limit: number,
) {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pages = 0; pages < 20; pages++) {
    const result = await read(cursor ? { limit, cursor } : { limit });
    assert.ok(result.items.length <= limit, "repository must honor the requested page bound");
    for (const item of result.items) {
      assert.ok(!seen.has(item.id), "an entity/event must appear in only one page");
      seen.add(item.id);
      items.push(item);
    }
    if (!result.nextCursor) return items;
    assert.notEqual(result.nextCursor, cursor, "pagination cursor must make progress");
    cursor = result.nextCursor;
  }
  assert.fail("pagination did not terminate");
}
