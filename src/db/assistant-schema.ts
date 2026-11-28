import { sql } from "drizzle-orm";
import {
  check,
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

import type {
  AssistantArtifact,
  AssistantMemory,
  AssistantSource,
  AssistantToolResult,
  AssistantTurn,
} from "../contracts/assistant";
import { notes, people, userProfiles, workspaceMemberships, workspaces } from "./schema";

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });
const identity = () => ({
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  id: uuid("id").notNull(),
  actorId: uuid("actor_id")
    .notNull()
    .references(() => userProfiles.id),
  createdAt: time("created_at").notNull().defaultNow(),
});

export const assistantThreads = pgTable(
  "assistant_threads",
  {
    ...identity(),
    noteId: uuid("note_id"),
    title: text("title").notNull().default("New conversation"),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    unique("assistant_threads_owner_identity").on(t.workspaceId, t.id, t.actorId),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    foreignKey({
      columns: [t.workspaceId, t.noteId],
      foreignColumns: [notes.workspaceId, notes.id],
    }),
    index("assistant_threads_owner_updated").on(
      t.workspaceId,
      t.actorId,
      t.updatedAt.desc(),
      t.id.desc(),
    ),
  ],
).enableRLS();

export const assistantTurns = pgTable(
  "assistant_turns",
  {
    ...identity(),
    threadId: uuid("thread_id").notNull(),
    status: text("status").$type<AssistantTurn["status"]>().notNull().default("queued"),
    text: text("text").notNull(),
    policy: jsonb("policy").$type<unknown>().notNull(),
    fingerprint: text("fingerprint").notNull(),
    outputFingerprint: text("output_fingerprint"),
    error: text("error"),
    dispatchCheckedAt: time("dispatch_checked_at"),
    cancellationDispatchedAt: time("cancellation_dispatched_at"),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    unique("assistant_turns_thread_identity").on(t.workspaceId, t.threadId, t.id),
    foreignKey({
      name: "assistant_turns_thread_owner_fk",
      columns: [t.workspaceId, t.threadId, t.actorId],
      foreignColumns: [assistantThreads.workspaceId, assistantThreads.id, assistantThreads.actorId],
    }),
    uniqueIndex("assistant_turns_one_active")
      .on(t.workspaceId, t.threadId)
      .where(sql`${t.status} in ('queued', 'running')`),
    check(
      "assistant_turns_status",
      sql`${t.status} in ('queued','running','succeeded','failed','cancelled','interrupted')`,
    ),
    check("assistant_turns_text_bound", sql`length(${t.text}) between 1 and 16000`),
    check("assistant_turns_policy_bound", sql`octet_length(${t.policy}::text) <= 65536`),
    index("assistant_turns_dispatch")
      .on(sql`coalesce(${t.dispatchCheckedAt}, ${t.createdAt})`, t.workspaceId, t.id)
      .where(
        sql`${t.status} in ('queued','running') or (${t.status} = 'cancelled' and ${t.cancellationDispatchedAt} is null)`,
      ),
  ],
).enableRLS();

export const assistantMessages = pgTable(
  "assistant_messages",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull(),
    threadId: uuid("thread_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    text: text("text").notNull(),
    tools: jsonb("tools").$type<AssistantToolResult[]>().notNull().default([]),
    sources: jsonb("sources").$type<AssistantSource[]>().notNull().default([]),
    // Allocated under the thread lock; timestamps alone cannot preserve causal
    // ordering for acceptance and completion within the same millisecond.
    sequence: integer("sequence").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    unique("assistant_messages_turn_role").on(t.workspaceId, t.turnId, t.role),
    unique("assistant_messages_thread_sequence").on(t.workspaceId, t.threadId, t.sequence),
    foreignKey({
      columns: [t.workspaceId, t.threadId, t.turnId],
      foreignColumns: [assistantTurns.workspaceId, assistantTurns.threadId, assistantTurns.id],
    }),
    check("assistant_messages_role", sql`${t.role} in ('user','assistant')`),
    check("assistant_messages_sequence", sql`${t.sequence} > 0`),
    check("assistant_messages_text_bound", sql`length(${t.text}) <= 100000`),
  ],
).enableRLS();

export const assistantMemories = pgTable(
  "assistant_memories",
  {
    ...identity(),
    subjectId: uuid("subject_id"),
    kind: text("kind").$type<AssistantMemory["kind"]>().notNull(),
    content: text("content").notNull(),
    provenance: text("provenance").$type<AssistantMemory["provenance"]>().notNull(),
    sources: jsonb("sources").$type<AssistantSource[]>().notNull(),
    status: text("status").$type<AssistantMemory["status"]>().notNull().default("active"),
    revision: integer("revision").notNull().default(1),
    expiresAt: time("expires_at"),
    invalidationReason: text("invalidation_reason"),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    foreignKey({
      columns: [t.workspaceId, t.subjectId],
      foreignColumns: [people.workspaceId, people.id],
    }),
    check("assistant_memories_revision", sql`${t.revision} > 0`),
    check(
      "assistant_memories_status",
      sql`${t.status} in ('active','invalidated','expired','needs-review')`,
    ),
    check("assistant_memories_kind", sql`${t.kind} in ('preference','claim','working-summary')`),
    check(
      "assistant_memories_provenance",
      sql`${t.provenance} in ('user-stated','source-supported','agent-inferred')`,
    ),
    check("assistant_memories_content_bound", sql`length(${t.content}) between 1 and 8000`),
    index("assistant_memories_recall").on(
      t.workspaceId,
      t.actorId,
      t.subjectId,
      t.createdAt.desc(),
    ),
  ],
).enableRLS();

