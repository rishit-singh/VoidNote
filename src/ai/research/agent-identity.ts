import type { ResearchRunExecutionKey } from "../../contracts/research/runs";

export function researchAgentName(key: ResearchRunExecutionKey): string {
  return `research-${key.workspaceId}-${key.runId}`;
}
