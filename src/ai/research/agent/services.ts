// Compatibility boundary for pinned research-agent-v2 executions.
// Remove when that execution version is retired.
export type {
  ResearchAgentExecution,
  ResearchAgentPublication,
  ResearchAgentRunKey,
  ResearchAgentScope,
  ResearchAgentServices,
  ResearchAgentToolContext,
  ResearchAgentToolName,
} from "../../../contracts/research/execution";

export type ResearchAgentEnvironment = Cloudflare.Env;
