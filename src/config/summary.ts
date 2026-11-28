import { type SummaryPolicy, summaryPolicy, summaryPolicySchema } from "../ai/runtime";

const summarySelectionSchema = summaryPolicySchema
  .pick({ model: true, budgetId: true, reasoningEffort: true })
  .required({ budgetId: true })
  .extend({
    reasoningEffort: summaryPolicySchema.shape.reasoningEffort.default("none"),
  });

export type SummaryPolicyEnvironment = {
  SUMMARY_ENABLED?: string;
  SUMMARY_MODEL?: string;
  SUMMARY_BUDGET_ID?: string;
  SUMMARY_REASONING_EFFORT?: string;
};

export function readSummaryPolicy(env: SummaryPolicyEnvironment): SummaryPolicy | null {
  if (env.SUMMARY_ENABLED !== "true") {
    return null;
  }

  const selection = summarySelectionSchema.safeParse({
    model: env.SUMMARY_MODEL,
    budgetId: env.SUMMARY_BUDGET_ID,
    reasoningEffort: env.SUMMARY_REASONING_EFFORT,
  });

  if (!selection.success) {
    return null;
  }

  return {
    ...summaryPolicy(selection.data.model, selection.data.budgetId),
    reasoningEffort: selection.data.reasoningEffort,
  };
}
