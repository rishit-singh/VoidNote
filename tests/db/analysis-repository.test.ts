import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { platformTables } from "./platform-tables";

import type { ContextReference, SummaryContext } from "../../src/ai/context";
import { summaryPolicy, type SummaryPolicy } from "../../src/ai/runtime";
import type { SummaryAnalysis } from "../../src/contracts/analysis";
import { WorkspaceError } from "../../src/contracts/workspace";
import { createAnalysisRepository } from "../../src/db/analysis";
import { createAssistantRepository } from "../../src/db/assistant";
import { createRecordingRepository } from "../../src/db/recording-repository";
import { createWorkspaceRepository } from "../../src/db/repository";
import * as schema from "../../src/db/schema";
import { createTranscriptCorrectionRepository } from "../../src/db/transcript-correction-repository";

// A real database suite with the same empty-DB guard and advisory lock as the
// existing repository suites. Never load application environment files.
const url = process.env.TEST_DATABASE_URL;
if (!url || !/(^|[_-])test($|[_-])/.test(decodeURIComponent(new URL(url).pathname.slice(1)))) {
  throw new Error("A dedicated empty TEST_DATABASE_URL is required.");
}
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
const repo = createAnalysisRepository(db);
const assistant = createAssistantRepository(db);
const workspaceRepo = createWorkspaceRepository(db);
const corrections = createTranscriptCorrectionRepository(db);
const policy = summaryPolicy("@cf/test/summary");
const migrationsSchema = `analysis_test_migrations_${randomUUID().replaceAll("-", "")}`;
const lock = await sql.reserve();
let ownsTables = false;

async function teardown() {
  try {
    if (ownsTables) {
      for (const table of [
        ...platformTables,
        "summary_inference_reservations",
        "summary_inference_budgets",
        "note_summaries",
        "analysis_jobs",
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
      ]) {
        await sql`drop table if exists ${sql(`public.${table}`)}`;
      }
      await sql`drop schema if exists ${sql(migrationsSchema)} cascade`;
      await sql`drop table if exists auth.users`;
      await sql`drop schema if exists auth`;
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
  const existing = await sql`
    select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname not in ('pg_catalog','information_schema')
      and n.nspname not like 'pg_toast%' and c.relkind in ('r','p','v','m','S')`;
  assert.equal(existing.length, 0, "refusing to migrate a nonempty database");
  const [authSchema] = await sql`select 1 from pg_namespace where nspname = 'auth'`;
  assert.equal(authSchema, undefined, "refusing to own an existing auth schema");
  ownsTables = true;
  await sql`create schema auth`;
  await sql`create table auth.users (id uuid primary key)`;
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    migrationsSchema,
  });
} catch (error) {
  await teardown();
  throw error;
}
after(teardown);

const code = (expected: WorkspaceError["code"]) => (error: unknown) =>
  error instanceof WorkspaceError && error.code === expected;

async function fixture() {
  const principal = { id: randomUUID(), email: null };
  await sql`insert into auth.users (id) values (${principal.id})`;
  const workspace = await workspaceRepo.ensureWorkspace(principal);
  const workspaceId = workspace.id;
  const note = await workspaceRepo.saveNote(principal, workspaceId, {
    commandId: randomUUID(),
    id: randomUUID(),
    expectedRevision: 0,
    content: { title: "Launch meeting", transcript: "This is not transcript evidence." },
  });
  const recordingId = randomUUID();
  const runId = randomUUID();
  await db.insert(schema.recordings).values({
    workspaceId,
    id: recordingId,
    noteId: note.id,
    actorId: principal.id,
    sha256: "a".repeat(64),
    bytes: 20,
    mimeType: "audio/webm",
    durationSeconds: 20,
    objectKey: `${workspaceId}/recording`,
    status: "ready",
  });
  await db.insert(schema.processingRuns).values({
    workspaceId,
    id: runId,
    noteId: note.id,
    recordingId,
    actorId: principal.id,
    config: { model: "test", transcriptionModel: "test" },
    status: "succeeded",
    transcriptGeneration: 1,
  });
  const utterances = [
    {
      id: randomUUID(),
      sequence: 0,
      text: "Ship the release on Friday.",
      speakerLabel: "SPEAKER_00",
      startSeconds: 0,
      endSeconds: 5,
    },
    {
      id: randomUUID(),
      sequence: 1,
      text: "I will write the release notes.",
      speakerLabel: "SPEAKER_01",
      startSeconds: 4,
      endSeconds: 9,
    },
  ];
  await db
    .insert(schema.transcriptUtterances)
    .values(utterances.map((utterance) => ({ ...utterance, workspaceId, runId })));
  return {
    principal,
    workspaceId,
    note,
    noteId: note.id,
    recordingId,
    runId,
    utterances,
    request: (commandId: string = randomUUID(), override: SummaryPolicy | null = policy) =>
      repo.request(principal, workspaceId, { commandId, noteId: note.id }, override),
  };
}

function referenceFor(context: SummaryContext): ContextReference {
  const checksum = createHash("sha256").update(JSON.stringify(context)).digest("hex");
  return {
    snapshotId: context.snapshotId,
    objectKey: `analysis/${context.workspaceId}/${context.snapshotId}/context-${checksum}.json`,
    checksum,
    source: context.source,
    noteRevision: context.noteRevision,
    profiles: context.people.map(({ personId, revision }) => ({ personId, revision })),
  };
}

