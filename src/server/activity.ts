import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { activityHubName } from "../contracts/activity";
import type { Principal } from "../contracts/workspace";
import { createActivityRepository } from "../db/activity";
import { withDatabase } from "../db/client";
import { dispatchApplicationEvents } from "../events";

export async function createActivitySubscription(principal: Principal, workspaceId: string) {
  await withDatabase((db) => createActivityRepository(db).assertAccess(principal, workspaceId));
  const { env } = getCloudflareContext();
  const hub = env.ACTIVITY_HUB.getByName(activityHubName(workspaceId, principal.id));
  return { workspaceId, userId: principal.id, ...(await hub.issueTicket()) };
}

/** Post-commit acceleration only; the persisted delivery outbox owns recovery. */
export function notifyApplicationEvents() {
  try {
    const { env, ctx } = getCloudflareContext();
    ctx.waitUntil(dispatchApplicationEvents(env).catch(() => undefined));
  } catch {
    // Non-Worker tests and unavailable runtime context still retain durable intent.
  }
}
