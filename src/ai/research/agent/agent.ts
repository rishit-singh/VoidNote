import type {
  PrepareStepContext,
  ToolCallContext,
  ToolCallDecision,
  TurnConfig,
  TurnContext,
} from "@cloudflare/think";
import { Think } from "@cloudflare/think";
import type { ToolSet } from "ai";
import { wrapLanguageModel } from "ai";

import type { ResearchRunPolicy } from "../../../config/research-runs";
import type {
  ResearchAgentExecution,
  ResearchAgentRunKey,
  ResearchAgentScope,
  ResearchAgentServices,
} from "../../../contracts/research/execution";
import { researchRunExecutionKeySchema } from "../../../contracts/research/runs";
import { researchWorkflowCandidateSchema } from "../../../contracts/research/workflow";
import { createOperations } from "../../../server/research/worker";
import { researchWorkflowInstructions } from "./instructions";
import { createResearchWorkflowTools } from "./tools";

export type ResearchWorkflowAgentEnvironment = Cloudflare.Env;

type AgentState = {
  version: 1;
  scope: ResearchAgentScope | null;
  policy: ResearchRunPolicy | null;
  requestId: string | null;
  requestIds: string[];
  correctionMode: boolean;
  toolCalls: number;
  searchCalls: number;
  evidenceBytes: number;
  uncertainOperation: boolean;
};

const initialAgentState: AgentState = {
  version: 1,
  scope: null,
  policy: null,
  requestId: null,
  requestIds: [],
  correctionMode: false,
  toolCalls: 0,
  searchCalls: 0,
  evidenceBytes: 0,
  uncertainOperation: false,
};

async function stableRequestId(identity: readonly string[]): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(identity))),
  ).slice(0, 16);

  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Think owns model turns and tool execution; the Workflow owns durable stages. */
export class ResearchWorkflowAgent extends Think<ResearchWorkflowAgentEnvironment, AgentState> {
  override initialState: AgentState = initialAgentState;
  override includeMcpTools = false;
  override sendReasoning = false;

  #preparedStep = 0;
  #toolAdmission: Promise<void> = Promise.resolve();
  #evidenceAdmission: Promise<void> = Promise.resolve();

