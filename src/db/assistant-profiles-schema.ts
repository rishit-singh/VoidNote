import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { AssistantSource } from "../contracts/assistant";
import type { ContactFields } from "../contracts/contacts";
import { assistantTurns } from "./assistant-schema";
import { people, workspaceMemberships, workspaces } from "./schema";

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

/** Immutable actor/source evidence and field ownership for each profile patch. */
export const assistantProfileChanges = pgTable(
  "assistant_profile_changes",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    executor: text("executor").$type<"user" | "agent" | "workflow">().notNull(),
    kind: text("kind").$type<"create" | "patch" | "contact-save">().notNull(),
    turnId: uuid("turn_id"),
    personId: uuid("person_id").notNull(),
    expectedPersonRevision: integer("expected_person_revision").notNull(),
    personRevision: integer("person_revision").notNull(),
    expectedContactRevision: integer("expected_contact_revision").notNull(),
    contactRevision: integer("contact_revision").notNull(),
    fingerprint: text("fingerprint").notNull(),
    fields: jsonb("fields")
      .$type<{ [K in keyof ContactFields]?: ContactFields[K] | undefined }>()
      .notNull(),
    sources: jsonb("sources").$type<AssistantSource[]>().notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId], foreignColumns: [workspaces.id] }),
    foreignKey({
      columns: [t.workspaceId, t.personId],
      foreignColumns: [people.workspaceId, people.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    foreignKey({
      columns: [t.workspaceId, t.turnId],
      foreignColumns: [assistantTurns.workspaceId, assistantTurns.id],
    }),
    uniqueIndex("assistant_profile_changes_operation")
      .on(t.workspaceId, t.operationId)
      .where(sql`${t.executor} in ('agent', 'workflow')`),
    uniqueIndex("assistant_profile_changes_revision")
      .on(t.workspaceId, t.personId, t.contactRevision)
      .where(sql`${t.fields} <> '{}'::jsonb`),
    index("assistant_profile_changes_owner").on(
      t.workspaceId,
      t.personId,
      t.contactRevision.desc(),
    ),
    check(
      "assistant_profile_changes_executor",
      sql`${t.executor} in ('user', 'agent', 'workflow')`,
    ),
    check("assistant_profile_changes_kind", sql`${t.kind} in ('create', 'patch', 'contact-save')`),
    check(
      "assistant_profile_changes_turn",
      sql`(${t.executor} = 'user' and ${t.turnId} is null) or (${t.executor} <> 'user' and ${t.turnId} is not null)`,
    ),
    check(
      "assistant_profile_changes_revisions",
      sql`${t.expectedPersonRevision} >= 0 and ${t.personRevision} > 0 and ${t.expectedContactRevision} >= 0 and ${t.contactRevision} >= 0`,
    ),
    check("assistant_profile_changes_fingerprint", sql`length(${t.fingerprint}) = 64`),
    check(
      "assistant_profile_changes_evidence_bound",
      sql`octet_length(${t.fields}::text) <= 16384 and octet_length(${t.sources}::text) <= 65536`,
    ),
  ],
).enableRLS();
