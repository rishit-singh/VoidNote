import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { workspaces } from "./schema";

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });
const money = (name: string) => bigint(name, { mode: "number" });

// Migration must install a BEFORE UPDATE OR DELETE immutability trigger.
export const inferenceRates = pgTable(
  "inference_rates",
  {
    id: uuid("id").primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    currency: text("currency").$type<"USD">().notNull(),
    inputMicroUsdPerMillionTokens: money("input_micro_usd_per_million_tokens").notNull(),
    outputMicroUsdPerMillionTokens: money("output_micro_usd_per_million_tokens").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("inference_rates_model_identity").on(t.id, t.model),
    check("inference_rates_provider", sql`length(${t.provider}) between 1 and 128`),
    check("inference_rates_model", sql`length(${t.model}) between 1 and 256`),
    check("inference_rates_currency", sql`${t.currency} = 'USD'`),
    check(
      "inference_rates_input_range",
      sql`${t.inputMicroUsdPerMillionTokens} between 0 and 9007199254740991`,
    ),
    check(
      "inference_rates_output_range",
      sql`${t.outputMicroUsdPerMillionTokens} between 0 and 9007199254740991`,
    ),
  ],
).enableRLS();

// Only explicit administrative approval creates a budget. No runtime creation,
// top-up, transfer, or automatic expiry/release of uncertain holds.
export const inferenceBudgets = pgTable(
  "inference_budgets",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    id: uuid("id").notNull(),
    rateVersionId: uuid("rate_version_id")
      .notNull()
      .references(() => inferenceRates.id),
    limitMicroUsd: money("limit_micro_usd").notNull(),
    reservedMicroUsd: money("reserved_micro_usd").notNull().default(0),
    settledMicroUsd: money("settled_micro_usd").notNull().default(0),
    approvedAt: time("approved_at").notNull(),
    revokedAt: time("revoked_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    unique("inference_budgets_rate_identity").on(t.workspaceId, t.id, t.rateVersionId),
    check("inference_budgets_limit_range", sql`${t.limitMicroUsd} between 0 and 9007199254740991`),
    check(
      "inference_budgets_reserved_range",
      sql`${t.reservedMicroUsd} between 0 and 9007199254740991`,
    ),
    check(
      "inference_budgets_settled_range",
      sql`${t.settledMicroUsd} between 0 and 9007199254740991`,
    ),
  ],
).enableRLS();

// Permanent even after settlement. Migration must prohibit deletion, identity
// changes, and rewriting settled usage; only held → settled may update a receipt.
export const inferenceReceipts = pgTable(
  "inference_receipts",
  {
    workspaceId: uuid("workspace_id").notNull(),
    requestId: uuid("request_id").notNull(),
    budgetId: uuid("budget_id").notNull(),
    rateVersionId: uuid("rate_version_id").notNull(),
    model: text("model").notNull(),
    inputTokenBound: integer("input_token_bound").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    reservedMicroUsd: money("reserved_micro_usd").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    actualMicroUsd: money("actual_micro_usd"),
    createdAt: time("created_at").notNull().defaultNow(),
    settledAt: time("settled_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.requestId] }),
    foreignKey({
      name: "inference_receipts_budget_fk",
      columns: [t.workspaceId, t.budgetId, t.rateVersionId],
      foreignColumns: [
        inferenceBudgets.workspaceId,
        inferenceBudgets.id,
        inferenceBudgets.rateVersionId,
      ],
    }),
    foreignKey({
      name: "inference_receipts_rate_model_fk",
      columns: [t.rateVersionId, t.model],
      foreignColumns: [inferenceRates.id, inferenceRates.model],
    }),
    check("inference_receipts_model", sql`length(${t.model}) between 1 and 256`),
    check("inference_receipts_input_bound", sql`${t.inputTokenBound} >= 0`),
    check("inference_receipts_output_bound", sql`${t.maxOutputTokens} >= 0`),
    check(
      "inference_receipts_reserved_range",
      sql`${t.reservedMicroUsd} between 0 and 9007199254740991`,
    ),
    check(
      "inference_receipts_settlement",
      sql`(
        ${t.settledAt} is null and ${t.inputTokens} is null
        and ${t.outputTokens} is null and ${t.actualMicroUsd} is null
      ) or (
        ${t.settledAt} is not null and ${t.inputTokens} is not null
        and ${t.outputTokens} is not null and ${t.actualMicroUsd} is not null
        and ${t.inputTokens} >= 0 and ${t.outputTokens} >= 0
        and ${t.actualMicroUsd} between 0 and 9007199254740991
      )`,
    ),
    index("inference_receipts_budget").on(t.workspaceId, t.budgetId),
  ],
).enableRLS();
