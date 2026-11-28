import type { ResearchRunPolicy } from "../../../config/research-runs";
import type { researchAgentToolSchemas } from "../../../contracts/research/agent";
import { type ResearchAgentScope } from "../../../contracts/research/agent";

export type { ResearchAgentScope } from "../../../contracts/research/agent";

export type ResearchAgentToolName = keyof typeof researchAgentToolSchemas;

export type ResearchAgentRunKey = {
  workspaceId: string;
  runId: string;
};

export type ResearchAgentExecution = {
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  scope: ResearchAgentScope;
  policy: ResearchRunPolicy;
};

export type ResearchAgentToolContext = ResearchAgentScope & {
  operationId: string;
};

export type ResearchAgentPublication =
  | { published: true; receiptId: string }
  | {
      published: false;
      reason: "invalid-citations" | "rejected";
      /** Fixed, bounded validation feedback; never include provider or source text. */
      feedback?: string;
    };

/**
 * Application-owned ports. Implementations must authorize each operation against
 * the run; the durable object state is execution context, never authority.
 */
export interface ResearchAgentServices {
  execution(scope: ResearchAgentRunKey): Promise<ResearchAgentExecution>;
  beginRun(scope: ResearchAgentRunKey): Promise<boolean>;
  isCancelled(scope: ResearchAgentRunKey): Promise<boolean>;
  executeTool(
    name: ResearchAgentToolName,
    input: unknown,
    context: ResearchAgentToolContext,
  ): Promise<unknown>;
  publishReport(
    scope: ResearchAgentScope,
    input: unknown,
    operationId: string,
  ): Promise<ResearchAgentPublication>;
  failRun(scope: ResearchAgentScope, message: string): Promise<void>;
  admitModelRequest(
    scope: ResearchAgentScope & { requestId: string; inputTokenBound: number },
    policy: ResearchRunPolicy,
  ): Promise<void>;
}

export type ResearchAgentEnvironment = Cloudflare.Env;
