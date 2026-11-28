import { createAssistantRepository } from "../db/assistant";
import { createInferenceRepository } from "../db/inference";
import { executionTrace, tracedOperations } from "../telemetry/execution";
import { AssistantAgent as AssistantRuntime, assistantAgentName } from "./assistant";
import { createAssistantServices } from "./assistant-services";
import { observeScopedInferenceUsage, requestInferenceStreamUsage } from "./inference";
import { withJobDatabase } from "./jobs";

type PendingUsage = {
  workspaceId: string;
  requestId: string;
  inputTokens: number;
  outputTokens: number;
};

const usagePrefix = "assistant-usage:";

/** Cloudflare composition root. The runtime only depends on application ports. */
export class AssistantAgent extends AssistantRuntime {
  protected override createServices() {
    const services = createAssistantServices(this.env);
    const scope = this.state.scope;
    const turnId = this.state.active?.turnId;

    return scope && turnId
      ? tracedOperations(
          this.env,
          { workspaceId: scope.workspaceId, turnId },
          "assistant.persistence",
          services,
        )
      : services;
  }

  override getAIBinding(): Ai {
    return observeScopedInferenceUsage(
      requestInferenceStreamUsage(super.getAIBinding()),
      () => this.currentAssistantModelRequest(),
      async (scope, usage) => {
        const receipt: PendingUsage = {
          workspaceId: scope.workspaceId,
          requestId: scope.requestId,
          ...usage,
        };

        // Never discard complete provider evidence just because SQL is unavailable.
        await this.ctx.storage.put(`${usagePrefix}${scope.requestId}`, receipt);
        await this.schedule(60, "reconcileInferenceUsage");
        await executionTrace(
          this.env,
          scope,
          "assistant.model.usage",
          () => this.reconcileInferenceUsage(),
          { ...usage, model: scope.policy.model },
        );
      },
    );
  }

  async reconcileInferenceUsage(): Promise<void> {
    const pending = await this.ctx.storage.list<PendingUsage>({ prefix: usagePrefix, limit: 20 });
    let deferred = false;

    for (const [key, receipt] of pending) {
      try {
        await executionTrace(this.env, receipt, "assistant.inference-budget.settle", () =>
          withJobDatabase(this.env, (db) => createInferenceRepository(db).settle(receipt)),
        );
        await this.ctx.storage.delete(key);
      } catch {
        deferred = true;
      }
    }

    if (deferred || pending.size === 20) {
      await this.schedule(60, "reconcileInferenceUsage");
    }
  }
}

export async function dispatchAssistantOutbox(
  env: Pick<Cloudflare.Env, "HYPERDRIVE" | "ASSISTANT_AGENT" | "ASSISTANT_ENABLED">,
) {
  const pending = await withJobDatabase(env, (db) =>
    createAssistantRepository(db).pendingTurns(20),
  );

  for (const item of pending) {
    try {
      const execution = await withJobDatabase(env, (db) =>
        createAssistantRepository(db).execution(item.workspaceId, item.turnId),
      );

      if (!execution) {
        continue;
      }

      const agent = env.ASSISTANT_AGENT.get(
        env.ASSISTANT_AGENT.idFromName(
          assistantAgentName({ workspaceId: item.workspaceId, threadId: execution.thread.id }),
        ),
      );

      if (item.status === "cancelled") {
        await agent.cancelTurn({ workspaceId: item.workspaceId, turnId: item.turnId });
        await withJobDatabase(env, (db) =>
          createAssistantRepository(db).acknowledgeCancellation(item.workspaceId, item.turnId),
        );
      } else if (env.ASSISTANT_ENABLED === "true") {
        await agent.startTurn({ workspaceId: item.workspaceId, turnId: item.turnId });
      } else {
        // Export/cleanup remains recoverable even while new inference is disabled.
        await agent.retryExport({ workspaceId: item.workspaceId, turnId: item.turnId });
      }
    } catch {
      console.warn("assistant.dispatch.deferred", {
        workspaceId: item.workspaceId,
        turnId: item.turnId,
      });
    }
  }
}
