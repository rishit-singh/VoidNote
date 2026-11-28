import type { AssistantPolicy } from "../../config/assistant";
import type {
  AssistantMessage,
  AssistantSource,
  AssistantThread,
  AssistantToolResult,
  AssistantTurn,
} from "../../contracts/assistant";
import type { AssistantMemoryMutation } from "../../contracts/assistant/lineage";
import type { AssistantProfileMutation } from "../../contracts/assistant/lineage";
import type { ConversationSummary } from "../../contracts/conversation-summaries";
import type { Principal } from "../../contracts/workspace";
import type { AssistantToolName } from "./tools";

export type AssistantTurnInput = { workspaceId: string; turnId: string };

export type AssistantExecution = {
  principal: Principal;
  thread: AssistantThread;
  turn: AssistantTurn;
  text: string;
  policy: AssistantPolicy;
};

export type AssistantCompletion = {
  text: string;
  tools: AssistantToolResult[];
  sources: AssistantSource[];
  memoryMutations?: AssistantMemoryMutation[];
  profileMutations?: AssistantProfileMutation[];
};

export type AssistantToolContext = AssistantTurnInput & {
  threadId: string;
  principal: Principal;
  toolCallId: string;
  operationId: string;
};

export type AssistantToolOutput = {
  summary: string;
  sources: AssistantSource[];
  data: unknown;
  /** Explicitly superseded/invalidated by this acknowledged operation. Applied
   * only to earlier evidence, so a revision may return the new source as well.
   */
  invalidatedSources?: Array<{ kind: AssistantSource["kind"]; id: string }>;
};

/** Each implementation opens/closes its database connection per operation.
 * Authorization and cancellation are rechecked by the service, including inside
 * mutation transactions. The agent's pinned principal is never sufficient alone.
 */
export interface AssistantServices {
  execution(workspaceId: string, turnId: string): Promise<AssistantExecution>;
  beginTurn(workspaceId: string, turnId: string): Promise<boolean>;
  completeTurn(
    workspaceId: string,
    turnId: string,
    completion: AssistantCompletion,
  ): Promise<unknown>;
  /** Internal idempotent terminalizer: preserve terminal turns, tolerate missing
   * rows, and do not require source authorization after publication rejection.
   */
  failTurn(
    workspaceId: string,
    turnId: string,
    status: "failed" | "interrupted",
    error: string,
  ): Promise<unknown>;
  cancelTurn(workspaceId: string, turnId: string): Promise<unknown>;
  isCancelled(workspaceId: string, turnId: string): Promise<boolean>;
  authorize(execution: AssistantExecution, scope: AssistantTurnInput): Promise<void>;
  /** Chronological authorized history, excluding assistant replies whose source
   * dependencies are stale, invalidated, expired or no longer accessible.
   */
  history(workspaceId: string, threadId: string, limit: number): Promise<AssistantMessage[]>;
  /** Fresh authorized derived context. Revalidate the saved message dependencies;
   * this is not a current profile read, a new saved message, or a memory write.
   */
  contextSummary?(workspaceId: string, threadId: string): Promise<ConversationSummary | null>;
  executeTool(
    name: AssistantToolName,
    input: unknown,
    context: AssistantToolContext,
  ): Promise<AssistantToolOutput>;
  /** Must atomically reserve a NEW immutable request receipt or throw, even if
   * the same request ID already exists. An unknown outcome retains its hold.
   * No Summary allowance fallback is permitted.
   */
  admitModelRequest(
    input: AssistantTurnInput & {
      requestId: string;
      policy: AssistantPolicy;
      inputTokenBound: number;
    },
  ): Promise<void>;
}
