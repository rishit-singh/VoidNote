import {
  type ConversationSummaryPolicyEnvironment,
  requireConversationSummaryPolicy,
} from "../../config/conversation-summary";
import { createConversationSummaryRepository } from "../../db/conversation-summaries";
import { createInferenceRepository } from "../../db/inference";
import { withJobDatabase } from "../jobs";
import { createConversationSummaryModel } from "./model";
import type { ConversationSummaryRuntime } from "./ports";

export type ConversationSummaryEnvironment = ConversationSummaryPolicyEnvironment &
  Pick<Cloudflare.Env, "AI" | "HYPERDRIVE" | "CONVERSATION_SUMMARY_WORKFLOW">;

export function createConversationSummaryRuntime(
  env: ConversationSummaryEnvironment,
): ConversationSummaryRuntime {
  const repository = <T>(
    work: (repo: ReturnType<typeof createConversationSummaryRepository>) => Promise<T>,
  ) => withJobDatabase(env, (db) => work(createConversationSummaryRepository(db)));

  const requireEnabled: ConversationSummaryRuntime["requireEnabled"] = (policy) =>
    requireConversationSummaryPolicy(env, policy);

  return {
    load: (key) => repository((repo) => repo.load(key)),
    begin: (key) => repository((repo) => repo.begin(key)),
    publish: (key, text) => repository((repo) => repo.publish(key, text)),
    fail: (key, error) => repository((repo) => repo.fail(key, error)),
    requireEnabled,
    generate: createConversationSummaryModel(env.AI, requireEnabled),
    async reserve(execution, inputTokenBound) {
      requireEnabled(execution.policy);
      await withJobDatabase(env, async (db) => {
        const ledger = createInferenceRepository(db);

        const rate = await ledger.getRate(execution.policy.rateVersionId);

        if (!rate || rate.provider !== "workers-ai" || rate.model !== execution.policy.model) {
          throw new Error("Conversation summary rate does not match its pinned provider/model.");
        }

        requireEnabled(execution.policy);
        await ledger.reserve({
          workspaceId: execution.workspaceId,
          requestId: execution.jobId,
          budgetId: execution.policy.budgetId,
          rateVersionId: execution.policy.rateVersionId,
          model: execution.policy.model,
          inputTokenBound,
          maxOutputTokens: execution.policy.maxOutputTokens,
        });
      });
    },
    async settle(key, usage) {
      await withJobDatabase(env, (db) =>
        createInferenceRepository(db)
          .settle({
            workspaceId: key.workspaceId,
            requestId: key.jobId,
            ...usage,
          })
          .then(() => undefined),
      );
    },
  };
}
