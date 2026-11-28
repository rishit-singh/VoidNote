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
  uuid,
} from "drizzle-orm/pg-core";

import type {
  ResearchDiscoveryCheckpoint,
  ResearchFactCheckpoint,
  ResearchSource,
} from "../ai/research";
import type { ResearchPolicy } from "../config/research";
import type { ContactFields } from "../contracts/contacts";
import type { RequestResearch, ResearchPersonRequest, ResearchStatus } from "../contracts/research";
import { people, workspaceMemberships, workspaces } from "./schema";

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

export const researchBatches = pgTable(
  "research_batches",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    id: uuid("id").notNull(),
    actorId: uuid("actor_id").notNull(),
    request: jsonb("request").$type<RequestResearch>().notNull(),
    policy: jsonb("policy").$type<ResearchPolicy>().notNull(),
    cancelledAt: time("cancelled_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    index("research_batches_workspace_created").on(t.workspaceId, t.createdAt.desc(), t.id),
    check("research_batches_request_bound", sql`octet_length(${t.request}::text) <= 100000`),
  ],
).enableRLS();

export const researchItems = pgTable(
  "research_items",
  {
    workspaceId: uuid("workspace_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    personId: uuid("person_id").notNull(),
    request: jsonb("request").$type<ResearchPersonRequest>().notNull(),
    profileRevision: integer("profile_revision").notNull(),
    contactRevision: integer("contact_revision").notNull().default(0),
    contact: jsonb("contact").$type<ContactFields>().notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull(),
    generation: integer("generation").notNull().default(1),
    status: text("status").$type<ResearchStatus>().notNull().default("queued"),
    sources: jsonb("sources").$type<ResearchSource[]>().notNull().default([]),
    facts: jsonb("facts").$type<ResearchFactCheckpoint[]>().notNull().default([]),
    discovery: jsonb("discovery")
      .$type<ResearchDiscoveryCheckpoint>()
      .notNull()
      .default({ state: "pending", operationId: "", creditsUsed: null, settled: false }),
    error: text("error"),
    deadline: time("deadline").notNull(),
    dispatchCheckedAt: time("dispatch_checked_at"),
    cleanupAt: time("cleanup_at"),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.batchId, t.personId] }),
    foreignKey({
      columns: [t.workspaceId, t.batchId],
      foreignColumns: [researchBatches.workspaceId, researchBatches.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.personId],
      foreignColumns: [people.workspaceId, people.id],
    }),
    check(
      "research_items_status",
      sql`${t.status} in ('queued','running','needs-input','partial','completed','failed','cancelled')`,
    ),
    check(
      "research_items_versions",
      sql`${t.generation} > 0 and ${t.profileRevision} > 0 and ${t.contactRevision} >= 0`,
    ),
    check("research_items_sources_bound", sql`octet_length(${t.sources}::text) <= 3200000`),
    check("research_items_facts_bound", sql`octet_length(${t.facts}::text) <= 1000000`),
    index("research_items_workspace_recent").on(
      t.workspaceId,
      t.updatedAt.desc(),
      t.batchId.desc(),
      t.personId.desc(),
    ),
    index("research_items_person_evidence")
      .on(t.workspaceId, t.personId, t.updatedAt.desc(), t.batchId.desc())
      .where(sql`${t.status} in ('completed','partial')`),
    index("research_items_dispatch")
      .on(
        sql`coalesce(${t.dispatchCheckedAt}, ${t.updatedAt})`,
        t.workspaceId,
        t.batchId,
        t.personId,
      )
      .where(
        sql`${t.status} in ('queued','running') or (${t.status} = 'cancelled' and ${t.cleanupAt} is null)`,
      ),
  ],
).enableRLS();

export const researchCommands = pgTable(
  "research_commands",
  {
    workspaceId: uuid("workspace_id").notNull(),
    requestId: uuid("request_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.requestId] }),
    foreignKey({
      columns: [t.workspaceId, t.batchId],
      foreignColumns: [researchBatches.workspaceId, researchBatches.id],
    }),
  ],
).enableRLS();
