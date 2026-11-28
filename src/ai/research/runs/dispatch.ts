import type { ResearchRunExecutionKey } from "../../../contracts/research/runs";
import { createInferenceRepository } from "../../../db/inference";
import { createResearchRunsRepository } from "../../../db/research/runs";
import { createServiceBudgetRepository } from "../../../db/service-budgets";
import {
  type ResearchRunEnvironment,
  withResearchRunDatabase as withJobDatabase,
} from "./environment";

type Binding = NonNullable<ResearchRunEnvironment["RESEARCH_RUN_WORKFLOW"]>;

/** Create/get always share the run's stable command identity. */
export async function dispatchResearchRun(
  env: ResearchRunEnvironment,
  key: ResearchRunExecutionKey,
  cancel = false,
) {
  const binding = env.RESEARCH_RUN_WORKFLOW;

  if (!binding) {
    throw new Error("Research Workflow binding is unavailable.");
  }

  const params = { workspaceId: key.workspaceId, runId: key.runId };

  if (cancel) {
    const instance = await binding.get(key.runId);

    const status = await instance.status();

    if (!["complete", "errored", "terminated"].includes(status.status)) {
      await instance.terminate();
    }

    return;
  }

  try {
    await binding.create({ id: key.runId, params });
  } catch {
    // The create acknowledgement can be lost. Existing instance status below is
    // authoritative; never invent another Workflow ID or operation identity.
  }

  const instance = await binding.get(key.runId);

  const status = await instance.status();

  if (status.status === "errored" || status.status === "terminated") {
    await withJobDatabase(env, async (db) => {
      await createResearchRunsRepository(db).finish(key, {
        status: "failed",
        error: "Research Workflow stopped. Uncertain paid operations were not replayed.",
      });
    });
  } else if (status.status === "complete") {
    const run = await withJobDatabase(env, (db) => createResearchRunsRepository(db).loadWork(key));

    if (run?.status === "running") {
      await withJobDatabase(env, (db) =>
        createResearchRunsRepository(db).finish(key, {
          status: "failed",
          error: "Workflow completed without a durably published report.",
        }),
      );
    }
  }
}

export async function reconcileResearchRuns(env: ResearchRunEnvironment, limit = 20) {
  const pending = await withJobDatabase(env, (db) =>
    createResearchRunsRepository(db).pendingDispatch(limit),
  );

  const settled = await withJobDatabase(env, (db) =>
    createResearchRunsRepository(db).pendingDiscoverySettlement(10),
  );

  const inferenceSettlements = await withJobDatabase(env, (db) =>
    createResearchRunsRepository(db).pendingInferenceSettlement(10),
  );

  const [dispatchResults, settlementResults, inferenceSettlementResults] = await Promise.all([
    Promise.allSettled(pending.map((key) => dispatchResearchRun(env, key))),
    Promise.allSettled(
      settled.map((operation) =>
        withJobDatabase(env, (db) =>
          createServiceBudgetRepository(db).settle({
            workspaceId: operation.workspaceId,
            provider: "firecrawl",
            operationId: operation.operationId,
            actualUnits: operation.creditsUsed!,
          }),
        ),
      ),
    ),
    Promise.allSettled(
      inferenceSettlements.map((operation) =>
        withJobDatabase(env, async (db) => {
          if (!operation.usage) {
            return;
          }

          await createInferenceRepository(db).settle({
            workspaceId: operation.workspaceId,
            requestId: operation.operationId,
            ...operation.usage,
          });
          await createResearchRunsRepository(db).settleQuestionInference(
            { workspaceId: operation.workspaceId, runId: operation.runId },
            operation.questionId,
          );
        }),
      ),
    ),
  ]);

  return {
    attempted: pending.length,
    deferred: dispatchResults.filter((result) => result.status === "rejected").length,
    settlementAttempted: settled.length,
    settlementDeferred: settlementResults.filter((result) => result.status === "rejected").length,
    inferenceSettlementAttempted: inferenceSettlements.length,
    inferenceSettlementDeferred: inferenceSettlementResults.filter(
      (result) => result.status === "rejected",
    ).length,
  };
}

export type ResearchRunWorkflowBinding = Pick<Binding, "create" | "get">;
