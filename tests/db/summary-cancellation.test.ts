import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";

import type { ContextReference, SummaryContext } from "../../src/ai/context";
import { summaryPolicy } from "../../src/ai/runtime";
import {
  dispatchSummaryMaintenance,
  type SummaryWorkflowParams,
} from "../../src/ai/summary/dispatch";
import type { SummaryAnalysis } from "../../src/contracts/analysis";
import { createAnalysisRepository } from "../../src/db/analysis";
import * as schema from "../../src/db/schema";
import { summaryCancellationCleanup } from "../../src/db/summary-cleanup-schema";
import { db, setupDatabase, sql, teardownDatabase, workspace } from "./fixture";

await setupDatabase();
after(teardownDatabase);

const repository = createAnalysisRepository(db);
const policy = summaryPolicy("@cf/test/summary");

async function fixture() {
  const owner = await workspace();
  const noteId = randomUUID();
  const recordingId = randomUUID();
  const runId = randomUUID();
  await db.insert(schema.notes).values({
    workspaceId: owner.workspaceId,
    id: noteId,
    title: "Cancellation fixture",
    transcript: "",
    revision: 1,
  });
  await db.insert(schema.recordings).values({
    workspaceId: owner.workspaceId,
    id: recordingId,
    noteId,
    actorId: owner.principal.id,
    sha256: "a".repeat(64),
    bytes: 20,
    mimeType: "audio/webm",
    durationSeconds: 20,
    objectKey: `${owner.workspaceId}/recording`,
    status: "ready",
  });
  await db.insert(schema.processingRuns).values({
    workspaceId: owner.workspaceId,
    id: runId,
    noteId,
    recordingId,
    actorId: owner.principal.id,
    config: { model: "test", transcriptionModel: "test" },
    status: "succeeded",
    transcriptGeneration: 1,
  });
  await db.insert(schema.transcriptUtterances).values({
    workspaceId: owner.workspaceId,
    runId,
    id: randomUUID(),
    sequence: 0,
    text: "Ship the release on Friday.",
    speakerLabel: "SPEAKER_00",
    startSeconds: 0,
    endSeconds: 5,
  });

  return {
    ...owner,
    noteId,
    request: () =>
      repository.request(
        owner.principal,
        owner.workspaceId,
        { commandId: randomUUID(), noteId },
        policy,
      ),
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

async function cleanupReceipt(params: SummaryWorkflowParams) {
  const [row] = await db
    .select()
    .from(summaryCancellationCleanup)
    .where(
      and(
        eq(summaryCancellationCleanup.workspaceId, params.workspaceId),
        eq(summaryCancellationCleanup.jobId, params.jobId),
      ),
    );

  return row;
}

function maintenance(cancel: (params: SummaryWorkflowParams) => Promise<void>) {
  return {
    pendingCancellationCleanup: (limit: number) => repository.pendingCancellationCleanup(limit),
    cancel,
    cancellationCleaned: ({ workspaceId, jobId }: SummaryWorkflowParams) =>
      repository.cancellationCleaned(workspaceId, jobId),
    cancellationFailed() {},
    pendingDispatch(): Promise<SummaryWorkflowParams[]> {
      assert.fail("Disabled inference must not scan active jobs.");
    },
    start(): Promise<string | null> {
      assert.fail("Cancellation recovery must not start inference.");
    },
    dispatched(): Promise<void> {
      assert.fail("Cancellation recovery must not acknowledge inference dispatch.");
    },
    failed() {
      assert.fail("Cancellation recovery must not dispatch inference.");
    },
  };
}

void describe("durable summary cancellation cleanup", () => {
  void it("recovers a failed notification with inference disabled and preserves the publication fence", async () => {
    const f = await fixture();
    const job = await f.request();
    const params = { workspaceId: f.workspaceId, jobId: job.id };
    const context = await repository.prepareContext(f.workspaceId, job.id);
    const reference = referenceFor(context);
    await repository.pinContext(f.workspaceId, job.id, reference);
    const cancelled = await repository.cancel(f.principal, f.workspaceId, job.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await cleanupReceipt(params))?.completedAt, null);

    let notifications = 0;
    let failures = 0;
    const runtimeStarted = Promise.withResolvers<void>();
    const runtimeFinished = Promise.withResolvers<void>();
    const operations = {
      ...maintenance(async (input) => {
        assert.deepEqual(input, params);
        notifications += 1;
        if (notifications === 1) {
          throw new Error("Runtime notification was lost.");
        }
        runtimeStarted.resolve();
        await runtimeFinished.promise;
      }),
      cancellationFailed() {
        failures += 1;
      },
    };

    await dispatchSummaryMaintenance(false, operations);
    assert.equal(failures, 1);
    assert.equal((await cleanupReceipt(params))?.completedAt, null);
    assert.equal(
      await repository.publish(f.workspaceId, job.id, reference, analysisFor(context)),
      null,
    );
    assert.equal(
      (await repository.pendingDispatch(100)).some((pending) => pending.jobId === job.id),
      false,
    );

    const retry = dispatchSummaryMaintenance(false, operations);
    await runtimeStarted.promise;
    assert.equal((await cleanupReceipt(params))?.completedAt, null);
    runtimeFinished.resolve();
    await retry;
    const completed = await cleanupReceipt(params);
    assert.ok(completed?.completedAt);

    await repository.cancel(f.principal, f.workspaceId, job.id);
    await dispatchSummaryMaintenance(false, operations);
    assert.equal(notifications, 2);
    assert.deepEqual(await cleanupReceipt(params), completed);
    assert.equal(
      await repository.publish(f.workspaceId, job.id, reference, analysisFor(context)),
      null,
    );
    const [saved] = await sql`
      select count(*)::int as count from note_summaries
      where workspace_id = ${f.workspaceId} and job_id = ${job.id}`;
    assert.equal(saved?.count, 0);
  });

  void it("retains cleanup after lost acknowledgement and retries the same runtime identity", async () => {
    const f = await fixture();
    const job = await f.request();
    await repository.cancel(f.principal, f.workspaceId, job.id);
    const params = { workspaceId: f.workspaceId, jobId: job.id };
    const notifications: SummaryWorkflowParams[] = [];
    let acknowledgements = 0;
    const operations = {
      ...maintenance((input) => {
        notifications.push(input);

        return Promise.resolve();
      }),
      async cancellationCleaned(input: SummaryWorkflowParams) {
        acknowledgements += 1;
        if (acknowledgements === 1) {
          throw new Error("Database acknowledgement unavailable.");
        }
        await repository.cancellationCleaned(input.workspaceId, input.jobId);
      },
    };

    await dispatchSummaryMaintenance(false, operations);
    assert.equal((await cleanupReceipt(params))?.completedAt, null);
    await dispatchSummaryMaintenance(false, operations);
    await dispatchSummaryMaintenance(false, operations);
    assert.deepEqual(notifications, [params, params]);
    assert.ok((await cleanupReceipt(params))?.completedAt);
  });

  void it("rotates a failing full batch so later cancellations can complete", async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const job = await f.request();
      ids.push(job.id);
      await repository.cancel(f.principal, f.workspaceId, job.id);
    }
    const firstBatch: string[] = [];
    await dispatchSummaryMaintenance(
      false,
      maintenance(({ jobId }) => {
        firstBatch.push(jobId);

        return Promise.reject(new Error("First batch runtime is unavailable."));
      }),
    );
    assert.equal(firstBatch.length, 10);
    const later = ids.filter((id) => !firstBatch.includes(id));
    const secondBatch: string[] = [];
    await dispatchSummaryMaintenance(
      false,
      maintenance(({ jobId }) => {
        secondBatch.push(jobId);

        return firstBatch.includes(jobId)
          ? Promise.reject(new Error("Still unavailable."))
          : Promise.resolve();
      }),
    );
    assert.deepEqual(new Set(secondBatch.slice(0, 2)), new Set(later));
    for (const jobId of later) {
      assert.ok((await cleanupReceipt({ workspaceId: f.workspaceId, jobId }))?.completedAt);
    }
    await dispatchSummaryMaintenance(
      false,
      maintenance(() => Promise.resolve()),
    );
    assert.deepEqual(await repository.pendingCancellationCleanup(100), []);
  });

  void it("deduplicates concurrent cancellation and does not enqueue non-cancelled terminal jobs", async () => {
    const f = await fixture();
    const job = await f.request();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => repository.cancel(f.principal, f.workspaceId, job.id)),
    );
    assert.ok(results.every((result) => result.status === "cancelled"));
    const pending = await repository.pendingCancellationCleanup(100);
    assert.equal(pending.filter((item) => item.jobId === job.id).length, 1);
    await dispatchSummaryMaintenance(
      false,
      maintenance(() => Promise.resolve()),
    );

    const failed = await f.request();
    await repository.fail(f.workspaceId, failed.id, "failed", "Fixture failure.");
    assert.equal((await repository.cancel(f.principal, f.workspaceId, failed.id)).status, "failed");
    assert.equal(await cleanupReceipt({ workspaceId: f.workspaceId, jobId: failed.id }), undefined);
  });

  void it("rolls back cancellation if its durable cleanup request cannot commit", async () => {
    const f = await fixture();
    const job = await f.request();
    const trigger = `summary_cleanup_fail_${randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(`create function public.${trigger}() returns trigger language plpgsql as $$
      begin
        if NEW.job_id = '${job.id}'::uuid then
          raise exception 'injected cleanup persistence failure';
        end if;
        return NEW;
      end $$`);
    try {
      await sql.unsafe(
        `create trigger ${trigger} before insert on summary_cancellation_cleanup for each row execute function public.${trigger}()`,
      );
      await assert.rejects(repository.cancel(f.principal, f.workspaceId, job.id));
      assert.equal((await repository.get(f.principal, f.workspaceId, job.id)).status, "queued");
      assert.equal(await cleanupReceipt({ workspaceId: f.workspaceId, jobId: job.id }), undefined);
    } finally {
      await sql.unsafe(`drop trigger if exists ${trigger} on summary_cancellation_cleanup`);
      await sql.unsafe(`drop function public.${trigger}()`);
    }
    await repository.cancel(f.principal, f.workspaceId, job.id);
    await dispatchSummaryMaintenance(
      false,
      maintenance(() => Promise.resolve()),
    );
  });
});
