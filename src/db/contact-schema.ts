import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type { ContactDetails, ContactFields } from "../contracts/contacts";
import { people } from "./schema";

export const contactDetails = pgTable(
  "contact_details",
  {
    workspaceId: uuid("workspace_id").notNull(),
    personId: uuid("person_id").notNull(),
    organization: text("organization").notNull().default(""),
    role: text("role").notNull().default(""),
    links: jsonb("links").$type<ContactFields["links"]>().notNull().default([]),
    revision: integer("revision").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.personId] }),
    foreignKey({
      columns: [t.workspaceId, t.personId],
      foreignColumns: [people.workspaceId, people.id],
    }),
    check("contact_details_revision_check", sql`${t.revision} > 0`),
  ],
).enableRLS();

export const contactReceipts = pgTable(
  "contact_receipts",
  {
    workspaceId: uuid("workspace_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    personId: uuid("person_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    result: jsonb("result").$type<ContactDetails>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.operationId] }),
    foreignKey({
      columns: [t.workspaceId, t.personId],
      foreignColumns: [people.workspaceId, people.id],
    }),
  ],
).enableRLS();
