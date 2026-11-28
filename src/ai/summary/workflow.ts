import type { ThinkWorkflowStep } from "@cloudflare/think/workflows";
import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent, DefaultProgress } from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";

import { WorkspaceError } from "../../contracts/workspace";
import { summaryTrace } from "../../telemetry/summary";
import { summaryPolicySchema } from "../runtime";
import type { SummaryAgent, SummaryEnvironment } from "./agent";
import type { SummaryWorkflowParams } from "./dispatch";
import { summaryAgentName, summaryExecutionName, summaryWorkflowParamsSchema } from "./dispatch";
import { summaryPublicationFailureMessage } from "./failure";
import { summaryModelOutputSchema, SummaryOutputValidationError } from "./output";
import {
  failSummary,
  getSummaryExecution,
  loadSummaryPrompt,
  prepareSummaryContext,
  publishSummary,
} from "./service";

export class SummaryWorkflow extends ThinkWorkflow<
  SummaryAgent,
  SummaryWorkflowParams,
  DefaultProgress,
  SummaryEnvironment
> {
  override async run(event: AgentWorkflowEvent<SummaryWorkflowParams>, step: ThinkWorkflowStep) {
    const params = summaryWorkflowParamsSchema.parse(event.payload);

    return summaryTrace(this.env, { ...params, workflowId: event.instanceId }, "workflow.run", () =>
      this.#run(event, step),
    );
  }

  async #run(event: AgentWorkflowEvent<SummaryWorkflowParams>, step: ThinkWorkflowStep) {
    const params = summaryWorkflowParamsSchema.parse(event.payload);
    const { workspaceId, jobId } = params;
    if (event.instanceId !== summaryExecutionName(params)) {
      throw new Error("Summary Workflow identity does not match the job.");
    }

    try {
      const policy = await step.do("load-policy", async () => {
        const execution = await getSummaryExecution(this.env, workspaceId, jobId);

        return summaryPolicySchema.parse(execution.policy);
      });
      const scope = { ...params, workflowId: event.instanceId };
      const reference = await step.do("prepare-context", () =>
        summaryTrace(this.env, scope, "workflow.prepare", () =>
          prepareSummaryContext(this.env, workspaceId, jobId),
        ),
      );
      // The service enforces the pinned full-input byte bound before this
      // small prompt is checkpointed. Raw recordings never enter a step result.
      const prompt = await step.do("load-prompt", () =>
        loadSummaryPrompt(this.env, workspaceId, jobId, reference),
      );
      const analysis = await summaryTrace(this.env, scope, "workflow.generate", () =>
        step.prompt("summarize", {
          prompt,
          output: summaryModelOutputSchema(policy.promptVersion),
          timeout: `${Math.ceil(policy.promptTimeoutMs / 1000)} seconds`,
          cancelOnTimeout: true,
        }),
      );
      const result = await step.do("publish-summary", async () => {
        const summary = await summaryTrace(
          this.env,
          { ...scope, snapshotId: reference.snapshotId },
          "workflow.publish",
          async () => {
            try {
              return await publishSummary(this.env, workspaceId, jobId, reference, analysis);
            } catch (error) {
              if (error instanceof SummaryOutputValidationError) {
                throw new NonRetryableError(error.message);
              }

              throw error;
            }
          },
        );

        return summary
          ? { status: "succeeded" as const, summaryId: summary.id }
          : { status: "superseded" as const, summaryId: null };
      });
      await summaryTrace(
        this.env,
        {
          ...scope,
          snapshotId: reference.snapshotId,
          ...(result.summaryId ? { resultId: result.summaryId } : {}),
        },
        "workflow.complete",
        () => step.reportComplete(result),
      );

      return result;
    } catch (error) {
      const status =
        error instanceof WorkspaceError
          ? error.code === "conflict"
            ? "superseded"
            : "blocked"
          : "failed";
      let message = "The summary source or submitting account changed before publication.";
      if (status === "failed") {
        const publicationFailure = summaryPublicationFailureMessage(error);
        message =
          publicationFailure ??
          "Summary generation failed or was interrupted. No automatic model retry was issued.";
        // Completed inference may still fail application evidence validation.
        // Do not replace that known rejection with a provider diagnosis.
        if (!publicationFailure) {
          try {
            const agent = this.env.SUMMARY_AGENT.get(
              this.env.SUMMARY_AGENT.idFromName(summaryAgentName(params)),
            );
            message = await agent.diagnoseSummaryFailure(
              error instanceof Error ? error.message : error,
            );
          } catch {
            // The generic terminal outcome remains safe if diagnostic RPC is unavailable.
          }
        }
      }

      // If these database retries exhaust, scheduled reconciliation observes
      // the terminal Workflow and repairs the active job without new inference.
      await step.do("record-failure", () =>
        summaryTrace(this.env, { ...params, workflowId: event.instanceId }, "workflow.fail", () =>
          failSummary(this.env, workspaceId, jobId, status, message),
        ),
      );
      throw new Error(message);
    }
  }
}
