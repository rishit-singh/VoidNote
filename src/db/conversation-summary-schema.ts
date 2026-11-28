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
  uuid,
} from "drizzle-orm/pg-core";

import type { AssistantSource } from "../contracts/assistant";
import type {
  ConversationSummary,
  ConversationSummaryExecution,
  ConversationSummaryPolicy,
} from "../contracts/conversation-summaries";
import { assistantThreads } from "./assistant-schema";

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

export const conversationSummaryJobs = pgTable(
  "conversation_summary_jobs",
  {
    workspaceId: uuid("workspace_id").notNull(),
    threadId: uuid("thread_id").notNull(),
    id: uuid("id").notNull(),
    actorId: uuid("actor_id").notNull(),
    status: text("status").$type<ConversationSummary["status"]>().notNull().default("queued"),
    fromSequence: integer("from_sequence").notNull(),
    throughSequence: integer("through_sequence").notNull(),
    messageCount: integer("message_count").notNull(),
    // Immutable accepted input; no runtime method rewrites the source snapshot.
    messages: jsonb("messages").$type<ConversationSummaryExecution["messages"]>().notNull(),
    sources: jsonb("sources").$type<AssistantSource[]>().notNull(),
    policy: jsonb("policy").$type<ConversationSummaryPolicy>().notNull(),
    inputBytes: integer("input_bytes").notNull(),
    text: text("text"),
    error: text("error"),
    dispatchCheckedAt: time("dispatch_checked_at"),
    createdAt: time("created_at").notNull().defaultNow(),
    completedAt: time("completed_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    foreignKey({
      name: "conversation_summary_jobs_thread_owner_fk",
      columns: [t.workspaceId, t.threadId, t.actorId],
      foreignColumns: [assistantThreads.workspaceId, assistantThreads.id, assistantThreads.actorId],
    }),
    unique("conversation_summary_jobs_cutoff").on(t.workspaceId, t.threadId, t.throughSequence),
    check(
      "conversation_summary_jobs_status",
      sql`${t.status} in ('queued','running','succeeded','failed','stale')`,
    ),
    check(
      "conversation_summary_jobs_coverage",
      sql`${t.fromSequence} > 0 and ${t.throughSequence} >= ${t.fromSequence}
        and ${t.messageCount} between 1 and 50
        and ${t.messageCount} <= ${t.throughSequence} - ${t.fromSequence} + 1
        and jsonb_array_length(${t.messages}) = ${t.messageCount}
        and jsonb_array_length(${t.sources}) = ${t.messageCount}`,
    ),
    check("conversation_summary_jobs_input_bound", sql`${t.inputBytes} between 1 and 128000`),
    check(
      "conversation_summary_jobs_text_bound",
      sql`${t.text} is null or length(${t.text}) <= 8000`,
    ),
    check(
      "conversation_summary_jobs_error_bound",
      sql`${t.error} is null or length(${t.error}) <= 1000`,
    ),
    index("conversation_summary_jobs_latest").on(
      t.workspaceId,
      t.threadId,
      t.throughSequence.desc(),
    ),
    index("conversation_summary_jobs_dispatch")
      .on(sql`coalesce(${t.dispatchCheckedAt}, ${t.createdAt})`, t.workspaceId, t.id)
      .where(sql`${t.status} in ('queued','running')`),
  ],
).enableRLS();

// Attempt rotation is independent of successful acceptance: inaccessible/stale or
// oversized candidate tails cannot monopolize the next bounded idle scan.
export const conversationSummaryScans = pgTable(
  "conversation_summary_scans",
  {
    workspaceId: uuid("workspace_id").notNull(),
    threadId: uuid("thread_id").notNull(),
    checkedAt: time("checked_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.threadId] }),
    foreignKey({
      columns: [t.workspaceId, t.threadId],
      foreignColumns: [assistantThreads.workspaceId, assistantThreads.id],
    }),
    index("conversation_summary_scans_checked").on(t.checkedAt, t.workspaceId, t.threadId),
  ],
).enableRLS();
