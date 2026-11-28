import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  correctionCommandSchema,
  correctionReceiptSchema,
  correctedTurnSchema,
  MAX_CORRECTION_TARGETS,
  type CorrectionCommand,
  type CorrectionResult,
  type CorrectedTurn,
} from "../contracts/transcript-corrections";
import { idSchema, WorkspaceError, type Principal } from "../contracts/workspace";
import { groupTranscriptPassages } from "../lib/transcript-passages";
import type { Database } from "./repository";
import { appendApplicationEvent } from "./activity";
import {
  notes,
  people,
  processingRuns,
  recordings,
  transcriptUtterances,
  transcriptSegments as segments,
  transcriptCorrections as corrections,
  transcriptSampleCandidates as samples,
  transcriptCorrectionOutbox,
  workspaceMemberships,
  workspaces,
  type TranscriptSegmentSnapshot,
} from "./schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Snapshot = TranscriptSegmentSnapshot;
// Leave room for receipt/page envelopes within the 2 MiB response budget.
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024 - 4096;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const scope = (workspaceId: string, runId: string) =>
  and(eq(segments.workspaceId, workspaceId), eq(segments.runId, runId));
const targetsQuerySchema = z
  .object({
    speakerLabel: z.string().max(200).optional(),
    startSeconds: z.number().min(0).max(7200).optional(),
    endSeconds: z.number().min(0).max(7200).optional(),
    includeManual: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.startSeconds === undefined && v.endSeconds === undefined) ||
      (v.speakerLabel === undefined &&
        v.startSeconds !== undefined &&
        v.endSeconds !== undefined &&
        v.endSeconds > v.startSeconds),
  );
export type CorrectionTargetsQuery = z.infer<typeof targetsQuerySchema>;

const cursorSchema = z.object({
  v: z.literal(1),
  scope: z.string(),
  id: idSchema,
  sequence: z.number().int().nonnegative().optional(),
  orderKey: z
    .string()
    .regex(/^[01]*$/)
    .max(256)
    .optional(),
  createdAt: z.iso.datetime().optional(),
});
type Cursor = z.infer<typeof cursorSchema>;
const encodeCursor = (value: Omit<Cursor, "v">) =>
  Buffer.from(JSON.stringify({ v: 1, ...value })).toString("base64url");
