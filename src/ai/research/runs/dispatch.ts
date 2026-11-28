import { researchRunPolicySchema } from "../../../config/research-runs";
import type { ResearchRunExecutionKey } from "../../../contracts/research/runs";
import { createInferenceRepository } from "../../../db/inference";
import { createResearchRunsRepository } from "../../../db/research/runs";
import { createServiceBudgetRepository } from "../../../db/service-budgets";
import { researchAgentName } from "../agent-identity";
import { settleResearchAgentOperations } from "../agent-settlement";
import {
  type ResearchRunEnvironment,
  withResearchRunDatabase as withJobDatabase,
} from "./environment";

type Binding = NonNullable<ResearchRunEnvironment["RESEARCH_RUN_WORKFLOW"]>;

async function terminateWorkflowIfPresent(binding: Binding, runId: string) {
  let instance: Awaited<ReturnType<Binding["get"]>>;

  try {
    instance = await binding.get(runId);
  } catch (error) {
    if (error instanceof Error && error.message === "instance.not_found") {
      return;
    }

    throw error;
  }

  const status = await instance.status();

  if (!["complete", "errored", "terminated"].includes(status.status)) {
    await instance.terminate();
  }
}

/** Create/get always share the run's stable command identity. */
export async function dispatchResearchRun(
  env: ResearchRunEnvironment,
  key: ResearchRunExecutionKey,
  cancel = false,
) {
  const work = await withJobDatabase(env, (db) => createResearchRunsRepository(db).loadWork(key));

  if (!work) {
    return;
  }

  if (researchRunPolicySchema.parse(work.policy).executionVersion === "research-workflow-v3") {
    if (!env.RESEARCH_WORKFLOW_AGENT || !env.RESEARCH_INVESTIGATION_WORKFLOW) {
      throw new Error("Research investigation bindings are unavailable.");
    }

    const { getAgentByName } = await import("agents");

    const agent = await getAgentByName(env.RESEARCH_WORKFLOW_AGENT, researchAgentName(key));

    if (cancel || work.status === "cancelled") {
      await agent.cancelResearch();
      await terminateWorkflowIfPresent(env.RESEARCH_INVESTIGATION_WORKFLOW, key.runId);

      return;
    }

    if (env.RESEARCH_AGENT_ENABLED !== "true") {
      return;
    }

    try {
      await agent.startResearch(key);
    } catch {
      // A lost create response is reconciled against the same instance below.
    }

    const instance = await env.RESEARCH_INVESTIGATION_WORKFLOW.get(key.runId);

    const status = await instance.status();

    if (["errored", "terminated"].includes(status.status)) {
      await withJobDatabase(env, (db) =>
        createResearchRunsRepository(db).finish(key, {
          status: "failed",
          error: "Research investigation stopped before publication.",
        }),
      );
    } else if (status.status === "complete") {
      const run = await withJobDatabase(env, (db) =>
        createResearchRunsRepository(db).loadWork(key),
      );

      if (run?.status === "running") {
        await withJobDatabase(env, (db) =>
          createResearchRunsRepository(db).finish(key, {
            status: "failed",
            error: "Research investigation completed without a durably published report.",
          }),
        );
      }
    }

    return;
  }

  if (researchRunPolicySchema.parse(work.policy).executionVersion === "research-agent-v2") {
    if (!env.RESEARCH_AGENT) {
      throw new Error("Research Agent binding is unavailable.");
    }

    const agent = env.RESEARCH_AGENT.get(env.RESEARCH_AGENT.idFromName(researchAgentName(key)));

    if (cancel || work.status === "cancelled") {
      await agent.cancelResearchRun(key);
    } else if (env.RESEARCH_AGENT_ENABLED === "true") {
      await agent.startResearchRun(key);
    } else {
      await agent.reconcileResearchPublication();
    }

    return;
  }

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
  const agentSettlement = await settleResearchAgentOperations(env);

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
    agentSettlement,
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
