import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { dispatchResearchItem } from "@/ai/research";
import { readResearchPolicy } from "@/config/research";
import type { RequestResearch, ResearchBatch } from "@/contracts/research";
import type { Principal } from "@/contracts/workspace";
import { withDatabase } from "@/db/client";
import { createResearchRepository } from "@/db/research";

function environment() {
  return getCloudflareContext().env;
}

export function researchPolicy() {
  const env = environment();

  if (!env.RESEARCH_WORKFLOW || !env.AI || !env.HYPERDRIVE) {
    return null;
  }

  return readResearchPolicy(env);
}

function repository<T>(work: (repo: ReturnType<typeof createResearchRepository>) => Promise<T>) {
  return withDatabase((db) => work(createResearchRepository(db)));
}

function notify(batch: ResearchBatch) {
  const { ctx } = getCloudflareContext();

  const env = environment();

  const work = Promise.allSettled(
    batch.items
      .filter((item) => ["queued", "cancelled"].includes(item.status))
      .map((item) =>
        dispatchResearchItem(
          env,
          {
            workspaceId: batch.workspaceId,
            batchId: batch.id,
            personId: item.personId,
            generation: item.generation,
          },
          item.status === "cancelled",
        ),
      ),
  );

  ctx.waitUntil(
    work.then((results) => {
      if (results.some((result) => result.status === "rejected")) {
        console.warn("Research runtime notification deferred.");
      }
    }),
  );
}

/** UI and model-visible tools share these authorized operations. They return
 * persisted acceptance/status, never represent a queued request as a finding. */
export async function requestContactResearch(principal: Principal, input: RequestResearch) {
  const batch = await repository((repo) => repo.request(principal, input, researchPolicy()));

  notify(batch);

  return batch;
}

export function readContactResearch(principal: Principal, workspaceId: string, batchId: string) {
  return repository((repo) => repo.get(principal, workspaceId, batchId));
}

export function listContactResearch(principal: Principal, workspaceId: string, personId?: string) {
  return repository((repo) => repo.list(principal, workspaceId, personId));
}

export async function cancelContactResearch(
  principal: Principal,
  workspaceId: string,
  batchId: string,
) {
  const batch = await repository((repo) => repo.cancel(principal, workspaceId, batchId));

  notify(batch);

  return batch;
}

export async function retryContactResearch(principal: Principal, input: unknown) {
  const batch = await repository((repo) => repo.retry(principal, input));

  notify(batch);

  return batch;
}
