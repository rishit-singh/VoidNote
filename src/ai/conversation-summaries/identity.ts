import { z } from "zod";

export const conversationSummaryKeySchema = z
  .object({
    workspaceId: z.uuid(),
    threadId: z.uuid(),
    jobId: z.uuid(),
  })
  .strict();

export type ConversationSummaryKey = z.infer<typeof conversationSummaryKeySchema>;

export function conversationSummaryWorkflowId(key: ConversationSummaryKey): string {
  // Job UUID is globally stable; workspace + job fit the native 100-char ID bound.
  return `conversation-summary-${key.workspaceId}-${key.jobId}`;
}
