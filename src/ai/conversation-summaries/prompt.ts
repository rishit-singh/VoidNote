import {
  buildConversationSummaryPrompt,
  type ConversationSummaryExecution,
  conversationSummaryPolicySchema,
} from "../../contracts/conversation-summaries";
import { inferenceInputTokenBound } from "../inference";

const framingTokenBound = 2048;

export function conversationSummaryPrompt(execution: ConversationSummaryExecution) {
  const policy = conversationSummaryPolicySchema.parse(execution.policy);

  if (!execution.messages.length || execution.messages.length > policy.maxMessages) {
    throw new Error("Conversation summary message range exceeds its admitted bound.");
  }

  const { system, prompt, inputBytes } = buildConversationSummaryPrompt(execution);

  if (inputBytes > policy.maxInputBytes) {
    throw new Error("Conversation summary input exceeds its admitted byte bound.");
  }

  const inputTokenBound = inferenceInputTokenBound(
    { prompt: { system, prompt } },
    {
      maxInputTokens: policy.maxInputBytes + framingTokenBound,
      maxOutputTokens: policy.maxOutputTokens,
      contextWindowTokens: policy.maxInputBytes + framingTokenBound + policy.maxOutputTokens,
    },
  );

  return { system, prompt, inputTokenBound };
}
