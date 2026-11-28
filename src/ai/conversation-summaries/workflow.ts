import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { runConversationSummary } from "./execution";
import {
  type ConversationSummaryKey,
  conversationSummaryKeySchema,
  conversationSummaryWorkflowId,
} from "./identity";
import type { ConversationSummaryRuntime } from "./ports";
import { type ConversationSummaryEnvironment, createConversationSummaryRuntime } from "./runtime";

/** Uses the established single-request Workflow pattern rather than a chat DO:
 * no tools, native client submission, model retries, or auto-memory policies. */
export class ConversationSummaryWorkflow extends WorkflowEntrypoint<
  ConversationSummaryEnvironment,
  ConversationSummaryKey
> {
  protected createRuntime(): ConversationSummaryRuntime {
    return createConversationSummaryRuntime(this.env);
  }

  override async run(event: WorkflowEvent<ConversationSummaryKey>, step: WorkflowStep) {
    const key = conversationSummaryKeySchema.parse(event.payload);

    if (event.instanceId !== conversationSummaryWorkflowId(key)) {
      throw new Error("Conversation summary Workflow identity mismatch.");
    }

    return runConversationSummary(key, step, this.createRuntime());
  }
}