function analysisFor(context: SummaryContext): SummaryAnalysis {
  const passage = context.passages[0]!;
  const statement = {
    text: "The release is planned.",
    citations: [{ evidenceId: passage.evidenceId, quote: passage.text }],
  };
  return {
    quickSummary: [statement],
    detailedSummary: [statement],
    keywords: ["release"],
    decisions: [],
    nextSteps: [],
    keyMoments: [],
    participants: [],
    engagement: { observations: [], limitations: ["Audio was not reviewed."] },
    agendaAssessment: [],
    memoryCandidates: [],
    overlapFindings: [],
    uncertainties: [],
  };
}

async function prepared(f: Awaited<ReturnType<typeof fixture>>) {
  const job = await f.request();
  const context = await repo.prepareContext(f.workspaceId, job.id);
  const reference = referenceFor(context);
  await repo.pinContext(f.workspaceId, job.id, reference);
  return { job, context, reference, analysis: analysisFor(context) };
}

async function assigned(f: Awaited<ReturnType<typeof fixture>>) {
  const person = await workspaceRepo.savePerson(f.principal, f.workspaceId, {
    commandId: randomUUID(),
    id: randomUUID(),
    expectedRevision: 0,
    content: { displayName: "Ada", description: "Release manager" },
  });
  await corrections.command(f.principal, f.workspaceId, f.noteId, f.runId, {
    kind: "assign",
    commandId: randomUUID(),
    targets: f.utterances.map(({ id }) => ({ id, expectedAttributionRevision: 0 })),
    assignment: { kind: "person", personId: person.id },
  });
  return person;
}

