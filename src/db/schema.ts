import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { NoteRecord, PersonRecord } from "../contracts/workspace";

export const DEFAULT_BRANCH = "default";
const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });
const recordColumns = () => ({
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  id: uuid("id").notNull(),
  branchId: text("branch_id").notNull().default(DEFAULT_BRANCH),
  revision: integer("revision").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
  deletedAt: time("deleted_at"),
});

// Auth-provider identities enter through the verified Principal boundary. Keeping
// this table independent of auth.users also supports isolated vanilla Postgres.
export const userProfiles = pgTable("user_profiles", {
  id: uuid("id").primaryKey(),
  email: text("email"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}).enableRLS();

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => userProfiles.id),
    name: text("name").notNull().default("Private workspace"),
    createdAt: time("created_at").notNull().defaultNow(),
    deletedAt: time("deleted_at"),
  },
  (t) => [unique("workspaces_owner_unique").on(t.ownerId)],
).enableRLS();

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfiles.id),
    role: text("role").notNull().default("member"),
    createdAt: time("created_at").notNull().defaultNow(),
    revokedAt: time("revoked_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    check("workspace_memberships_role_check", sql`${t.role} in ('owner', 'member')`),
    index("workspace_memberships_user_idx").on(t.userId, t.workspaceId),
  ],
).enableRLS();

export const notes = pgTable(
  "notes",
  {
    ...recordColumns(),
    title: text("title").notNull(),
    transcript: text("transcript").notNull(),
    // Retained database columns only; current contracts/repositories do not use
    // prototype payloads. Removing stored data requires a separate migration.
    legacyUtterances: jsonb("legacy_utterances")
      .$type<Array<{ speaker: string; text: string }>>()
      .notNull()
      .default([]),
    importSourceKey: text("import_source_key"),
    sourceCreatedAt: time("source_created_at"),
    sourceUpdatedAt: time("source_updated_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    unique("notes_import_source_unique").on(t.workspaceId, t.importSourceKey),
    check("notes_revision_check", sql`${t.revision} > 0`),
    check("notes_branch_check", sql`${t.branchId} = 'default'`),
    index("notes_active_updated_idx")
      .on(t.workspaceId, t.updatedAt.desc(), t.id.desc())
      .where(sql`${t.deletedAt} is null`),
    index("notes_title_prefix_idx")
      .on(t.workspaceId, sql`lower(${t.title}) text_pattern_ops`)
      .where(sql`${t.deletedAt} is null`),
  ],
).enableRLS();

// Allocations live independently of notes, so rename/delete never recycle a title.
// A separate row also avoids upgrading the workspace authorization SHARE lock.
export const noteTitleCounters = pgTable(
  "note_title_counters",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id),
    lastNumber: integer("last_number").notNull(),
  },
  (t) => [check("note_title_counters_number_check", sql`${t.lastNumber} > 0`)],
).enableRLS();

