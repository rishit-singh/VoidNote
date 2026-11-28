import {
  type ConversationSummaryPolicy,
  conversationSummaryPolicySchema,
} from "../contracts/conversation-summaries";

export type ConversationSummaryPolicyEnvironment = {
  CONVERSATION_SUMMARY_ENABLED?: string;
  CONVERSATION_SUMMARY_MODEL?: string;
  CONVERSATION_SUMMARY_BUDGET_ID?: string;
  CONVERSATION_SUMMARY_RATE_VERSION_ID?: string;
};

export function readConversationSummaryPolicy(
  env: ConversationSummaryPolicyEnvironment,
): ConversationSummaryPolicy | null {
  if (env.CONVERSATION_SUMMARY_ENABLED !== "true") {
    return null;
  }

  const policy = conversationSummaryPolicySchema.safeParse({
    version: "conversation-summary-v1",
    promptVersion: "conversation-summary-v1",
    model: env.CONVERSATION_SUMMARY_MODEL?.trim(),
    budgetId: env.CONVERSATION_SUMMARY_BUDGET_ID,
    rateVersionId: env.CONVERSATION_SUMMARY_RATE_VERSION_ID,
  });

  return policy.success ? policy.data : null;
}

export function requireConversationSummaryPolicy(
  env: ConversationSummaryPolicyEnvironment,
  pinned: ConversationSummaryPolicy,
): void {
  const selected = readConversationSummaryPolicy(env);

  if (
    !selected ||
    selected.model !== pinned.model ||
    selected.budgetId !== pinned.budgetId ||
    selected.rateVersionId !== pinned.rateVersionId
  ) {
    throw new Error(
      "Conversation summary inference is disabled or its selected allowance changed.",
    );
  }
}
