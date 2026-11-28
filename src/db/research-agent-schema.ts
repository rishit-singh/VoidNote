import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { researchRuns } from "./research-runs-schema";

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

export type ResearchAgentOperationState = "pending" | "submitted" | "completed" | "uncertain";

/** Durable identity and recovery receipt for one potentially paid agent operation. */
export const researchAgentOperations = pgTable(
  "research_agent_operations",
  {
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    kind: text("kind").$type<"model" | "tool">().notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    state: text("state").$type<ResearchAgentOperationState>().notNull().default("pending"),
    result: jsonb("result").$type<unknown>(),
    usage: jsonb("usage").$type<unknown>(),
    usageSettledAt: time("usage_settled_at"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.runId, t.operationId] }),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [researchRuns.workspaceId, researchRuns.id],
    }),
    check("research_agent_operations_kind", sql`${t.kind} in ('model','tool')`),
    check(
      "research_agent_operations_state",
      sql`${t.state} in ('pending','submitted','completed','uncertain')`,
    ),
    check(
      "research_agent_operations_payload_bound",
      sql`octet_length(${t.payload}::text) <= 50000`,
    ),
    check(
      "research_agent_operations_result_bound",
      sql`${t.result} is null or octet_length(${t.result}::text) <= 100000`,
    ),
    check(
      "research_agent_operations_usage_bound",
      sql`${t.usage} is null or octet_length(${t.usage}::text) <= 10000`,
    ),
    index("research_agent_operations_run").on(t.workspaceId, t.runId, t.createdAt),
  ],
).enableRLS();