export const people = pgTable(
  "people",
  {
    ...recordColumns(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    accountId: uuid("account_id"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    foreignKey({
      name: "people_account_membership_fk",
      columns: [t.workspaceId, t.accountId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    check("people_revision_check", sql`${t.revision} > 0`),
    check("people_branch_check", sql`${t.branchId} = 'default'`),
    index("people_active_id_idx")
      .on(t.workspaceId, t.id)
      .where(sql`${t.deletedAt} is null`),
    // Search is case-insensitive literal prefix matching, not an unindexed contains scan.
    index("people_active_name_prefix_idx")
      .on(t.workspaceId, sql`lower(${t.displayName}) text_pattern_ops`, t.id)
      .where(sql`${t.deletedAt} is null`),
  ],
).enableRLS();

export const commandReceipts = pgTable(
  "command_receipts",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    commandId: uuid("command_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    // NULL only while the inserting transaction owns an unfinished command.
    result: jsonb("result").$type<NoteRecord | PersonRecord>(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.commandId] }),
    foreignKey({
      name: "command_receipts_actor_membership_fk",
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
  ],
).enableRLS();

export const domainEvents = pgTable(
  "domain_events",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    id: uuid("id").notNull().defaultRandom(),
    entityType: text("entity_type").$type<"note" | "person">().notNull(),
    entityId: uuid("entity_id").notNull(),
    noteId: uuid("note_id"),
    personId: uuid("person_id"),
    branchId: text("branch_id").notNull().default(DEFAULT_BRANCH),
    revision: integer("revision").notNull(),
    operation: text("operation").notNull(),
    operationVersion: integer("operation_version").notNull().default(1),
    actorId: uuid("actor_id").notNull(),
    commandId: uuid("command_id").notNull(),
    payload: jsonb("payload").$type<NoteRecord | PersonRecord>().notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    unique("domain_events_entity_sequence_unique").on(
      t.workspaceId,
      t.entityType,
      t.entityId,
      t.branchId,
      t.revision,
    ),
    unique("domain_events_command_unique").on(t.workspaceId, t.commandId),
    foreignKey({
      name: "domain_events_note_fk",
      columns: [t.workspaceId, t.noteId],
      foreignColumns: [notes.workspaceId, notes.id],
    }),
    foreignKey({
      name: "domain_events_person_fk",
      columns: [t.workspaceId, t.personId],
      foreignColumns: [people.workspaceId, people.id],
    }),
    foreignKey({
      name: "domain_events_actor_membership_fk",
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    foreignKey({
      name: "domain_events_receipt_fk",
      columns: [t.workspaceId, t.commandId],
      foreignColumns: [commandReceipts.workspaceId, commandReceipts.commandId],
    }),
    check(
      "domain_events_entity_check",
      sql`(${t.entityType} = 'note' and ${t.noteId} is not null and ${t.noteId} = ${t.entityId} and ${t.personId} is null) or (${t.entityType} = 'person' and ${t.personId} is not null and ${t.personId} = ${t.entityId} and ${t.noteId} is null)`,
    ),
    check("domain_events_revision_check", sql`${t.revision} > 0`),
    check("domain_events_version_check", sql`${t.operationVersion} > 0`),
    check("domain_events_branch_check", sql`${t.branchId} = 'default'`),
  ],
).enableRLS();

export const outbox = pgTable(
  "outbox",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    id: uuid("id").notNull().defaultRandom(),
    eventId: uuid("event_id").notNull(),
    kind: text("kind").notNull(),
    availableAt: time("available_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    completedAt: time("completed_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    unique("outbox_event_unique").on(t.workspaceId, t.eventId),
    foreignKey({
      name: "outbox_event_fk",
      columns: [t.workspaceId, t.eventId],
      foreignColumns: [domainEvents.workspaceId, domainEvents.id],
    }),
    check("outbox_attempts_check", sql`${t.attempts} >= 0`),
    index("outbox_eligible_idx")
      .on(t.availableAt, t.workspaceId, t.id)
      .where(sql`${t.completedAt} is null`),
  ],
).enableRLS();

// Finalized whole-file backup is intentionally separate from local capture chunks.
export const recordings = pgTable(
  "recordings",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    noteId: uuid("note_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    sha256: text("sha256").notNull(),
    bytes: integer("bytes").notNull(),
    mimeType: text("mime_type").notNull(),
    durationSeconds: doublePrecision("duration_seconds").notNull(),
    objectKey: text("object_key").notNull(),
    status: text("status").$type<"upload_pending" | "ready">().notNull().default("upload_pending"),
    createdAt: time("created_at").notNull().defaultNow(),
    deletedAt: time("deleted_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    foreignKey({
      columns: [t.workspaceId, t.noteId],
      foreignColumns: [notes.workspaceId, notes.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    unique("recordings_note_identity").on(t.workspaceId, t.noteId, t.id),
    check(
      "recordings_bounds",
      sql`${t.bytes} > 0 and ${t.bytes} <= 1073741824 and ${t.durationSeconds} > 0 and ${t.durationSeconds} <= 7200`,
    ),
    check("recordings_status", sql`${t.status} in ('upload_pending','ready')`),
    index("recordings_note_idx").on(t.workspaceId, t.noteId, t.createdAt.desc(), t.id),
  ],
).enableRLS();

export const processingRuns = pgTable(
  "processing_runs",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    noteId: uuid("note_id").notNull(),
    recordingId: uuid("recording_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    status: text("status")
      .$type<import("../contracts/recording-processing").ProcessingStatus>()
      .notNull()
      .default("queued"),
    providerJobId: text("provider_job_id"),
    config: jsonb("config").$type<{ model: string; transcriptionModel: string }>().notNull(),
    rawObjectKey: text("raw_object_key"),
    correctionsMaterializedAt: time("corrections_materialized_at"),
    error: text("error"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    foreignKey({
      columns: [t.workspaceId, t.noteId, t.recordingId],
      foreignColumns: [recordings.workspaceId, recordings.noteId, recordings.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    unique("processing_runs_one_logical_run").on(t.workspaceId, t.recordingId),
    unique("processing_runs_provider_job").on(t.providerJobId),
    check(
      "processing_runs_status",
      sql`${t.status} in ('queued','submitting','submission_unknown','submitted','running','succeeded','failed','blocked')`,
    ),
    index("processing_runs_note_idx").on(t.workspaceId, t.noteId, t.createdAt.desc()),
  ],
).enableRLS();

// Append-only finalized transcript version: a run is one immutable version.
// Provider labels remain run-scoped labels, never application person identities.
export const transcriptUtterances = pgTable(
  "transcript_utterances",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    runId: uuid("run_id").notNull(),
    sequence: integer("sequence").notNull(),
    startSeconds: doublePrecision("start_seconds").notNull(),
    endSeconds: doublePrecision("end_seconds").notNull(),
    speakerLabel: text("speaker_label").notNull(),
    text: text("text").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [processingRuns.workspaceId, processingRuns.id],
    }),
    unique("transcript_utterances_run_sequence").on(t.workspaceId, t.runId, t.sequence),
    unique("transcript_utterances_run_identity").on(t.workspaceId, t.runId, t.id),
    check(
      "transcript_utterances_bounds",
      sql`${t.sequence} >= 0 and ${t.startSeconds} >= 0 and ${t.endSeconds} >= ${t.startSeconds} and ${t.endSeconds} <= 7200`,
    ),
    index("transcript_utterances_page_idx").on(t.workspaceId, t.runId, t.sequence),
  ],
).enableRLS();

export const recordingEvents = pgTable(
  "recording_events",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    recordingId: uuid("recording_id").notNull(),
    runId: uuid("run_id"),
    kind: text("kind").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    foreignKey({
      columns: [t.workspaceId, t.recordingId],
      foreignColumns: [recordings.workspaceId, recordings.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [processingRuns.workspaceId, processingRuns.id],
    }),
  ],
).enableRLS();

export const processingOutbox = pgTable(
  "processing_outbox",
  {
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    dispatchedAt: time("dispatched_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.runId] }),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [processingRuns.workspaceId, processingRuns.id],
    }),
    index("processing_outbox_pending_idx")
      .on(t.createdAt)
      .where(sql`${t.dispatchedAt} is null`),
  ],
).enableRLS();

// Provider transcript_utterances are immutable proposals. Only this projection is
// edited. Retired segments remain addressable, including their original lineage.
export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    id: uuid("id").notNull(),
    sourceUtteranceId: uuid("source_utterance_id").notNull(),
    parentId: uuid("parent_id"),
    sequence: integer("sequence").notNull(),
    // Binary lineage orders arbitrarily nested splits without floating point drift.
    orderKey: text("order_key").notNull().default(""),
    active: boolean("active").notNull().default(true),
    revision: integer("revision").notNull().default(0),
    attributionRevision: integer("attribution_revision").notNull().default(0),
    startSeconds: doublePrecision("start_seconds").notNull(),
    endSeconds: doublePrecision("end_seconds").notNull(),
    text: text("text").notNull(),
    assignmentKind: text("assignment_kind")
      .$type<"unassigned" | "unknown" | "person">()
      .notNull()
      .default("unassigned"),
    personId: uuid("person_id"),
    assignmentSource: text("assignment_source")
      .$type<"unassigned" | "manual">()
      .notNull()
      .default("unassigned"),
    reviewState: text("review_state")
      .$type<"unreviewed" | "confirmed" | "needs_review">()
      .notNull()
      .default("unreviewed"),
    providerScore: doublePrecision("provider_score"),
    sampleSuitability: text("sample_suitability")
      .$type<"not_evaluated" | "candidate" | "invalidated">()
      .notNull()
      .default("not_evaluated"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    unique("transcript_segments_run_identity").on(t.workspaceId, t.runId, t.id),
    uniqueIndex("transcript_segments_lineage")
      .on(t.workspaceId, t.runId, t.sequence, t.orderKey)
      .where(sql`${t.active}`),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [processingRuns.workspaceId, processingRuns.id],
    }),
    foreignKey({
      name: "transcript_segments_source_fk",
      columns: [t.workspaceId, t.runId, t.sourceUtteranceId],
      foreignColumns: [
        transcriptUtterances.workspaceId,
        transcriptUtterances.runId,
        transcriptUtterances.id,
      ],
    }),
    foreignKey({
      name: "transcript_segments_parent_fk",
      columns: [t.workspaceId, t.runId, t.parentId],
      foreignColumns: [t.workspaceId, t.runId, t.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.personId],
      foreignColumns: [people.workspaceId, people.id],
    }),
    check(
      "transcript_segments_bounds",
      sql`${t.startSeconds} >= 0 and ${t.endSeconds} >= ${t.startSeconds} and ${t.endSeconds} <= 7200`,
    ),
    check(
      "transcript_segments_revisions",
      sql`${t.revision} >= ${t.attributionRevision} and ${t.attributionRevision} >= 0`,
    ),
    check(
      "transcript_segments_assignment",
      sql`(${t.assignmentKind} = 'unassigned' and ${t.assignmentSource} = 'unassigned' and ${t.personId} is null) or (${t.assignmentKind} = 'unknown' and ${t.assignmentSource} = 'manual' and ${t.personId} is null) or (${t.assignmentKind} = 'person' and ${t.assignmentSource} = 'manual' and ${t.personId} is not null)`,
    ),
    check(
      "transcript_segments_review",
      sql`${t.reviewState} in ('unreviewed','confirmed','needs_review')`,
    ),
    check(
      "transcript_segments_sample",
      sql`${t.sampleSuitability} in ('not_evaluated','candidate','invalidated')`,
    ),
    check(
      "transcript_segments_order",
      sql`${t.sequence} >= 0 and ${t.orderKey} ~ '^[01]*$' and length(${t.orderKey}) <= 256`,
    ),
    index("transcript_segments_page_idx")
      .on(t.workspaceId, t.runId, t.sequence, t.orderKey, t.id)
      .where(sql`${t.active}`),
    index("transcript_segments_person_idx")
      .on(t.workspaceId, t.personId, t.id)
      .where(sql`${t.active}`),
  ],
).enableRLS();

export type TranscriptSegmentSnapshot =
  import("../contracts/transcript-corrections").CorrectedTurn & {
    active: boolean;
    orderKey: string;
  };

// An immutable batch is also the successful command receipt. Before/after hold
// every touched version (including retired parents), not a dynamic target filter.
export const transcriptCorrections = pgTable(
  "transcript_corrections",
  {
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    id: uuid("id").notNull(),
    commandId: uuid("command_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    kind: text("kind").$type<"assign" | "edit" | "split" | "undo">().notNull(),
    affectedCount: integer("affected_count").notNull(),
    snapshotBytes: integer("snapshot_bytes").notNull(),
    undoOf: uuid("undo_of"),
    before: jsonb("before").$type<TranscriptSegmentSnapshot[]>().notNull(),
    after: jsonb("after").$type<TranscriptSegmentSnapshot[]>().notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    unique("transcript_corrections_command").on(t.workspaceId, t.commandId),
    unique("transcript_corrections_run_identity").on(t.workspaceId, t.runId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [processingRuns.workspaceId, processingRuns.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    foreignKey({
      name: "transcript_corrections_undo_fk",
      columns: [t.workspaceId, t.runId, t.undoOf],
      foreignColumns: [t.workspaceId, t.runId, t.id],
    }),
    check("transcript_corrections_kind", sql`${t.kind} in ('assign','edit','split','undo')`),
    check(
      "transcript_corrections_count",
      sql`${t.affectedCount} > 0 and ${t.affectedCount} <= 500`,
    ),
    check(
      "transcript_corrections_snapshot_bytes",
      sql`${t.snapshotBytes} > 0 and ${t.snapshotBytes} <= 2097152`,
    ),
    index("transcript_corrections_history_idx").on(
      t.workspaceId,
      t.runId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
).enableRLS();

// These are review candidates, never automatic voice-recognition enrollment.
// Keeping the captured audio span preserves evidence even after a boundary edit.
export const transcriptSampleCandidates = pgTable(
  "transcript_sample_candidates",
  {
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    correctionId: uuid("correction_id").notNull(),
    segmentId: uuid("segment_id").notNull(),
    personId: uuid("person_id").notNull(),
    startSeconds: doublePrecision("start_seconds").notNull(),
    endSeconds: doublePrecision("end_seconds").notNull(),
    state: text("state")
      .$type<"candidate" | "confirmed" | "invalidated">()
      .notNull()
      .default("candidate"),
    invalidatedAt: time("invalidated_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.correctionId, t.segmentId] }),
    foreignKey({
      name: "transcript_samples_correction_fk",
      columns: [t.workspaceId, t.runId, t.correctionId],
      foreignColumns: [
        transcriptCorrections.workspaceId,
        transcriptCorrections.runId,
        transcriptCorrections.id,
      ],
    }),
    foreignKey({
      name: "transcript_samples_segment_fk",
      columns: [t.workspaceId, t.runId, t.segmentId],
      foreignColumns: [
        transcriptSegments.workspaceId,
        transcriptSegments.runId,
        transcriptSegments.id,
      ],
    }),
    foreignKey({
      columns: [t.workspaceId, t.personId],
      foreignColumns: [people.workspaceId, people.id],
    }),
    check("transcript_samples_state", sql`${t.state} in ('candidate','confirmed','invalidated')`),
    check(
      "transcript_samples_bounds",
      sql`${t.startSeconds} >= 0 and ${t.endSeconds} >= ${t.startSeconds} and ${t.endSeconds} <= 7200`,
    ),
    index("transcript_samples_segment_idx").on(t.workspaceId, t.runId, t.segmentId),
  ],
).enableRLS();

export const transcriptCorrectionOutbox = pgTable(
  "transcript_correction_outbox",
  {
    workspaceId: uuid("workspace_id").notNull(),
    correctionId: uuid("correction_id").notNull(),
    kind: text("kind").notNull().default("transcript.dependencies_invalidated"),
    createdAt: time("created_at").notNull().defaultNow(),
    completedAt: time("completed_at"),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.correctionId] }),
    foreignKey({
      columns: [t.workspaceId, t.correctionId],
      foreignColumns: [transcriptCorrections.workspaceId, transcriptCorrections.id],
    }),
    check("transcript_correction_outbox_attempts", sql`${t.attempts} >= 0`),
    index("transcript_correction_outbox_pending_idx")
      .on(t.createdAt)
      .where(sql`${t.completedAt} is null`),
  ],
).enableRLS();
