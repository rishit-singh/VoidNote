import type { ThinkWorkflowStep } from "@cloudflare/think/workflows";
import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent, DefaultProgress } from "agents/workflows";

import { summaryAnalysisSchema } from "../../contracts/analysis";
import { WorkspaceError } from "../../contracts/workspace";
import { summaryPolicySchema } from "../runtime";
import type { SummaryAgent, SummaryEnvironment } from "./agent";
import type { SummaryWorkflowParams } from "./dispatch";
import { summaryExecutionName, summaryWorkflowParamsSchema } from "./dispatch";
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
    const { workspaceId, jobId } = params;
    if (event.instanceId !== summaryExecutionName(params)) {
      throw new Error("Summary Workflow identity does not match the job.");
    }

    try {
      const policy = await step.do("load-policy", async () => {
        const execution = await getSummaryExecution(this.env, workspaceId, jobId);

        return summaryPolicySchema.parse(execution.policy);
      });
      const reference = await step.do("prepare-context", () =>
        prepareSummaryContext(this.env, workspaceId, jobId),
      );
      // The service enforces the pinned full-input byte bound before this
      // small prompt is checkpointed. Raw recordings never enter a step result.
      const prompt = await step.do("load-prompt", () =>
        loadSummaryPrompt(this.env, workspaceId, jobId, reference),
      );
      const analysis = await step.prompt("summarize", {
        prompt,
        output: summaryAnalysisSchema,
        timeout: `${Math.ceil(policy.promptTimeoutMs / 1000)} seconds`,
        cancelOnTimeout: true,
      });
      const result = await step.do("publish-summary", async () => {
        const summary = await publishSummary(this.env, workspaceId, jobId, reference, analysis);

        return summary
          ? { status: "succeeded" as const, summaryId: summary.id }
          : { status: "superseded" as const, summaryId: null };
      });
      await step.reportComplete(result);

      return result;
    } catch (error) {
      const status =
        error instanceof WorkspaceError
          ? error.code === "conflict"
            ? "superseded"
            : "blocked"
          : "failed";
      const message =
        status === "failed"
          ? "Summary generation failed or was interrupted. No automatic model retry was issued."
          : "The summary source or submitting account changed before publication.";

      // If these database retries exhaust, scheduled reconciliation observes
      // the terminal Workflow and repairs the active job without new inference.
      await step.do("record-failure", () =>
        failSummary(this.env, workspaceId, jobId, status, message),
      );
      throw new Error(message);
    }
  }
}
