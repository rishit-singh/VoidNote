import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { workspaces } from "./schema";

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });
const units = (name: string) => bigint(name, { mode: "number" });

export type ServiceBudgetProvider = "firecrawl" | "composio";

/** Budgets are provisioned only by an authorized administrator; application
 * repositories intentionally provide no create, top-up, or transfer operation. */
export const serviceBudgets = pgTable(
  "service_budgets",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    provider: text("provider").$type<ServiceBudgetProvider>().notNull(),
    id: uuid("id").notNull(),
    limitUnits: units("limit_units").notNull(),
    reservedUnits: units("reserved_units").notNull().default(0),
    settledUnits: units("settled_units").notNull().default(0),
    approvedAt: time("approved_at").notNull(),
    revokedAt: time("revoked_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.provider, t.id] }),
    check("service_budgets_provider", sql`${t.provider} in ('firecrawl','composio')`),
    check("service_budgets_limit_range", sql`${t.limitUnits} between 0 and 9007199254740991`),
    check("service_budgets_reserved_range", sql`${t.reservedUnits} between 0 and 9007199254740991`),
    check("service_budgets_settled_range", sql`${t.settledUnits} between 0 and 9007199254740991`),
    check(
      "service_budgets_accounted_within_limit",
      sql`${t.reservedUnits} + ${t.settledUnits} <= ${t.limitUnits}`,
    ),
  ],
).enableRLS();

/** Permanent operation identity. Unknown external outcomes retain their full
 * maximumUnits reservation indefinitely; only a known receipt may settle it. */
export const serviceBudgetOperations = pgTable(
  "service_budget_operations",
  {
    workspaceId: uuid("workspace_id").notNull(),
    provider: text("provider").$type<ServiceBudgetProvider>().notNull(),
    operationId: uuid("operation_id").notNull(),
    budgetId: uuid("budget_id").notNull(),
    maximumUnits: units("maximum_units").notNull(),
    actualUnits: units("actual_units"),
    createdAt: time("created_at").notNull().defaultNow(),
    settledAt: time("settled_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.provider, t.operationId] }),
    foreignKey({
      name: "service_budget_operations_budget_fk",
      columns: [t.workspaceId, t.provider, t.budgetId],
      foreignColumns: [serviceBudgets.workspaceId, serviceBudgets.provider, serviceBudgets.id],
    }),
    check("service_budget_operations_provider", sql`${t.provider} in ('firecrawl','composio')`),
    check(
      "service_budget_operations_maximum_range",
      sql`${t.maximumUnits} between 1 and 9007199254740991`,
    ),
    check(
      "service_budget_operations_settlement",
      sql`(${t.actualUnits} is null and ${t.settledAt} is null)
        or (${t.actualUnits} between 0 and ${t.maximumUnits} and ${t.settledAt} is not null)`,
    ),
    index("service_budget_operations_budget").on(t.workspaceId, t.provider, t.budgetId),
  ],
).enableRLS();
