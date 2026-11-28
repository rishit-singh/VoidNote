import { z } from "zod";

import {
  SUMMARY_PROMPT_VERSION,
  SUMMARY_PROMPT_VERSIONS,
  SUMMARY_SCHEMA_VERSION,
} from "../../contracts/analysis";

// Explicit bounds for the first full-input proof. Oversize conversations fail
// before inference; chunked synthesis belongs to the following product slice.
export const summaryPolicySchema = z
  .object({
    version: z.literal("summary-proof-v1"),
    // Optional only for historical jobs and the isolated, separately bounded proof.
    budgetId: z.uuid().optional(),
    // Absent on historical jobs, which retain full-window admission.
    budgetAccounting: z.literal("request-usage-v1").optional(),
    reasoningEffort: z.enum(["none", "low"]).optional(),
    model: z
      .string()
      .regex(/^@cf\/[a-zA-Z0-9._/-]+$/)
      .max(200),
    promptVersion: z.enum(SUMMARY_PROMPT_VERSIONS),
    schemaVersion: z.literal(SUMMARY_SCHEMA_VERSION),
    maxContextBytes: z.number().int().min(1024).max(128_000),
    maxPassages: z.number().int().min(1).max(1000),
    maxOutputBytes: z.number().int().min(1024).max(256_000),
    maxSteps: z.number().int().min(1).max(6),
    maxOutputTokens: z.number().int().min(256).max(16_000),
    timeoutMs: z.number().int().min(1000).max(300_000),
    promptTimeoutMs: z.number().int().min(1000).max(600_000),
  })
  .strict();

export function summaryPolicy(model: string, budgetId?: string) {
  return summaryPolicySchema.parse({
    version: "summary-proof-v1",
    model,
    ...(budgetId ? { budgetId, budgetAccounting: "request-usage-v1" } : {}),
    reasoningEffort: "none",
    promptVersion: SUMMARY_PROMPT_VERSION,
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    maxContextBytes: 64_000,
    maxPassages: 1000,
    maxOutputBytes: 128_000,
    maxSteps: 1,
    maxOutputTokens: 8192,
    timeoutMs: 120_000,
    promptTimeoutMs: 180_000,
  });
}

export type SummaryPolicy = z.infer<typeof summaryPolicySchema>;
