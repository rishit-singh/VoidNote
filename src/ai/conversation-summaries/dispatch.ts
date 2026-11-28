import { readConversationSummaryPolicy } from "../../config/conversation-summary";
import { createConversationSummaryRepository } from "../../db/conversation-summaries";
import { withJobDatabase } from "../jobs";
import { reconcileConversationSummaryCheckpoint } from "./execution";
import { type ConversationSummaryKey, conversationSummaryWorkflowId } from "./identity";
import type { ConversationSummaryRuntime } from "./ports";
import { type ConversationSummaryEnvironment, createConversationSummaryRuntime } from "./runtime";

type DispatchRuntime = Pick<ConversationSummaryRuntime, "settle" | "publish" | "fail">;

/** Create/get always use the same ID. Recovery-only rows may inspect an existing
 * instance but never create one. Missing recovery evidence defers with its hold. */
export async function dispatchConversationSummary(
  binding: Pick<Workflow<ConversationSummaryKey>, "create" | "get">,
  key: ConversationSummaryKey,
  runtime: DispatchRuntime,
  recoveryOnly = false,
): Promise<void> {
  // Pending-scan metadata is not part of either native Workflow parameters or
  // the repository execution identity.
  const params: ConversationSummaryKey = {
    workspaceId: key.workspaceId,
    threadId: key.threadId,
    jobId: key.jobId,
  };

  const id = conversationSummaryWorkflowId(params);

  if (!recoveryOnly) {
    try {
      await binding.create({ id, params });
    } catch {
      // Get/status below distinguishes a duplicate from unavailable infrastructure.
    }
  }

  const instance = await binding.get(id);

  const status = await instance.status();

  if (status.status === "complete") {
    await reconcileConversationSummaryCheckpoint(params, status.output, runtime);
  } else if (status.status === "errored" || status.status === "terminated") {
    await runtime.fail(
      params,
      "Conversation summary runtime stopped. No paid request was restarted.",
    );
  }
}

export async function reconcileConversationSummaries(env: ConversationSummaryEnvironment) {
  const policy = readConversationSummaryPolicy(env);

  // Enqueue errors must not prevent recovery of already accepted work.
  let enqueueDeferred = false;

  if (policy) {
    try {
      await withJobDatabase(env, (db) =>
        createConversationSummaryRepository(db).enqueueIdle(policy, 10),
      );
    } catch {
      enqueueDeferred = true;
    }
  }

  const pending: Array<ConversationSummaryKey & { recoveryOnly?: true }> = await withJobDatabase(
    env,
    (db) => createConversationSummaryRepository(db).pending(20),
  );

  const runtime = createConversationSummaryRuntime(env);

  const results = await Promise.allSettled(
    pending.map((key) =>
      dispatchConversationSummary(
        env.CONVERSATION_SUMMARY_WORKFLOW,
        key,
        runtime,
        key.recoveryOnly ?? false,
      ),
    ),
  );

  return {
    attempted: pending.length,
    deferred: results.filter((result) => result.status === "rejected").length,
    enqueueDeferred,
  };
}
