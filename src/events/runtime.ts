import { z } from "zod";

import { withJobDatabase } from "../ai/jobs";
import { readSummaryPolicy } from "../config/summary";
import { createActivityRepository } from "../db/activity";
import { createAnalysisRepository } from "../db/analysis";
import { WorkspaceError } from "../contracts/workspace";
import { activityHubName } from "../contracts/activity";

const deliveryMessageSchema = z.object({ deliveryId: z.uuid() }).strict();

type EventEnvironment = Pick<Cloudflare.Env, "HYPERDRIVE"> & {
  EVENT_QUEUE?: Queue<{ deliveryId: string }>;
  ACTIVITY_HUB?: Cloudflare.Env["ACTIVITY_HUB"];
  SUMMARY_AUTO_ENABLED?: string;
  SUMMARY_ENABLED?: string;
  SUMMARY_MODEL?: string;
  SUMMARY_BUDGET_ID?: string;
  SUMMARY_REASONING_EFFORT?: string;
};

export async function consumeEventDelivery(env: EventEnvironment, value: unknown) {
  const message = deliveryMessageSchema.parse(value);
  const claim = await withJobDatabase(env, (db) =>
    createActivityRepository(db).claim(message.deliveryId),
  );
  if (!claim) return;

  try {
    if (claim.subscriber === "activity-v1") {
      await withJobDatabase(env, (db) => createActivityRepository(db).notify(claim.event));
      if (env.ACTIVITY_HUB) {
        // The saved feed is authoritative even if this wakeup is lost.
        await env.ACTIVITY_HUB.getByName(
          activityHubName(claim.event.workspaceId, claim.event.actorId),
        )
          .publish()
          .catch(() => undefined);
      }
    } else if (claim.subscriber === "automatic-summary-v1" && env.SUMMARY_AUTO_ENABLED === "true") {
      const event = claim.event;
      const policy = readSummaryPolicy(env);
      const { noteId, runId, generation } = event;
      if (policy && noteId && runId && generation !== undefined) {
        try {
          // Admission creates the existing durable Summary dispatch intent.
          // Its scheduled reconciler owns execution, not the queue delivery.
          await withJobDatabase(env, (db) =>
            createAnalysisRepository(db).request(
              { id: event.actorId, email: null },
              event.workspaceId,
              { commandId: event.id, noteId },
              policy,
              { runId, generation },
            ),
          );
        } catch (error) {
          // Deleted/stale sources are obsolete events, not jobs to keep retrying.
          if (
            !(error instanceof WorkspaceError) ||
            !["conflict", "not_found", "forbidden"].includes(error.code)
          )
            throw error;
        }
      }
    }
    await withJobDatabase(env, (db) =>
      createActivityRepository(db).complete(claim.id, claim.leaseId),
    );
  } catch {
    await withJobDatabase(env, (db) =>
      createActivityRepository(db).retry(claim.id, claim.leaseId, claim.attempts),
    );
    // Durable retry state owns backoff. A duplicate message cannot bypass it.
  }
}

export async function dispatchApplicationEvents(env: EventEnvironment) {
  const pending = await withJobDatabase(env, (db) =>
    createActivityRepository(db).reserveDispatch(),
  );
  for (const delivery of pending) {
    try {
      if (env.EVENT_QUEUE) {
        await env.EVENT_QUEUE.send({ deliveryId: delivery.id });
      } else {
        // Local/incremental deployment fallback uses the exact same receipt path.
        await consumeEventDelivery(env, { deliveryId: delivery.id });
      }
    } catch {
      console.warn("events.dispatch.deferred", { deliveryId: delivery.id });
    }
  }
}