function decodeCursor(value: string | undefined, expectedScope: string): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (value.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (cursor.scope !== expectedScope) throw new Error();
    if (
      expectedScope.startsWith("transcript:") &&
      (cursor.sequence === undefined || cursor.orderKey === undefined)
    )
      throw new Error();
    if (expectedScope.startsWith("history:") && cursor.createdAt === undefined) throw new Error();
    return cursor;
  } catch {
    throw new WorkspaceError("invalid_cursor", "Invalid correction pagination cursor.");
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function conflict(ids: string[], message = "Segments changed; refresh before retrying."): never {
  throw new WorkspaceError("conflict", message, undefined, ids);
}
const publicTurn = (value: Snapshot): CorrectedTurn => correctedTurnSchema.parse(value);
const receipt = (value: typeof corrections.$inferSelect) =>
  correctionReceiptSchema.parse({ ...value, createdAt: value.createdAt.toISOString() });

async function authorize(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  noteId?: string,
) {
  idSchema.parse(principal.id);
  idSchema.parse(workspaceId);
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
  if (!member) throw new WorkspaceError("forbidden", "Workspace access denied.");
  if (noteId !== undefined) {
    const [note] = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(
        and(
          eq(notes.workspaceId, workspaceId),
          eq(notes.id, idSchema.parse(noteId)),
          isNull(notes.deletedAt),
        ),
      )
      .for("share")
      .limit(1);
    if (!note) throw new WorkspaceError("not_found", "Note is unavailable.");
  }
}

// Uses the same row lock as provider publication. No late publication can replace
// an overlay, and lazy initialization can never race a command or another reader.
async function lockRun(tx: Transaction, workspaceId: string, noteId: string, runId: string) {
  const [run] = await tx
    .select()
    .from(processingRuns)
    .where(
      and(
        eq(processingRuns.workspaceId, workspaceId),
        eq(processingRuns.noteId, noteId),
        eq(processingRuns.id, idSchema.parse(runId)),
        eq(processingRuns.status, "succeeded"),
      ),
    )
    .for("update")
    .limit(1);
  if (!run) throw new WorkspaceError("not_found", "Finalized transcript is unavailable.");
  const [recording] = await tx
    .select()
    .from(recordings)
    .where(
      and(
        eq(recordings.workspaceId, workspaceId),
        eq(recordings.noteId, noteId),
        eq(recordings.id, run.recordingId),
        eq(recordings.status, "ready"),
        isNull(recordings.deletedAt),
      ),
    )
    .for("share")
    .limit(1);
  if (!recording) throw new WorkspaceError("not_found", "Recording is unavailable.");
  return { run, recording };
}
async function materialize(tx: Transaction, run: typeof processingRuns.$inferSelect) {
  if (run.correctionsMaterializedAt) return;
  await tx.execute(sql`
    insert into transcript_segments (workspace_id, run_id, id, source_utterance_id, sequence, start_seconds, end_seconds, text)
    select workspace_id, run_id, id, id, sequence, start_seconds, end_seconds, text
    from transcript_utterances where workspace_id = ${run.workspaceId} and run_id = ${run.id}
    on conflict (workspace_id, id) do nothing
  `);
  await tx
    .update(processingRuns)
    .set({ correctionsMaterializedAt: new Date() })
    .where(and(eq(processingRuns.workspaceId, run.workspaceId), eq(processingRuns.id, run.id)));
}

// One joined read supplies original provider evidence and current profile names.
async function readSegments(
  tx: Transaction,
  workspaceId: string,
  runId: string,
  recordingId: string,
  filter?: SQL,
  limit = 501,
) {
  const rows = await tx
    .select({ segment: segments, original: transcriptUtterances, personName: people.displayName })
    .from(segments)
    .innerJoin(
      transcriptUtterances,
      and(
        eq(transcriptUtterances.workspaceId, segments.workspaceId),
        eq(transcriptUtterances.runId, segments.runId),
        eq(transcriptUtterances.id, segments.sourceUtteranceId),
      ),
    )
    .leftJoin(
      people,
      and(
        eq(people.workspaceId, segments.workspaceId),
        eq(people.id, segments.personId),
        isNull(people.deletedAt),
      ),
    )
    .where(and(scope(workspaceId, runId), filter))
    .orderBy(asc(segments.sequence), asc(segments.orderKey), asc(segments.id))
    .limit(limit);
  return rows.map(({ segment: s, original, personName }): Snapshot => ({
    id: s.id,
    runId,
    recordingId,
    sequence: s.sequence,
    sourceUtteranceId: s.sourceUtteranceId,
    parentId: s.parentId,
    revision: s.revision,
    attributionRevision: s.attributionRevision,
    startSeconds: s.startSeconds,
    endSeconds: s.endSeconds,
    text: s.text,
    speakerLabel: original.speakerLabel,
    originalText: original.text,
    originalStartSeconds: original.startSeconds,
    originalEndSeconds: original.endSeconds,
    assignment:
      s.assignmentKind === "person"
        ? { kind: "person", personId: s.personId! }
        : { kind: s.assignmentKind },
    assignmentSource: s.assignmentSource,
    reviewState:
      s.assignmentKind === "person" && personName === null ? "needs_review" : s.reviewState,
    personName,
    providerScore: s.providerScore,
    sampleSuitability: s.sampleSuitability,
    active: s.active,
    orderKey: s.orderKey,
  }));
}

async function segmentMetadata(
  tx: Transaction,
  workspaceId: string,
  runId: string,
  filter?: SQL,
  limit = 501,
) {
  return tx
    .select({
      id: segments.id,
      revision: segments.revision,
      attributionRevision: segments.attributionRevision,
      active: segments.active,
      sequence: segments.sequence,
      orderKey: segments.orderKey,
      textBytes: sql<number>`octet_length(to_json(${segments.text})::text) + octet_length(to_json(${transcriptUtterances.text})::text)`,
    })
    .from(segments)
    .innerJoin(
      transcriptUtterances,
      and(
        eq(transcriptUtterances.workspaceId, segments.workspaceId),
        eq(transcriptUtterances.runId, segments.runId),
        eq(transcriptUtterances.id, segments.sourceUtteranceId),
      ),
    )
    .where(and(scope(workspaceId, runId), filter))
    .orderBy(asc(segments.sequence), asc(segments.orderKey), asc(segments.id))
    .limit(limit);
}

async function requirePeople(tx: Transaction, workspaceId: string, ids: string[]) {
  const uniqueIds = [...new Set(ids)].sort();
  if (!uniqueIds.length) return new Map<string, string>();
  const rows = await tx
    .select({ id: people.id, name: people.displayName })
    .from(people)
    .where(
      and(
        eq(people.workspaceId, workspaceId),
        inArray(people.id, uniqueIds),
        isNull(people.deletedAt),
      ),
    )
    .orderBy(asc(people.id))
    .for("share");
  if (rows.length !== uniqueIds.length)
    throw new WorkspaceError("not_found", "Assigned person is unavailable in this workspace.");
  return new Map(rows.map((row) => [row.id, row.name]));
}

async function correctionResult(
  tx: Transaction,
  workspaceId: string,
  runId: string,
  recordingId: string,
  correction: typeof corrections.$inferSelect,
): Promise<CorrectionResult> {
  const resultReceipt = receipt(correction);
  const incomplete: CorrectionResult = {
    receipt: resultReceipt,
    current: { items: [], removed: [], complete: false },
  };
  // Historical snapshots identify the scope only. Read current rows while the
  // authorized run lock is held, including on an exact command replay.
  const ids = [...new Set([...correction.before, ...correction.after].map((turn) => turn.id))];
  if (!ids.length || ids.length > MAX_CORRECTION_TARGETS) return incomplete;

  const metadata = await segmentMetadata(
    tx,
    workspaceId,
    runId,
    inArray(segments.id, ids),
    MAX_CORRECTION_TARGETS,
  );
  // Use the page's conservative per-row allowance before loading large strings.
  // An oversized current projection must not turn a committed replay into failure.
  const estimatedBytes = metadata.reduce(
    (bytes, row) => bytes + (row.active ? row.textBytes + 4096 : 256),
    4096,
  );
  if (metadata.length !== ids.length || estimatedBytes > MAX_PAGE_BYTES) return incomplete;

  const activeIds = metadata.filter((row) => row.active).map((row) => row.id);
  const current = activeIds.length
    ? await readSegments(
        tx,
        workspaceId,
        runId,
        recordingId,
        and(inArray(segments.id, activeIds), eq(segments.active, true)),
        MAX_CORRECTION_TARGETS,
      )
    : [];
  if (current.length !== activeIds.length) return incomplete;

  const result: CorrectionResult = {
    receipt: resultReceipt,
    current: {
      items: current.map(publicTurn),
      removed: metadata
        .filter((row) => !row.active)
        .map(({ id, revision, attributionRevision }) => ({ id, revision, attributionRevision })),
      complete: true,
    },
  };
  return Buffer.byteLength(JSON.stringify(result)) <= MAX_PAGE_BYTES ? result : incomplete;
}

async function persistSegments(tx: Transaction, workspaceId: string, snapshots: Snapshot[]) {
  // Retire before inserting replacements so the active-lineage unique index also
  // permits a fresh split after an earlier split was undone.
  const retired = snapshots.filter((s) => !s.active).map((s) => s.id);
  if (retired.length)
    await tx
      .update(segments)
      .set({ active: false })
      .where(
        and(
          eq(segments.workspaceId, workspaceId),
          eq(segments.runId, snapshots[0]!.runId),
          inArray(segments.id, retired),
        ),
      );
  const saved = await tx
    .insert(segments)
    .values(
      snapshots.map((s) => ({
        workspaceId,
        runId: s.runId,
        id: s.id,
        sourceUtteranceId: s.sourceUtteranceId,
        parentId: s.parentId,
        sequence: s.sequence,
        orderKey: s.orderKey,
        active: s.active,
        revision: s.revision,
        attributionRevision: s.attributionRevision,
        startSeconds: s.startSeconds,
        endSeconds: s.endSeconds,
        text: s.text,
        assignmentKind: s.assignment.kind,
        personId: s.assignment.kind === "person" ? s.assignment.personId : null,
        assignmentSource: s.assignmentSource,
        reviewState: s.reviewState,
        providerScore: s.providerScore,
        sampleSuitability: s.sampleSuitability,
      })),
    )
    .onConflictDoUpdate({
      target: [segments.workspaceId, segments.id],
      set: {
        active: sql`excluded.active`,
        revision: sql`excluded.revision`,
        attributionRevision: sql`excluded.attribution_revision`,
        startSeconds: sql`excluded.start_seconds`,
        endSeconds: sql`excluded.end_seconds`,
        text: sql`excluded.text`,
        assignmentKind: sql`excluded.assignment_kind`,
        personId: sql`excluded.person_id`,
        assignmentSource: sql`excluded.assignment_source`,
        reviewState: sql`excluded.review_state`,
        sampleSuitability: sql`excluded.sample_suitability`,
      },
      setWhere: sql`${segments.runId} = excluded.run_id and ${segments.sourceUtteranceId} = excluded.source_utterance_id`,
    })
    .returning({ id: segments.id });
  if (saved.length !== snapshots.length)
    conflict(
      snapshots.map((s) => s.id),
      "Segment IDs have already been used.",
    );
}

export function createTranscriptCorrectionRepository(db: Database) {
  return {
    async transcript(
      principal: Principal,
      workspaceId: string,
      noteId: string,
      runId: string,
      cursor?: string,
      limit = 100,
    ) {
      const pageSize = z.number().int().min(1).max(100).parse(limit);

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId, noteId);
        const { run } = await lockRun(tx, workspaceId, noteId, runId);
        const cursorScope = `transcript:${workspaceId}:${noteId}:${runId}`;
        const after = decodeCursor(cursor, cursorScope);
        await materialize(tx, run);
        const rows = await segmentMetadata(
          tx,
          workspaceId,
          runId,
          and(
            eq(segments.active, true),
            after
              ? sql`(${segments.sequence}, ${segments.orderKey}, ${segments.id}) > (${after.sequence}, ${after.orderKey}, ${after.id}::uuid)`
              : undefined,
          ),
          pageSize + 1,
        );
        let bytes = 0;
        const page: typeof rows = [];
        for (const row of rows.slice(0, pageSize)) {
          const size = row.textBytes + 4096;
          if (page.length && bytes + size > MAX_PAGE_BYTES) break;
          bytes += size;
          page.push(row);
        }
        const last = page.at(-1);
        const snapshots = page.length
          ? await readSegments(
              tx,
              workspaceId,
              runId,
              run.recordingId,
              inArray(
                segments.id,
                page.map((s) => s.id),
              ),
              100,
            )
          : [];
        const items = snapshots.map(publicTurn);
        const passages = groupTranscriptPassages(items).map((passage) => ({
          id: passage.id,
          turnIds: passage.turnIds,
          startSeconds: passage.startSeconds,
          endSeconds: passage.endSeconds,
          text: passage.text,
        }));
        return {
          items,
          // Group only this page and keep the existing response byte budget.
          ...(bytes + Buffer.byteLength(JSON.stringify(passages)) <= MAX_PAGE_BYTES
            ? { passages }
            : {}),
          nextCursor:
            last && rows.length > page.length
              ? encodeCursor({
                  scope: cursorScope,
                  id: last.id,
                  sequence: last.sequence,
                  orderKey: last.orderKey,
                })
              : null,
        };
      });
    },

    async targets(
      principal: Principal,
      workspaceId: string,
      noteId: string,
      runId: string,
      options: CorrectionTargetsQuery,
    ) {
      const query = targetsQuerySchema.parse(options);
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId, noteId);
        const { run } = await lockRun(tx, workspaceId, noteId, runId);
        await materialize(tx, run);
        const filter = and(
          scope(workspaceId, runId),
          eq(segments.active, true),
          query.speakerLabel !== undefined
            ? eq(transcriptUtterances.speakerLabel, query.speakerLabel)
            : undefined,
          query.startSeconds !== undefined
            ? gt(segments.endSeconds, query.startSeconds)
            : undefined,
          query.endSeconds !== undefined ? lt(segments.startSeconds, query.endSeconds) : undefined,
        );
        const join = and(
          eq(transcriptUtterances.workspaceId, segments.workspaceId),
          eq(transcriptUtterances.runId, segments.runId),
          eq(transcriptUtterances.id, segments.sourceUtteranceId),
        );
        const [{ count: manualCount } = { count: 0 }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(segments)
          .innerJoin(transcriptUtterances, join)
          .where(and(filter, eq(segments.assignmentSource, "manual")));
        const targets = await tx
          .select({ id: segments.id, expectedAttributionRevision: segments.attributionRevision })
          .from(segments)
          .innerJoin(transcriptUtterances, join)
          .where(
            and(
              filter,
              query.includeManual ? undefined : eq(segments.assignmentSource, "unassigned"),
            ),
          )
          .orderBy(asc(segments.sequence), asc(segments.orderKey), asc(segments.id))
          .limit(MAX_CORRECTION_TARGETS + 1);
        if (targets.length > MAX_CORRECTION_TARGETS)
          throw new WorkspaceError(
            "conflict",
            "At most 500 segments can be corrected atomically. Choose a smaller time range.",
          );
        return { targets, excludedManualCount: query.includeManual ? 0 : manualCount };
      });
    },

    async command(
      principal: Principal,
      workspaceId: string,
      noteId: string,
      runId: string,
      value: CorrectionCommand,
    ) {
      const input = correctionCommandSchema.parse(value);
      const normalized =
        input.kind === "assign"
          ? { ...input, targets: [...input.targets].sort((a, b) => a.id.localeCompare(b.id)) }
          : input;
      const fingerprint = createHash("sha256")
        .update(
          canonical({
            version: 1,
            actorId: principal.id,
            workspaceId,
            noteId,
            runId,
            input: normalized,
          }),
        )
        .digest("hex");
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId, noteId);
        // A command ID is workspace-wide, including concurrent attempts on different
        // runs. Lock it before the run, then read the receipt before any revisions.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:correction:${input.commandId}`}, 0))`,
        );
        const { run, recording } = await lockRun(tx, workspaceId, noteId, runId);
        const [existing] = await tx
          .select()
          .from(corrections)
          .where(
            and(
              eq(corrections.workspaceId, workspaceId),
              eq(corrections.commandId, input.commandId),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.actorId !== principal.id || existing.fingerprint !== fingerprint)
            throw new WorkspaceError(
              "command_reused",
              "Command ID already identifies another correction.",
            );
          return correctionResult(tx, workspaceId, runId, recording.id, existing);
        }
        await materialize(tx, run);
        let before: Snapshot[];
        let after: Snapshot[];
        let undoOf: string | null = null;
        let affectedCount: number;
        if (input.kind === "undo") {
          const [original] = await tx
            .select()
            .from(corrections)
            .where(
              and(
                eq(corrections.workspaceId, workspaceId),
                eq(corrections.runId, runId),
                eq(corrections.id, input.correctionId),
              ),
            )
            .limit(1);
          if (!original) throw new WorkspaceError("not_found", "Correction is unavailable.");
          const ids = original.after.map((s) => s.id);
          const metadata = await segmentMetadata(tx, workspaceId, runId, inArray(segments.id, ids));
          const currentById = new Map(metadata.map((s) => [s.id, s]));
          const stale = original.after
            .filter((s) => {
              const current = currentById.get(s.id);
              return (
                !current ||
                current.revision !== s.revision ||
                current.attributionRevision !== s.attributionRevision ||
                current.active !== s.active
              );
            })
            .map((s) => s.id);
          if (stale.length) conflict(stale, "Undo would overwrite newer changes.");
          before = await readSegments(
            tx,
            workspaceId,
            runId,
            recording.id,
            inArray(segments.id, ids),
          );
          const restored = new Map(original.before.map((s) => [s.id, s]));
          const names = await requirePeople(
            tx,
            workspaceId,
            original.before
              .filter((s) => s.active && s.assignment.kind === "person")
              .map((s) => (s.assignment.kind === "person" ? s.assignment.personId : "")),
          );
          after = before.map((current) => {
            const old = restored.get(current.id);
            const target = old ?? { ...current, active: false };
            const attributionChanged =
              target.active !== current.active ||
              target.startSeconds !== current.startSeconds ||
              target.endSeconds !== current.endSeconds ||
              canonical(target.assignment) !== canonical(current.assignment) ||
              original.kind === "assign";
            return {
              ...target,
              revision: current.revision + 1,
              attributionRevision: current.attributionRevision + (attributionChanged ? 1 : 0),
              sampleSuitability:
                current.sampleSuitability === "not_evaluated" &&
                target.sampleSuitability === "not_evaluated"
                  ? "not_evaluated"
                  : "invalidated",
              personName:
                target.assignment.kind === "person"
                  ? (names.get(target.assignment.personId) ?? null)
                  : null,
            };
          });
          undoOf = original.id;
          affectedCount = original.affectedCount;
        } else {
          const ids =
            input.kind === "assign" ? input.targets.map((t) => t.id) : [input.utteranceId];
          const metadata = await segmentMetadata(
            tx,
            workspaceId,
            runId,
            and(inArray(segments.id, ids), eq(segments.active, true)),
          );
          const byId = new Map(metadata.map((s) => [s.id, s]));
          const stale =
            input.kind === "assign"
              ? input.targets
                  .filter(
                    (t) => byId.get(t.id)?.attributionRevision !== t.expectedAttributionRevision,
                  )
                  .map((t) => t.id)
              : metadata[0]?.revision !== input.expectedRevision
                ? ids
                : [];
          if (stale.length) conflict(stale);
          // Reject oversized frozen manifests before loading their large strings.
          // The exact serialized snapshot check below includes all metadata too.
          if (
            input.kind === "assign" &&
            metadata.reduce((sum, s) => sum + s.textBytes * 2, 0) > MAX_SNAPSHOT_BYTES
          )
            throw new WorkspaceError(
              "conflict",
              "Correction exceeds the 2 MiB atomic history limit. Select fewer or shorter segments.",
            );
          before = await readSegments(
            tx,
            workspaceId,
            runId,
            recording.id,
            and(inArray(segments.id, ids), eq(segments.active, true)),
          );
          affectedCount = ids.length;
          if (input.kind === "assign") {
            const names = await requirePeople(
              tx,
              workspaceId,
              input.assignment.kind === "person" ? [input.assignment.personId] : [],
            );
            after = before.map((s) => ({
              ...s,
              revision: s.revision + 1,
              attributionRevision: s.attributionRevision + 1,
              assignment: input.assignment,
              assignmentSource: "manual",
              reviewState: "confirmed",
              personName:
                input.assignment.kind === "person" ? names.get(input.assignment.personId)! : null,
              sampleSuitability:
                input.assignment.kind === "person"
                  ? "candidate"
                  : s.sampleSuitability === "not_evaluated"
                    ? "not_evaluated"
                    : "invalidated",
            }));
          } else if (input.kind === "edit") {
            const current = before[0]!;
            if (
              input.endSeconds <= input.startSeconds ||
              input.endSeconds > recording.durationSeconds + 0.5
            )
              conflict(
                ids,
                "Edited bounds must lie within the recording and have positive duration.",
              );
            after = [
              {
                ...current,
                revision: current.revision + 1,
                attributionRevision:
                  current.attributionRevision +
                  (input.startSeconds !== current.startSeconds ||
                  input.endSeconds !== current.endSeconds
                    ? 1
                    : 0),
                text: input.text,
                startSeconds: input.startSeconds,
                endSeconds: input.endSeconds,
                sampleSuitability:
                  current.sampleSuitability === "not_evaluated" ? "not_evaluated" : "invalidated",
              },
            ];
          } else if (input.selection) {
            const current = before[0]!;
            const selected = input.selection;
            const { startOffset, endOffset, startSeconds, endSeconds, assignment } = selected;
            const breaksPair = (offset: number) => {
              const left = current.text.charCodeAt(offset - 1),
                right = current.text.charCodeAt(offset);
              return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
            };
            if (
              startOffset >= endOffset ||
              endOffset > current.text.length ||
              startSeconds < current.startSeconds ||
              endSeconds > current.endSeconds ||
              startSeconds >= endSeconds ||
              (startOffset === 0
                ? startSeconds !== current.startSeconds
                : startSeconds <= current.startSeconds) ||
              (endOffset === current.text.length
                ? endSeconds !== current.endSeconds
                : endSeconds >= current.endSeconds) ||
              current.orderKey.length >= 254 ||
              breaksPair(startOffset) ||
              breaksPair(endOffset)
            )
              conflict(ids, "Choose words and an audio range inside this speech.");
            const newIds = [input.leftId, selected.selectedId, input.rightId];
            if (new Set([...ids, ...newIds]).size !== 4)
              conflict(ids, "Selection identities must be distinct.");
            for (const id of [...newIds].sort())
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:segment:${id}`}, 0))`,
              );
            const used = await tx
              .select({ id: segments.id })
              .from(segments)
              .where(and(eq(segments.workspaceId, workspaceId), inArray(segments.id, newIds)))
              .limit(3);
            const sourceUsed = await tx
              .select({ id: transcriptUtterances.id })
              .from(transcriptUtterances)
              .where(
                and(
                  eq(transcriptUtterances.workspaceId, workspaceId),
                  inArray(transcriptUtterances.id, newIds),
                ),
              )
              .limit(3);
            if (used.length || sourceUsed.length)
              conflict(newIds, "Selection identities have already been used.");
            const names = await requirePeople(
              tx,
              workspaceId,
              assignment.kind === "person" ? [assignment.personId] : [],
            );
            const child = {
              ...current,
              parentId: current.id,
              revision: current.revision + 1,
              attributionRevision: current.attributionRevision + 1,
              sampleSuitability: "invalidated" as const,
            };
            after = [{ ...child, id: current.id, parentId: current.parentId, active: false }];
            if (startOffset > 0)
              after.push({
                ...child,
                id: input.leftId,
                orderKey: `${current.orderKey}00`,
                text: current.text.slice(0, startOffset),
                endSeconds: startSeconds,
              });
            after.push({
              ...child,
              id: selected.selectedId,
              orderKey: `${current.orderKey}01`,
              text: current.text.slice(startOffset, endOffset),
              startSeconds,
              endSeconds,
              assignment,
              assignmentSource: "manual",
              reviewState: "confirmed",
              personName: assignment.kind === "person" ? names.get(assignment.personId)! : null,
              sampleSuitability: assignment.kind === "person" ? "candidate" : "invalidated",
            });
            if (endOffset < current.text.length)
              after.push({
                ...child,
                id: input.rightId,
                orderKey: `${current.orderKey}1`,
                text: current.text.slice(endOffset),
                startSeconds: endSeconds,
              });
            if (after.some((s) => s.active && !s.text.trim()))
              conflict(ids, "Select a nonempty speech range.");
          } else {
            const current = before[0]!;
            if (
              input.splitSeconds <= current.startSeconds ||
              input.splitSeconds >= current.endSeconds ||
              input.textOffset >= current.text.length ||
              current.orderKey.length >= 256
            )
              conflict(
                ids,
                "Split must be inside the current text and audio span (maximum lineage depth 256).",
              );
            const leftText = current.text.slice(0, input.textOffset).trim();
            const rightText = current.text.slice(input.textOffset).trim();
            // Do not split a UTF-16 surrogate pair into invalid text.
            const previous = current.text.charCodeAt(input.textOffset - 1);
            const next = current.text.charCodeAt(input.textOffset);
            if (
              !leftText ||
              !rightText ||
              (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
            )
              conflict(ids, "Choose a nonempty text boundary.");
            if (
              input.leftId === input.rightId ||
              ids.includes(input.leftId) ||
              ids.includes(input.rightId)
            )
              conflict(ids, "Split segment IDs must be new and distinct.");
            for (const id of [input.leftId, input.rightId].sort())
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:segment:${id}`}, 0))`,
              );
            const usedIds = await tx
              .select({ id: segments.id })
              .from(segments)
              .where(
                and(
                  eq(segments.workspaceId, workspaceId),
                  inArray(segments.id, [input.leftId, input.rightId]),
                ),
              )
              .limit(2);
            if (usedIds.length)
              conflict(
                usedIds.map((s) => s.id),
                "Split segment IDs have already been used.",
              );
            const providerIds = await tx
              .select({ id: transcriptUtterances.id })
              .from(transcriptUtterances)
              .where(
                and(
                  eq(transcriptUtterances.workspaceId, workspaceId),
                  inArray(transcriptUtterances.id, [input.leftId, input.rightId]),
                ),
              )
              .limit(2);
            if (providerIds.length)
              conflict(
                providerIds.map((s) => s.id),
                "Split IDs identify immutable provider segments.",
              );
            const child = {
              ...current,
              parentId: current.id,
              revision: current.revision + 1,
              attributionRevision: current.attributionRevision + 1,
              sampleSuitability:
                current.sampleSuitability === "not_evaluated"
                  ? ("not_evaluated" as const)
                  : ("invalidated" as const),
            };
            after = [
              {
                ...current,
                active: false,
                revision: current.revision + 1,
                attributionRevision: current.attributionRevision + 1,
                sampleSuitability: child.sampleSuitability,
              },
              {
                ...child,
                id: input.leftId,
                orderKey: `${current.orderKey}0`,
                text: leftText,
                endSeconds: input.splitSeconds,
              },
              {
                ...child,
                id: input.rightId,
                orderKey: `${current.orderKey}1`,
                text: rightText,
                startSeconds: input.splitSeconds,
              },
            ];
          }
        }
        const snapshotBytes = Buffer.byteLength(JSON.stringify({ before, after }));
        if (snapshotBytes > MAX_SNAPSHOT_BYTES)
          throw new WorkspaceError(
            "conflict",
            "Correction exceeds the 2 MiB atomic history limit. Select fewer or shorter segments.",
          );
        await persistSegments(tx, workspaceId, after);
        const [saved] = await tx
          .insert(corrections)
          .values({
            workspaceId,
            runId,
            id: randomUUID(),
            commandId: input.commandId,
            actorId: principal.id,
            fingerprint,
            kind: input.kind,
            affectedCount,
            snapshotBytes,
            undoOf,
            before,
            after,
          })
          .returning();
        await tx
          .update(samples)
          .set({ state: "invalidated", invalidatedAt: new Date() })
          .where(
            and(
              eq(samples.workspaceId, workspaceId),
              eq(samples.runId, runId),
              inArray(
                samples.segmentId,
                before.map((s) => s.id),
              ),
              isNull(samples.invalidatedAt),
            ),
          );
        const candidates = after.filter(
          (s) => s.active && s.sampleSuitability === "candidate" && s.assignment.kind === "person",
        );
        if (candidates.length)
          await tx.insert(samples).values(
            candidates.map((s) => ({
              workspaceId,
              runId,
              correctionId: saved!.id,
              segmentId: s.id,
              personId: s.assignment.kind === "person" ? s.assignment.personId : "",
              startSeconds: s.startSeconds,
              endSeconds: s.endSeconds,
            })),
          );
        // Advance once per committed command, independently of its segment count.
        // Exact receipt replays return above; lazy materialization is unchanged source.
        const [advancedRun] = await tx
          .update(processingRuns)
          .set({ transcriptGeneration: sql`${processingRuns.transcriptGeneration} + 1` })
          .where(and(eq(processingRuns.workspaceId, workspaceId), eq(processingRuns.id, runId)))
          .returning({ generation: processingRuns.transcriptGeneration });
        await tx
          .insert(transcriptCorrectionOutbox)
          .values({ workspaceId, correctionId: saved!.id });
        await appendApplicationEvent(tx, {
          id: saved!.id,
          workspaceId,
          type: "transcript.corrected",
          actorId: principal.id,
          executor: "user",
          operationId: input.commandId,
          noteId,
          runId,
          generation: advancedRun!.generation,
        });
        return correctionResult(tx, workspaceId, runId, recording.id, saved!);
      });
    },

    async history(
      principal: Principal,
      workspaceId: string,
      noteId: string,
      runId: string,
      cursor?: string,
    ) {
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId, noteId);
        await lockRun(tx, workspaceId, noteId, runId);
        const cursorScope = `history:${workspaceId}:${noteId}:${runId}`;
        const after = decodeCursor(cursor, cursorScope);
        // Fetch only byte metadata first; never load twenty 2 MiB batches merely
        // to discard nineteen. Two bounded queries, independent of target count.
        const rows = await tx
          .select({
            id: corrections.id,
            bytes: corrections.snapshotBytes,
            createdAt: corrections.createdAt,
          })
          .from(corrections)
          .where(
            and(
              eq(corrections.workspaceId, workspaceId),
              eq(corrections.runId, runId),
              after
                ? or(
                    lt(corrections.createdAt, new Date(after.createdAt!)),
                    and(
                      eq(corrections.createdAt, new Date(after.createdAt!)),
                      lt(corrections.id, after.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(corrections.createdAt), desc(corrections.id))
          .limit(21);
        const selected: typeof rows = [];
        let bytes = 0;
        for (const row of rows.slice(0, 20)) {
          if (selected.length && bytes + row.bytes + 1024 > MAX_PAGE_BYTES) break;
          selected.push(row);
          bytes += row.bytes + 1024;
        }
        const batches = selected.length
          ? await tx
              .select()
              .from(corrections)
              .where(
                and(
                  eq(corrections.workspaceId, workspaceId),
                  eq(corrections.runId, runId),
                  inArray(
                    corrections.id,
                    selected.map((s) => s.id),
                  ),
                ),
              )
              .orderBy(desc(corrections.createdAt), desc(corrections.id))
          : [];
        const last = selected.at(-1);
        return {
          items: batches.map((batch) => ({
            ...receipt(batch),
            actorId: batch.actorId,
            before: batch.before.filter((s) => s.active).map(publicTurn),
            after: batch.after.filter((s) => s.active).map(publicTurn),
          })),
          nextCursor:
            last && rows.length > selected.length
              ? encodeCursor({
                  scope: cursorScope,
                  id: last.id,
                  createdAt: last.createdAt.toISOString(),
                })
              : null,
        };
      });
    },

    async appearances(
      principal: Principal,
      workspaceId: string,
      personId: string,
      cursor?: string,
    ) {
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        idSchema.parse(personId);
        await requirePeople(tx, workspaceId, [personId]);
        const cursorScope = `appearances:${workspaceId}:${personId}`;
        const after = decodeCursor(cursor, cursorScope);
        const rows = await tx
          .select({
            noteId: notes.id,
            noteTitle: notes.title,
            recordingId: recordings.id,
            runId: segments.runId,
            utteranceId: segments.id,
            startSeconds: segments.startSeconds,
            endSeconds: segments.endSeconds,
            text: sql<string>`left(${segments.text}, 500)`,
          })
          .from(segments)
          .innerJoin(
            processingRuns,
            and(
              eq(processingRuns.workspaceId, segments.workspaceId),
              eq(processingRuns.id, segments.runId),
              eq(processingRuns.status, "succeeded"),
            ),
          )
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
          .innerJoin(
            notes,
            and(
              eq(notes.workspaceId, processingRuns.workspaceId),
              eq(notes.id, processingRuns.noteId),
              isNull(notes.deletedAt),
            ),
          )
          .where(
            and(
              eq(segments.workspaceId, workspaceId),
              eq(segments.personId, personId),
              eq(segments.active, true),
              after ? gt(segments.id, after.id) : undefined,
            ),
          )
          .orderBy(asc(segments.id))
          .limit(21);
        const page = rows.slice(0, 20);
        return {
          items: page,
          nextCursor:
            rows.length > 20
              ? encodeCursor({ scope: cursorScope, id: page.at(-1)!.utteranceId })
              : null,
        };
      });
    },
  };
}
