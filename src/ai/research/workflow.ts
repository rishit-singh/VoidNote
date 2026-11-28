import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { executionTrace } from "../../telemetry/execution";
import { researchExecutionKeySchema, researchWorkflowId } from "./identity";
import { runResearchItem } from "./pipeline";
import type { ResearchExecutionKey } from "./ports";
import {
  createResearchRuntime,
  readResearchExecutionOutcome,
  type ResearchEnvironment,
} from "./runtime";

/** Application-owned model extraction does not need a conversational Think DO.
 * Real Cloudflare Workflows own scheduling/retries; Postgres owns per-source and
 * per-fact checkpoints and refuses uncertain paid replay across step restarts. */
export class ResearchWorkflow extends WorkflowEntrypoint<
  ResearchEnvironment,
  ResearchExecutionKey
> {
  override async run(event: WorkflowEvent<ResearchExecutionKey>, step: WorkflowStep) {
    const key = researchExecutionKeySchema.parse(event.payload);

    if (event.instanceId !== researchWorkflowId(key)) {
      throw new Error("Research Workflow identity mismatch.");
    }

    await step.do(
      "research-person",
      {
        retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
        timeout: "20 minutes",
      },
      () =>
        executionTrace(this.env, key, "research.workflow", async () => {
          await runResearchItem(key, createResearchRuntime(this.env, key));

          return readResearchExecutionOutcome(this.env, key);
        }),
    );

    return { personId: key.personId, generation: key.generation };
  }
}
