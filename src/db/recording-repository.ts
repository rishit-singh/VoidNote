import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  recordingInputSchema,
  recordingSchema,
  processingRunSchema,
  type RecordingInput,
  type ProcessingStatus,
} from "../contracts/recording-processing";
import { idSchema, WorkspaceError, type Principal } from "../contracts/workspace";
import type { Database } from "./repository";
import {
  notes,
  recordings,
  processingRuns,
  processingOutbox,
  recordingEvents,
  transcriptUtterances,
  workspaceMemberships,
  workspaces,
} from "./schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type NormalizedTurn = { start: number; end: number; speaker: string; text: string };
const config = { model: "precision-3", transcriptionModel: "parakeet-tdt-0.6b-v3" };
const remote = (row: typeof recordings.$inferSelect) =>
  recordingSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    noteId: row.noteId,
    sha256: row.sha256,
    bytes: row.bytes,
    mimeType: row.mimeType,
    durationSeconds: row.durationSeconds,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  });
const runDTO = (row: typeof processingRuns.$inferSelect) =>
  processingRunSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

async function authorizeNote(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  noteId: string,
) {
  idSchema.parse(workspaceId);
  idSchema.parse(noteId);
  idSchema.parse(principal.id);
  const [membership] = await tx
    .select({ id: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.id),
        isNull(workspaceMemberships.revokedAt),
        isNull(workspaces.deletedAt),
      ),
    )
    .for("share", { of: workspaceMemberships })
    .limit(1);
  if (!membership) throw new WorkspaceError("forbidden", "Workspace access denied.");
  const [note] = await tx
    .select({ id: notes.id })
    .from(notes)
    .where(and(eq(notes.workspaceId, workspaceId), eq(notes.id, noteId), isNull(notes.deletedAt)))
    .for("share")
    .limit(1);
  if (!note) throw new WorkspaceError("not_found", "Note is unavailable.");
}

