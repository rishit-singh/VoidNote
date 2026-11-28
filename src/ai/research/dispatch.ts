import { createInferenceRepository } from "../../db/inference";
import { createResearchRepository } from "../../db/research";
import { withJobDatabase } from "../jobs";
import { researchWorkflowId } from "./identity";
import type { ResearchExecutionKey } from "./ports";
import type { ResearchEnvironment } from "./runtime";

type ResearchDispatchEnvironment = Pick<ResearchEnvironment, "HYPERDRIVE" | "RESEARCH_WORKFLOW">;

export async function dispatchResearchItem(
  env: ResearchDispatchEnvironment,
  key: ResearchExecutionKey,
  cancel = false,
) {
  const id = researchWorkflowId(key);

  if (cancel) {
    // An absent instance is made terminal too, fencing delayed original dispatch.
    // create is idempotent by Workflow ID; a failed create is reconciled by get.
    try {
      await env.RESEARCH_WORKFLOW.create({ id, params: key });
    } catch {
      /* inspect existing below */
    }

    const instance = await env.RESEARCH_WORKFLOW.get(id);

    const status = await instance.status();

    if (!["complete", "errored", "terminated"].includes(status.status)) {
      await instance.terminate();
    }

    await withJobDatabase(env, (db) => createResearchRepository(db).acknowledgeCleanup(key));

    return;
  }

  try {
    await env.RESEARCH_WORKFLOW.create({ id, params: key });
  } catch {
    // A lost create acknowledgement is not an instruction to invent a new ID.
    const instance = await env.RESEARCH_WORKFLOW.get(id);

    const status = await instance.status();

    if (["errored", "terminated", "complete"].includes(status.status)) {
      await withJobDatabase(env, async (db) => {
        const repo = createResearchRepository(db);

        const execution = await repo.execution.load(key);

        if (!execution) {
          return;
        }

        const uncertain = execution.facts.some((fact) => fact.state === "started");

        await repo.execution.finish(
          key,
          uncertain ? "needs-input" : "failed",
          uncertain
            ? "The runtime stopped with an uncertain extraction. Its paid request will not be replayed."
            : "The runtime stopped before completing this item. Completed checkpoints are retained.",
        );
      });
    }
  }
}

/** Register with the existing scheduled reconciler. The scan rotates attempts
 * before I/O, including cancellations; waitUntil notification is only a hint. */
export async function reconcileResearch(env: ResearchDispatchEnvironment, limit = 20) {
  const pending = await withJobDatabase(env, (db) =>
    createResearchRepository(db).pendingDispatch(limit),
  );

  const results = await Promise.allSettled(
    pending.map((key) => dispatchResearchItem(env, key, key.status === "cancelled")),
  );

  const usage = await withJobDatabase(env, (db) => createResearchRepository(db).pendingUsage(5));

  // A terminal/cancelled item can still own known usage awaiting settlement.
  // This path never invokes a model or releases an uncertain hold.
  const settlements = await Promise.allSettled(
    usage.map(async (receipt) => {
      await withJobDatabase(env, async (db) => {
        await createInferenceRepository(db).settle({
          workspaceId: receipt.workspaceId,
          requestId: receipt.operationId,
          ...receipt.usage,
        });
        await createResearchRepository(db).execution.markSettled(receipt, receipt.factKey);
      });
    }),
  );

  return {
    attempted: pending.length,
    deferred: results.filter((result) => result.status === "rejected").length,
    usageAttempted: usage.length,
    usageDeferred: settlements.filter((result) => result.status === "rejected").length,
  };
}
