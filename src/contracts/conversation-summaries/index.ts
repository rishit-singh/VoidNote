import { z } from "zod";

import { assistantSourceSchema } from "../assistant/index.ts";
export { buildConversationSummaryPrompt, measureConversationSummaryPrompt } from "./prompt.ts";

export const conversationSummaryScopeSchema = z
  .object({
    workspaceId: z.uuid(),
    threadId: z.uuid(),
  })
  .strict();

export const conversationSummarySchema = z.object({
  id: z.uuid(),
  threadId: z.uuid(),
  status: z.enum(["queued", "running", "succeeded", "failed", "stale"]),
  fromSequence: z.number().int().positive(),
  throughSequence: z.number().int().positive(),
  messageCount: z.number().int().positive(),
  text: z.string().max(8000).nullable(),
  sources: z.array(assistantSourceSchema).max(100),
  error: z.string().max(1000).nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationSummaryPolicySchema = z.object({
  version: z.literal("conversation-summary-v1"),
  promptVersion: z.literal("conversation-summary-v1"),
  model: z.string().min(1).max(200),
  budgetId: z.uuid(),
  rateVersionId: z.uuid(),
  idleMs: z.literal(300_000).default(300_000),
  minNewMessages: z.literal(20).default(20),
  maxMessages: z.number().int().min(20).max(100).default(50),
  maxInputBytes: z.number().int().min(4000).max(128_000).default(64_000),
  maxOutputTokens: z.number().int().min(256).max(4096).default(1536),
});

export type ConversationSummaryPolicy = z.infer<typeof conversationSummaryPolicySchema>;

export type ConversationSummaryExecution = {
  workspaceId: string;
  threadId: string;
  jobId: string;
  policy: ConversationSummaryPolicy;
  messages: Array<{ id: string; role: "user" | "assistant"; text: string }>;
  sources: z.infer<typeof assistantSourceSchema>[];
};
