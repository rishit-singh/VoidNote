import type { ResearchAgentRunKey } from "../../../contracts/research/execution";
import { createInferenceRepository } from "../../../db/inference";
import { createResearchAgentOperationsRepository } from "../../../db/research/agent-operations";
import { withResearchRunDatabase } from "../../../server/research/environment";
import { createOperations } from "../../../server/research/worker";
import { executionTrace } from "../../../telemetry/execution";
import { observeScopedInferenceUsage, requestInferenceStreamUsage } from "../../inference";
import { ResearchWorkflowAgent as NativeAgent } from "./agent";

type PendingUsage = {
  workspaceId: string;
  runId: string;
  requestId: string;
  inputTokens: number;
  outputTokens: number;
};

const usagePrefix = "research-workflow-usage:";

/** Worker binding composition: capture raw usage before settlement can fail. */
export class ResearchWorkflowAgent extends NativeAgent {
  async startResearch(key: ResearchAgentRunKey): Promise<string> {
    const execution = await createOperations(this.env).execution(key);

    if (execution.policy.executionVersion !== "research-workflow-v3") {
      throw new Error("Research execution belongs to another runtime.");
    }

    if (execution.status !== "queued" && execution.status !== "running") {
      return key.runId;
    }

    return this.runWorkflow("RESEARCH_INVESTIGATION_WORKFLOW", key, {
      id: key.runId,
      agentBinding: "RESEARCH_WORKFLOW_AGENT",
    });
  }

  async cancelResearch(): Promise<void> {
    const submissions = await this.listSubmissions({ limit: 20 });

    await Promise.all(
      submissions.map((submission) => this.cancelSubmission(submission.submissionId)),
    );
  }

  protected override observeResearchAIBinding(binding: Ai): Ai {
    return observeScopedInferenceUsage(
      requestInferenceStreamUsage(binding),
      () => this.currentResearchModelRequest(),
      async (scope, usage) => {
        const receipt: PendingUsage = {
          workspaceId: scope.workspaceId,
          runId: scope.runId,
          requestId: scope.requestId,
          ...usage,
        };

        await this.ctx.storage.put(`${usagePrefix}${receipt.requestId}`, receipt);
        await this.schedule(60, "reconcileInferenceUsage");
        await executionTrace(
          this.env,
          { workspaceId: scope.workspaceId, runId: scope.runId },
          "research.workflow.model.usage",
          () => this.reconcileInferenceUsage(),
          { ...usage, model: scope.policy.model, actorType: "agent" },
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

          await operations.complete(key, {
            result: { usageObserved: true },
            usage: { inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens },
          });
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