  #operations(): ResearchAgentServices {
    return createOperations(this.env);
  }

  #scope(): ResearchAgentScope {
    const scope = this.state.scope;

    if (!scope) {
      throw new Error("The research Workflow has not prepared its authorized scope.");
    }

    return scope;
  }

  #policy(): ResearchRunPolicy {
    const policy = this.state.policy;

    if (!policy) {
      throw new Error("The research Workflow has not pinned its execution policy.");
    }

    return policy;
  }

  override getModel(): string {
    return this.#policy().model;
  }

  override getAIBinding(): Ai {
    return this.observeResearchAIBinding(super.getAIBinding());
  }

  /** Composition seam for the application-owned raw usage observer. */
  protected observeResearchAIBinding(binding: Ai): Ai {
    return binding;
  }

  protected currentResearchModelRequest(): ResearchAgentScope & {
    requestId: string;
    policy: ResearchRunPolicy;
  } {
    const requestId = this.state.requestId;

    if (!requestId) {
      throw new Error("No admitted research model request is active.");
    }

    return { ...this.#scope(), requestId, policy: this.#policy() };
  }

  override getSystemPrompt(): string {
    return researchWorkflowInstructions(this.#scope(), this.#policy());
  }

  override getTools(): ToolSet {
    return createResearchWorkflowTools(
      this.#operations(),
      this.#scope(),
      undefined,
      () => {
        this.setState({ ...this.state, uncertainOperation: true });
      },
      (text) => this.#retainEvidenceText(text),
    );
  }

  async #retainEvidenceText(text: string): Promise<string> {
    let release!: () => void;

    const previous = this.#evidenceAdmission;

    this.#evidenceAdmission = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      const availableBytes = Math.max(
        0,
        this.#policy().maxEvidenceBytes - this.state.evidenceBytes,
      );

      const encoder = new TextEncoder();

      const retained: string[] = [];

      let retainedBytes = 0;

      for (const character of text) {
        const characterBytes = encoder.encode(character).byteLength;

        if (retainedBytes + characterBytes > availableBytes) {
          break;
        }

        retained.push(character);
        retainedBytes += characterBytes;
      }

      this.setState({
        ...this.state,
        evidenceBytes: this.state.evidenceBytes + retainedBytes,
      });

      return retained.join("");
    } finally {
      release();
    }
  }

  /**
   * Called by ThinkWorkflow in a checkpointed step. Postgres remains authoritative;
   * this DO state only carries the pinned execution context for Think's turn.
   */
  async prepareResearchRun(input: ResearchAgentRunKey): Promise<ResearchAgentExecution> {
    const key = researchRunExecutionKeySchema.parse(input);

    let execution = await this.#operations().execution(key);

    if (execution.policy.executionVersion !== "research-workflow-v3") {
      throw new Error("This research run is not pinned to research-workflow-v3.");
    }

    if (execution.status === "queued") {
      await this.#operations().beginRun(key);
      execution = await this.#operations().execution(key);
    }

    if (execution.status !== "running") {
      throw new Error("Research run is no longer active.");
    }

    if (execution.scope.workspaceId !== key.workspaceId || execution.scope.runId !== key.runId) {
      throw new Error("Research services returned a different authorized run.");
    }

    if (
      this.state.scope &&
      (this.state.scope.workspaceId !== execution.scope.workspaceId ||
        this.state.scope.runId !== execution.scope.runId)
    ) {
      throw new Error("Research authorization or pinned policy changed during execution.");
    }

    this.setState({
      ...this.state,
      scope: execution.scope,
      policy: execution.policy,
    });

    return execution;
  }

  /** Publication uses the app operation, never a model-visible publish tool. */
  async publishResearchCandidate(candidate: unknown): Promise<{
    published: boolean;
    feedback?: string;
  }> {
    const scope = this.#scope();

    const validated = researchWorkflowCandidateSchema.parse(candidate);

    const result = await this.#operations().publishReport(
      scope,
      validated,
      await stableRequestId([
        "research-workflow-v3-publish",
        scope.workspaceId,
        scope.runId,
        JSON.stringify(validated),
      ]),
    );

    return result.published
      ? { published: true }
      : { published: false, ...(result.feedback ? { feedback: result.feedback } : {}) };
  }

  setCorrectionMode(): void {
    this.setState({ ...this.state, correctionMode: true });
  }

  override beforeStep(context: PrepareStepContext): void {
    this.#preparedStep = context.stepNumber;
  }

  override async beforeTurn(context: TurnContext): Promise<TurnConfig> {
    const scope = this.#scope();

    const policy = this.#policy();

    const execution = await this.#operations().execution({
      workspaceId: scope.workspaceId,
      runId: scope.runId,
    });

    if (
      execution.status !== "running" ||
      JSON.stringify(execution.policy) !== JSON.stringify(policy) ||
      (await this.#operations().isCancelled(scope))
    ) {
      throw new Error("Research run authorization or pinned policy changed before inference.");
    }

    if (typeof context.model === "string") {
      throw new Error("Research model must resolve before request admission.");
    }

    return {
      model: wrapLanguageModel({
        model: context.model,
        middleware: {
          transformParams: async ({ params }) => {
            const requestId = await stableRequestId([
              "research-workflow-v3-model",
              scope.workspaceId,
              scope.runId,
              context.requestId ?? "workflow-prompt",
              String(this.#preparedStep),
            ]);

            if (this.state.requestIds.includes(requestId)) {
              throw new Error("Research inference outcome is uncertain and will not be replayed.");
            }

            const inputTokenBound =
              new TextEncoder().encode(JSON.stringify(params)).byteLength + 2048;

            this.setState({
              ...this.state,
              requestId,
              requestIds: [...this.state.requestIds, requestId],
            });
            await this.#operations().admitModelRequest(
              { ...scope, requestId, inputTokenBound },
              policy,
            );

            if (await this.#operations().isCancelled(scope)) {
              throw new Error("Research run was cancelled before model submission.");
            }

            return params;
          },
        },
      }),
      instructions: this.getSystemPrompt(),
      activeTools: this.state.correctionMode ? [] : Object.keys(this.getTools()),
      maxSteps: policy.maxModelSteps,
      maxOutputTokens: policy.maxOutputTokens,
      maxRetries: 0,
      timeout: policy.deadlineMs,
      sendReasoning: false,
      providerOptions: {
        "workers-ai": {
          reasoning_effort: policy.reasoningEffort,
        },
      },
    };
  }

  override async beforeToolCall(context: ToolCallContext): Promise<ToolCallDecision> {
    const scope = this.#scope();

    const policy = this.#policy();

    if (await this.#operations().isCancelled(scope)) {
      return { action: "block", reason: "The authorized research run is no longer active." };
    }

    if (this.state.uncertainOperation) {
      return {
        action: "block",
        reason: "A research operation has an uncertain result; no further operation is permitted.",
      };
    }

    let release!: () => void;

    const previous = this.#toolAdmission;

    this.#toolAdmission = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      const input = context.input as { queries?: unknown };

      const searchCount =
        context.toolName === "search_sources" && Array.isArray(input.queries)
          ? input.queries.length
          : Number(context.toolName === "search_sources");

      if (this.state.toolCalls >= policy.maxToolCalls) {
        return { action: "block", reason: "The research tool-call limit has been reached." };
      }

      if (this.state.searchCalls + searchCount > policy.maxSearchCalls) {
        return { action: "block", reason: "The research search-call limit has been reached." };
      }

      this.setState({
        ...this.state,
        toolCalls: this.state.toolCalls + 1,
        searchCalls: this.state.searchCalls + searchCount,
      });

      return { action: "allow" };
    } finally {
      release();
    }
  }
}
