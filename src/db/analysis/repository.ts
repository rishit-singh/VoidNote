import { createHash, randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import {
  type ContextReference,
  contextReferenceSchema,
  type SummaryContext,
  summaryContextSchema,
} from "../../ai/context";
import { type SummaryPolicy, summaryPolicySchema } from "../../ai/runtime";
import {
  type AnalysisJob,
  analysisJobSchema,
  type EvidencePassage,
  type RequestSummary,
  requestSummarySchema,
  type SavedSummary,
  savedSummarySchema,
  type SummaryAnalysis,
  summaryAnalysisSchema,
  type SummaryHistory,
  type SummaryOverview,
  type TranscriptVersion,
} from "../../contracts/analysis";
import { idSchema, type Principal, WorkspaceError } from "../../contracts/workspace";
import { appendApplicationEvent } from "../activity";
import type { Database } from "../repository";
import {
  analysisJobs,
  notes,
  noteSummaries,
  people,
  processingRuns,
  recordings,
  transcriptSegments,
  transcriptUtterances,
  workspaceMemberships,
  workspaces,
} from "../schema";
import { summaryCancellationCleanup } from "../summary-cleanup-schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type AnalysisExecution = typeof analysisJobs.$inferSelect;

type Note = Pick<typeof notes.$inferSelect, "id" | "revision" | "title" | "deletedAt">;

type Run = typeof processingRuns.$inferSelect;

type LockedJob = {
  job: AnalysisExecution;
  note: Note | undefined;
  run: Run | undefined;
  unavailable: WorkspaceError | null;
};

const jobScope = (workspaceId: string, jobId: string) =>
  and(eq(analysisJobs.workspaceId, workspaceId), eq(analysisJobs.id, jobId));
const active = (job: AnalysisExecution) => job.status === "queued" || job.status === "running";

function sameSource(left: TranscriptVersion, right: TranscriptVersion) {
  return (
    left.noteId === right.noteId &&
    left.recordingId === right.recordingId &&
    left.runId === right.runId &&
    left.generation === right.generation
  );
}

function sameProfiles(left: ContextReference["profiles"], right: ContextReference["profiles"]) {
  const ordered = (items: ContextReference["profiles"]) =>
    [...items].sort((a, b) => a.personId.localeCompare(b.personId));
  const expected = ordered(right);

  return (
    left.length === right.length &&
    ordered(left).every(
      (item, index) =>
        item.personId === expected[index]?.personId && item.revision === expected[index]?.revision,
    )
  );
}

function sameReference(left: ContextReference, right: ContextReference) {
  return (
    left.snapshotId === right.snapshotId &&
    left.objectKey === right.objectKey &&
    left.checksum === right.checksum &&
    left.noteRevision === right.noteRevision &&
    sameSource(left.source, right.source) &&
    sameProfiles(left.profiles, right.profiles)
  );
}

function publicJob(row: AnalysisExecution, resultId: string | null): AnalysisJob {
  return analysisJobSchema.parse({
    id: row.id,
    commandId: row.commandId,
    noteId: row.noteId,
    status: row.status,
    source: row.source,
    resultId,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function publicSummary(row: typeof noteSummaries.$inferSelect): SavedSummary {
  return savedSummarySchema.parse({
    id: row.id,
    noteId: row.noteId,
    jobId: row.jobId,
    version: row.version,
    snapshotId: row.snapshotId,
    source: row.source,
    analysis: row.analysis,
    provenance: row.provenance,
    createdAt: row.createdAt.toISOString(),
  });
}

// Lifecycle locks are held even for an unavailable row. Background terminal
// transitions can then record blocked without throwing away their transaction.
async function membershipError(tx: Transaction, principal: Principal, workspaceId: string) {
  idSchema.parse(principal.id);
  idSchema.parse(workspaceId);
  const [member] = await tx
    .select({ revokedAt: workspaceMemberships.revokedAt, deletedAt: workspaces.deletedAt })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.id),
      ),
    )
    .for("share", { of: [workspaceMemberships, workspaces] })
    .limit(1);

  return !member || member.revokedAt || member.deletedAt
    ? new WorkspaceError("forbidden", "Workspace access denied.")
    : null;
}

async function lockNote(tx: Transaction, workspaceId: string, noteId: string) {
  // Serialize only analysis operations. Recording replay already holds its run
  // lock before taking a shared note lifecycle lock, so an exclusive note lock
  // here would invert that order. A separate advisory lock retains serialized
  // admission/version allocation without excluding those shared readers.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:note-analysis:${noteId}`}, 0))`,
  );
  const [note] = await tx
    .select({
      id: notes.id,
      revision: notes.revision,
      title: notes.title,
      deletedAt: notes.deletedAt,
    })
    .from(notes)
    .where(and(eq(notes.workspaceId, workspaceId), eq(notes.id, noteId)))
    .for("share")
    .limit(1);

  return note;
}

