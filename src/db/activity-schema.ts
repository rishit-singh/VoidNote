import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
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

import type { ApplicationEventInput } from "../contracts/activity";
import { workspaceMemberships, workspaces } from "./schema";

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

export const applicationEvents = pgTable(
  "application_events",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    id: uuid("id").notNull(),
    type: text("type").$type<ApplicationEventInput["type"]>().notNull(),
    version: integer("version").notNull().default(1),
    payload: jsonb("payload").$type<ApplicationEventInput>().notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    check("application_events_payload_bound", sql`octet_length(${t.payload}::text) <= 4096`),
  ],
).enableRLS();

export const eventDeliveries = pgTable(
  "event_deliveries",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    eventId: uuid("event_id").notNull(),
    subscriber: text("subscriber").$type<"activity-v1" | "automatic-summary-v1">().notNull(),
    status: text("status")
      .$type<"pending" | "running" | "completed" | "failed">()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: time("available_at").notNull().defaultNow(),
    leaseId: uuid("lease_id"),
    leaseUntil: time("lease_until"),
    enqueuedAt: time("enqueued_at"),
    error: text("error"),
    completedAt: time("completed_at"),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.eventId],
      foreignColumns: [applicationEvents.workspaceId, applicationEvents.id],
    }),
    unique("event_deliveries_subscriber").on(t.workspaceId, t.eventId, t.subscriber),
    index("event_deliveries_pending")
      .on(t.availableAt, t.id)
      .where(sql`${t.status} in ('pending', 'running')`),
    check(
      "event_deliveries_state",
      sql`${t.status} in ('pending', 'running', 'completed', 'failed')`,
    ),
  ],
).enableRLS();

export const activityNotifications = pgTable(
  "activity_notifications",
  {
    workspaceId: uuid("workspace_id").notNull(),
    recipientId: uuid("recipient_id").notNull(),
    eventId: uuid("event_id").notNull(),
    sequence: bigserial("sequence", { mode: "bigint" }).notNull(),
    title: text("title").notNull(),
    href: text("href").notNull(),
    visible: boolean("visible").notNull().default(true),
    createdAt: time("created_at").notNull().defaultNow(),
    readAt: time("read_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.recipientId, t.eventId] }),
    foreignKey({
      columns: [t.workspaceId, t.eventId],
      foreignColumns: [applicationEvents.workspaceId, applicationEvents.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.recipientId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    index("activity_notifications_feed").on(t.workspaceId, t.recipientId, t.sequence),
    index("activity_notifications_unread")
      .on(t.workspaceId, t.recipientId)
      .where(sql`${t.readAt} is null`),
  ],
).enableRLS();
