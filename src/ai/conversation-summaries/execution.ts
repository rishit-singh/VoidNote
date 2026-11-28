import type { WorkflowStep } from "cloudflare:workers";
import { z } from "zod";

import { conversationSummaryPolicySchema } from "../../contracts/conversation-summaries";
import { INFERENCE_MAX_TOKENS } from "../inference";
import { type ConversationSummaryKey, conversationSummaryKeySchema } from "./identity";
import type { ConversationSummaryRuntime } from "./ports";
import { conversationSummaryPrompt } from "./prompt";

const generationSchema = z.object({
  text: z.string().max(8001),
  rawUsage: z
    .object({
      inputTokens: z.number().int().min(0).max(INFERENCE_MAX_TOKENS),
      outputTokens: z.number().int().min(0).max(INFERENCE_MAX_TOKENS),
    })
    .nullable(),
});

export const conversationSummaryCheckpointSchema = z
  .object({
    version: z.literal(1),
    key: conversationSummaryKeySchema,
    status: z.enum(["succeeded", "pending", "rejected"]),
    generation: generationSchema.nullable(),
    error: z.string().max(1000).nullable(),
  })
  .strict();

export type ConversationSummaryCheckpoint = z.infer<typeof conversationSummaryCheckpointSchema>;

const retryPersistence = {
  retries: { limit: 3, delay: "1 second", backoff: "exponential" },
  timeout: "1 minute",
} as const;

const interruptedMessage =
  "Conversation summary generation failed or was interrupted. Its paid request was not retried.";

const invalidOutputMessage = "Conversation summary output was empty or exceeded its length limit.";

const sourceChangedMessage =
  "Conversation summary sources or access changed before publication. No inference was retried.";

export function permanentConversationSummaryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["conflict", "not_found", "forbidden", "command_reused"].includes(String(error.code))
  );
}

function validText(text: string) {
  return text.trim().length > 0 && text.length <= 8000;
}

export async function runConversationSummary(
  key: ConversationSummaryKey,
  step: Pick<WorkflowStep, "do">,
  runtime: ConversationSummaryRuntime,
): Promise<ConversationSummaryCheckpoint> {
  const checkpoint: ConversationSummaryCheckpoint = {
    version: 1,
    key,
    status: "pending",
    generation: null,
    error: null,
  };

  try {
    checkpoint.generation = generationSchema.parse(
      await step.do(
        "generate-conversation-summary-once",
        { retries: { limit: 0, delay: "1 second" }, timeout: "3 minutes" },
        async () => {
          const execution = await runtime.load(key);

          if (
            !execution ||
            execution.workspaceId !== key.workspaceId ||
            execution.threadId !== key.threadId ||
            execution.jobId !== key.jobId
          ) {
            throw new Error("Conversation summary execution is unavailable.");
          }

          const policy = conversationSummaryPolicySchema.parse(execution.policy);

          runtime.requireEnabled(policy);
          const { inputTokenBound } = conversationSummaryPrompt(execution);

          if (!(await runtime.begin(key))) {
            throw new Error("Conversation summary was already claimed.");
          }

          runtime.requireEnabled(policy);
          // This non-idempotent reserve must stay INSIDE the generation callback.
          // Cached step output bypasses it; a replayed callback must hit the ledger
          // again and be rejected, even if the model ran but checkpointing failed.
          await runtime.reserve(execution, inputTokenBound);
          runtime.requireEnabled(policy);

          return runtime.generate(execution);
        },
      ),
    );
  } catch {
    checkpoint.status = "rejected";
    checkpoint.error = interruptedMessage;
  }

  if (checkpoint.generation?.rawUsage) {
    try {
      const usage = checkpoint.generation.rawUsage;

      await step.do("settle-conversation-summary-usage", retryPersistence, () =>
        runtime.settle(key, usage),
      );
    } catch {
      // Workflow output retains the exact generation + raw receipt. Scheduled
      // reconciliation retries settlement/publication without entering a model.
      return checkpoint;
    }
  }

  if (checkpoint.generation && !validText(checkpoint.generation.text)) {
    checkpoint.status = "rejected";
    checkpoint.error = invalidOutputMessage;
  }

  if (checkpoint.status !== "rejected" && checkpoint.generation) {
    try {
      const text = checkpoint.generation.text;

      const publication = await step.do(
        "publish-conversation-summary",
        retryPersistence,
        async () => {
          try {
            await runtime.publish(key, text);

            return { status: "succeeded" as const, error: null };
          } catch (error) {
            if (permanentConversationSummaryError(error)) {
              // Checkpoint the rejection before trying its terminal SQL write.
              return { status: "rejected" as const, error: sourceChangedMessage };
            }

            throw error;
          }
        },
      );

      checkpoint.status = publication.status;
      checkpoint.error = publication.error;
    } catch {
      return checkpoint;
    }
  }

  if (checkpoint.status === "rejected") {
    try {
      await step.do("fail-conversation-summary", retryPersistence, () =>
        runtime.fail(key, checkpoint.error ?? interruptedMessage),
      );
    } catch {
      // Preserve the rejection in Workflow output; reconciliation retries only
      // fail(), never the rejected publication or its paid generation.
    }
  }

  return checkpoint;
}

/** Terminal Workflow reconciliation consumes only bounded native output. It
 * never calls begin, reserve, generate, restart, or any memory operation. */
export async function reconcileConversationSummaryCheckpoint(
  key: ConversationSummaryKey,
  output: unknown,
  runtime: Pick<ConversationSummaryRuntime, "settle" | "publish" | "fail">,
): Promise<void> {
  const parsed = conversationSummaryCheckpointSchema.safeParse(output);

  if (
    !parsed.success ||
    parsed.data.key.workspaceId !== key.workspaceId ||
    parsed.data.key.threadId !== key.threadId ||
    parsed.data.key.jobId !== key.jobId
  ) {
    await runtime.fail(key, interruptedMessage);

    return;
  }

  const checkpoint = parsed.data;

  if (checkpoint.generation?.rawUsage) {
    await runtime.settle(key, checkpoint.generation.rawUsage);
  }

  if (checkpoint.status === "rejected" || !checkpoint.generation) {
    await runtime.fail(key, checkpoint.error ?? interruptedMessage);

    return;
  }

  if (!validText(checkpoint.generation.text)) {
    await runtime.fail(key, invalidOutputMessage);

    return;
  }

  try {
    await runtime.publish(key, checkpoint.generation.text);
  } catch (error) {
    if (!permanentConversationSummaryError(error)) {
      throw error;
    }

    await runtime.fail(key, sourceChangedMessage);
  }
}