async function lockRun(tx: Transaction, workspaceId: string, noteId: string, runId: string) {
  const [run] = await tx
    .select()
    .from(processingRuns)
    .where(
      and(
        eq(processingRuns.workspaceId, workspaceId),
        eq(processingRuns.noteId, noteId),
        eq(processingRuns.id, runId),
      ),
    )
    .for("update")
    .limit(1);
  if (!run) {
    return { run, available: false };
  }

  const [recording] = await tx
    .select({ id: recordings.id, deletedAt: recordings.deletedAt, status: recordings.status })
    .from(recordings)
    .where(
      and(
        eq(recordings.workspaceId, workspaceId),
        eq(recordings.noteId, noteId),
        eq(recordings.id, run.recordingId),
      ),
    )
    .for("share")
    .limit(1);

  return {
    run,
    available:
      run.status === "succeeded" &&
      run.transcriptGeneration > 0 &&
      !!recording &&
      recording.deletedAt === null &&
      recording.status === "ready",
  };
}

async function lockJob(
  tx: Transaction,
  workspaceId: string,
  jobId: string,
  principal?: Principal,
): Promise<LockedJob> {
  idSchema.parse(workspaceId);
  idSchema.parse(jobId);
  // This read discovers immutable ownership only; all decisions use locked rows.
  const [identity] = await tx
    .select({
      actorId: analysisJobs.actorId,
      noteId: analysisJobs.noteId,
      runId: analysisJobs.runId,
    })
    .from(analysisJobs)
    .where(jobScope(workspaceId, jobId))
    .limit(1);
  if (!identity) {
    if (principal) {
      const denied = await membershipError(tx, principal, workspaceId);
      if (denied) {
        throw denied;
      }
    }

    throw new WorkspaceError("not_found", "Analysis job is unavailable.");
  }

  const denied = await membershipError(
    tx,
    principal ?? { id: identity.actorId, email: null },
    workspaceId,
  );
  const note = await lockNote(tx, workspaceId, identity.noteId);
  const { run, available } = await lockRun(tx, workspaceId, identity.noteId, identity.runId);
  const [job] = await tx
    .select()
    .from(analysisJobs)
    .where(jobScope(workspaceId, jobId))
    .for("update")
    .limit(1);
  if (!job) {
    throw new WorkspaceError("not_found", "Analysis job is unavailable.");
  }

  return {
    job,
    note,
    run,
    unavailable:
      denied ??
      (!note || note.deletedAt
        ? new WorkspaceError("not_found", "Note is unavailable.")
        : !available
          ? new WorkspaceError("not_found", "Finalized recording transcript is unavailable.")
          : null),
  };
}

function requireAvailable(
  locked: LockedJob,
): asserts locked is LockedJob & { note: Note; run: Run } {
  if (locked.unavailable) {
    throw locked.unavailable;
  }

  if (!locked.note || !locked.run) {
    throw new WorkspaceError("not_found", "Analysis source is unavailable.");
  }
}

function currentSource(locked: LockedJob) {
  return (
    !!locked.run &&
    locked.run.id === locked.job.source.runId &&
    locked.run.recordingId === locked.job.source.recordingId &&
    locked.run.noteId === locked.job.source.noteId &&
    locked.run.transcriptGeneration === locked.job.source.generation
  );
}

async function saved(tx: Transaction, job: AnalysisExecution) {
  const [summary] = await tx
    .select()
    .from(noteSummaries)
    .where(and(eq(noteSummaries.workspaceId, job.workspaceId), eq(noteSummaries.jobId, job.id)))
    .limit(1);

  return summary ? publicSummary(summary) : null;
}

async function jobDTO(tx: Transaction, job: AnalysisExecution) {
  const summary = job.status === "succeeded" ? await saved(tx, job) : null;

  return publicJob(job, summary?.id ?? null);
}

async function terminal(
  tx: Transaction,
  job: AnalysisExecution,
  status: "failed" | "blocked" | "superseded" | "cancelled",
  message: string | null,
) {
  if (!active(job)) {
    return job;
  }

  const [updated] = await tx
    .update(analysisJobs)
    .set({ status, error: message?.slice(0, 1000) ?? null, updatedAt: new Date() })
    .where(jobScope(job.workspaceId, job.id))
    .returning();

  if (status === "failed" || status === "blocked") {
    await appendApplicationEvent(tx, {
      id: randomUUID(),
      workspaceId: job.workspaceId,
      type: "summary.failed",
      actorId: job.actorId,
      executor: "workflow",
      operationId: job.id,
      noteId: job.noteId,
      runId: job.runId,
      generation: job.source.generation,
    });
  }

  return updated!;
}