export const assistantArtifacts = pgTable(
  "assistant_artifacts",
  {
    ...identity(),
    turnId: uuid("turn_id"),
    kind: text("kind").$type<AssistantArtifact["kind"]>().notNull(),
    noteId: uuid("note_id"),
    name: text("name").notNull(),
    mediaType: text("media_type").$type<AssistantArtifact["mediaType"]>().notNull(),
    content: text("content").notNull(),
    sources: jsonb("sources").$type<AssistantSource[]>().notNull(),
    revision: integer("revision").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    foreignKey({
      columns: [t.workspaceId, t.turnId],
      foreignColumns: [assistantTurns.workspaceId, assistantTurns.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.noteId],
      foreignColumns: [notes.workspaceId, notes.id],
    }),
    check("assistant_artifacts_kind", sql`${t.kind} in ('note','file','annotation')`),
    check("assistant_artifacts_media_type", sql`${t.mediaType} in ('text/plain','text/markdown')`),
    check("assistant_artifacts_revision", sql`${t.revision} > 0`),
    check("assistant_artifacts_content_bound", sql`length(${t.content}) <= 100000`),
    check("assistant_artifacts_note", sql`${t.kind} = 'file' or ${t.noteId} is not null`),
    index("assistant_artifacts_owner").on(t.workspaceId, t.actorId, t.createdAt.desc(), t.id),
  ],
).enableRLS();

// Compact permanent identity receipts. Replay reads the current projection so an
// invalidation or deleted note cannot be resurrected by a historical response.
export const assistantOperationReceipts = pgTable(
  "assistant_operation_receipts",
  {
    workspaceId: uuid("workspace_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    kind: text("kind")
      .$type<"remember" | "revise-memory" | "invalidate-memory" | "create-artifact">()
      .notNull(),
    resultId: uuid("result_id").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.operationId] }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    check("assistant_operation_receipts_hash", sql`length(${t.fingerprint}) = 64`),
    check(
      "assistant_operation_receipts_kind",
      sql`${t.kind} in ('remember','revise-memory','invalidate-memory','create-artifact')`,
    ),
  ],
).enableRLS();

export const assistantMemoryRevisions = pgTable(
  "assistant_memory_revisions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    memoryId: uuid("memory_id").notNull(),
    revision: integer("revision").notNull(),
    operationId: uuid("operation_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    reason: text("reason").notNull(),
    before: jsonb("before").$type<AssistantMemory | null>(),
    after: jsonb("after").$type<AssistantMemory>().notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.memoryId, t.revision] }),
    unique("assistant_memory_revisions_operation").on(t.workspaceId, t.operationId),
    foreignKey({
      columns: [t.workspaceId, t.memoryId],
      foreignColumns: [assistantMemories.workspaceId, assistantMemories.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.operationId],
      foreignColumns: [
        assistantOperationReceipts.workspaceId,
        assistantOperationReceipts.operationId,
      ],
    }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    check("assistant_memory_revisions_positive", sql`${t.revision} > 0`),
    check("assistant_memory_revisions_reason", sql`length(${t.reason}) between 1 and 1000`),
    check(
      "assistant_memory_revisions_snapshot_bound",
      sql`octet_length(${t.after}::text) <= 524288 and (${t.before} is null or octet_length(${t.before}::text) <= 524288)`,
    ),
  ],
).enableRLS();

// Durable SQL content is authoritative until the private-object publisher records
// its acknowledgement. Object storage writes must use this deterministic key.
export const assistantArtifactPublications = pgTable(
  "assistant_artifact_publications",
  {
    workspaceId: uuid("workspace_id").notNull(),
    artifactId: uuid("artifact_id").notNull(),
    objectKey: text("object_key").notNull(),
    checksum: text("checksum").notNull(),
    attempts: integer("attempts").notNull().default(0),
    availableAt: time("available_at").notNull().defaultNow(),
    publishedAt: time("published_at"),
    cancelledAt: time("cancelled_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.artifactId] }),
    foreignKey({
      columns: [t.workspaceId, t.artifactId],
      foreignColumns: [assistantArtifacts.workspaceId, assistantArtifacts.id],
    }),
    unique("assistant_artifact_publications_key").on(t.objectKey),
    check("assistant_artifact_publications_attempts", sql`${t.attempts} >= 0`),
    check("assistant_artifact_publications_checksum", sql`${t.checksum} ~ '^[0-9a-f]{64}$'`),
    index("assistant_artifact_publications_pending")
      .on(t.availableAt, t.workspaceId, t.artifactId)
      .where(sql`${t.publishedAt} is null and ${t.cancelledAt} is null`),
  ],
).enableRLS();
