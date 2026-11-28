import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { workspaceMemberships } from "./schema";

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

// Composio connection identities and non-replayable external-write receipts.
export const connectorConnections = pgTable(
  "connector_connections",
  {
    workspaceId: uuid("workspace_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    provider: text("provider").$type<"slack">().notNull(),
    connectedAccountId: text("connected_account_id"),
    status: text("status").$type<"pending" | "connected" | "revoked">().notNull(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.actorId, t.provider] }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    unique("connector_connections_account").on(t.connectedAccountId),
    check(
      "connector_connections_state",
      sql`(${t.status} = 'pending' and ${t.connectedAccountId} is not null) or (${t.status} = 'revoked' and ${t.connectedAccountId} is null) or (${t.status} = 'connected' and ${t.connectedAccountId} is not null)`,
    ),
  ],
).enableRLS();

export const connectorOperationReceipts = pgTable(
  "connector_operation_receipts",
  {
    workspaceId: uuid("workspace_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    provider: text("provider").$type<"slack">().notNull(),
    actorId: uuid("actor_id").notNull(),
    origin: text("origin").notNull(),
    fingerprint: text("fingerprint").notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    briefId: uuid("brief_id").notNull(),
    channelId: text("channel_id").notNull(),
    status: text("status").$type<"in_flight" | "sent" | "failed" | "unknown">().notNull(),
    providerRequestId: text("provider_request_id"),
    remoteMessageId: text("remote_message_id"),
    messageUrl: text("message_url"),
    createdAt: time("created_at").notNull().defaultNow(),
    completedAt: time("completed_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.operationId] }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    check("connector_receipt_origin_bound", sql`length(${t.origin}) between 1 and 200`),
    check("connector_receipt_fingerprint", sql`length(${t.fingerprint}) = 64`),
    check("connector_receipt_state", sql`${t.status} in ('in_flight','sent','failed','unknown')`),
    index("connector_receipts_brief").on(t.workspaceId, t.briefId, t.createdAt.desc()),
    uniqueIndex("connector_one_in_flight_per_workspace")
      .on(t.workspaceId, t.provider)
      .where(sql`${t.status} = 'in_flight'`),
  ],
).enableRLS();

export const connectorLinkReceipts = pgTable(
  "connector_link_receipts",
  {
    workspaceId: uuid("workspace_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    origin: text("origin").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").$type<"in_flight" | "linked" | "failed" | "unknown">().notNull(),
    connectedAccountId: text("connected_account_id"),
    createdAt: time("created_at").notNull().defaultNow(),
    completedAt: time("completed_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.operationId] }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    check("connector_link_origin_bound", sql`length(${t.origin}) between 1 and 200`),
    check("connector_link_fingerprint", sql`length(${t.fingerprint}) = 64`),
    check(
      "connector_link_state",
      sql`(${t.status} = 'in_flight' and ${t.completedAt} is null)
        or (${t.status} in ('linked','failed','unknown') and ${t.completedAt} is not null)`,
    ),
    check(
      "connector_link_account",
      sql`(${t.status} = 'linked' and ${t.connectedAccountId} is not null)
        or (${t.status} <> 'linked' and ${t.connectedAccountId} is null)`,
    ),
    uniqueIndex("connector_one_link_in_flight_per_actor")
      .on(t.workspaceId, t.actorId)
      .where(sql`${t.status} = 'in_flight'`),
    index("connector_link_receipts_owner").on(t.workspaceId, t.actorId, t.createdAt.desc()),
  ],
).enableRLS();