async function lockProfiles(tx: Transaction, workspaceId: string, personIds: string[]) {
  if (!personIds.length) {
    return [];
  }

  return tx
    .select({
      personId: people.id,
      revision: people.revision,
      deletedAt: people.deletedAt,
      bytes: sql<number>`octet_length(${people.displayName}) + octet_length(${people.description})`,
    })
    .from(people)
    .where(and(eq(people.workspaceId, workspaceId), inArray(people.id, personIds)))
    .orderBy(asc(people.id))
    .for("share");
}

async function referenceCurrent(tx: Transaction, locked: LockedJob, reference: ContextReference) {
  if (
    !currentSource(locked) ||
    reference.snapshotId !== locked.job.id ||
    !sameSource(reference.source, locked.job.source) ||
    reference.noteRevision !== locked.note?.revision
  ) {
    return false;
  }

  const rows = await lockProfiles(
    tx,
    locked.job.workspaceId,
    reference.profiles.map((profile) => profile.personId),
  );

  return rows.every((row) => row.deletedAt === null) && sameProfiles(rows, reference.profiles);
}

async function contextFor(tx: Transaction, locked: LockedJob): Promise<SummaryContext> {
  requireAvailable(locked);
  const { job, note, run } = locked;
  if (!active(job)) {
    throw new WorkspaceError("conflict", "Analysis job is already terminal.");
  }

  if (!currentSource(locked)) {
    throw new WorkspaceError("conflict", "Transcript changed before context preparation.");
  }

  const policy = summaryPolicySchema.parse(job.policy);
  // Aggregate in Postgres before transferring text. A limit alone can still
  // allocate 1000 * 100 KiB in the Worker. The run lock keeps this preflight and
  // the subsequent bounded read on the same transcript generation.
  const source = run.correctionsMaterializedAt ? transcriptSegments : transcriptUtterances;
  const [size] = await tx
    .select({
      count: sql<number>`count(*)::integer`,
      bytes: sql`coalesce(sum(octet_length(${source.text})), 0)`.mapWith(Number),
    })
    .from(source)
    .where(
      and(
        eq(source.workspaceId, job.workspaceId),
        eq(source.runId, run.id),
        run.correctionsMaterializedAt ? eq(transcriptSegments.active, true) : undefined,
      ),
    );
  if (!size || size.count === 0 || size.count > policy.maxPassages) {
    throw new WorkspaceError(
      "conflict",
      "Transcript exceeds the complete-context passage budget or is empty.",
    );
  }

  if (size.bytes > policy.maxContextBytes) {
    throw new WorkspaceError("conflict", "Transcript exceeds the complete-context byte budget.");
  }

  let passages: EvidencePassage[];
  if (run.correctionsMaterializedAt) {
    const rows = await tx
      .select({ segment: transcriptSegments, providerTrackId: transcriptUtterances.speakerLabel })
      .from(transcriptSegments)
      .innerJoin(
        transcriptUtterances,
        and(
          eq(transcriptUtterances.workspaceId, transcriptSegments.workspaceId),
          eq(transcriptUtterances.runId, transcriptSegments.runId),
          eq(transcriptUtterances.id, transcriptSegments.sourceUtteranceId),
        ),
      )
      .where(
        and(
          eq(transcriptSegments.workspaceId, job.workspaceId),
          eq(transcriptSegments.runId, run.id),
          eq(transcriptSegments.active, true),
        ),
      )
      .orderBy(
        asc(transcriptSegments.sequence),
        asc(transcriptSegments.orderKey),
        asc(transcriptSegments.id),
      )
      .limit(policy.maxPassages + 1);
    passages = rows.map(({ segment, providerTrackId }) => ({
      evidenceId: segment.id,
      segmentId: segment.id,
      segmentRevision: segment.revision,
      attributionRevision: segment.attributionRevision,
      sourceUtteranceId: segment.sourceUtteranceId,
      sequence: segment.sequence,
      orderKey: segment.orderKey,
      providerTrackId,
      assignment:
        segment.assignmentKind === "person"
          ? { kind: "person", personId: segment.personId! }
          : { kind: segment.assignmentKind },
      text: segment.text,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
    }));
  } else {
    const rows = await tx
      .select()
      .from(transcriptUtterances)
      .where(
        and(
          eq(transcriptUtterances.workspaceId, job.workspaceId),
          eq(transcriptUtterances.runId, run.id),
        ),
      )
      .orderBy(asc(transcriptUtterances.sequence), asc(transcriptUtterances.id))
      .limit(policy.maxPassages + 1);
    passages = rows.map((row) => ({
      evidenceId: row.id,
      segmentId: row.id,
      segmentRevision: 0,
      attributionRevision: 0,
      sourceUtteranceId: row.id,
      sequence: row.sequence,
      orderKey: "",
      providerTrackId: row.speakerLabel,
      assignment: { kind: "unassigned" },
      text: row.text,
      startSeconds: row.startSeconds,
      endSeconds: row.endSeconds,
    }));
  }

  if (!passages.length || passages.length > policy.maxPassages) {
    throw new WorkspaceError(
      "conflict",
      "Transcript exceeds the complete-context passage budget or is empty.",
    );
  }

  const personIds = [
    ...new Set(
      passages.flatMap((passage) =>
        passage.assignment.kind === "person" ? [passage.assignment.personId] : [],
      ),
    ),
  ];
  if (personIds.length > 100) {
    throw new WorkspaceError("conflict", "Transcript exceeds the complete-context profile budget.");
  }

  // Lock only metadata and byte lengths first, so authored descriptions are not
  // transferred until their combined size is known to fit the pinned budget.
  const profileMetadata = await lockProfiles(tx, job.workspaceId, personIds);
  if (profileMetadata.length !== personIds.length || profileMetadata.some((row) => row.deletedAt)) {
    throw new WorkspaceError("conflict", "A referenced person is unavailable.");
  }

  if (
    profileMetadata.reduce((bytes, profile) => bytes + profile.bytes, size.bytes) >
    policy.maxContextBytes
  ) {
    throw new WorkspaceError("conflict", "Profiles exceed the complete-context byte budget.");
  }

  const profileRows = personIds.length
    ? await tx
        .select({
          personId: people.id,
          revision: people.revision,
          displayName: people.displayName,
          authoredDescription: people.description,
        })
        .from(people)
        .where(and(eq(people.workspaceId, job.workspaceId), inArray(people.id, personIds)))
        .orderBy(asc(people.id))
    : [];
  const context = summaryContextSchema.parse({
    schemaVersion: 1,
    snapshotId: job.id,
    workspaceId: job.workspaceId,
    source: job.source,
    noteRevision: note.revision,
    title: note.title,
    passages,
    people: profileRows.map(({ personId, revision, displayName, authoredDescription }) => ({
      personId,
      revision,
      displayName,
      authoredDescription,
    })),
    agenda: null,
    relatedConversations: [],
    coverage: { complete: true, passageCount: passages.length },
  });
  if (new TextEncoder().encode(JSON.stringify(context)).byteLength > policy.maxContextBytes) {
    throw new WorkspaceError("conflict", "Transcript exceeds the complete-context byte budget.");
  }

  return context;
}

