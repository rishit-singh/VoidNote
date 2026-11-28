import { createInferenceRepository } from "../../db/inference";
import { createResearchAgentOperationsRepository } from "../../db/research/agent-operations";
import { executionTrace } from "../../telemetry/execution";
import { observeScopedInferenceUsage, requestInferenceStreamUsage } from "../inference";
import { ResearchAgent as NativeResearchAgent } from "./agent";
import { createResearchAgentServices } from "./agent-services";
import { withResearchRunDatabase } from "./runs/environment";

export { researchAgentName } from "./agent";

type PendingUsage = {
  workspaceId: string;
  runId: string;
  requestId: string;
  inputTokens: number;
  outputTokens: number;
};

const usagePrefix = "research-usage:";

/** Worker composition; the native agent owns model/tool iteration. */
export class ResearchAgent extends NativeResearchAgent {
  protected override createServices() {
    const services = createResearchAgentServices(this.env);

    return {
      ...services,
      executeTool: (name, input, scope) =>
        executionTrace(
          this.env,
          { workspaceId: scope.workspaceId, runId: scope.runId },
          `research.agent.tool.${name}`,
          () => services.executeTool(name, input, scope),
          { actorType: "agent" },
        ),
      publishReport: (scope, input, operationId) =>
        executionTrace(
          this.env,
          { workspaceId: scope.workspaceId, runId: scope.runId },
          "research.agent.publish",
          () => services.publishReport(scope, input, operationId),
          { actorType: "agent" },
        ),
    } satisfies ReturnType<typeof createResearchAgentServices>;
  }

  override getAIBinding(): Ai {
    return observeScopedInferenceUsage(
      requestInferenceStreamUsage(super.getAIBinding()),
      () => this.currentResearchModelRequest(),
      async (scope, usage) => {
        const receipt: PendingUsage = {
          workspaceId: scope.workspaceId,
          runId: scope.runId,
          requestId: scope.requestId,
          ...usage,
        };

        await this.ctx.storage.put(`${usagePrefix}${scope.requestId}`, receipt);
        await this.schedule(60, "reconcileInferenceUsage");
        await executionTrace(
          this.env,
          { workspaceId: scope.workspaceId, runId: scope.runId },
          "research.agent.model.usage",
          () => this.reconcileInferenceUsage(),
          { ...usage, model: scope.policy.model },
        );
      },
    );
  }

  async reconcileInferenceUsage(): Promise<void> {
    const pending = await this.ctx.storage.list<PendingUsage>({ prefix: usagePrefix, limit: 20 });

    let deferred = false;

    for (const [storageKey, receipt] of pending) {
      try {
        await withResearchRunDatabase(this.env, async (db) => {
          const operations = createResearchAgentOperationsRepository(db);

          const key = {
            workspaceId: receipt.workspaceId,
            runId: receipt.runId,
            operationId: receipt.requestId,
          };

          const usage = {
            inputTokens: receipt.inputTokens,
            outputTokens: receipt.outputTokens,
          };

          await operations.complete(key, { result: { usageObserved: true }, usage });
          await createInferenceRepository(db).settle(receipt);
          await operations.markUsageSettled(key);
        });
        await this.ctx.storage.delete(storageKey);
      } catch {
        deferred = true;
      }
    }

    if (deferred || pending.size === 20) {
      await this.schedule(60, "reconcileInferenceUsage");
    }
  }
}
