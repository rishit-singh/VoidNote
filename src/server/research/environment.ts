import type { ResearchRunExecutionKey } from "../../contracts/research/runs";
import type { Database } from "../../db/repository";
import { withJobDatabase } from "../../ai/jobs";

export type ResearchRunEnvironment = {
  HYPERDRIVE?: Cloudflare.Env["HYPERDRIVE"];
  AI?: Ai;
  FIRECRAWL_API_KEY?: string;
  RESEARCH_ENABLED?: string;
  RESEARCH_AGENT_ENABLED?: string;
  RESEARCH_AGENT?: Cloudflare.Env["RESEARCH_AGENT"];
  RESEARCH_WORKFLOW_AGENT?: Cloudflare.Env["RESEARCH_WORKFLOW_AGENT"];
  RESEARCH_INVESTIGATION_WORKFLOW?: Cloudflare.Env["RESEARCH_INVESTIGATION_WORKFLOW"];
  RESEARCH_DISCOVERY_ENABLED?: string;
  RESEARCH_RUN_WORKFLOW?: Workflow<ResearchRunExecutionKey>;
  LOGFIRE_TOKEN?: string;
  LOGFIRE_BASE_URL?: string;
  LOGFIRE_ENVIRONMENT?: string;
};

export function withResearchRunDatabase<T>(
  env: ResearchRunEnvironment,
  work: (db: Database) => Promise<T>,
) {
  if (!env.HYPERDRIVE) {
    throw new Error("Research database binding is unavailable.");
  }

  return withJobDatabase({ HYPERDRIVE: env.HYPERDRIVE }, work);
}
