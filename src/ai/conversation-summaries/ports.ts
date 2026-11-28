import type {
  ConversationSummaryExecution,
  ConversationSummaryPolicy,
} from "../../contracts/conversation-summaries";
import type { InferenceUsage } from "../inference";
import type { ConversationSummaryKey } from "./identity";

export type ConversationSummaryGeneration = { text: string; rawUsage: InferenceUsage | null };

export type ConversationSummaryRuntime = {
  load(key: ConversationSummaryKey): Promise<ConversationSummaryExecution | null>;
  begin(key: ConversationSummaryKey): Promise<boolean>;
  publish(key: ConversationSummaryKey, text: string): Promise<void>;
  fail(key: ConversationSummaryKey, error: string): Promise<void>;
  requireEnabled(policy: ConversationSummaryPolicy): void;
  /** Non-idempotent ledger admission. An existing requestId MUST reject replay. */
  reserve(execution: ConversationSummaryExecution, inputTokenBound: number): Promise<void>;
  generate(execution: ConversationSummaryExecution): Promise<ConversationSummaryGeneration>;
  settle(key: ConversationSummaryKey, usage: InferenceUsage): Promise<void>;
};
