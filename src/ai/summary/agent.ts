import type {
  ChatRecoveryOptions,
  StepContext,
  ThinkSubmissionInspection,
  TurnConfig,
  TurnContext,
} from "@cloudflare/think";
import { Think } from "@cloudflare/think";
import { wrapLanguageModel } from "ai";

import { WorkspaceError } from "../../contracts/workspace";
import { emitSummaryUsage, summaryTrace } from "../../telemetry/summary";
import { requestInferenceStreamUsage } from "../inference";
import type { SummaryPolicy, SummaryUsage } from "../runtime";
import { summaryInputTokenBound, summaryPolicySchema } from "../runtime";
import type { SummaryWorkflowParams } from "./dispatch";
import { summaryAgentName, summaryExecutionName, summaryWorkflowParamsSchema } from "./dispatch";
import {
  classifySummaryFailure,
  classifyThinkSubmissionError,
  summaryFailureMessage,
} from "./failure";
import { resolveSummaryPrompt } from "./instructions";
import {
  failSummary,
  getSummaryExecution,
  reserveSummaryInference,
  settleSummaryInference,
} from "./service";
import { observeSummaryUsage } from "./usage";

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
  // Optional so existing durable state remains readable. Missing usage retains
  // the hold; a complete provider receipt is persisted before settlement I/O.
  pendingUsage?: SummaryUsage | null;
  // Retained after settlement so terminal diagnosis survives usage receipt cleanup.
  failureEvidence?: ReturnType<typeof classifySummaryFailure> | null;
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

  override getAIBinding(): Ai {
    return this.observeSummaryAIBinding(super.getAIBinding());
  }

  protected observeSummaryAIBinding(binding: Ai): Ai {
    return observeSummaryUsage(requestInferenceStreamUsage(binding), async (usage) => {
      if (!this.#scope().policy.budgetId) {
        return;
      }

      // Persist only authoritative raw provider counts. The observer finalizes
      // streams before SDK completion; recovery never needs response content.
      this.setState({
        ...this.state,
        pendingUsage: usage,
        failureEvidence: {
          ...this.state.failureEvidence,
          kind: this.state.failureEvidence?.kind ?? "provider",
          confidence: "provider",
          usage: { ...this.state.failureEvidence?.usage, ...usage },
        },
      });
      await this.schedule(60, "reconcileSummaryUsage");
    });
  }

  override getSystemPrompt(): string {
    return resolveSummaryPrompt(this.#scope().policy.promptVersion).system;
  }

  override async beforeTurn(context: TurnContext): Promise<TurnConfig> {
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

    const model = context.model;
    if (typeof model === "string") {
      throw new Error("Summary model must resolve before admission.");
    }

    return {
      model: wrapLanguageModel({
        model,
        middleware: {
          transformParams: async ({ params }) => {
            // Runs after Think adds the final-answer instruction/schema and the
            // SDK filters tools. Count the actual request, not just the transcript.
            await this.#reserveInference(
              scope.policy.budgetAccounting ? summaryInputTokenBound(params) : undefined,
            );

            return params;
          },
        },
      }),
      instructions: resolveSummaryPrompt(scope.policy.promptVersion).system,
      activeTools: [],
      maxSteps: scope.policy.maxSteps,
      maxOutputTokens: scope.policy.maxOutputTokens,
      maxRetries: 0,
      timeout: scope.policy.timeoutMs,
      sendReasoning: false,
      ...(scope.policy.reasoningEffort
        ? { providerOptions: { "workers-ai": { reasoning_effort: scope.policy.reasoningEffort } } }
        : {}),
    };
  }

  async #reserveInference(inputTokenBound?: number): Promise<void> {
    const scope = this.#scope();
    if (
      this.state.inferenceStarted ||
      this.state.cancelled ||
      this.env.SUMMARY_ENABLED !== "true"
    ) {
      throw new Error(interruptedMessage);
    }

    try {
      await summaryTrace(this.env, scope, "agent.reserve", () =>
        reserveSummaryInference(
          this.env,
          scope.workspaceId,
          scope.jobId,
          scope.policy,
          inputTokenBound,
        ),
      );
    } catch (error) {
      await failSummary(
        this.env,
        scope.workspaceId,
        scope.jobId,
        "blocked",
        error instanceof WorkspaceError
          ? error.message
          : "Summary inference allowance is unavailable or already reserved. No new model request was sent.",
      );
      throw error;
    }

    if (this.state.cancelled) {
      throw new Error("Summary execution was cancelled after reserving its allowance.");
    }

    // Commit before returning control to the SDK/provider. Even an unexpected
    // replay of admission cannot silently issue another paid model turn.
    this.setState({ ...this.state, inferenceStarted: true });
  }

  override async onStepEnd(context: StepContext): Promise<void> {
    const scope = this.#scope();
    const finishReason =
      typeof context.finishReason === "string" && context.finishReason !== "error"
        ? context.finishReason
        : undefined;
    const cachedInputTokens: unknown = context.usage.inputTokenDetails.cacheReadTokens;
    const reasoningTokens: unknown = context.usage.outputTokenDetails.reasoningTokens;
    const knownUsage = {
      ...(typeof context.usage.inputTokens === "number"
        ? { inputTokens: context.usage.inputTokens }
        : {}),
      ...(typeof context.usage.outputTokens === "number"
        ? { outputTokens: context.usage.outputTokens }
        : {}),
      ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
      ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
    };
    if (finishReason || Object.keys(knownUsage).length > 0) {
      const evidence = classifySummaryFailure({
        finishReason,
        outputTokenLimit: this.#scope().policy.maxOutputTokens,
        ...(finishReason !== undefined && finishReason !== "tool-calls"
          ? { finalAnswerPresent: false }
          : {}),
        usage: { ...this.state.failureEvidence?.usage, ...knownUsage },
      });
      this.setState({ ...this.state, failureEvidence: evidence });
    }

    // SDK usage may contain adapter-synthesized zeros for absent provider fields.
    // Only the raw binding observer is allowed to create an accounting receipt.
    await this.#settleUsage();
    await super.onStepEnd(context);
    await emitSummaryUsage(
      this.env,
      { ...scope, workflowId: summaryExecutionName(scope) },
      {
        model: scope.policy.model,
        ...(finishReason ? { finishReason } : {}),
        ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
        ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
        responseTimeMs: context.performance.responseTimeMs,
        stepTimeMs: context.performance.stepTimeMs,
        ...(context.performance.timeToFirstOutputMs !== undefined
          ? { timeToFirstOutputMs: context.performance.timeToFirstOutputMs }
          : {}),
        ...(context.usage.inputTokens !== undefined
          ? { inputTokens: context.usage.inputTokens }
          : {}),
        ...(context.usage.outputTokens !== undefined
          ? { outputTokens: context.usage.outputTokens }
          : {}),
      },
    );
  }

  async reconcileSummaryUsage(): Promise<void> {
    if (!(await this.#settleUsage())) {
      await this.schedule(60, "reconcileSummaryUsage");
    }
  }

  /** Internal Workflow RPC: return only a user-safe diagnosis from durable evidence. */
  diagnoseSummaryFailure(error: unknown): string {
    const scope = this.#scope();
    const evidence = this.state.failureEvidence;
    const errorKind = classifyThinkSubmissionError(error);
    const diagnosis = classifySummaryFailure({
      ...(evidence?.finishReason ? { finishReason: evidence.finishReason } : {}),
      outputTokenLimit: scope.policy.maxOutputTokens,
      ...(errorKind === "missing_final_answer" ? { finalAnswerPresent: false } : {}),
      interrupted: errorKind === "interrupted",
      schemaFailure: errorKind === "schema" || evidence?.kind === "schema",
      usage: evidence?.usage,
    });

    this.setState({ ...this.state, failureEvidence: diagnosis });

    return summaryFailureMessage(diagnosis);
  }

  async #settleUsage(): Promise<boolean> {
    const usage = this.state.pendingUsage;
    if (!usage) {
      return true;
    }

    const scope = this.#scope();
    try {
      await settleSummaryInference(this.env, scope.workspaceId, scope.jobId, usage);
      this.setState({ ...this.state, pendingUsage: null });

      return true;
    } catch {
      // Retain the original hold until settlement succeeds. Never log usage
      // payloads or database errors, and never re-enter inference from recovery.
      return false;
    }
  }

  // Native DO RPC only. The Worker never exposes this namespace through the
  // general Agent HTTP/WebSocket router, and this method is not @callable.
  async startSummary(input: SummaryWorkflowParams): Promise<string | null> {
    const scope = this.#params(input);

    return summaryTrace(
      this.env,
      { ...scope, workflowId: summaryExecutionName(scope) },
      "agent.start",
      () => this.#startSummary(scope),
    );
  }

  async #startSummary(input: SummaryWorkflowParams): Promise<string | null> {
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
      const evidence = this.state.failureEvidence;
      const errorKind = classifyThinkSubmissionError(submission.error);
      const finalAnswerAbsent =
        submission.status === "error" ||
        errorKind === "missing_final_answer" ||
        evidence?.kind === "output_limit" ||
        evidence?.kind === "missing_final_answer";
      const diagnosed = classifySummaryFailure({
        ...(evidence?.finishReason ? { finishReason: evidence.finishReason } : {}),
        outputTokenLimit: scope.policy.maxOutputTokens,
        ...(finalAnswerAbsent ? { finalAnswerPresent: false } : {}),
        interrupted:
          errorKind === "interrupted" ||
          (errorKind === undefined && evidence === undefined && this.state.inferenceStarted),
        schemaFailure: errorKind === "schema" || evidence?.kind === "schema",
        providerFailure: errorKind === "provider" || evidence?.kind === "provider",
        usage: evidence?.usage,
      });
      this.setState({ ...this.state, failureEvidence: diagnosed });
      await failSummary(
        this.env,
        scope.workspaceId,
        scope.jobId,
        "failed",
        this.state.inferenceStarted
          ? diagnosed
            ? summaryFailureMessage(diagnosed)
            : interruptedMessage
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
