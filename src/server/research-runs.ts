import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { dispatchResearchRun } from "@/ai/research/runs";
import { readResearchPolicy } from "@/config/research";
import { pinResearchRunPolicy } from "@/config/research-runs";
import type { RequestResearchRun, ResearchRunListInput } from "@/contracts/research/runs";
import type { Principal } from "@/contracts/workspace";
import { withDatabase } from "@/db/client";
import { createResearchRunsRepository } from "@/db/research";

function repository<T>(
  work: (repo: ReturnType<typeof createResearchRunsRepository>) => Promise<T>,
) {
  return withDatabase((db) => work(createResearchRunsRepository(db)));
}

export async function requestResearchRun(principal: Principal, input: RequestResearchRun) {
  const { env, ctx } = getCloudflareContext();
  const configured = readResearchPolicy(env);
  const policy =
    configured && env.RESEARCH_RUN_WORKFLOW && env.AI && env.HYPERDRIVE
      ? pinResearchRunPolicy(configured)
      : null;
  const run = await repository((repo) => repo.request(principal, input, policy));

  if (run.status === "queued") {
    ctx.waitUntil(
      dispatchResearchRun(env, { workspaceId: run.workspaceId, runId: run.id }).catch(() => {
        console.warn("Research run dispatch deferred.");
      }),
    );
  }

  return run;
}

export function readResearchRun(principal: Principal, workspaceId: string, runId: string) {
  return repository((repo) => repo.get(principal, workspaceId, runId));
}

export function listResearchRuns(
  principal: Principal,
  workspaceId: string,
  input: ResearchRunListInput,
) {
  return repository((repo) => repo.list(principal, workspaceId, input));
}

export function cancelResearchRun(principal: Principal, workspaceId: string, runId: string) {
  return repository((repo) => repo.cancel(principal, workspaceId, runId));
}
