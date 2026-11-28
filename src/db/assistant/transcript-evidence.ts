import { Buffer } from "node:buffer";

import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { idSchema, type Principal, WorkspaceError } from "../../contracts/workspace";
import type { Database } from "../repository";
import {
  notes,
  people,
  processingRuns,
  recordings,
  transcriptSegments,
  transcriptUtterances,
  workspaceMemberships,
  workspaces,
} from "../schema";

const inputSchema = z
  .object({
    noteId: idSchema,
    runId: idSchema.optional(),
    startSeconds: z.number().finite().min(0).max(7200).optional(),
    endSeconds: z.number().finite().nonnegative().max(7200).optional(),
    personId: idSchema.optional(),
    speakerLabel: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().max(2000).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict()
  .refine(
    (value) => !(value.personId !== undefined && value.speakerLabel !== undefined),
    "Use assigned personId or provider speakerLabel, not both.",
  )
  .refine(
    (value) =>
      value.startSeconds === undefined ||
      value.endSeconds === undefined ||
      value.endSeconds > value.startSeconds,
    "endSeconds must be greater than startSeconds.",
  );

type Input = z.infer<typeof inputSchema>;

type Cursor = { sequence: number; orderKey: string; id: string; generation: number };

function normalizedFilter(value: Input, workspaceId: string, selectedRunId: string): string {
  return JSON.stringify([
    "assistant-transcript-v1",
    workspaceId,
    value.noteId,
    selectedRunId,
    value.startSeconds ?? null,
    value.endSeconds ?? null,
    value.personId ?? null,
    value.speakerLabel ?? null,
  ]);
}

function encodeCursor(filter: string, cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ filter, ...cursor })).toString("base64url");
}

function decodeCursor(value: string | undefined, filter: string): Cursor | undefined {
  if (!value) {
    return undefined;
  }

  try {
    if (value.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error();
    }

    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      filter: string;
      sequence: number;
      orderKey: string;
      id: string;
      generation: number;
    };

    if (
      parsed.filter !== filter ||
      !Number.isSafeInteger(parsed.sequence) ||
      !Number.isSafeInteger(parsed.generation) ||
      !/^[01]*$/.test(parsed.orderKey) ||
      !z.uuid().safeParse(parsed.id).success
    ) {
      throw new Error();
    }

    return parsed;
  } catch {
    throw new WorkspaceError("invalid_cursor", "Invalid transcript evidence cursor.");
  }
}

/**
 * Reads a filtered, authorized transcript page. All predicates are applied in
 * SQL before ordering/limit, and a cursor is bound to filters plus generation.
 */