async function waitForDatabaseBlock(waiterPid: number, blockerPid: number) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const [state] = await sql<{ blocked: boolean }[]>`
      select ${blockerPid} = any(pg_blocking_pids(${waiterPid})) as blocked`;
    if (state?.blocked) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Expected database lock dependency ${waiterPid} -> ${blockerPid}`);
}

void describe("summary job repository", () => {
  void it("coalesces duplicate automatic admissions and rejects obsolete source events", async () => {
    const f = await fixture();
    const source = { runId: f.runId, generation: 1 };
    const automatic = () =>
      repo.request(
        f.principal,
        f.workspaceId,
        { commandId: randomUUID(), noteId: f.noteId },
        policy,
        source,
      );
    const jobs = await Promise.all([automatic(), automatic(), automatic()]);
    assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
    await workspaceRepo.saveNote(f.principal, f.workspaceId, {
      commandId: randomUUID(),
      id: f.noteId,
      expectedRevision: f.note.revision,
      content: { transcript: f.note.transcript, title: "Renamed without changing recording" },
    });
    assert.equal((await automatic()).id, jobs[0].id);
    await db
      .update(schema.processingRuns)
      .set({ transcriptGeneration: 2 })
      .where(
        and(
          eq(schema.processingRuns.workspaceId, f.workspaceId),
          eq(schema.processingRuns.id, f.runId),
        ),
      );
    await assert.rejects(automatic(), code("conflict"));
    const next = await repo.request(
      f.principal,
      f.workspaceId,
      { commandId: randomUUID(), noteId: f.noteId },
      policy,
      { runId: f.runId, generation: 2 },
    );
    assert.notEqual(next.id, jobs[0].id);
    assert.equal(next.source.generation, 2);
  });

  void it("automatic delivery after a manual request does not create another paid intent", async () => {
    const f = await fixture();
    const manual = await f.request();
    const automatic = await repo.request(
      f.principal,
      f.workspaceId,
      { commandId: randomUUID(), noteId: f.noteId },
      policy,
      { runId: f.runId, generation: 1 },
    );
    assert.equal(automatic.id, manual.id);
  });

  void it("deduplicates concurrent exact requests, pins policy, and rejects changed note/actor", async () => {
    const f = await fixture();
    const commandId = randomUUID();
    const jobs = await Promise.all(Array.from({ length: 4 }, () => f.request(commandId)));
    assert.deepEqual(new Set(jobs.map((job) => job.id)), new Set([commandId]));
    const replay = await f.request(commandId, { ...policy, maxPassages: 1 });
    assert.deepEqual(replay, jobs[0]);
    assert.equal(
      (await repo.execution(f.workspaceId, commandId)).policy.maxPassages,
      policy.maxPassages,
    );
    const [count] =
      await sql`select count(*)::int as count from analysis_jobs where workspace_id=${f.workspaceId}`;
    assert.equal(count?.count, 1);
    await assert.rejects(
      repo.request(f.principal, f.workspaceId, { commandId, noteId: randomUUID() }, policy),
      code("command_reused"),
    );
    const second = { id: randomUUID(), email: null };
    await sql`insert into auth.users (id) values (${second.id})`;
    await workspaceRepo.ensureWorkspace(second);
    await db
      .insert(schema.workspaceMemberships)
      .values({ workspaceId: f.workspaceId, userId: second.id });
    await assert.rejects(
      repo.request(second, f.workspaceId, { commandId, noteId: f.noteId }, policy),
      code("command_reused"),
    );
    assert.deepEqual(await f.request(commandId, null), jobs[0]);
    await assert.rejects(
      f.request(randomUUID(), null),
      (error: unknown) =>
        error instanceof WorkspaceError &&
        error.code === "conflict" &&
        error.message === "Summary generation is not enabled.",
    );
  });

  void it("captures ordered raw evidence without materializing corrections or using manual note text", async () => {
    const f = await fixture();
    const job = await f.request();
    const context = await repo.prepareContext(f.workspaceId, job.id);
    assert.equal(context.snapshotId, job.id);
    assert.equal(context.noteRevision, f.note.revision);
    assert.equal(context.coverage.complete, true);
    assert.deepEqual(
      context.passages.map((passage) => passage.text),
      f.utterances.map((turn) => turn.text),
    );
    assert.deepEqual(
      context.passages.map((passage) => passage.providerTrackId),
      ["SPEAKER_00", "SPEAKER_01"],
    );
    assert.deepEqual(
      context.passages.map((passage) => passage.segmentId),
      f.utterances.map((turn) => turn.id),
    );
    assert.deepEqual(context.people, []);
    assert.equal(context.agenda, null);
    assert.deepEqual(context.relatedConversations, []);
    const [run] =
      await sql`select corrections_materialized_at from processing_runs where workspace_id=${f.workspaceId} and id=${f.runId}`;
    const [segments] =
      await sql`select count(*)::int as count from transcript_segments where workspace_id=${f.workspaceId}`;
    assert.equal(run?.corrections_materialized_at, null);
    assert.equal(segments?.count, 0);
  });

  void it("uses corrected evidence, preserves raw track identity, and batch-loads profiles", async () => {
    const f = await fixture();
    const person = await assigned(f);
    const job = await f.request();
    queryCount = 0;
    const context = await repo.prepareContext(f.workspaceId, job.id);
    assert.ok(queryCount <= 11, `snapshot used ${queryCount} queries`);
    assert.deepEqual(context.people, [
      {
        personId: person.id,
        revision: person.revision,
        displayName: "Ada",
        authoredDescription: "Release manager",
      },
    ]);
    assert.equal(context.source.generation, 2);
    assert.deepEqual(
      context.passages.map((passage) => passage.assignment),
      [
        { kind: "person", personId: person.id },
        { kind: "person", personId: person.id },
      ],
    );
    assert.deepEqual(
      context.passages.map((passage) => passage.providerTrackId),
      ["SPEAKER_00", "SPEAKER_01"],
    );
    assert.ok(context.passages.every((passage) => passage.attributionRevision > 0));
  });

  void it("pins exact context identity and rejects changed checksums, object keys, and profile omissions", async () => {
    const f = await fixture();
    await assigned(f);
    const job = await f.request();
    const context = await repo.prepareContext(f.workspaceId, job.id);
    const reference = referenceFor(context);
    await assert.rejects(
      repo.pinContext(f.workspaceId, job.id, { ...reference, profiles: [] }),
      code("conflict"),
    );
    await assert.rejects(
      repo.pinContext(f.workspaceId, job.id, { ...reference, checksum: "b".repeat(64) }),
      code("conflict"),
    );
    assert.deepEqual(await repo.pinContext(f.workspaceId, job.id, reference), reference);
    assert.deepEqual(await repo.pinContext(f.workspaceId, job.id, reference), reference);
    await assert.rejects(
      repo.pinContext(f.workspaceId, job.id, { ...reference, objectKey: "other" }),
      code("conflict"),
    );
    assert.equal((await repo.get(f.principal, f.workspaceId, job.id)).status, "running");
  });

  void it("publishes once under concurrency, allocates note versions, and returns original successful output", async () => {
    const f = await fixture();
    const first = await prepared(f);
    const outputs = await Promise.all(
      Array.from({ length: 4 }, () =>
        repo.publish(f.workspaceId, first.job.id, first.reference, first.analysis),
      ),
    );
    assert.ok(outputs[0]);
    assert.ok(outputs.every((output) => output?.id === outputs[0]!.id));
    assert.equal(outputs[0].version, 1);
    const second = await prepared(f);
    const third = await prepared(f);
    const next = await Promise.all(
      [second, third].map((p) => repo.publish(f.workspaceId, p.job.id, p.reference, p.analysis)),
    );
    assert.deepEqual(next.map((output) => output?.version).sort(), [2, 3]);
    const replay = await repo.publish(f.workspaceId, first.job.id, first.reference, {
      ...first.analysis,
      keywords: ["changed"],
    });
    assert.deepEqual(replay, outputs[0]);
    assert.deepEqual((await f.request(first.job.id)).resultId, outputs[0].id);
    assert.equal(
      (await repo.result(f.principal, f.workspaceId, first.job.id)).freshness,
      "current",
    );
    await repo.fail(f.workspaceId, first.job.id, "failed", "late error");
    assert.equal((await repo.cancel(f.principal, f.workspaceId, first.job.id)).status, "succeeded");
  });

  void it("admits and publishes summaries while recording replay holds the run lock", async () => {
    for (const operation of ["request", "publish"] as const) {
      const f = await fixture();
      const preparedJob = await prepared(f);
      const recordingActor = { id: randomUUID(), email: null };
      await sql`insert into auth.users (id) values (${recordingActor.id})`;
      await workspaceRepo.ensureWorkspace(recordingActor);
      await db.insert(schema.workspaceMemberships).values({
        workspaceId: f.workspaceId,
        userId: recordingActor.id,
      });
      await db
        .update(schema.processingRuns)
        .set({ actorId: recordingActor.id })
        .where(
          and(
            eq(schema.processingRuns.workspaceId, f.workspaceId),
            eq(schema.processingRuns.id, f.runId),
          ),
        );
      const replaySql = postgres(url, { max: 1, prepare: false, connect_timeout: 5 });
      const summarySql = postgres(url, { max: 1, prepare: false, connect_timeout: 5 });
      const replayRepository = createRecordingRepository(drizzle(replaySql, { schema }));
      const summaryRepository = createAnalysisRepository(drizzle(summarySql, { schema }));
      const membershipReady = Promise.withResolvers<number>();
      const releaseMembership = Promise.withResolvers<void>();
      // Hold only the recording actor's membership. Replay first acquires its
      // run UPDATE lock, then pauses here before its note SHARE request.
      const membershipBlocker = sql
        .begin(async (connection) => {
          const [backend] = await connection<{ pid: number }[]>`select pg_backend_pid() as pid`;
          await connection`
            select user_id from workspace_memberships
            where workspace_id=${f.workspaceId} and user_id=${recordingActor.id}
            for update`;
          membershipReady.resolve(backend!.pid);
          await releaseMembership.promise;
        })
        .catch((error: unknown) => {
          membershipReady.reject(error);
          throw error;
        });
      const blockerResult = Promise.allSettled([membershipBlocker]);
      let replayResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
      let summaryResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        const [replayBackend] = await replaySql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        const [summaryBackend] = await summarySql<
          { pid: number }[]
        >`select pg_backend_pid() as pid`;
        const membershipPid = await membershipReady.promise;
        replayResult = Promise.allSettled([
          replayRepository.publish(f.workspaceId, f.runId, "ignored-replay.json", []),
        ]);
        await waitForDatabaseBlock(replayBackend!.pid, membershipPid);
        summaryResult = Promise.allSettled([
          operation === "request"
            ? summaryRepository.request(
                f.principal,
                f.workspaceId,
                { commandId: randomUUID(), noteId: f.noteId },
                policy,
              )
            : summaryRepository.publish(
                f.workspaceId,
                preparedJob.job.id,
                preparedJob.reference,
                preparedJob.analysis,
              ),
        ]);
        // Summary now owns its note lifecycle lock and is waiting for replay's
        // run lock. Releasing membership forces replay's opposite note request.
        // UPDATE on the summary note would deterministically deadlock here.
        await waitForDatabaseBlock(summaryBackend!.pid, replayBackend!.pid);
        releaseMembership.resolve();
        const results = [
          ...(await blockerResult),
          ...(await replayResult),
          ...(await summaryResult),
        ];
        for (const result of results) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
        if (operation === "publish") {
          assert.equal(
            (await repo.result(f.principal, f.workspaceId, preparedJob.job.id)).summary.version,
            1,
          );
        }
      } finally {
        releaseMembership.resolve();
        await blockerResult;
        await replayResult;
        await summaryResult;
        await Promise.all([replaySql.end({ timeout: 5 }), summarySql.end({ timeout: 5 })]);
      }
    }
  });

  void it("preserves cancellation against late publish and failure, including cancel/publish races", async () => {
    const f = await fixture();
    const p = await prepared(f);
    await repo.cancel(f.principal, f.workspaceId, p.job.id);
    assert.equal(await repo.publish(f.workspaceId, p.job.id, p.reference, p.analysis), null);
    await repo.fail(f.workspaceId, p.job.id, "failed", "late error");
    assert.equal((await f.request(p.job.id)).status, "cancelled");
    await assert.rejects(repo.result(f.principal, f.workspaceId, p.job.id), code("not_found"));
    const racing = await prepared(f);
    const [cancelled, published] = await Promise.all([
      repo.cancel(f.principal, f.workspaceId, racing.job.id),
      repo.publish(f.workspaceId, racing.job.id, racing.reference, racing.analysis),
    ]);
    assert.equal(published === null, cancelled.status === "cancelled");
    const final = await repo.get(f.principal, f.workspaceId, racing.job.id);
    assert.equal(final.status, published ? "succeeded" : "cancelled");
  });

  void it("rejects stale source preparation and durably supersedes late publication", async () => {
    const f = await fixture();
    const p = await prepared(f);
    await corrections.command(f.principal, f.workspaceId, f.noteId, f.runId, {
      kind: "edit",
      commandId: randomUUID(),
      utteranceId: f.utterances[0]!.id,
      expectedRevision: 0,
      text: "Ship next week instead.",
      startSeconds: 0,
      endSeconds: 5,
    });
    await assert.rejects(repo.prepareContext(f.workspaceId, p.job.id), code("conflict"));
    assert.equal(
      (await repo.get(f.principal, f.workspaceId, p.job.id)).status,
      "running",
      "a throwing transaction did not persist a terminal status",
    );
    assert.equal(await repo.publish(f.workspaceId, p.job.id, p.reference, p.analysis), null);
    assert.equal((await repo.get(f.principal, f.workspaceId, p.job.id)).status, "superseded");
    await repo.fail(f.workspaceId, p.job.id, "failed", "late error");
    assert.equal((await f.request(p.job.id)).status, "superseded");
  });

  void it("summary assistant sources become stale on transcript correction without a note revision", async () => {
    const f = await fixture();
    const p = await prepared(f);
    await repo.publish(f.workspaceId, p.job.id, p.reference, p.analysis);
    const source = {
      kind: "summary" as const,
      id: p.job.id,
      noteId: f.noteId,
      label: "Saved Summary",
      revision: 1,
    };
    const thread = await assistant.openThread(f.principal, f.workspaceId, randomUUID(), f.noteId);
    const firstTurn = randomUUID();
    await assistant.requestTurn(
      f.principal,
      f.workspaceId,
      thread.id,
      firstTurn,
      "Read summary",
      {},
    );
    await assistant.beginTurn(f.workspaceId, firstTurn);
    assert.equal(
      (
        await assistant.completeTurn(f.workspaceId, firstTurn, {
          text: "The meeting planned a release.",
          tools: [],
          sources: [source],
        })
      )?.status,
      "succeeded",
    );

    await corrections.command(f.principal, f.workspaceId, f.noteId, f.runId, {
      kind: "edit",
      commandId: randomUUID(),
      utteranceId: f.utterances[0]!.id,
      expectedRevision: 0,
      text: "Ship next week instead.",
      startSeconds: 0,
      endSeconds: 5,
    });
    assert.equal(f.note.revision, 1);

    const secondTurn = randomUUID();
    await assistant.requestTurn(
      f.principal,
      f.workspaceId,
      thread.id,
      secondTurn,
      "Reuse the saved summary",
      {},
    );
    await assistant.beginTurn(f.workspaceId, secondTurn);
    await assert.rejects(
      assistant.completeTurn(f.workspaceId, secondTurn, {
        text: "The meeting planned a release.",
        tools: [],
        sources: [source],
      }),
      code("conflict"),
    );
  });

  void it("revalidates note and profile revisions at pin/publication and reports saved output freshness", async () => {
    const f = await fixture();
    const person = await assigned(f);
    const p = await prepared(f);
    const published = await repo.publish(f.workspaceId, p.job.id, p.reference, p.analysis);
    assert.ok(published);
    const pending = await prepared(f);
    await workspaceRepo.savePerson(f.principal, f.workspaceId, {
      commandId: randomUUID(),
      id: person.id,
      expectedRevision: person.revision,
      content: { displayName: "Ada", description: "Updated responsibilities" },
    });
    assert.equal(
      await repo.publish(f.workspaceId, pending.job.id, pending.reference, pending.analysis),
      null,
    );
    assert.equal((await repo.result(f.principal, f.workspaceId, p.job.id)).freshness, "stale");
    assert.deepEqual(
      await repo.publish(f.workspaceId, p.job.id, p.reference, p.analysis),
      published,
    );
    const unpinned = await f.request();
    const context = await repo.prepareContext(f.workspaceId, unpinned.id);
    await workspaceRepo.saveNote(f.principal, f.workspaceId, {
      commandId: randomUUID(),
      id: f.noteId,
      expectedRevision: f.note.revision,
      content: { title: "Renamed meeting", transcript: "" },
    });
    await assert.rejects(
      repo.pinContext(f.workspaceId, unpinned.id, referenceFor(context)),
      code("conflict"),
    );
  });

  void it("rejects missing/deleted profiles without silently dropping attribution", async () => {
    const f = await fixture();
    const person = await assigned(f);
    const job = await f.request();
    await db
      .update(schema.people)
      .set({ deletedAt: new Date() })
      .where(and(eq(schema.people.workspaceId, f.workspaceId), eq(schema.people.id, person.id)));
    await assert.rejects(repo.prepareContext(f.workspaceId, job.id), code("conflict"));
    assert.equal((await repo.get(f.principal, f.workspaceId, job.id)).status, "queued");
  });

  void it("enforces complete-input budgets and rejects generation-zero sources", async () => {
    const f = await fixture();
    const tooMany = await f.request(randomUUID(), { ...policy, maxPassages: 1 });
    await assert.rejects(repo.prepareContext(f.workspaceId, tooMany.id), code("conflict"));
    const tooLarge = await f.request(randomUUID(), { ...policy, maxContextBytes: 1024 });
    await assert.rejects(repo.prepareContext(f.workspaceId, tooLarge.id), code("conflict"));
    await db
      .update(schema.processingRuns)
      .set({ transcriptGeneration: 0 })
      .where(
        and(
          eq(schema.processingRuns.workspaceId, f.workspaceId),
          eq(schema.processingRuns.id, f.runId),
        ),
      );
    await assert.rejects(f.request(), code("conflict"));
  });

  void it("preflights UTF-8 transcript and profile bytes before fetching oversized content", async () => {
    const f = await fixture();
    await db
      .update(schema.transcriptUtterances)
      .set({ text: "é".repeat(40_000) })
      .where(
        and(
          eq(schema.transcriptUtterances.workspaceId, f.workspaceId),
          eq(schema.transcriptUtterances.id, f.utterances[0]!.id),
        ),
      );
    const oversizedTranscript = await f.request();
    queryCount = 0;
    await assert.rejects(
      repo.prepareContext(f.workspaceId, oversizedTranscript.id),
      code("conflict"),
    );
    assert.ok(queryCount <= 8, "oversize raw text should fail before the passage SELECT");

    const other = await fixture();
    const person = await assigned(other);
    await workspaceRepo.savePerson(other.principal, other.workspaceId, {
      commandId: randomUUID(),
      id: person.id,
      expectedRevision: person.revision,
      content: { displayName: "Ada", description: "é".repeat(5000) },
    });
    const oversizedProfile = await other.request(randomUUID(), {
      ...policy,
      maxContextBytes: 8192,
    });
    queryCount = 0;
    await assert.rejects(
      repo.prepareContext(other.workspaceId, oversizedProfile.id),
      code("conflict"),
    );
    assert.ok(
      queryCount <= 10,
      "oversize descriptions should fail after metadata-only profile read",
    );
  });

  void it("guards workspace isolation and original-actor revocation, while preserving terminal output", async () => {
    const f = await fixture();
    const outsider = await fixture();
    const p = await prepared(f);
    await assert.rejects(repo.get(outsider.principal, f.workspaceId, p.job.id), code("forbidden"));
    await assert.rejects(
      repo.get(outsider.principal, outsider.workspaceId, p.job.id),
      code("not_found"),
    );
    await assert.rejects(
      repo.cancel(outsider.principal, f.workspaceId, p.job.id),
      code("forbidden"),
    );
    await db
      .update(schema.workspaceMemberships)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.workspaceMemberships.workspaceId, f.workspaceId),
          eq(schema.workspaceMemberships.userId, f.principal.id),
        ),
      );
    await assert.rejects(repo.execution(f.workspaceId, p.job.id), code("forbidden"));
    await assert.rejects(f.request(p.job.id), code("forbidden"));
    assert.equal(await repo.publish(f.workspaceId, p.job.id, p.reference, p.analysis), null);
    const [job] =
      await sql`select status from analysis_jobs where workspace_id=${f.workspaceId} and id=${p.job.id}`;
    assert.equal(job?.status, "blocked");
  });

  void it("serves stale saved evidence to another active reader after the original actor is revoked", async () => {
    const f = await fixture();
    const p = await prepared(f);
    await assert.rejects(repo.evidence(f.principal, f.workspaceId, p.job.id), code("not_found"));
    await repo.publish(f.workspaceId, p.job.id, p.reference, p.analysis);
    const reader = await fixture();
    await assert.rejects(
      repo.evidence(reader.principal, f.workspaceId, p.job.id),
      code("forbidden"),
    );
    await db.insert(schema.workspaceMemberships).values({
      workspaceId: f.workspaceId,
      userId: reader.principal.id,
    });
    await corrections.command(f.principal, f.workspaceId, f.noteId, f.runId, {
      kind: "edit",
      commandId: randomUUID(),
      utteranceId: f.utterances[0]!.id,
      expectedRevision: 0,
      text: "The date has changed.",
      startSeconds: 0,
      endSeconds: 5,
    });
    await db
      .update(schema.workspaceMemberships)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.workspaceMemberships.workspaceId, f.workspaceId),
          eq(schema.workspaceMemberships.userId, f.principal.id),
        ),
      );
    assert.equal((await repo.result(reader.principal, f.workspaceId, p.job.id)).freshness, "stale");
    assert.deepEqual(await repo.evidence(reader.principal, f.workspaceId, p.job.id), {
      reference: p.reference,
      maxContextBytes: policy.maxContextBytes,
    });
    await assert.rejects(repo.evidence(f.principal, f.workspaceId, p.job.id), code("forbidden"));
    await db
      .update(schema.notes)
      .set({ deletedAt: new Date() })
      .where(and(eq(schema.notes.workspaceId, f.workspaceId), eq(schema.notes.id, f.noteId)));
    await assert.rejects(
      repo.evidence(reader.principal, f.workspaceId, p.job.id),
      code("not_found"),
    );
  });

  void it("blocks note, recording, and workspace deletion before late publication or successful replay", async () => {
    for (const target of ["notes", "recordings", "workspaces"] as const) {
      const f = await fixture();
      const p = await prepared(f);
      const completed = await prepared(f);
      await repo.publish(f.workspaceId, completed.job.id, completed.reference, completed.analysis);
      const id =
        target === "notes" ? f.noteId : target === "recordings" ? f.recordingId : f.workspaceId;
      await sql`update ${sql(target)} set deleted_at=now() where id=${id}`;
      assert.equal(await repo.publish(f.workspaceId, p.job.id, p.reference, p.analysis), null);
      assert.equal(
        await repo.publish(
          f.workspaceId,
          completed.job.id,
          completed.reference,
          completed.analysis,
        ),
        null,
      );
      await assert.rejects(
        repo.result(f.principal, f.workspaceId, completed.job.id),
        code(target === "workspaces" ? "forbidden" : "not_found"),
      );
      const jobs =
        await sql`select id,status from analysis_jobs where workspace_id=${f.workspaceId}`;
      assert.equal(jobs.find((job) => job.id === p.job.id)?.status, "blocked");
      assert.equal(jobs.find((job) => job.id === completed.job.id)?.status, "succeeded");
    }
  });

  void it("reconciles acknowledged active jobs and tracks checks separately from confirmations", async () => {
    const f = await fixture();
    const job = await f.request();
    const running = await prepared(f);
    const cancelled = await f.request();
    await repo.cancel(f.principal, f.workspaceId, cancelled.id);
    const completed = await prepared(f);
    await repo.publish(f.workspaceId, completed.job.id, completed.reference, completed.analysis);
    await sql`update analysis_jobs set created_at='2000-01-01'::timestamptz where workspace_id=${f.workspaceId}`;
    await sql`update analysis_jobs set dispatched_at='2001-01-01'::timestamptz where workspace_id=${f.workspaceId} and id=${running.job.id}`;
    const pending = await repo.pendingDispatch(100);
    assert.ok(pending.some((item) => item.jobId === job.id && item.workspaceId === f.workspaceId));
    assert.ok(pending.some((item) => item.jobId === running.job.id));
    assert.ok(!pending.some((item) => item.jobId === cancelled.id));
    assert.ok(!pending.some((item) => item.jobId === completed.job.id));
    assert.ok(pending.every((item) => Object.keys(item).length === 2));
    await sql`update analysis_jobs set dispatch_checked_at='2000-01-01'::timestamptz where workspace_id=${f.workspaceId} and id=${job.id}`;
    await sql`update analysis_jobs set dispatch_checked_at='2001-01-01'::timestamptz where workspace_id=${f.workspaceId} and id=${running.job.id}`;
    assert.deepEqual(await repo.pendingDispatch(1), [
      { workspaceId: f.workspaceId, jobId: job.id },
    ]);
    await repo.dispatched(f.workspaceId, job.id);
    assert.deepEqual(await repo.pendingDispatch(1), [
      { workspaceId: f.workspaceId, jobId: running.job.id },
    ]);
    // Successful confirmation does not change when the job was checked.
    const checked = await repo.execution(f.workspaceId, running.job.id);
    await repo.dispatched(f.workspaceId, running.job.id);
    const acknowledged = await repo.execution(f.workspaceId, running.job.id);
    assert.ok(acknowledged.dispatchedAt);
    assert.ok(acknowledged.dispatchedAt.getTime() > Date.parse("2002-01-01"));
    assert.deepEqual(acknowledged.dispatchCheckedAt, checked.dispatchCheckedAt);
    assert.equal((await repo.get(f.principal, f.workspaceId, job.id)).status, "queued");
    assert.equal(acknowledged.status, "running");
  });

  void it("rotates failed checks so the eleventh active job is not starved", async () => {
    const f = await fixture();
    const jobs = [];
    for (let index = 0; index < 11; index += 1) {
      const job = await f.request();
      jobs.push(job);
      await db
        .update(schema.analysisJobs)
        .set({ createdAt: new Date(Date.UTC(1990, 0, 1, 0, 0, index)) })
        .where(
          and(
            eq(schema.analysisJobs.workspaceId, f.workspaceId),
            eq(schema.analysisJobs.id, job.id),
          ),
        );
    }
    const first = await repo.pendingDispatch(10);
    assert.deepEqual(
      first.map(({ jobId }) => jobId),
      jobs.slice(0, 10).map(({ id }) => id),
    );
    // Simulate all ten runtime confirmations failing: never call dispatched().
    const checked = await sql<{ dispatched_at: Date | null; dispatch_checked_at: Date | null }[]>`
      select dispatched_at, dispatch_checked_at from analysis_jobs
      where workspace_id=${f.workspaceId} and id in ${sql(first.map(({ jobId }) => jobId))}`;
    assert.equal(checked.length, 10);
    assert.ok(
      checked.every((job) => job.dispatched_at === null && job.dispatch_checked_at !== null),
    );
    assert.deepEqual(await repo.pendingDispatch(1), [
      { workspaceId: f.workspaceId, jobId: jobs[10]!.id },
    ]);
  });

  void it("rejects structurally invalid output and mismatched reference without partial publication", async () => {
    const f = await fixture();
    const p = await prepared(f);
    await assert.rejects(
      repo.publish(f.workspaceId, p.job.id, { ...p.reference, objectKey: "wrong" }, p.analysis),
      code("conflict"),
    );
    await assert.rejects(
      repo.publish(f.workspaceId, p.job.id, p.reference, { ...p.analysis, quickSummary: [] }),
    );
    assert.equal((await repo.get(f.principal, f.workspaceId, p.job.id)).status, "running");
    const [count] =
      await sql`select count(*)::int as count from note_summaries where workspace_id=${f.workspaceId}`;
    assert.equal(count?.count, 0);
  });

  void it("rolls back summary insertion when the terminal job write fails", async () => {
    const f = await fixture();
    const p = await prepared(f);
    const name = `analysis_fail_${randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(`create function public.${name}() returns trigger language plpgsql as $$
      begin
        if NEW.workspace_id = '${f.workspaceId}'::uuid and NEW.status = 'succeeded' then
          raise exception 'injected analysis completion failure' using errcode = 'P0001';
        end if;
        return NEW;
      end $$`);
    try {
      await sql.unsafe(
        `create trigger ${name} before update on public.analysis_jobs for each row execute function public.${name}()`,
      );
      await assert.rejects(repo.publish(f.workspaceId, p.job.id, p.reference, p.analysis));
      const [count] =
        await sql`select count(*)::int as count from note_summaries where workspace_id=${f.workspaceId}`;
      assert.equal(count?.count, 0);
      assert.equal((await repo.get(f.principal, f.workspaceId, p.job.id)).status, "running");
    } finally {
      await sql.unsafe(`drop trigger if exists ${name} on public.analysis_jobs`);
      await sql.unsafe(`drop function public.${name}()`);
    }
    assert.equal(
      (await repo.publish(f.workspaceId, p.job.id, p.reference, p.analysis))?.version,
      1,
    );
  });

  void it("authorizes overview, separates latest job from latest saved result, and preserves disabled history", async () => {
    const f = await fixture();
    const saved = await prepared(f);
    await repo.publish(f.workspaceId, saved.job.id, saved.reference, saved.analysis);
    const failed = await f.request();
    await repo.fail(f.workspaceId, failed.id, "failed", "fixture failure");
    const active = await f.request();
    await sql`
      update analysis_jobs set created_at = case
        when id = ${saved.job.id} then '2026-01-01T00:00:00Z'::timestamptz
        when id = ${failed.id} then '2026-01-02T00:00:00Z'::timestamptz
        else '2026-01-03T00:00:00Z'::timestamptz end
      where workspace_id = ${f.workspaceId} and id in (${saved.job.id}, ${failed.id}, ${active.id})`;

    const overview = await repo.overview(f.principal, f.workspaceId, f.noteId, true);
    assert.equal(overview.latestJob?.id, active.id);
    assert.equal(overview.latestJob?.status, "queued");
    assert.equal(overview.latestSummaryJobId, saved.job.id);
    assert.equal(overview.canGenerate, true);
    assert.equal(overview.unavailableReason, null);

    await repo.fail(f.workspaceId, active.id, "failed", "second fixture failure");
    const terminal = await repo.overview(f.principal, f.workspaceId, f.noteId, true);
    assert.equal(terminal.latestJob?.id, active.id);
    assert.equal(terminal.latestJob?.status, "failed");
    assert.equal(terminal.latestSummaryJobId, saved.job.id);

    const disabled = await repo.overview(f.principal, f.workspaceId, f.noteId, false);
    assert.equal(disabled.latestSummaryJobId, saved.job.id);
    assert.equal(disabled.canGenerate, false);
    assert.equal(disabled.unavailableReason, "Summary generation is disabled.");

    const stranger = { id: randomUUID(), email: null };
    await sql`insert into auth.users (id) values (${stranger.id})`;
    await workspaceRepo.ensureWorkspace(stranger);
    await assert.rejects(repo.overview(stranger, f.workspaceId, f.noteId, true), code("forbidden"));
    await assert.rejects(
      repo.history(stranger, f.workspaceId, f.noteId, undefined, 10),
      code("forbidden"),
    );
  });

  void it("paginates version history stably and rejects malformed or cross-note cursors", async () => {
    const f = await fixture();
    const saved = [];
    for (let index = 0; index < 3; index += 1) {
      const output = await prepared(f);
      const result = await repo.publish(
        f.workspaceId,
        output.job.id,
        output.reference,
        output.analysis,
      );
      assert.ok(result);
      saved.push(result);
    }
    await sql`
      update note_summaries set created_at = '2026-02-01T00:00:00Z'::timestamptz
      where workspace_id = ${f.workspaceId} and note_id = ${f.noteId}`;

    const first = await repo.history(f.principal, f.workspaceId, f.noteId, undefined, 2);
    assert.deepEqual(
      first.items.map((item) => item.version),
      [3, 2],
    );
    assert.ok(first.nextCursor);
    const second = await repo.history(f.principal, f.workspaceId, f.noteId, first.nextCursor, 2);
    assert.deepEqual(
      second.items.map((item) => item.version),
      [1],
    );
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map((item) => item.jobId)).size, 3);

    await assert.rejects(
      repo.history(f.principal, f.workspaceId, f.noteId, "not-a-cursor", 2),
      code("invalid_cursor"),
    );
    const otherNote = await workspaceRepo.saveNote(f.principal, f.workspaceId, {
      commandId: randomUUID(),
      id: randomUUID(),
      expectedRevision: 0,
      content: { title: "Other note", transcript: "" },
    });
    await assert.rejects(
      repo.history(f.principal, f.workspaceId, otherNote.id, first.nextCursor, 2),
      code("invalid_cursor"),
    );
  });

  void it("reports source eligibility and hides deleted notes without mutating saved results", async () => {
    const f = await fixture();
    const output = await prepared(f);
    await repo.publish(f.workspaceId, output.job.id, output.reference, output.analysis);

    await db
      .update(schema.processingRuns)
      .set({ transcriptGeneration: 0 })
      .where(
        and(
          eq(schema.processingRuns.workspaceId, f.workspaceId),
          eq(schema.processingRuns.id, f.runId),
        ),
      );
    const generationZero = await repo.overview(f.principal, f.workspaceId, f.noteId, true);
    assert.equal(generationZero.canGenerate, false);
    assert.equal(generationZero.unavailableReason, "A finalized transcript is required.");

    await db
      .update(schema.processingRuns)
      .set({ transcriptGeneration: 2 })
      .where(
        and(
          eq(schema.processingRuns.workspaceId, f.workspaceId),
          eq(schema.processingRuns.id, f.runId),
        ),
      );
    assert.equal((await repo.result(f.principal, f.workspaceId, output.job.id)).freshness, "stale");
    await db
      .update(schema.recordings)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(schema.recordings.workspaceId, f.workspaceId),
          eq(schema.recordings.id, f.recordingId),
        ),
      );
    const ineligible = await repo.overview(f.principal, f.workspaceId, f.noteId, true);
    assert.equal(ineligible.canGenerate, false);
    assert.equal(ineligible.unavailableReason, "A finalized transcript is required.");
    assert.equal(ineligible.latestSummaryJobId, output.job.id);

    await db
      .update(schema.notes)
      .set({ deletedAt: new Date() })
      .where(and(eq(schema.notes.workspaceId, f.workspaceId), eq(schema.notes.id, f.noteId)));
    await assert.rejects(
      repo.overview(f.principal, f.workspaceId, f.noteId, true),
      code("not_found"),
    );
    await assert.rejects(
      repo.history(f.principal, f.workspaceId, f.noteId, undefined, 10),
      code("not_found"),
    );
  });
});
