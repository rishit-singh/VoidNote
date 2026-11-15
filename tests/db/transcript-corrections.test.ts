import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "../../src/db/schema";
import { createRecordingRepository, type NormalizedTurn } from "../../src/db/recording-repository";
import { createWorkspaceRepository } from "../../src/db/repository";
import { createTranscriptCorrectionRepository } from "../../src/db/transcript-correction-repository";
import { WorkspaceError, type Principal } from "../../src/contracts/workspace";
import {
  type CorrectionCommand,
  type CorrectedTurn,
  correctionHistoryPageSchema,
  correctedTranscriptPageSchema,
  personAppearancesSchema,
} from "../../src/contracts/transcript-corrections";

// Match the repository's dedicated, empty-DB fixture and advisory suite lock.
// No application environment files or credentials are read by this test.
const url = process.env.TEST_DATABASE_URL;
if (!url || !/(^|[_-])test($|[_-])/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("A dedicated empty TEST_DATABASE_URL is required.");
const sql = postgres(url, { max: 12, prepare: false, connect_timeout: 5, onnotice: () => {} });
let queryCount = 0;
const db = drizzle(sql, {
  schema,
  logger: {
    logQuery: () => {
      queryCount += 1;
    },
  },
});
const repo = createTranscriptCorrectionRepository(db);
const recordingRepo = createRecordingRepository(db);
const workspaceRepo = createWorkspaceRepository(db);
const migrationsSchema = `correction_test_migrations_${randomUUID().replaceAll("-", "")}`;
const lock = await sql.reserve();
let ownsTables = false;
async function teardown() {
  try {
    if (ownsTables) {
      for (const table of [
        "transcript_correction_outbox",
        "transcript_sample_candidates",
        "transcript_corrections",
        "transcript_segments",
        "processing_outbox",
        "recording_events",
        "transcript_utterances",
        "processing_runs",
        "recordings",
        "outbox",
        "domain_events",
        "command_receipts",
        "people",
        "notes",
        "workspace_memberships",
        "workspaces",
        "user_profiles",
      ])
        await sql`drop table if exists ${sql(`public.${table}`)}`;
      await sql`drop schema if exists ${sql(migrationsSchema)} cascade`;
    }
  } finally {
    await lock`select pg_advisory_unlock(72002, 1)`;
    lock.release();
    await sql.end({ timeout: 5 });
  }
}
try {
  const [result] = await lock`select pg_try_advisory_lock(72002, 1) as acquired`;
  assert.equal(result?.acquired, true, "another DB suite owns this database");
  const existing =
    await sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and c.relkind in ('r','p','v','m','S')`;
  assert.equal(existing.length, 0, "refusing to migrate a nonempty database");
  ownsTables = true;
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    migrationsSchema,
  });
} catch (error) {
  await teardown();
  throw error;
}

const code = (expected: WorkspaceError["code"]) => (error: unknown) =>
  error instanceof WorkspaceError && error.code === expected;
const turns: NormalizedTurn[] = [
  { start: 0, end: 4, speaker: "SPEAKER_00", text: "Hello Ada and Grace" },
  { start: 3, end: 6, speaker: "SPEAKER_00", text: "Overlapping speech" },
  { start: 7, end: 10, speaker: "SPEAKER_01", text: "Another track" },
];
type Owner = { principal: Principal; workspaceId: string; noteId: string };
async function newRun(owner: Owner, inputTurns = turns) {
  if ("runId" in owner) {
    const note = await workspaceRepo.saveNote(owner.principal, owner.workspaceId, {
      id: randomUUID(),
      commandId: randomUUID(),
      expectedRevision: 0,
      content: { title: "Another conversation", transcript: "" },
    });
    owner = { ...owner, noteId: note.id };
  }
  const { principal, workspaceId, noteId } = owner;
  const recordingId = randomUUID();
  await recordingRepo.initialize(principal, workspaceId, noteId, {
    id: recordingId,
    sha256: "a".repeat(64),
    bytes: 20,
    durationSeconds: 7200,
    mimeType: "audio/webm",
  });
  await recordingRepo.acknowledge(principal, workspaceId, noteId, recordingId, 20);
  const run = await recordingRepo.requestProcessing(
    principal,
    workspaceId,
    noteId,
    recordingId,
    randomUUID(),
  );
  await recordingRepo.claimSubmission(workspaceId, run.id);
  await recordingRepo.bindJob(workspaceId, run.id, randomUUID());
  await recordingRepo.publish(workspaceId, run.id, "private/raw.json", inputTurns);
  return {
    ...owner,
    runId: run.id,
    recordingId,
    page: (cursor?: string) => repo.transcript(principal, workspaceId, noteId, run.id, cursor),
    command: (input: CorrectionCommand) =>
      repo.command(principal, workspaceId, noteId, run.id, input),
    history: (cursor?: string) => repo.history(principal, workspaceId, noteId, run.id, cursor),
  };
}
async function fixture(inputTurns = turns) {
  const principal = { id: randomUUID(), email: null };
  const workspace = await workspaceRepo.ensureWorkspace(principal);
  const note = await workspaceRepo.saveNote(principal, workspace.id, {
    id: randomUUID(),
    commandId: randomUUID(),
    expectedRevision: 0,
    content: { title: "Conversation", transcript: "Manual note text" },
  });
  const person = await workspaceRepo.savePerson(principal, workspace.id, {
    id: randomUUID(),
    commandId: randomUUID(),
    expectedRevision: 0,
    content: { displayName: "Ada", description: "Guest" },
  });
  return {
    ...(await newRun({ principal, workspaceId: workspace.id, noteId: note.id }, inputTurns)),
    person,
    note,
  };
}
function assign(items: CorrectedTurn[], personId?: string): CorrectionCommand {
  return {
    kind: "assign",
    commandId: randomUUID(),
    targets: items.map((item) => ({
      id: item.id,
      expectedAttributionRevision: item.attributionRevision,
    })),
    assignment: personId ? { kind: "person", personId } : { kind: "unknown" },
  };
}
async function counts(workspaceId: string) {
  const [row] = await sql`select
    (select count(*)::int from transcript_corrections where workspace_id=${workspaceId}) as batches,
    (select count(*)::int from transcript_correction_outbox where workspace_id=${workspaceId}) as outbox,
    (select count(*)::int from transcript_sample_candidates where workspace_id=${workspaceId}) as samples`;
  return row;
}

void describe("transcript corrections / isolated real PostgreSQL", { concurrency: false }, () => {
  after(teardown);

  void it("assigns a selected middle span atomically, replays exactly and undoes all three children", async () => {
    const s = await fixture();
    const original = (await s.page()).items[0]!;
    const command: CorrectionCommand = {
      kind: "split",
      commandId: randomUUID(),
      utteranceId: original.id,
      expectedRevision: original.revision,
      splitSeconds: 2,
      textOffset: 9,
      leftId: randomUUID(),
      rightId: randomUUID(),
      selection: {
        startOffset: 6,
        endOffset: 9,
        startSeconds: 1,
        endSeconds: 2,
        selectedId: randomUUID(),
        assignment: { kind: "person", personId: s.person.id },
      },
    };
    const receipt = await s.command(command);
    assert.deepEqual(await s.command(command), receipt);
    const children = (await s.page()).items.filter((t) => t.parentId === original.id);
    assert.equal(children.length, 3);
    assert.equal(children.map((t) => t.text).join(""), original.text);
    assert.equal(children[1]!.text, "Ada");
    assert.deepEqual(children[1]!.assignment, { kind: "person", personId: s.person.id });
    assert.equal(children[0]!.assignment.kind, "unassigned");
    assert.equal(children[2]!.assignment.kind, "unassigned");
    assert.deepEqual(await counts(s.workspaceId), { batches: 1, outbox: 1, samples: 1 });
    await assert.rejects(s.command({ ...command, commandId: randomUUID() }), code("conflict"));
    await s.command({ kind: "undo", commandId: randomUUID(), correctionId: receipt.id });
    const restored = (await s.page()).items;
    assert.equal(restored.length, 3);
    assert.equal(restored[0]!.id, original.id);
    assert.equal(restored[0]!.text, original.text);
  });

  void it("rejects invalid selection bounds and foreign people without partial splits", async () => {
    const s = await fixture();
    const original = (await s.page()).items[0]!;
    const base: CorrectionCommand = {
      kind: "split",
      commandId: randomUUID(),
      utteranceId: original.id,
      expectedRevision: original.revision,
      splitSeconds: 2,
      textOffset: 9,
      leftId: randomUUID(),
      rightId: randomUUID(),
      selection: {
        startOffset: 6,
        endOffset: 9,
        startSeconds: 0,
        endSeconds: 2,
        selectedId: randomUUID(),
        assignment: { kind: "unknown" },
      },
    };
    await assert.rejects(s.command(base), code("conflict"));
    await assert.rejects(
      s.command({
        ...base,
        commandId: randomUUID(),
        selection: {
          ...base.selection!,
          startSeconds: 1,
          assignment: { kind: "person", personId: randomUUID() },
        },
      }),
      code("not_found"),
    );
    assert.deepEqual((await s.page()).items[0], original);
    assert.deepEqual(await counts(s.workspaceId), { batches: 0, outbox: 0, samples: 0 });
  });

  void it("materializes once, preserves provider originals/overlap and distinguishes manual unknown", async () => {
    const s = await fixture();
    const pages = await Promise.all(Array.from({ length: 4 }, () => s.page()));
    assert.deepEqual(pages[0], pages[1]);
    const initial = correctedTranscriptPageSchema.parse(pages[0]).items;
    assert.equal(initial.length, 3);
    assert.ok(
      initial.every(
        (t) =>
          t.revision === 0 &&
          t.assignment.kind === "unassigned" &&
          t.parentId === null &&
          t.sourceUtteranceId === t.id,
      ),
    );
    const saved = await s.command(assign([initial[0]!]));
    const current = (await s.page()).items;
    assert.deepEqual(current[0]!.assignment, { kind: "unknown" });
    assert.equal(current[0]!.assignmentSource, "manual");
    assert.equal(current[1]!.assignment.kind, "unassigned");
    assert.ok(current[1]!.startSeconds < current[0]!.endSeconds);
    await recordingRepo.publish(s.workspaceId, s.runId, "late.json", [
      { start: 1, end: 2, speaker: "REPLACED", text: "Late provider response" },
    ]);
    assert.deepEqual((await s.page()).items, current);
    const original = await recordingRepo.transcript(
      s.principal,
      s.workspaceId,
      s.noteId,
      s.runId,
      -1,
    );
    assert.equal(original.items[0]!.text, turns[0]!.text);
    assert.equal(original.items[0]!.speakerLabel, turns[0]!.speaker);
    const [note] =
      await sql`select revision, transcript from notes where workspace_id=${s.workspaceId} and id=${s.noteId}`;
    assert.deepEqual(note, { revision: 1, transcript: "Manual note text" });
    assert.equal(saved.affectedCount, 1);
    assert.deepEqual(await counts(s.workspaceId), { batches: 1, outbox: 1, samples: 0 });
  });

  void it("reuses one persisted identity across tracks/recordings and renames without reassigning", async () => {
    const s = await fixture();
    const initial = (await s.page()).items;
    await s.command(assign([initial[0]!, initial[2]!], s.person.id));
    const other = await newRun(s);
    await other.command(assign([(await other.page()).items[1]!], s.person.id));
    const renamed = await workspaceRepo.savePerson(s.principal, s.workspaceId, {
      commandId: randomUUID(),
      id: s.person.id,
      expectedRevision: 1,
      content: { displayName: "Ada renamed", description: "Guest" },
    });
    assert.equal(renamed.revision, 2);
    const current = (await s.page()).items;
    assert.equal(current[0]!.personName, "Ada renamed");
    assert.equal(current[0]!.attributionRevision, 1);
    assert.equal(current[1]!.assignment.kind, "unassigned");
    assert.equal(current[2]!.personName, "Ada renamed");
    const appearances = personAppearancesSchema.parse(
      await repo.appearances(s.principal, s.workspaceId, s.person.id),
    );
    assert.equal(appearances.items.length, 3);
    assert.equal(new Set(appearances.items.map((a) => a.recordingId)).size, 2);
  });

  void it("returns canonical actor-bound receipts before revisions, including concurrent retries", async () => {
    const s = await fixture();
    const command = assign((await s.page()).items, s.person.id);
    assert.equal(command.kind, "assign");
    if (command.kind !== "assign") throw new Error();
    const results = await Promise.all(Array.from({ length: 5 }, () => s.command(command)));
    assert.ok(results.every((r) => r.id === results[0]!.id));
    assert.deepEqual(
      await s.command({ ...command, targets: [...command.targets].reverse() }),
      results[0],
    );
    await assert.rejects(
      s.command({ ...command, assignment: { kind: "unknown" } }),
      code("command_reused"),
    );
    const member: Principal = { id: randomUUID(), email: null };
    await db.insert(schema.userProfiles).values({ id: member.id });
    await db
      .insert(schema.workspaceMemberships)
      .values({ workspaceId: s.workspaceId, userId: member.id, role: "member" });
    await assert.rejects(
      repo.command(member, s.workspaceId, s.noteId, s.runId, command),
      code("command_reused"),
    );
    await sql`update workspace_memberships set revoked_at=now() where workspace_id=${s.workspaceId} and user_id=${s.principal.id}`;
    await assert.rejects(s.command(command), code("forbidden"));
    assert.deepEqual(await counts(s.workspaceId), { batches: 1, outbox: 1, samples: 3 });
  });

  void it("serializes competing revisions and rejects an entire stale frozen batch", async () => {
    const s = await fixture();
    const initial = (await s.page()).items;
    const outcomes = await Promise.allSettled([
      s.command(assign([initial[0]!], s.person.id)),
      s.command(assign([initial[0]!])),
    ]);
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = outcomes.find((r) => r.status === "rejected");
    assert.ok(rejected?.status === "rejected" && code("conflict")(rejected.reason));
    const before = await counts(s.workspaceId);
    await assert.rejects(
      s.command(assign(initial)),
      (error: unknown) =>
        code("conflict")(error) &&
        error instanceof WorkspaceError &&
        error.affectedTargets?.includes(initial[0]!.id) === true,
    );
    assert.deepEqual(await counts(s.workspaceId), before);
    assert.equal((await s.page()).items[1]!.revision, 0);
  });

  void it("serializes reused command IDs across different runs", async () => {
    const s = await fixture();
    const other = await newRun(s);
    const commandId = randomUUID();
    const a = { ...assign([(await s.page()).items[0]!]), commandId };
    const b = { ...assign([(await other.page()).items[0]!]), commandId };
    const outcomes = await Promise.allSettled([s.command(a), other.command(b)]);
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok(outcomes.some((r) => r.status === "rejected" && code("command_reused")(r.reason)));
    assert.equal((await counts(s.workspaceId))?.batches, 1);
  });

  void it(
    "does not deadlock concurrent late publication and correction commands",
    { timeout: 5000 },
    async () => {
      const s = await fixture();
      const original = (await s.page()).items[0]!;
      await Promise.all([
        s.command(assign([original])),
        ...Array.from({ length: 5 }, () =>
          recordingRepo.publish(s.workspaceId, s.runId, "late.json", [
            { start: 0, end: 1, speaker: "LATE", text: "must not replace original" },
          ]),
        ),
      ]);
      const current = (await s.page()).items[0]!;
      assert.equal(current.assignment.kind, "unknown");
      assert.equal(current.originalText, original.text);
      assert.equal(current.revision, 1);
    },
  );

  void it("freezes bulk targets, excludes manual labels by default and selects overlapping ranges", async () => {
    const s = await fixture();
    const initial = (await s.page()).items;
    await s.command(assign([initial[0]!]));
    const targets = await repo.targets(s.principal, s.workspaceId, s.noteId, s.runId, {
      speakerLabel: "SPEAKER_00",
    });
    assert.deepEqual(targets, {
      targets: [{ id: initial[1]!.id, expectedAttributionRevision: 0 }],
      excludedManualCount: 1,
    });
    const all = await repo.targets(s.principal, s.workspaceId, s.noteId, s.runId, {
      speakerLabel: "SPEAKER_00",
      includeManual: true,
    });
    assert.equal(all.targets.length, 2);
    assert.equal(all.excludedManualCount, 0);
    const range = await repo.targets(s.principal, s.workspaceId, s.noteId, s.runId, {
      startSeconds: 3.5,
      endSeconds: 4.5,
    });
    assert.deepEqual(range.targets, targets.targets);
    await assert.rejects(
      repo.targets(s.principal, s.workspaceId, s.noteId, s.runId, {
        startSeconds: 4,
        endSeconds: 3,
      }),
    );
    await s.command({
      kind: "assign",
      commandId: randomUUID(),
      targets: targets.targets,
      assignment: { kind: "person", personId: s.person.id },
    });
    assert.equal((await s.page()).items[2]!.assignment.kind, "unassigned");
  });

  void it("boundary edits invalidate frozen attribution targets; undo preserves immutable source spans", async () => {
    const s = await fixture();
    const initial = (await s.page()).items[0]!;
    await workspaceRepo.saveNote(s.principal, s.workspaceId, {
      commandId: randomUUID(),
      id: s.noteId,
      expectedRevision: 1,
      content: { title: "Retitled independently", transcript: "Manual note text" },
    });
    const edited = await s.command({
      kind: "edit",
      commandId: randomUUID(),
      utteranceId: initial.id,
      expectedRevision: 0,
      text: "Corrected words",
      startSeconds: 0.5,
      endSeconds: 3.5,
    });
    const current = (await s.page()).items[0]!;
    assert.equal(current.revision, 1);
    assert.equal(current.attributionRevision, 1);
    await assert.rejects(s.command(assign([initial])), code("conflict"));
    assert.equal(current.originalText, initial.text);
    assert.equal(current.originalStartSeconds, 0);
    assert.equal(current.originalEndSeconds, 4);
    await assert.rejects(
      s.command({
        kind: "edit",
        commandId: randomUUID(),
        utteranceId: initial.id,
        expectedRevision: 0,
        text: "stale",
        startSeconds: 0,
        endSeconds: 2,
      }),
      code("conflict"),
    );
    await assert.rejects(
      s.command({
        kind: "edit",
        commandId: randomUUID(),
        utteranceId: initial.id,
        expectedRevision: 1,
        text: "invalid",
        startSeconds: 3,
        endSeconds: 2,
      }),
    );
    const undo = await s.command({
      kind: "undo",
      commandId: randomUUID(),
      correctionId: edited.id,
    });
    assert.equal(undo.undoOf, edited.id);
    const restored = (await s.page()).items[0]!;
    assert.equal(restored.text, initial.text);
    assert.equal(restored.revision, 2);
    assert.equal(restored.attributionRevision, 2);
    assert.equal(restored.startSeconds, initial.startSeconds);
    const history = correctionHistoryPageSchema.parse(await s.history());
    assert.equal(history.items.length, 2);
    assert.equal(history.items.find((h) => h.id === edited.id)!.after[0]!.text, "Corrected words");
  });

  void it("text-only edits keep frozen attribution targets valid", async () => {
    const s = await fixture();
    const original = (await s.page()).items[0]!;
    await s.command({
      kind: "edit",
      commandId: randomUUID(),
      utteranceId: original.id,
      expectedRevision: original.revision,
      text: "Corrected words only",
      startSeconds: original.startSeconds,
      endSeconds: original.endSeconds,
    });
    await s.command(assign([original]));
    const current = (await s.page()).items[0]!;
    assert.equal(current.text, "Corrected words only");
    assert.equal(current.assignment.kind, "unknown");
  });

  void it("splits stable lineage, preserves original text, and blocks undo over any newer child edit", async () => {
    const s = await fixture();
    const original = (await s.page()).items[0]!;
    const leftId = randomUUID();
    const rightId = randomUUID();
    const split = await s.command({
      kind: "split",
      commandId: randomUUID(),
      utteranceId: original.id,
      expectedRevision: 0,
      splitSeconds: 2,
      textOffset: 9,
      leftId,
      rightId,
    });
    const current = (await s.page()).items;
    assert.equal(current.length, 4);
    assert.deepEqual(
      current.slice(0, 2).map((t) => t.id),
      [leftId, rightId],
    );
    assert.equal(current[0]!.text, "Hello Ada");
    assert.equal(current[1]!.text, "and Grace");
    for (const child of current.slice(0, 2)) {
      assert.equal(child.sourceUtteranceId, original.id);
      assert.equal(child.parentId, original.id);
      assert.equal(child.originalText, original.text);
      assert.equal(child.attributionRevision, 1);
    }
    const assigned = await s.command(assign([current[1]!], s.person.id));
    await s.command({ kind: "undo", commandId: randomUUID(), correctionId: assigned.id });
    await assert.rejects(
      s.command({ kind: "undo", commandId: randomUUID(), correctionId: split.id }),
      (error: unknown) =>
        error instanceof WorkspaceError &&
        error.code === "conflict" &&
        error.affectedTargets?.includes(rightId) === true,
    );
    assert.equal((await s.page()).items[0]!.id, leftId);
    assert.equal((await s.page()).items[1]!.assignment.kind, "unassigned");
    await assert.rejects(
      s.command({
        kind: "assign",
        commandId: randomUUID(),
        targets: [{ id: original.id, expectedAttributionRevision: 1 }],
        assignment: { kind: "unknown" },
      }),
      code("conflict"),
    );
    const history = await s.history();
    const event = history.items.find((h) => h.id === split.id)!;
    assert.equal(event.before.length, 1);
    assert.equal(event.after.length, 2);
  });

  void it("undoes splits without deleting children; repeated/nested splits keep precise ordering", async () => {
    const s = await fixture();
    const original = (await s.page()).items[0]!;
    const leftId = randomUUID();
    const rightId = randomUUID();
    const split = await s.command({
      kind: "split",
      commandId: randomUUID(),
      utteranceId: original.id,
      expectedRevision: 0,
      splitSeconds: 2,
      textOffset: 9,
      leftId,
      rightId,
    });
    const undo = await s.command({ kind: "undo", commandId: randomUUID(), correctionId: split.id });
    assert.equal((await s.page()).items.length, 3);
    const [retired] =
      await sql`select active, revision from transcript_segments where workspace_id=${s.workspaceId} and id=${leftId}`;
    assert.deepEqual(retired, { active: false, revision: 2 });
    // Compensating an undo is safe if no target has changed since it.
    await s.command({ kind: "undo", commandId: randomUUID(), correctionId: undo.id });
    assert.equal((await s.page()).items[0]!.id, leftId);
    const child = (await s.page()).items[0]!;
    const childLeft = randomUUID();
    const childRight = randomUUID();
    await s.command({
      kind: "split",
      commandId: randomUUID(),
      utteranceId: leftId,
      expectedRevision: child.revision,
      splitSeconds: 1,
      textOffset: 5,
      leftId: childLeft,
      rightId: childRight,
    });
    const page = await s.page();
    assert.deepEqual(
      page.items.slice(0, 3).map((t) => t.id),
      [childLeft, childRight, rightId],
    );
    assert.equal(page.items[0]!.sourceUtteranceId, original.id);
    assert.equal(page.items[0]!.parentId, leftId);
    const fresh = await fixture();
    const root = (await fresh.page()).items[0]!;
    const first = await fresh.command({
      kind: "split",
      commandId: randomUUID(),
      utteranceId: root.id,
      expectedRevision: 0,
      splitSeconds: 2,
      textOffset: 9,
      leftId: randomUUID(),
      rightId: randomUUID(),
    });
    await fresh.command({ kind: "undo", commandId: randomUUID(), correctionId: first.id });
    await fresh.command({
      kind: "split",
      commandId: randomUUID(),
      utteranceId: root.id,
      expectedRevision: 2,
      splitSeconds: 2,
      textOffset: 9,
      leftId: randomUUID(),
      rightId: randomUUID(),
    });
    assert.equal((await fresh.page()).items.length, 4);
  });

  void it("undo never restores over newer attribution and invalidates sample evidence atomically", async () => {
    const s = await fixture();
    const initial = (await s.page()).items;
    const first = await s.command(assign([initial[0]!], s.person.id));
    await sql`update transcript_sample_candidates set state='confirmed' where workspace_id=${s.workspaceId} and correction_id=${first.id}`;
    await s.command(assign([(await s.page()).items[1]!], s.person.id));
    const undo = await s.command({ kind: "undo", commandId: randomUUID(), correctionId: first.id });
    assert.equal(undo.undoOf, first.id);
    const current = (await s.page()).items;
    assert.equal(current[0]!.assignment.kind, "unassigned");
    assert.equal(current[0]!.sampleSuitability, "invalidated");
    assert.equal(current[1]!.assignment.kind, "person");
    const [candidate] =
      await sql`select state, invalidated_at, start_seconds, end_seconds from transcript_sample_candidates where workspace_id=${s.workspaceId} and correction_id=${first.id}`;
    assert.equal(candidate?.state, "invalidated");
    assert.ok(candidate?.invalidated_at);
    assert.equal(candidate?.start_seconds, 0);
    assert.equal(candidate?.end_seconds, 4);
    await assert.rejects(
      s.command({ kind: "undo", commandId: randomUUID(), correctionId: first.id }),
      code("conflict"),
    );
    const next = await s.command(assign([current[0]!], s.person.id));
    await s.command(assign([(await s.page()).items[0]!]));
    await assert.rejects(
      s.command({ kind: "undo", commandId: randomUUID(), correctionId: next.id }),
      code("conflict"),
    );
    assert.equal((await repo.appearances(s.principal, s.workspaceId, s.person.id)).items.length, 1);
    const latest = await s.command(assign([(await s.page()).items[0]!], s.person.id));
    const target = (await s.page()).items[0]!;
    await s.command({
      kind: "edit",
      commandId: randomUUID(),
      utteranceId: target.id,
      expectedRevision: target.revision,
      text: "Newer text must survive",
      startSeconds: 0,
      endSeconds: 4,
    });
    await assert.rejects(
      s.command({ kind: "undo", commandId: randomUUID(), correctionId: latest.id }),
      code("conflict"),
    );
    assert.equal((await s.page()).items[0]!.text, "Newer text must survive");
  });

  void it("rolls back projections, receipts, samples and history on a late outbox failure", async () => {
    const s = await fixture();
    const initial = await s.page();
    const name = `correction_failure_${randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(
      `create function public.${name}() returns trigger language plpgsql as $$ begin if NEW.workspace_id = '${s.workspaceId}'::uuid then raise exception 'injected correction outbox failure'; end if; return NEW; end $$`,
    );
    await sql.unsafe(
      `create trigger ${name} before insert on transcript_correction_outbox for each row execute function public.${name}()`,
    );
    const command = assign(initial.items, s.person.id);
    try {
      await assert.rejects(s.command(command));
      assert.deepEqual(await s.page(), initial);
      assert.deepEqual(await counts(s.workspaceId), { batches: 0, outbox: 0, samples: 0 });
    } finally {
      await sql.unsafe(`drop trigger ${name} on transcript_correction_outbox`);
      await sql.unsafe(`drop function public.${name}()`);
    }
    await s.command(command);
    assert.deepEqual(await counts(s.workspaceId), { batches: 1, outbox: 1, samples: 3 });
  });

  void it("scopes all reads/writes and FKs to active workspaces, notes, recordings and people", async () => {
    const s = await fixture();
    const other = await fixture();
    const first = (await s.page()).items[0]!;
    const command = assign([first]);
    await assert.rejects(
      repo.transcript(other.principal, s.workspaceId, s.noteId, s.runId),
      code("forbidden"),
    );
    await assert.rejects(
      repo.targets(other.principal, s.workspaceId, s.noteId, s.runId, {}),
      code("forbidden"),
    );
    await assert.rejects(
      repo.history(other.principal, s.workspaceId, s.noteId, s.runId),
      code("forbidden"),
    );
    await assert.rejects(
      repo.command(other.principal, s.workspaceId, s.noteId, s.runId, command),
      code("forbidden"),
    );
    await assert.rejects(
      repo.appearances(other.principal, s.workspaceId, s.person.id),
      code("forbidden"),
    );
    await assert.rejects(
      repo.transcript(s.principal, s.workspaceId, other.noteId, s.runId),
      code("not_found"),
    );
    await assert.rejects(
      repo.transcript(s.principal, s.workspaceId, s.noteId, other.runId),
      code("not_found"),
    );
    await assert.rejects(s.command(assign([first], other.person.id)), code("not_found"));
    await assert.rejects(
      sql`update transcript_segments set assignment_kind='person', assignment_source='manual', person_id=${other.person.id} where workspace_id=${s.workspaceId} and id=${first.id}`,
    );
    const saved = await s.command(assign([first], s.person.id));
    const inactivePerson = await workspaceRepo.deletePerson(s.principal, s.workspaceId, {
      commandId: randomUUID(),
      id: s.person.id,
      expectedRevision: 1,
    });
    assert.ok(inactivePerson.deletedAt);
    await assert.rejects(
      s.command(assign([(await s.page()).items[1]!], s.person.id)),
      code("not_found"),
    );
    await assert.rejects(
      repo.appearances(s.principal, s.workspaceId, s.person.id),
      code("not_found"),
    );
    assert.equal((await s.page()).items[0]!.reviewState, "needs_review");
    assert.equal((await s.page()).items[0]!.personName, null);
    await sql`update recordings set deleted_at=now() where workspace_id=${s.workspaceId} and id=${s.recordingId}`;
    await assert.rejects(s.page(), code("not_found"));
    await assert.rejects(s.history(), code("not_found"));
    await assert.rejects(
      s.command({ kind: "undo", commandId: randomUUID(), correctionId: saved.id }),
      code("not_found"),
    );
    await sql`update recordings set deleted_at=null where workspace_id=${s.workspaceId} and id=${s.recordingId}`;
    await workspaceRepo.deleteNote(s.principal, s.workspaceId, {
      commandId: randomUUID(),
      id: s.noteId,
      expectedRevision: 1,
    });
    await assert.rejects(s.page(), code("not_found"));
    await assert.rejects(s.command(command), code("not_found"));
  });

  void it("paginates transcript100/history20/appearances20 with scoped cursors and bounded queries", async () => {
    const s = await fixture(
      Array.from({ length: 103 }, (_, i) => ({
        start: i,
        end: i + 1,
        speaker: "S",
        text: `Speech ${i}`,
      })),
    );
    const page = await s.page();
    assert.equal(page.items.length, 100);
    assert.ok(page.nextCursor);
    queryCount = 0;
    const tail = await s.page(page.nextCursor);
    assert.equal(tail.items.length, 3);
    assert.equal(tail.nextCursor, null);
    assert.ok(queryCount <= 8, `transcript made ${queryCount} queries`);
    const other = await newRun(s);
    await assert.rejects(other.page(page.nextCursor), code("invalid_cursor"));
    await assert.rejects(s.page("not-a-cursor"), code("invalid_cursor"));
    for (const item of page.items.slice(0, 23)) await s.command(assign([item], s.person.id));
    queryCount = 0;
    const history = await s.history();
    assert.equal(history.items.length, 20);
    assert.ok(history.nextCursor);
    assert.ok(queryCount <= 8, `history made ${queryCount} queries`);
    const older = await s.history(history.nextCursor);
    assert.equal(older.items.length, 3);
    assert.equal(older.nextCursor, null);
    assert.equal(new Set([...history.items, ...older.items].map((h) => h.id)).size, 23);
    queryCount = 0;
    const appearances = await repo.appearances(s.principal, s.workspaceId, s.person.id);
    assert.equal(appearances.items.length, 20);
    assert.ok(appearances.nextCursor);
    assert.ok(queryCount <= 5, `appearances made ${queryCount} queries`);
    const next = await repo.appearances(
      s.principal,
      s.workspaceId,
      s.person.id,
      appearances.nextCursor,
    );
    assert.equal(next.items.length, 3);
    assert.equal(new Set([...appearances.items, ...next.items].map((a) => a.utteranceId)).size, 23);
    await sql`update recordings set deleted_at=now() where workspace_id=${s.workspaceId} and id=${s.recordingId}`;
    assert.equal((await repo.appearances(s.principal, s.workspaceId, s.person.id)).items.length, 0);
  });

  void it("accepts 500 frozen targets with a constant query budget and explicitly rejects 501", async () => {
    const s = await fixture(
      Array.from({ length: 501 }, (_, i) => ({
        start: i,
        end: i + 1,
        speaker: "S",
        text: `Speech ${i}`,
      })),
    );
    await assert.rejects(
      repo.targets(s.principal, s.workspaceId, s.noteId, s.runId, { speakerLabel: "S" }),
      code("conflict"),
    );
    const targetPage = await repo.targets(s.principal, s.workspaceId, s.noteId, s.runId, {
      startSeconds: 0,
      endSeconds: 500,
    });
    assert.equal(targetPage.targets.length, 500);
    queryCount = 0;
    const command = {
      kind: "assign" as const,
      commandId: randomUUID(),
      targets: targetPage.targets,
      assignment: { kind: "person" as const, personId: s.person.id },
    };
    const saved = await s.command(command);
    assert.equal(saved.affectedCount, 500);
    assert.ok(queryCount <= 17, `500-target command made ${queryCount} queries`);
    assert.deepEqual(await counts(s.workspaceId), { batches: 1, outbox: 1, samples: 500 });
    const remaining = await repo.targets(s.principal, s.workspaceId, s.noteId, s.runId, {
      speakerLabel: "S",
    });
    assert.equal(remaining.targets.length, 1);
    assert.equal(remaining.excludedManualCount, 500);
    await assert.rejects(
      s.command({
        ...command,
        commandId: randomUUID(),
        targets: [...targetPage.targets, ...remaining.targets],
      }),
    );
  });

  void it("enforces atomic snapshot and page-byte budgets without silently truncating batches", async () => {
    const s = await fixture(
      Array.from({ length: 8 }, (_, i) => ({
        start: i,
        end: i + 1,
        speaker: "S",
        text: "x".repeat(90_000),
      })),
    );
    const initial = (await s.page()).items;
    assert.equal(initial.length, 8);
    await assert.rejects(
      s.command(assign(initial)),
      (error: unknown) => error instanceof WorkspaceError && /2 MiB/.test(error.message),
    );
    assert.ok((await s.page()).items.every((t) => t.revision === 0));
    assert.equal((await counts(s.workspaceId))?.batches, 0);
    await s.command(assign(initial.slice(0, 5)));
    await s.command(assign((await s.page()).items.slice(0, 5)));
    await s.command(assign((await s.page()).items.slice(0, 5)));
    const first = await s.history();
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0]!.before.length, 5);
    assert.equal(first.items[0]!.after.length, 5);
    assert.ok(first.nextCursor);
    const second = await s.history(first.nextCursor);
    assert.equal(second.items.length, 1);
    assert.ok(second.nextCursor);
    const third = await s.history(second.nextCursor);
    assert.equal(third.items.length, 1);
    assert.equal(third.nextCursor, null);
    assert.equal(new Set([first.items[0]!.id, second.items[0]!.id, third.items[0]!.id]).size, 3);
    const long = await newRun(
      s,
      Array.from({ length: 15 }, (_, i) => ({
        start: i,
        end: i + 1,
        speaker: "S",
        text: "y".repeat(90_000),
      })),
    );
    const page = await long.page();
    assert.ok(page.items.length < 15 && page.items.length > 0);
    assert.ok(page.nextCursor);
    const rest = await long.page(page.nextCursor);
    assert.equal(page.items.length + rest.items.length, 15);
  });
});
