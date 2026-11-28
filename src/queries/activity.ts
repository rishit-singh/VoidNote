"use client";

import { queryPolicy } from "@/config/query";
import { getQueryRuntime } from "@/lib/query-runtime";
export {
  createActivityNotificationTracker,
  isBackgroundCompletion,
  safeActivityHref,
} from "./activity-notifications";

export const ACTIVITY_PAGE_SIZE = 20;
export const ACTIVITY_POLL_INTERVAL_MS = 20_000;
export const ACTIVITY_HEALTHY_POLL_INTERVAL_MS = 60_000;

export function activityPageQueryOptions(workspaceId: string, before?: string) {
  return getQueryRuntime().trpc.activity.list.queryOptions(
    {
      workspaceId,
      limit: ACTIVITY_PAGE_SIZE,
      ...(before ? { before } : {}),
    },
    {
      enabled: !!workspaceId,
      staleTime: queryPolicy.staleTimeMs,
      refetchInterval: 45_000,
      trpc: { abortOnUnmount: true },
    },
  );
}

export function activityChangesQueryOptions(
  workspaceId: string,
  after: string,
  socketHealthy: boolean,
) {
  return getQueryRuntime().trpc.activity.changes.queryOptions(
    { workspaceId, after },
    {
      enabled: !!workspaceId && !!after,
      staleTime: 0,
      refetchInterval: socketHealthy
        ? ACTIVITY_HEALTHY_POLL_INTERVAL_MS
        : ACTIVITY_POLL_INTERVAL_MS,
      trpc: { abortOnUnmount: true },
    },
  );
}
