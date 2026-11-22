import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import type { ContextReference } from "../ai/context";
import { readSummarySnapshot } from "../ai/context";
import { summaryPolicy } from "../ai/runtime";

export function analysisPolicy() {
  const { env } = getCloudflareContext();

  if (env.SUMMARY_ENABLED !== "true" || !env.SUMMARY_MODEL) {
    return null;
  }

  return summaryPolicy(env.SUMMARY_MODEL);
}

// Binding RPC keeps Think/Workflows runtime imports out of the Next route bundle.
// This is only an acceleration: the committed job remains its durable outbox.
export function notifySummaryJob(workspaceId: string, jobId: string, cancel = false) {
  const { env, ctx } = getCloudflareContext();
  const work = Promise.resolve().then(async () => {
    const agent = env.SUMMARY_AGENT.get(
      env.SUMMARY_AGENT.idFromName(`summary:${workspaceId}:${jobId}`),
    );

    if (cancel) {
      await agent.cancelSummary({ workspaceId, jobId });
    } else {
      await agent.startSummary({ workspaceId, jobId });
    }
  });

  ctx.waitUntil(
    work.catch(() => {
      // Do not log model payloads/provider errors. Scheduled dispatch reconciles
      // uncertain acceptance; persisted cancellation already fences publication.
      console.warn("Summary runtime notification deferred", { workspaceId, jobId, cancel });
    }),
  );
}

export async function summaryEvidence(
  workspaceId: string,
  jobId: string,
  snapshot: { reference: ContextReference; maxContextBytes: number },
) {
  const { env } = getCloudflareContext();
  const context = await readSummarySnapshot(
    env.RECORDING_ARTIFACTS,
    workspaceId,
    jobId,
    snapshot.reference,
    snapshot.maxContextBytes,
  );

  return { snapshotId: context.snapshotId, source: context.source, passages: context.passages };
}
