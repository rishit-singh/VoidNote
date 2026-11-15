import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "../../src/db/schema";
import { createRecordingRepository } from "../../src/db/recording-repository";
import { createWorkspaceRepository } from "../../src/db/repository";
import { WorkspaceError } from "../../src/contracts/workspace";

// Independent fixture: run this file serially on a fresh TEST_DATABASE_URL.
// Never reads DATABASE_URL, .env files, or the application's private credentials.
const url = process.env.TEST_DATABASE_URL;
if (!url || !/(^|[_-])test($|[_-])/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("A dedicated empty TEST_DATABASE_URL is required.");
const sql = postgres(url, { max: 8, prepare: false, connect_timeout: 5 });
const db = drizzle(sql, { schema });
const repo = createRecordingRepository(db);
const workspaceRepo = createWorkspaceRepository(db);
const migrationSchema = `recording_test_migrations_${randomUUID().replaceAll("-", "")}`;
let ownsTables = false;
const lock = await sql.reserve();
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
      await sql`drop schema if exists ${sql(migrationSchema)} cascade`;
    }
  } finally {
    await lock`select pg_advisory_unlock(72002, 1)`;
    lock.release();
    await sql.end({ timeout: 5 });
  }
}
try {
  const [result] = await lock`select pg_try_advisory_lock(72002, 1) as acquired`;
  assert.equal(result?.acquired, true, "another DB suite owns the database");
  const existing =
    await sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and c.relkind in ('r','p','v','m','S')`;
  assert.equal(existing.length, 0, "refusing to migrate nonempty database");
  ownsTables = true;
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    migrationsSchema: migrationSchema,
  });
} catch (error) {
  await teardown();
  throw error;
}

const code = (expected: WorkspaceError["code"]) => (error: unknown) =>
  error instanceof WorkspaceError && error.code === expected;
async function fixture(initialize = true) {
  const principal = { id: randomUUID(), email: null };
  const workspace = await workspaceRepo.ensureWorkspace(principal);
  const note = await workspaceRepo.saveNote(principal, workspace.id, {
    id: randomUUID(),
    commandId: randomUUID(),
    expectedRevision: 0,
    content: { title: "Recording note", transcript: "Manual text must remain" },
  });
  const input = {
    id: randomUUID(),
    sha256: "a".repeat(64),
    bytes: 20,
    durationSeconds: 10,
    mimeType: "audio/webm" as const,
  };
  if (initialize) await repo.initialize(principal, workspace.id, note.id, input);
  return { principal, workspaceId: workspace.id, noteId: note.id, input };
}
async function readyRun() {
  const state = await fixture();
  await repo.acknowledge(
    state.principal,
    state.workspaceId,
    state.noteId,
    state.input.id,
    state.input.bytes,
  );
  const run = await repo.requestProcessing(
    state.principal,
    state.workspaceId,
    state.noteId,
    state.input.id,
    randomUUID(),
  );
  return { ...state, run };
}

void describe("recording repository / isolated real PostgreSQL", { concurrency: false }, () => {
  after(teardown);
  void it("allows only one recording per note under concurrent initialization", async () => {
    const { principal, workspaceId, noteId, input } = await fixture(false);
    const attempts = await Promise.allSettled(
      [input, { ...input, id: randomUUID() }].map((value) =>
        repo.initialize(principal, workspaceId, noteId, value),
      ),
    );
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    const failed = attempts.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(code("conflict")(failed.reason));
  });
  void it("accepts 320 MiB and 1 GiB manifests while the database rejects larger files", async () => {
    for (const bytes of [320 * 1024 * 1024, 1024 * 1024 * 1024]) {
      const { principal, workspaceId, noteId, input } = await fixture(false);
      const recording = await repo.initialize(principal, workspaceId, noteId, {
        ...input,
        id: randomUUID(),
        bytes,
      });
      assert.equal(recording.bytes, bytes);
      await assert.rejects(
        sql`update recordings set bytes=1073741825 where workspace_id=${workspaceId} and id=${recording.id}`,
      );
    }
  });
  void it("retries immutable manifests and acknowledgments without duplicating events", async () => {
    const state = await fixture();
    const { principal, workspaceId, noteId, input } = state;
    assert.equal(
      (await repo.initialize(principal, workspaceId, noteId, input)).status,
      "upload_pending",
    );
    await assert.rejects(
      repo.initialize(principal, workspaceId, noteId, { ...input, sha256: "b".repeat(64) }),
      code("conflict"),
    );
    await assert.rejects(
      repo.requestProcessing(principal, workspaceId, noteId, input.id, randomUUID()),
      code("conflict"),
    );
    await assert.rejects(
      repo.acknowledge(principal, workspaceId, noteId, input.id, input.bytes + 1),
      code("conflict"),
    );
    const ready = await repo.acknowledge(principal, workspaceId, noteId, input.id, input.bytes);
    assert.deepEqual(
      await repo.acknowledge(principal, workspaceId, noteId, input.id, input.bytes),
      ready,
    );
    const [count] =
      await sql`select count(*)::int as n from recording_events where workspace_id=${workspaceId}`;
    assert.equal(count?.n, 1);
  });
  void it("commits one logical run and outbox under concurrent requests, claims the paid submit only once", async () => {
    const { principal, workspaceId, noteId, input, run } = await readyRun();
    const runs = await Promise.all(
      Array.from({ length: 5 }, () =>
        repo.requestProcessing(principal, workspaceId, noteId, input.id, randomUUID()),
      ),
    );
    assert.ok(runs.every((value) => value.id === run.id));
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => repo.claimSubmission(workspaceId, run.id)),
    );
    assert.equal(claims.filter((value) => value.submit).length, 1);
    const [counts] =
      await sql`select (select count(*) from processing_runs where workspace_id=${workspaceId})::int as runs, (select count(*) from processing_outbox where workspace_id=${workspaceId})::int as outbox`;
    assert.deepEqual(counts, { runs: 1, outbox: 1 });
  });
  void it("publishes stable timestamped versions atomically without changing manual notes", async () => {
    const { principal, workspaceId, noteId, run } = await readyRun();
    await repo.claimSubmission(workspaceId, run.id);
    await repo.bindJob(workspaceId, run.id, randomUUID());
    const turns = Array.from({ length: 102 }, (_, i) => ({
      start: i / 20,
      end: (i + 1) / 20,
      speaker: "SPEAKER_00",
      text: `Turn ${i}`,
    }));
    await repo.publish(workspaceId, run.id, "private/raw.json", turns);
    const page = await repo.transcript(principal, workspaceId, noteId, run.id, -1);
    assert.equal(page.items.length, 100);
    assert.equal(page.nextCursor, 99);
    const tail = await repo.transcript(principal, workspaceId, noteId, run.id, page.nextCursor);
    assert.equal(tail.items.length, 2);
    await repo.publish(workspaceId, run.id, "private/raw.json", turns);
    assert.deepEqual(await repo.transcript(principal, workspaceId, noteId, run.id, -1), page);
    assert.equal(
      (await workspaceRepo.getNote(principal, workspaceId, noteId)).transcript,
      "Manual text must remain",
    );
    assert.equal((await workspaceRepo.getNote(principal, workspaceId, noteId)).revision, 1);
  });
  void it("rolls transcript rows and publication state back after a late event failure", async () => {
    const { workspaceId, run } = await readyRun();
    await repo.bindJob(workspaceId, run.id, randomUUID());
    await sql`alter table recording_events add constraint test_publication_failure check (kind <> 'transcript.published') not valid`;
    try {
      await assert.rejects(
        repo.publish(workspaceId, run.id, "private/raw.json", [
          { start: 0, end: 1, speaker: "S", text: "Must roll back" },
        ]),
      );
      const [count] =
        await sql`select count(*)::int as n from transcript_utterances where run_id=${run.id}`;
      assert.equal(count?.n, 0);
      assert.equal((await repo.execution(workspaceId, run.id)).run.status, "submitted");
    } finally {
      await sql`alter table recording_events drop constraint test_publication_failure`;
    }
  });
  void it("denies cross-workspace audio, transcript and capability reads and blocks late publication after deletion", async () => {
    const a = await readyRun();
    const b = await fixture();
    await assert.rejects(
      repo.getRecording(b.principal, a.workspaceId, a.noteId, a.input.id),
      code("forbidden"),
    );
    await assert.rejects(
      repo.capabilityRecording(b.workspaceId, a.noteId, a.input.id),
      code("not_found"),
    );
    await repo.bindJob(a.workspaceId, a.run.id, randomUUID());
    await assert.rejects(
      repo.transcript(b.principal, a.workspaceId, a.noteId, a.run.id, -1),
      code("forbidden"),
    );
    await workspaceRepo.deleteNote(a.principal, a.workspaceId, {
      id: a.noteId,
      commandId: randomUUID(),
      expectedRevision: 1,
    });
    await assert.rejects(
      repo.publish(a.workspaceId, a.run.id, "private/raw.json", [
        { start: 0, end: 1, speaker: "S", text: "Late" },
      ]),
      code("not_found"),
    );
    await assert.rejects(
      repo.capabilityRecording(a.workspaceId, a.noteId, a.input.id),
      code("not_found"),
    );
    await assert.rejects(
      repo.acknowledge(a.principal, a.workspaceId, a.noteId, a.input.id, a.input.bytes),
      code("not_found"),
    );
  });
  void it("keeps unknown submissions recoverable, validates timeline bounds and rechecks original actor membership", async () => {
    const { workspaceId, run } = await readyRun();
    await repo.claimSubmission(workspaceId, run.id);
    await repo.status(workspaceId, run.id, "submission_unknown");
    assert.equal((await repo.claimSubmission(workspaceId, run.id)).submit, false);
    const job = randomUUID();
    await repo.bindJob(workspaceId, run.id, job);
    await repo.bindJob(workspaceId, run.id, job);
    await assert.rejects(repo.bindJob(workspaceId, run.id, randomUUID()), code("conflict"));
    await assert.rejects(
      repo.publish(workspaceId, run.id, "private/raw.json", [
        { start: 0, end: 11, speaker: "S", text: "Out of bounds" },
      ]),
      code("conflict"),
    );
    await sql`update workspace_memberships set revoked_at=now() where workspace_id=${workspaceId}`;
    await assert.rejects(repo.execution(workspaceId, run.id), code("forbidden"));
  });
});
