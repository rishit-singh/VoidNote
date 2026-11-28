import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import type { ResearchRunExecutionKey } from "../../../contracts/research/runs";
import { executionTrace } from "../../../telemetry/execution";
import { type ResearchRunEnvironment, runResearchRun } from "./runtime";

/** Workflow retries recover persisted source/inference checkpoints; unknown
 * provider submissions remain fenced instead of being replayed. */
export class ResearchRunWorkflow extends WorkflowEntrypoint<
  ResearchRunEnvironment,
  ResearchRunExecutionKey
> {
  override async run(event: WorkflowEvent<ResearchRunExecutionKey>, step: WorkflowStep) {
    const key = event.payload;

    if (event.instanceId !== key.runId) {
      throw new Error("Research Workflow identity mismatch.");
    }

    return step.do(
      "research-run",
      {
        retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
        timeout: "20 minutes",
      },
      () =>
        executionTrace(
          this.env,
          {
            workspaceId: key.workspaceId,
            runId: key.runId,
          },
          "research.run.workflow",
          () => runResearchRun(this.env, key, AbortSignal.timeout(20 * 60_000)),
          {
            actorType: "workflow",
            policyVersion: "research-run-v1",
            stage: "workflow",
          },
        ),
    );
  }
}