export async function readAssistantTranscriptEvidence(
  db: Database,
  principal: Principal,
  workspaceId: string,
  rawInput: unknown,
) {
  const input = inputSchema.parse(rawInput);

  idSchema.parse(workspaceId);
  idSchema.parse(principal.id);

  return db.transaction(async (tx) => {
    const [member] = await tx
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
      .for("share", { of: [workspaceMemberships, workspaces] })
      .limit(1);

    if (!member) {
      throw new WorkspaceError("forbidden", "Workspace access denied.");
    }

    const [note] = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(
        and(
          eq(notes.workspaceId, workspaceId),
          eq(notes.id, input.noteId),
          isNull(notes.deletedAt),
        ),
      )
      .for("share")
      .limit(1);

    if (!note) {
      throw new WorkspaceError("not_found", "Note is unavailable.");
    }

    const [run] = await tx
      .select({
        id: processingRuns.id,
        recordingId: processingRuns.recordingId,
        generation: processingRuns.transcriptGeneration,
      })
      .from(processingRuns)
      .innerJoin(
        recordings,
        and(
          eq(recordings.workspaceId, processingRuns.workspaceId),
          eq(recordings.noteId, processingRuns.noteId),
          eq(recordings.id, processingRuns.recordingId),
          eq(recordings.status, "ready"),
          isNull(recordings.deletedAt),
        ),
      )
      .where(
        and(
          eq(processingRuns.workspaceId, workspaceId),
          eq(processingRuns.noteId, input.noteId),
          eq(processingRuns.status, "succeeded"),
          input.runId ? eq(processingRuns.id, input.runId) : undefined,
        ),
      )
      .orderBy(sql`${processingRuns.createdAt} desc`, sql`${processingRuns.id} desc`)
      .for("share", { of: [processingRuns] })
      .limit(1);

    if (!run) {
      throw new WorkspaceError("not_found", "Finalized transcript is unavailable.");
    }

    // Bind implicit-latest-run pagination to the selected run, not merely the
    // caller's omission of runId. A newer run may have the same generation and
    // ordering keys; accepting that cursor would mix transcript versions.
    const filterIdentity = normalizedFilter(input, workspaceId, run.id);

    const cursor = decodeCursor(input.cursor, filterIdentity);

    if (cursor && cursor.generation !== run.generation) {
      throw new WorkspaceError("conflict", "Transcript changed; restart the filtered read.");
    }

    // The correction projection is materialized atomically by the existing
    // authorized transcript repository before any filtered reads are exposed.
    await tx.execute(sql`
      insert into transcript_segments
        (workspace_id, run_id, id, source_utterance_id, sequence, start_seconds, end_seconds, text)
      select workspace_id, run_id, id, id, sequence, start_seconds, end_seconds, text
      from transcript_utterances
      where workspace_id = ${workspaceId} and run_id = ${run.id}
      on conflict (workspace_id, id) do nothing
    `);

    const rows = await tx
      .select({
        id: transcriptSegments.id,
        sourceUtteranceId: transcriptSegments.sourceUtteranceId,
        revision: transcriptSegments.revision,
        attributionRevision: transcriptSegments.attributionRevision,
        sequence: transcriptSegments.sequence,
        orderKey: transcriptSegments.orderKey,
        startSeconds: transcriptSegments.startSeconds,
        endSeconds: transcriptSegments.endSeconds,
        text: transcriptSegments.text,
        personId: transcriptSegments.personId,
        speakerLabel: transcriptUtterances.speakerLabel,
        personName: people.displayName,
      })
      .from(transcriptSegments)
      .innerJoin(
        transcriptUtterances,
        and(
          eq(transcriptUtterances.workspaceId, transcriptSegments.workspaceId),
          eq(transcriptUtterances.runId, transcriptSegments.runId),
          eq(transcriptUtterances.id, transcriptSegments.sourceUtteranceId),
        ),
      )
      .leftJoin(
        people,
        and(
          eq(people.workspaceId, transcriptSegments.workspaceId),
          eq(people.id, transcriptSegments.personId),
          isNull(people.deletedAt),
        ),
      )
      .where(
        and(
          eq(transcriptSegments.workspaceId, workspaceId),
          eq(transcriptSegments.runId, run.id),
          eq(transcriptSegments.active, true),
          input.startSeconds !== undefined
            ? gt(transcriptSegments.endSeconds, input.startSeconds)
            : undefined,
          input.endSeconds !== undefined
            ? lt(transcriptSegments.startSeconds, input.endSeconds)
            : undefined,
          input.personId ? eq(transcriptSegments.personId, input.personId) : undefined,
          input.speakerLabel
            ? eq(transcriptUtterances.speakerLabel, input.speakerLabel)
            : undefined,
          cursor
            ? sql`(${transcriptSegments.sequence}, ${transcriptSegments.orderKey}, ${transcriptSegments.id}) > (${cursor.sequence}, ${cursor.orderKey}, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(
        asc(transcriptSegments.sequence),
        asc(transcriptSegments.orderKey),
        asc(transcriptSegments.id),
      )
      .limit(input.limit + 1);

    const page = rows.slice(0, input.limit);

    const last = page.at(-1);

    const [after] = await tx
      .select({ generation: processingRuns.transcriptGeneration })
      .from(processingRuns)
      .where(and(eq(processingRuns.workspaceId, workspaceId), eq(processingRuns.id, run.id)))
      .limit(1);

    if (after?.generation !== run.generation) {
      throw new WorkspaceError("conflict", "Transcript changed during the read.");
    }

    const sources = page.map((item) => ({
      kind: "transcript" as const,
      id: item.id,
      label: `${item.personName ?? item.speakerLabel} · ${Math.floor(item.startSeconds)}s`,
      revision: run.generation,
      noteId: input.noteId,
      recordingId: run.recordingId,
      runId: run.id,
      startSeconds: item.startSeconds,
      endSeconds: item.endSeconds,
      segmentRevision: item.revision,
      attributionRevision: item.attributionRevision,
      sourceUtteranceId: item.sourceUtteranceId,
    }));

    return {
      appliedFilters: {
        noteId: input.noteId,
        runId: run.id,
        ...(input.startSeconds !== undefined ? { startSeconds: input.startSeconds } : {}),
        ...(input.endSeconds !== undefined ? { endSeconds: input.endSeconds } : {}),
        ...(input.personId ? { personId: input.personId } : {}),
        ...(input.speakerLabel ? { speakerLabel: input.speakerLabel } : {}),
      },
      generation: run.generation,
      passages: page.map((item) => ({
        id: item.id,
        sourceUtteranceId: item.sourceUtteranceId,
        personId: item.personId,
        speakerLabel: item.speakerLabel,
        personName: item.personName,
        revision: item.revision,
        attributionRevision: item.attributionRevision,
        startSeconds: item.startSeconds,
        endSeconds: item.endSeconds,
        text: item.text.slice(0, 3000),
        truncated: item.text.length > 3000,
      })),
      sources,
      coverage: rows.length > input.limit ? "partial-page" : cursor ? "final-page" : "complete",
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor(filterIdentity, {
              sequence: last.sequence,
              orderKey: last.orderKey,
              id: last.id,
              generation: run.generation,
            })
          : null,
    };
  });
}
