import type { ChatRecoveryOptions, ThinkSubmissionInspection, TurnConfig } from "@cloudflare/think";
import { Think } from "@cloudflare/think";

import { WorkspaceError } from "../../contracts/workspace";
import type { SummaryPolicy } from "../runtime";
import { summaryPolicySchema } from "../runtime";
import type { SummaryWorkflowParams } from "./dispatch";
import { summaryAgentName, summaryExecutionName, summaryWorkflowParamsSchema } from "./dispatch";
import { summaryInstructions } from "./instructions";
import { failSummary, getSummaryExecution } from "./service";

// The SDK constrains Env to Cloudflare.Env. Use the generated environment
// directly so its namespace/workflow types do not form a second recursive alias.
export type SummaryEnvironment = Cloudflare.Env;

type SummaryScope = SummaryWorkflowParams & { policy: SummaryPolicy };

type SummaryState = {
  version: 1;
  scope: SummaryScope | null;
  workflowAttempted: boolean;
  workflowConfirmed: boolean;
  submissionId: string | null;
  inferenceStarted: boolean;
  inferenceUncertain: boolean;
  cancelled: boolean;
};

const interruptedMessage =
  "Summary inference was interrupted and its outcome is uncertain. No automatic model retry was issued.";

export class SummaryAgent extends Think<SummaryEnvironment, SummaryState> {
  override initialState: SummaryState = {
    version: 1,
    scope: null,
    workflowAttempted: false,
    workflowConfirmed: false,
    submissionId: null,
    inferenceStarted: false,
    inferenceUncertain: false,
    cancelled: false,
  };

  override includeMcpTools = false;
  override sendReasoning = false;

  override getModel(): string {
    return this.#scope().policy.model;
  }

  override getSystemPrompt(): string {
    return summaryInstructions;
  }

  override async beforeTurn(): Promise<TurnConfig> {
    const scope = this.#scope();
    const execution = await getSummaryExecution(this.env, scope.workspaceId, scope.jobId);
    this.#assertPinnedScope({ ...scope, policy: summaryPolicySchema.parse(execution.policy) });

    if (
      this.env.SUMMARY_ENABLED !== "true" ||
      this.state.cancelled ||
      (execution.status !== "queued" && execution.status !== "running")
    ) {
      throw new Error("Summary execution is no longer active.");
    }

    if (this.state.inferenceStarted) {
      throw new Error(interruptedMessage);
    }

    // Commit before returning control to the SDK/provider. Even an unexpected
    // replay of admission cannot silently issue another paid model turn.
    this.setState({ ...this.state, inferenceStarted: true });

    return {
      instructions: summaryInstructions,
      activeTools: [],
      maxSteps: scope.policy.maxSteps,
      maxOutputTokens: scope.policy.maxOutputTokens,
      maxRetries: 0,
      timeout: scope.policy.timeoutMs,
      sendReasoning: false,
    };
  }

  // Native DO RPC only. The Worker never exposes this namespace through the
  // general Agent HTTP/WebSocket router, and this method is not @callable.
  async startSummary(input: SummaryWorkflowParams): Promise<string | null> {
    const params = this.#params(input);
    if (this.env.SUMMARY_ENABLED !== "true") {
      throw new Error("Summary execution is disabled.");
    }

    let execution;
    try {
      execution = await getSummaryExecution(this.env, params.workspaceId, params.jobId);
    } catch (error) {
      if (error instanceof WorkspaceError) {
        await failSummary(
          this.env,
          params.workspaceId,
          params.jobId,
          error.code === "conflict" ? "superseded" : "blocked",
          "The summary source or submitting account is no longer authorized.",
        );
      }

      throw error;
    }

    const policy = summaryPolicySchema.parse(execution.policy);
    if (policy.maxSteps !== 1) {
      await failSummary(
        this.env,
        params.workspaceId,
        params.jobId,
        "blocked",
        "The summary proof requires a single model step.",
      );
      throw new Error("Unsupported summary step policy.");
    }

    const scope: SummaryScope = { ...params, policy };
    this.#assertPinnedScope(scope);

    if (!this.state.scope) {
      this.setState({ ...this.state, scope });
    }

    if (this.state.cancelled || (execution.status !== "queued" && execution.status !== "running")) {
      return null;
    }

    if (this.state.inferenceUncertain) {
      // Recovery may have persisted this marker while Postgres was unavailable.
      // Reconciliation retries only the terminal write, never the model turn.
      await failSummary(this.env, params.workspaceId, params.jobId, "failed", interruptedMessage);

      return null;
    }

    const workflowId = summaryExecutionName(params);
    if (this.state.workflowConfirmed || this.state.submissionId || this.state.inferenceStarted) {
      // Never recreate an expired/missing Workflow after known execution.
      await this.#confirmWorkflow(workflowId);
    } else {
      this.setState({ ...this.state, workflowAttempted: true });
      try {
        await this.runWorkflow("SUMMARY_WORKFLOW", params, {
          id: workflowId,
          agentBinding: "SUMMARY_AGENT",
          metadata: params,
        });
      } catch (creationError) {
        // The create may have committed before its response/tracking failed.
        // Only a successful status read is evidence of acceptance. Otherwise
        // propagate the error so the durable outbox can retry this same ID.
        try {
          await this.#confirmWorkflow(workflowId);
        } catch {
          throw creationError;
        }
      }
    }

    this.setState({ ...this.state, workflowConfirmed: true });

    if (this.state.cancelled) {
      await this.cancelSummary(params);
    }

    return workflowId;
  }