export function createAnalysisRepository(db: Database) {
  return {
    async overview(
      principal: Principal,
      workspaceId: string,
      noteId: string,
      canGenerate: boolean,
    ): Promise<SummaryOverview> {
      return db.transaction(async (tx) => {
        const denied = await membershipError(tx, principal, workspaceId);
        if (denied) {
          throw denied;
        }

        const note = await lockNote(tx, workspaceId, noteId);
        if (!note || note.deletedAt) {
          throw new WorkspaceError("not_found", "Note is unavailable.");
        }

        const [job] = await tx
          .select()
          .from(analysisJobs)
          .where(and(eq(analysisJobs.workspaceId, workspaceId), eq(analysisJobs.noteId, noteId)))
          .orderBy(desc(analysisJobs.createdAt), desc(analysisJobs.id))
          .limit(1);
        const [summary] = await tx
          .select({ jobId: noteSummaries.jobId })
          .from(noteSummaries)
          .where(and(eq(noteSummaries.workspaceId, workspaceId), eq(noteSummaries.noteId, noteId)))
          .orderBy(desc(noteSummaries.version))
          .limit(1);
        const [run] = await tx
          .select({ id: processingRuns.id })
          .from(processingRuns)
          .innerJoin(
            recordings,
            and(
              eq(recordings.workspaceId, processingRuns.workspaceId),
              eq(recordings.id, processingRuns.recordingId),
              isNull(recordings.deletedAt),
              eq(recordings.status, "ready"),
            ),
          )
          .where(
            and(
              eq(processingRuns.workspaceId, workspaceId),
              eq(processingRuns.noteId, noteId),
              eq(processingRuns.status, "succeeded"),
              sql`${processingRuns.transcriptGeneration} > 0`,
            ),
          )
          .orderBy(desc(processingRuns.createdAt), asc(processingRuns.id))
          .limit(1);
        const available = !!run;
        const unavailableReason = canGenerate
          ? available
            ? null
            : "A finalized transcript is required."
          : "Summary generation is disabled.";

        return {
          latestJob: job ? await jobDTO(tx, job) : null,
          latestSummaryJobId: summary?.jobId ?? null,
          canGenerate: canGenerate && available,
          unavailableReason,
        };
      });
    },

    async history(
      principal: Principal,
      workspaceId: string,
      noteId: string,
      cursor: string | undefined,
      limit: number,
    ): Promise<SummaryHistory> {
      return db.transaction(async (tx) => {
        const denied = await membershipError(tx, principal, workspaceId);
        if (denied) {
          throw denied;
        }

        const note = await lockNote(tx, workspaceId, noteId);
        if (!note || note.deletedAt) {
          throw new WorkspaceError("not_found", "Note is unavailable.");
        }

        let beforeVersion: number | undefined;
        if (cursor) {
          const match = /^(\d+):([0-9a-f-]{36})$/i.exec(cursor);
          if (!match) {
            throw new WorkspaceError("invalid_cursor", "Invalid summary history cursor.");
          }

          beforeVersion = Number(match[1]);
          const [cursorRow] = await tx
            .select({ version: noteSummaries.version })
            .from(noteSummaries)
            .where(
              and(
                eq(noteSummaries.workspaceId, workspaceId),
                eq(noteSummaries.noteId, noteId),
                eq(noteSummaries.version, beforeVersion),
                eq(noteSummaries.jobId, match[2]!),
              ),
            )
            .limit(1);
          if (!cursorRow) {
            throw new WorkspaceError("invalid_cursor", "Summary history cursor is unavailable.");
          }
        }

        const rows = await tx
          .select({
            jobId: noteSummaries.jobId,
            version: noteSummaries.version,
            createdAt: noteSummaries.createdAt,
          })
          .from(noteSummaries)
          .where(
            and(
              eq(noteSummaries.workspaceId, workspaceId),
              eq(noteSummaries.noteId, noteId),
              beforeVersion === undefined
                ? undefined
                : sql`${noteSummaries.version} < ${beforeVersion}`,
            ),
          )
          .orderBy(desc(noteSummaries.version), desc(noteSummaries.jobId))
          .limit(limit + 1);
        const hasMore = rows.length > limit;
        const items = rows.slice(0, limit).map((row) => ({
          jobId: row.jobId,
          version: row.version,
          createdAt: row.createdAt.toISOString(),
        }));
        const last = items.at(-1);

        return {
          items,
          nextCursor: hasMore && last ? `${last.version}:${last.jobId}` : null,
        };
      });
    },

    async request(
      principal: Principal,
      workspaceId: string,
      value: RequestSummary,
      policy: SummaryPolicy | null,
      automaticSource?: { runId: string; generation: number },
    ): Promise<AnalysisJob> {
      const command = requestSummarySchema.parse(value);

      return db.transaction(async (tx) => {
        const denied = await membershipError(tx, principal, workspaceId);
        if (denied) {
          throw denied;
        }

        const [existing] = await tx
          .select()
          .from(analysisJobs)
          .where(jobScope(workspaceId, command.commandId))
          .limit(1);
        if (existing) {
          if (existing.actorId !== principal.id || existing.noteId !== command.noteId) {
            throw new WorkspaceError(
              "command_reused",
              "Command ID already identifies another request.",
            );
          }

          const locked = await lockJob(tx, workspaceId, existing.id, principal);
          requireAvailable(locked);

          return jobDTO(tx, locked.job);
        }

        const note = await lockNote(tx, workspaceId, command.noteId);
        if (!note || note.deletedAt) {
          throw new WorkspaceError("not_found", "Note is unavailable.");
        }

        const [candidate] = await tx
          .select({ id: processingRuns.id })
          .from(processingRuns)
          .innerJoin(
            recordings,
            and(
              eq(recordings.workspaceId, processingRuns.workspaceId),
              eq(recordings.id, processingRuns.recordingId),
              eq(recordings.noteId, processingRuns.noteId),
              isNull(recordings.deletedAt),
              eq(recordings.status, "ready"),
            ),
          )
          .where(
            and(
              eq(processingRuns.workspaceId, workspaceId),
              eq(processingRuns.noteId, command.noteId),
              eq(processingRuns.status, "succeeded"),
            ),
          )
          .orderBy(desc(processingRuns.createdAt), asc(processingRuns.id))
          .limit(1);
        if (!candidate) {
          throw new WorkspaceError("conflict", "A finalized transcript is required.");
        }

        const { run, available } = await lockRun(tx, workspaceId, command.noteId, candidate.id);
        if (!run || !available) {
          throw new WorkspaceError("conflict", "A finalized transcript is required.");
        }

        if (automaticSource) {
          if (
            run.id !== automaticSource.runId ||
            run.transcriptGeneration !== automaticSource.generation
          ) {
            throw new WorkspaceError("conflict", "Automatic summary source has been superseded.");
          }

          const [accepted] = await tx
            .select()
            .from(analysisJobs)
            .where(
              and(
                eq(analysisJobs.workspaceId, workspaceId),
                eq(analysisJobs.noteId, command.noteId),
                eq(analysisJobs.runId, run.id),
                sql`${analysisJobs.source}->>'generation' = ${String(automaticSource.generation)}`,
              ),
            )
            .orderBy(desc(analysisJobs.createdAt))
            .limit(1);
          if (accepted) {
            return jobDTO(tx, accepted);
          }
        }

        // Concurrent exact requests serialize on the note. Do not validate new
        // policy until the winner is known; replay keeps the original policy.
        const [winner] = await tx
          .select()
          .from(analysisJobs)
          .where(jobScope(workspaceId, command.commandId))
          .for("update")
          .limit(1);
        if (winner) {
          if (winner.actorId !== principal.id || winner.noteId !== command.noteId) {
            throw new WorkspaceError(
              "command_reused",
              "Command ID already identifies another request.",
            );
          }

          return jobDTO(tx, winner);
        }

        if (policy === null) {
          throw new WorkspaceError("conflict", "Summary generation is not enabled.");
        }

        await tx
          .insert(analysisJobs)
          .values({
            workspaceId,
            id: command.commandId,
            commandId: command.commandId,
            actorId: principal.id,
            noteId: command.noteId,
            runId: run.id,
            source: {
              noteId: command.noteId,
              recordingId: run.recordingId,
              runId: run.id,
              generation: run.transcriptGeneration,
            },
            policy: summaryPolicySchema.parse(policy),
          })
          .onConflictDoNothing();
        const [job] = await tx
          .select()
          .from(analysisJobs)
          .where(jobScope(workspaceId, command.commandId))
          .for("update")
          .limit(1);
        if (!job || job.actorId !== principal.id || job.noteId !== command.noteId) {
          throw new WorkspaceError(
            "command_reused",
            "Command ID already identifies another request.",
          );
        }

        return jobDTO(tx, job);
      });
    },

    async get(principal: Principal, workspaceId: string, jobId: string): Promise<AnalysisJob> {
      return db.transaction(async (tx) => {
        const locked = await lockJob(tx, workspaceId, jobId, principal);
        requireAvailable(locked);

        return jobDTO(tx, locked.job);
      });
    },

    async cancel(principal: Principal, workspaceId: string, jobId: string): Promise<AnalysisJob> {
      return db.transaction(async (tx) => {
        const locked = await lockJob(tx, workspaceId, jobId, principal);
        requireAvailable(locked);

        const job = await terminal(tx, locked.job, "cancelled", null);
        if (job.status === "cancelled") {
          // Cancellation and its runtime cleanup request commit together. Keep
          // completed receipts so terminal command replay cannot recreate work.
          await tx
            .insert(summaryCancellationCleanup)
            .values({ workspaceId, jobId })
            .onConflictDoNothing();
        }

        return jobDTO(tx, job);
      });
    },

    async result(
      principal: Principal,
      workspaceId: string,
      jobId: string,
    ): Promise<{ summary: SavedSummary; freshness: "current" | "stale" }> {
      return db.transaction(async (tx) => {
        const locked = await lockJob(tx, workspaceId, jobId, principal);
        requireAvailable(locked);
        const summary = await saved(tx, locked.job);
        if (!summary || locked.job.status !== "succeeded") {
          throw new WorkspaceError("not_found", "Summary is not available.");
        }

        const current =
          !!locked.job.context && (await referenceCurrent(tx, locked, locked.job.context));

        return { summary, freshness: current ? "current" : "stale" };
      });
    },

    async evidence(
      principal: Principal,
      workspaceId: string,
      jobId: string,
    ): Promise<{ reference: ContextReference; maxContextBytes: number }> {
      return db.transaction(async (tx) => {
        // Readers authorize as themselves, independently of the original actor.
        // Source generation drift is allowed: citations resolve against the
        // immutable saved snapshot, not a fresh transcript projection.
        const locked = await lockJob(tx, workspaceId, jobId, principal);
        requireAvailable(locked);

        if (locked.job.status !== "succeeded" || !locked.job.context) {
          throw new WorkspaceError("not_found", "Saved summary evidence is not available.");
        }

        const [summary] = await tx
          .select({ id: noteSummaries.id })
          .from(noteSummaries)
          .where(and(eq(noteSummaries.workspaceId, workspaceId), eq(noteSummaries.jobId, jobId)))
          .limit(1);

        if (!summary) {
          throw new WorkspaceError("not_found", "Saved summary evidence is not available.");
        }

        return {
          reference: contextReferenceSchema.parse(locked.job.context),
          maxContextBytes: summaryPolicySchema.parse(locked.job.policy).maxContextBytes,
        };
      });
    },

    async pendingCancellationCleanup(limit = 10) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new WorkspaceError("conflict", "Invalid summary cleanup limit.");
      }

      return db.transaction(async (tx) => {
        const selected = await tx
          .select({
            workspaceId: summaryCancellationCleanup.workspaceId,
            jobId: summaryCancellationCleanup.jobId,
          })
          .from(summaryCancellationCleanup)
          .where(isNull(summaryCancellationCleanup.completedAt))
          .orderBy(
            sql`${summaryCancellationCleanup.checkedAt} asc nulls first`,
            asc(summaryCancellationCleanup.createdAt),
            asc(summaryCancellationCleanup.workspaceId),
            asc(summaryCancellationCleanup.jobId),
          )
          .limit(limit)
          .for("update", { skipLocked: true });

        if (selected.length) {
          // Rotate before external calls: failures and process loss cannot pin
          // the first batch forever. The monotonic floor also handles clock
          // precision ties without repeatedly selecting the same failed row.
          await tx
            .update(summaryCancellationCleanup)
            .set({
              checkedAt: sql`greatest(
                clock_timestamp(),
                coalesce(${summaryCancellationCleanup.checkedAt}, ${summaryCancellationCleanup.createdAt})
                  + interval '1 millisecond'
              )`,
            })
            .where(
              or(
                ...selected.map(({ workspaceId, jobId }) =>
                  and(
                    eq(summaryCancellationCleanup.workspaceId, workspaceId),
                    eq(summaryCancellationCleanup.jobId, jobId),
                  ),
                ),
              ),
            );
        }

        return selected;
      });
    },

    /** Acknowledge only after the exact runtime cancellation RPC has completed. */
    async cancellationCleaned(workspaceId: string, jobId: string): Promise<void> {
      idSchema.parse(workspaceId);
      idSchema.parse(jobId);
      await db
        .update(summaryCancellationCleanup)
        .set({ completedAt: new Date() })
        .where(
          and(
            eq(summaryCancellationCleanup.workspaceId, workspaceId),
            eq(summaryCancellationCleanup.jobId, jobId),
            isNull(summaryCancellationCleanup.completedAt),
          ),
        );
    },

    async pendingDispatch(limit = 10) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new WorkspaceError("conflict", "Invalid analysis dispatch limit.");
      }

      // This is both dispatch and reconciliation: an acknowledged/running job
      // may still need its runtime terminal state persisted after a DB outage.
      // Persist attempted checks before returning, so failed confirmations or
      // dispatcher crashes cannot leave the same oldest batch starving later jobs.
      // Only identities leave this scan; execution() authorizes source access.
      return db.transaction(async (tx) => {
        const selected = await tx
          .select({ workspaceId: analysisJobs.workspaceId, jobId: analysisJobs.id })
          .from(analysisJobs)
          .where(inArray(analysisJobs.status, ["queued", "running"]))
          .orderBy(
            asc(sql`coalesce(${analysisJobs.dispatchCheckedAt}, ${analysisJobs.createdAt})`),
            asc(analysisJobs.workspaceId),
            asc(analysisJobs.id),
          )
          .limit(limit)
          .for("update", { skipLocked: true });

        if (selected.length) {
          await tx
            .update(analysisJobs)
            .set({ dispatchCheckedAt: new Date() })
            .where(or(...selected.map(({ workspaceId, jobId }) => jobScope(workspaceId, jobId))));
        }

        return selected;
      });
    },

    async dispatched(workspaceId: string, jobId: string): Promise<void> {
      await db.transaction(async (tx) => {
        const locked = await lockJob(tx, workspaceId, jobId);
        if (locked.unavailable) {
          await terminal(tx, locked.job, "blocked", locked.unavailable.message);

          return;
        }

        await tx
          .update(analysisJobs)
          .set({ dispatchedAt: new Date() })
          .where(jobScope(workspaceId, jobId));
      });
    },

    async execution(workspaceId: string, jobId: string): Promise<AnalysisExecution> {
      return db.transaction(async (tx) => {
        const locked = await lockJob(tx, workspaceId, jobId);
        requireAvailable(locked);

        return locked.job;
      });
    },

    async prepareContext(workspaceId: string, jobId: string): Promise<SummaryContext> {
      return db.transaction(async (tx) => contextFor(tx, await lockJob(tx, workspaceId, jobId)));
    },

    async pinContext(
      workspaceId: string,
      jobId: string,
      value: ContextReference,
    ): Promise<ContextReference> {
      const reference = contextReferenceSchema.parse(value);

      return db.transaction(async (tx) => {
        const locked = await lockJob(tx, workspaceId, jobId);
        requireAvailable(locked);
        if (locked.job.context && !sameReference(locked.job.context, reference)) {
          throw new WorkspaceError("conflict", "Analysis context is already pinned.");
        }

        const context = await contextFor(tx, locked);
        const checksum = createHash("sha256").update(JSON.stringify(context)).digest("hex");
        if (
          reference.snapshotId !== context.snapshotId ||
          !sameSource(reference.source, context.source) ||
          reference.noteRevision !== context.noteRevision ||
          !sameProfiles(reference.profiles, context.people) ||
          reference.checksum !== checksum
        ) {
          throw new WorkspaceError(
            "conflict",
            "Context does not match the current complete snapshot.",
          );
        }

        if (!locked.job.context) {
          await tx
            .update(analysisJobs)
            .set({ context: reference, status: "running", updatedAt: new Date() })
            .where(jobScope(workspaceId, jobId));
        }

        return locked.job.context ?? reference;
      });
    },

    async publish(
      workspaceId: string,
      jobId: string,
      value: ContextReference,
      valueAnalysis: SummaryAnalysis,
    ): Promise<SavedSummary | null> {
      return db.transaction(async (tx) => {
        const locked = await lockJob(tx, workspaceId, jobId);
        if (locked.unavailable) {
          await terminal(tx, locked.job, "blocked", locked.unavailable.message);

          return null;
        }

        // A successful replay always returns the original output, even if a
        // caller presents different generated text or the source is now stale.
        if (locked.job.status === "succeeded") {
          return saved(tx, locked.job);
        }

        if (!active(locked.job)) {
          return null;
        }

        const reference = contextReferenceSchema.parse(value);
        const analysis = summaryAnalysisSchema.parse(valueAnalysis);
        if (!locked.job.context || !sameReference(locked.job.context, reference)) {
          throw new WorkspaceError("conflict", "Publication does not match the pinned context.");
        }

        if (!(await referenceCurrent(tx, locked, reference))) {
          await terminal(
            tx,
            locked.job,
            "superseded",
            "Analysis source changed before publication.",
          );

          return null;
        }

        const policy = summaryPolicySchema.parse(locked.job.policy);
        if (new TextEncoder().encode(JSON.stringify(analysis)).byteLength > policy.maxOutputBytes) {
          throw new WorkspaceError("conflict", "Summary exceeds the pinned output budget.");
        }

        // lockNote's analysis advisory lock serializes versions across jobs.
        const [latest] = await tx
          .select({ version: sql<number>`coalesce(max(${noteSummaries.version}), 0)::integer` })
          .from(noteSummaries)
          .where(
            and(
              eq(noteSummaries.workspaceId, workspaceId),
              eq(noteSummaries.noteId, locked.job.noteId),
            ),
          );
        const [summary] = await tx
          .insert(noteSummaries)
          .values({
            workspaceId,
            id: randomUUID(),
            noteId: locked.job.noteId,
            jobId,
            version: (latest?.version ?? 0) + 1,
            snapshotId: reference.snapshotId,
            source: locked.job.source,
            analysis,
            provenance: {
              model: policy.model,
              promptVersion: policy.promptVersion,
              schemaVersion: policy.schemaVersion,
              policyVersion: policy.version,
            },
          })
          .returning();
        await tx
          .update(analysisJobs)
          .set({ status: "succeeded", error: null, updatedAt: new Date() })
          .where(jobScope(workspaceId, jobId));

        await appendApplicationEvent(tx, {
          id: summary!.id,
          workspaceId,
          type: "summary.published",
          actorId: locked.job.actorId,
          executor: "workflow",
          operationId: jobId,
          noteId: locked.job.noteId,
          runId: locked.job.runId,
          generation: locked.job.source.generation,
          resultId: summary!.id,
        });

        return publicSummary(summary!);
      });
    },

    async fail(
      workspaceId: string,
      jobId: string,
      status: "failed" | "blocked" | "superseded",
      message: string,
    ): Promise<void> {
      await db.transaction(async (tx) => {
        const locked = await lockJob(tx, workspaceId, jobId);
        await terminal(
          tx,
          locked.job,
          locked.unavailable ? "blocked" : status,
          locked.unavailable?.message ?? message,
        );
      });
    },
  };
}
