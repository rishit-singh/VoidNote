import { z } from "zod";

import { createInferenceRepository } from "../../db/inference";
import { createResearchAgentOperationsRepository } from "../../db/research/agent-operations";
import { createServiceBudgetRepository } from "../../db/service-budgets";
import { type ResearchRunEnvironment, withResearchRunDatabase } from "./runs/environment";

const inferenceUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

const searchUsage = z.object({
  provider: z.literal("firecrawl"),
  creditsUsed: z.number().int().nonnegative(),
});

/** Reconcile saved provider evidence only; this never repeats provider calls. */
export async function settleResearchAgentOperations(env: ResearchRunEnvironment) {
  const pending = await withResearchRunDatabase(env, (db) =>
    createResearchAgentOperationsRepository(db).pendingSettlement(20),
  );

  const results = await Promise.allSettled(
    pending.map((operation) =>
      withResearchRunDatabase(env, async (db) => {
        if (operation.kind === "model") {
          const usage = inferenceUsage.parse(operation.usage);

          await createInferenceRepository(db).settle({
            workspaceId: operation.workspaceId,
            requestId: operation.operationId,
            ...usage,
          });
        } else {
          const usage = searchUsage.parse(operation.usage);

          await createServiceBudgetRepository(db).settle({
            workspaceId: operation.workspaceId,
            operationId: operation.operationId,
            provider: usage.provider,
            actualUnits: usage.creditsUsed,
          });
        }

        await createResearchAgentOperationsRepository(db).markUsageSettled(operation);
      }),
    ),
  );

  return {
    attempted: pending.length,
    deferred: results.filter((result) => result.status === "rejected").length,
  };
}