  async cancelSummary(input: SummaryWorkflowParams): Promise<void> {
    const params = this.#params(input);
    // A tombstone is meaningful even when cancellation wins before start.
    this.setState({ ...this.state, cancelled: true });

    const submissionId = this.state.submissionId;
    const cleanup = [];
    if (submissionId) {
      cleanup.push(this.cancelSubmission(submissionId, "Summary job cancelled."));
    }

    if (this.state.workflowAttempted) {
      cleanup.push(
        this.env.SUMMARY_WORKFLOW.get(summaryExecutionName(params)).then((instance) =>
          instance.terminate(),
        ),
      );
    }

    const results = await Promise.allSettled(cleanup);
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("Summary cancellation cleanup is incomplete.");
    }
  }

  protected override async onSubmissionStatus(
    submission: ThinkSubmissionInspection,
  ): Promise<void> {
    const scope = this.#scope();
    const expectedKey = `think-workflow:SUMMARY_WORKFLOW:${summaryExecutionName(scope)}:summarize`;
    const admitted = this.state.submissionId;
    if (
      submission.idempotencyKey !== expectedKey ||
      (admitted !== null && admitted !== submission.submissionId)
    ) {
      if (submission.status === "pending" || submission.status === "running") {
        await this.cancelSubmission(submission.submissionId, "Unexpected summary submission.");
      }

      return;
    }

    this.setState({ ...this.state, submissionId: submission.submissionId });
    if (
      this.state.cancelled &&
      (submission.status === "pending" || submission.status === "running")
    ) {
      await this.cancelSubmission(submission.submissionId, "Summary job cancelled.");

      return;
    }

    if (
      submission.status === "error" ||
      submission.status === "aborted" ||
      submission.status === "skipped"
    ) {
      await failSummary(
        this.env,
        scope.workspaceId,
        scope.jobId,
        "failed",
        this.state.inferenceStarted
          ? interruptedMessage
          : "Summary submission did not complete. No summary was published.",
      );
    }
  }

  protected override async onChatRecovery(): Promise<ChatRecoveryOptions> {
    this.setState({ ...this.state, inferenceUncertain: true });
    const scope = this.#scope();
    try {
      await failSummary(this.env, scope.workspaceId, scope.jobId, "failed", interruptedMessage);
    } catch {
      // The durable uncertainty marker survives database outages. Do not throw
      // from this hook: the SDK must still receive the no-continuation decision.
      console.error("summary.recovery.failure_pending", {
        workspaceId: scope.workspaceId,
        jobId: scope.jobId,
      });
    }

    return { continue: false };
  }

  #params(input: SummaryWorkflowParams): SummaryWorkflowParams {
    const params = summaryWorkflowParamsSchema.parse(input);
    if (this.name !== summaryAgentName(params)) {
      throw new Error("Summary Agent identity does not match the job.");
    }

    const pinned = this.state.scope;
    if (pinned && (pinned.workspaceId !== params.workspaceId || pinned.jobId !== params.jobId)) {
      throw new Error("Summary Agent scope cannot change.");
    }

    return params;
  }

  #scope(): SummaryScope {
    const scope = this.state.scope;
    if (!scope) {
      throw new Error("Summary Agent has not admitted a job.");
    }

    return scope;
  }

  #assertPinnedScope(scope: SummaryScope): void {
    this.#params({ workspaceId: scope.workspaceId, jobId: scope.jobId });
    const pinned = this.state.scope;
    if (pinned && JSON.stringify(pinned.policy) !== JSON.stringify(scope.policy)) {
      throw new Error("Summary policy cannot change after admission.");
    }
  }

  async #confirmWorkflow(workflowId: string): Promise<void> {
    const instance = await this.env.SUMMARY_WORKFLOW.get(workflowId);
    const status = await instance.status();
    if (status.status === "unknown") {
      throw new Error("Summary Workflow acceptance is still uncertain.");
    }

    if (
      status.status === "errored" ||
      status.status === "terminated" ||
      status.status === "complete"
    ) {
      const scope = this.#scope();
      // The job read at admission can predate publication. Re-read after the
      // terminal Workflow observation; failSummary also preserves terminal jobs
      // under its database lock if publication wins after this read.
      const execution = await getSummaryExecution(this.env, scope.workspaceId, scope.jobId);
      if (execution.status === "queued" || execution.status === "running") {
        await failSummary(
          this.env,
          scope.workspaceId,
          scope.jobId,
          "failed",
          "The summary Workflow ended without a successful publication. It will not be restarted.",
        );
      }
    }
  }
}
