import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import type {
  ConversationSummaryExecution,
  ConversationSummaryPolicy,
} from "../../contracts/conversation-summaries";
import { type InferenceUsage, observeInferenceUsage } from "../inference";
import type { ConversationSummaryGeneration } from "./ports";
import { conversationSummaryPrompt } from "./prompt";

const modelTimeoutMs = 90_000;

/** A single, tool-free Workers AI request. Usage is captured at the raw binding,
 * before the provider or AI SDK can fill absent counters with zero. */
export function createConversationSummaryModel(
  binding: Ai,
  requireEnabled: (policy: ConversationSummaryPolicy) => void = () => {
    throw new Error("Conversation summary inference is disabled.");
  },
) {
  return async (
    execution: ConversationSummaryExecution,
  ): Promise<ConversationSummaryGeneration> => {
    requireEnabled(execution.policy);
    const { system, prompt } = conversationSummaryPrompt(execution);

    let rawUsage: InferenceUsage | null = null;

    const guarded = new Proxy(binding, {
      get(target, property) {
        if (property === "run") {
          return (...args: Parameters<Ai["run"]>) => {
            requireEnabled(execution.policy);

            return Reflect.apply(target.run.bind(target), target, args);
          };
        }

        const value: unknown = Reflect.get(target, property, target);

        return typeof value === "function" ? (value.bind(target) as unknown) : value;
      },
    });

    const observed = observeInferenceUsage(guarded, (usage) => {
      rawUsage = usage;
    });

    const provider = createWorkersAI({ binding: observed });

    try {
      const result = await generateText({
        model: provider(execution.policy.model),
        system,
        prompt,
        maxOutputTokens: execution.policy.maxOutputTokens,
        // Protocol policy pinned by conversation-summary-v1: reserve the output
        // allowance for the derived summary, not hidden model reasoning.
        providerOptions: { "workers-ai": { reasoning_effort: "none" } },
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(modelTimeoutMs),
      });

      // Preserve invalid-output evidence without checkpointing unbounded text.
      // Validation follows usage settlement so known charges are never lost.
      return { text: result.text.trim().slice(0, 8001), rawUsage };
    } catch (error) {
      if (rawUsage) {
        return { text: "", rawUsage };
      }

      throw error;
    }
  };
}