function stableTurnId(runId: string, sequence: number) {
  const bytes = createHash("sha256").update(`${runId}:utterance:${sequence}`).digest();
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createRecordingRepository(db: Database) {
  const transaction = <T>(work: (tx: Transaction) => Promise<T>) =>
    db.transaction(async (tx) => {
      // Duration is part of the immutable initialization command. A database
      // default of 0 rounds float8 text output and can reject even a fresh insert.
      // Scope round-trip-safe output to this transaction: Hyperdrive pools and resets
      // connections, so a startup/session SET cannot establish this invariant.
      await tx.execute(sql`set local extra_float_digits = 3`);
      return work(tx);
    });
  async function ownedRecording(
    tx: Transaction,
    principal: Principal,
    workspaceId: string,
    noteId: string,
    id: string,
  ) {
    await authorizeNote(tx, principal, workspaceId, noteId);
    const [row] = await tx
      .select()
      .from(recordings)
      .where(
        and(
          eq(recordings.workspaceId, workspaceId),
          eq(recordings.noteId, noteId),
          eq(recordings.id, idSchema.parse(id)),
          isNull(recordings.deletedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) throw new WorkspaceError("not_found", "Recording is unavailable.");
    return row;
  }
  async function execution(tx: Transaction, workspaceId: string, runId: string) {
    const [run] = await tx
      .select()
      .from(processingRuns)
      .where(and(eq(processingRuns.workspaceId, workspaceId), eq(processingRuns.id, runId)))
      .for("update")
      .limit(1);
    if (!run) throw new WorkspaceError("not_found", "Processing run is unavailable.");
    const recording = await ownedRecording(
      tx,
      { id: run.actorId, email: null },
      workspaceId,
      run.noteId,
      run.recordingId,
    );
    if (recording.status !== "ready")
      throw new WorkspaceError("conflict", "Recording is not remotely ready.");
    return { run, recording };
  }
  return {
    async initialize(
      principal: Principal,
      workspaceId: string,
      noteId: string,
      value: RecordingInput,
    ) {
      const input = recordingInputSchema.parse(value);
      return transaction(async (tx) => {
        await authorizeNote(tx, principal, workspaceId, noteId);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:note-audio:${noteId}`}, 0))`,
        );
        const existingAudio = await tx
          .select({ id: recordings.id })
          .from(recordings)
          .where(
            and(
              eq(recordings.workspaceId, workspaceId),
              eq(recordings.noteId, noteId),
              isNull(recordings.deletedAt),
            ),
          );
        if (existingAudio.length && !existingAudio.some((row) => row.id === input.id))
          throw new WorkspaceError(
            "conflict",
            "This note already has a recording. Start a new note for new audio.",
          );
        await tx
          .insert(recordings)
          .values({
            ...input,
            workspaceId,
            noteId,
            actorId: principal.id,
            objectKey: `${workspaceId}/recordings/${input.id}/${input.sha256}`,
          })
          .onConflictDoNothing();
        const row = await ownedRecording(tx, principal, workspaceId, noteId, input.id);
        if (
          row.sha256 !== input.sha256 ||
          row.bytes !== input.bytes ||
          row.mimeType !== input.mimeType ||
          row.durationSeconds !== input.durationSeconds
        )
          throw new WorkspaceError("conflict", "Recording ID already identifies different audio.");
        return remote(row);
      });
    },
    async getRecording(principal: Principal, workspaceId: string, noteId: string, id: string) {
      return transaction((tx) => ownedRecording(tx, principal, workspaceId, noteId, id));
    },
    async capabilityRecording(workspaceId: string, noteId: string, id: string) {
      return transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(recordings)
          .where(
            and(
              eq(recordings.workspaceId, workspaceId),
              eq(recordings.noteId, noteId),
              eq(recordings.id, id),
            ),
          )
          .limit(1);
        if (!row) throw new WorkspaceError("not_found", "Recording is unavailable.");
        return ownedRecording(tx, { id: row.actorId, email: null }, workspaceId, noteId, id);
      });
    },
    async acknowledge(
      principal: Principal,
      workspaceId: string,
      noteId: string,
      id: string,
      bytes: number,
    ) {
      return transaction(async (tx) => {
        const row = await ownedRecording(tx, principal, workspaceId, noteId, id);
        if (bytes !== row.bytes)
          throw new WorkspaceError("conflict", "Stored audio length differs from the manifest.");
        if (row.status === "ready") return remote(row);
        const [ready] = await tx
          .update(recordings)
          .set({ status: "ready" })
          .where(and(eq(recordings.workspaceId, workspaceId), eq(recordings.id, id)))
          .returning();
        await tx
          .insert(recordingEvents)
          .values({ workspaceId, recordingId: id, kind: "recording.ready" });
        return remote(ready!);
      });
    },
    async overview(principal: Principal, workspaceId: string, noteId: string) {
      return transaction(async (tx) => {
        await authorizeNote(tx, principal, workspaceId, noteId);
        const audio = await tx
          .select()
          .from(recordings)
          .where(
            and(
              eq(recordings.workspaceId, workspaceId),
              eq(recordings.noteId, noteId),
              isNull(recordings.deletedAt),
            ),
          )
          .orderBy(desc(recordings.createdAt), asc(recordings.id))
          .limit(30);
        const runs = await tx
          .select()
          .from(processingRuns)
          .where(
            and(eq(processingRuns.workspaceId, workspaceId), eq(processingRuns.noteId, noteId)),
          )
          .orderBy(desc(processingRuns.createdAt))
          .limit(30);
        return { recordings: audio.map(remote), runs: runs.map(runDTO) };
      });
    },
    async requestProcessing(
      principal: Principal,
      workspaceId: string,
      noteId: string,
      recordingId: string,
      runId: string,
    ) {
      idSchema.parse(runId);
      return transaction(async (tx) => {
        const recording = await ownedRecording(tx, principal, workspaceId, noteId, recordingId);
        if (recording.status !== "ready")
          throw new WorkspaceError("conflict", "Upload audio before processing.");
        const [existing] = await tx
          .select()
          .from(processingRuns)
          .where(
            and(
              eq(processingRuns.workspaceId, workspaceId),
              eq(processingRuns.recordingId, recordingId),
            ),
          )
          .limit(1);
        if (existing) return runDTO(existing);
        const [reused] = await tx
          .select({ id: processingRuns.id })
          .from(processingRuns)
          .where(and(eq(processingRuns.workspaceId, workspaceId), eq(processingRuns.id, runId)))
          .limit(1);
        if (reused)
          throw new WorkspaceError(
            "command_reused",
            "Run ID already identifies another recording.",
          );
        const [run] = await tx
          .insert(processingRuns)
          .values({ workspaceId, id: runId, noteId, recordingId, actorId: principal.id, config })
          .returning();
        await tx
          .insert(recordingEvents)
          .values({ workspaceId, recordingId, runId, kind: "processing.requested" });
        await tx.insert(processingOutbox).values({ workspaceId, runId });
        return runDTO(run!);
      });
    },
    async transcript(
      principal: Principal,
      workspaceId: string,
      noteId: string,
      runId: string,
      after: number,
    ) {
      return transaction(async (tx) => {
        await authorizeNote(tx, principal, workspaceId, noteId);
        const [result] = await tx
          .select({ run: processingRuns })
          .from(processingRuns)
          .innerJoin(
            recordings,
            and(
              eq(recordings.workspaceId, processingRuns.workspaceId),
              eq(recordings.id, processingRuns.recordingId),
            ),
          )
          .where(
            and(
              eq(processingRuns.workspaceId, workspaceId),
              eq(processingRuns.noteId, noteId),
              eq(processingRuns.id, idSchema.parse(runId)),
              eq(processingRuns.status, "succeeded"),
              isNull(recordings.deletedAt),
            ),
          )
          .limit(1);
        if (!result) throw new WorkspaceError("not_found", "Finalized transcript is unavailable.");
        const { run } = result;
        const rows = await tx
          .select()
          .from(transcriptUtterances)
          .where(
            and(
              eq(transcriptUtterances.workspaceId, workspaceId),
              eq(transcriptUtterances.runId, runId),
              gt(transcriptUtterances.sequence, after),
            ),
          )
          .orderBy(asc(transcriptUtterances.sequence))
          .limit(101);
        const page = rows.slice(0, 100);
        return {
          items: page.map((row) => ({ ...row, recordingId: run.recordingId })),
          nextCursor: rows.length > 100 ? page.at(-1)!.sequence : null,
        };
      });
    },
    async pendingDispatch() {
      return db
        .select({ workspaceId: processingOutbox.workspaceId, runId: processingOutbox.runId })
        .from(processingOutbox)
        .where(isNull(processingOutbox.dispatchedAt))
        .orderBy(asc(processingOutbox.createdAt))
        .limit(25);
    },
    async dispatched(workspaceId: string, runId: string) {
      await db
        .update(processingOutbox)
        .set({ dispatchedAt: new Date() })
        .where(
          and(eq(processingOutbox.workspaceId, workspaceId), eq(processingOutbox.runId, runId)),
        );
    },
    execution: (workspaceId: string, runId: string) =>
      transaction((tx) => execution(tx, workspaceId, runId)),
    async claimSubmission(workspaceId: string, runId: string) {
      return transaction(async (tx) => {
        const state = await execution(tx, workspaceId, runId);
        if (state.run.providerJobId || state.run.status !== "queued")
          return { ...state, submit: false };
        await tx
          .update(processingRuns)
          .set({ status: "submitting", updatedAt: new Date() })
          .where(and(eq(processingRuns.workspaceId, workspaceId), eq(processingRuns.id, runId)));
        return { ...state, submit: true };
      });
    },
    async bindJob(workspaceId: string, runId: string, jobId: string) {
      return transaction(async (tx) => {
        const { run } = await execution(tx, workspaceId, runId);
        if (run.providerJobId && run.providerJobId !== jobId)
          throw new WorkspaceError("conflict", "Provider job is already bound.");
        if (["failed", "blocked", "succeeded"].includes(run.status)) return;
        await tx
          .update(processingRuns)
          .set({ providerJobId: jobId, status: "submitted", error: null, updatedAt: new Date() })
          .where(and(eq(processingRuns.workspaceId, workspaceId), eq(processingRuns.id, runId)));
      });
    },
    async status(
      workspaceId: string,
      runId: string,
      status: ProcessingStatus,
      error: string | null = null,
    ) {
      await transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(processingRuns)
          .where(and(eq(processingRuns.workspaceId, workspaceId), eq(processingRuns.id, runId)))
          .for("update")
          .limit(1);
        if (
          !current ||
          current.status === "succeeded" ||
          (status === "submission_unknown" && current.providerJobId)
        )
          return;
        await tx
          .update(processingRuns)
          .set({ status, error, updatedAt: new Date() })
          .where(and(eq(processingRuns.workspaceId, workspaceId), eq(processingRuns.id, runId)));
      });
    },
    async publish(
      workspaceId: string,
      runId: string,
      rawObjectKey: string,
      turns: NormalizedTurn[],
    ) {
      return transaction(async (tx) => {
        const { run, recording } = await execution(tx, workspaceId, runId);
        if (run.status === "succeeded") return;
        if (!run.providerJobId)
          throw new WorkspaceError("conflict", "No acknowledged provider job.");
        if (
          turns.some(
            (turn) =>
              !Number.isFinite(turn.start) ||
              !Number.isFinite(turn.end) ||
              turn.start < 0 ||
              turn.end < turn.start ||
              turn.end > recording.durationSeconds + 0.5,
          )
        )
          throw new WorkspaceError(
            "conflict",
            "Provider timestamps exceed the recording timeline.",
          );
        for (let offset = 0; offset < turns.length; offset += 100) {
          await tx.insert(transcriptUtterances).values(
            turns.slice(offset, offset + 100).map((turn, index) => ({
              workspaceId,
              runId,
              id: stableTurnId(runId, offset + index),
              sequence: offset + index,
              startSeconds: turn.start,
              endSeconds: turn.end,
              speakerLabel: turn.speaker,
              text: turn.text,
            })),
          );
        }
        await tx
          .update(processingRuns)
          .set({ status: "succeeded", rawObjectKey, error: null, updatedAt: new Date() })
          .where(and(eq(processingRuns.workspaceId, workspaceId), eq(processingRuns.id, runId)));
        await tx
          .insert(recordingEvents)
          .values({ workspaceId, recordingId: recording.id, runId, kind: "transcript.published" });
      });
    },
  };
}
