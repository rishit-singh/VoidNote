"use client";

import { MutationObserver } from "@tanstack/react-query";

import type {
  ResearchRunDetail,
  ResearchRunListInput,
  ResearchRunStatus,
} from "@/contracts/research/runs";
import { rpcCall } from "@/lib/api-error";
import { getQueryRuntime, type QueryRuntime } from "@/lib/query-runtime";

export const RESEARCH_RUN_ACTIVE_INTERVAL_MS = 5_000;
export const RESEARCH_RUN_SAFETY_INTERVAL_MS = 20_000;

export function isResearchRunActive(status: ResearchRunStatus | undefined) {
  return status === "queued" || status === "running";
}

export function researchRunQueryOptions(workspaceId: string, runId: string) {
  const runtime = getQueryRuntime();

  return runtime.trpc.researchRuns.get.queryOptions(
    { workspaceId, runId },
    {
      enabled: !!workspaceId && !!runId && runtime.identity?.workspaceId === workspaceId,
      staleTime: 0,
      trpc: { abortOnUnmount: true },
      refetchInterval: (query) =>
        isResearchRunActive(query.state.data?.status)
          ? RESEARCH_RUN_ACTIVE_INTERVAL_MS
          : RESEARCH_RUN_SAFETY_INTERVAL_MS,
      refetchIntervalInBackground: false,
    },
  );
}

export function researchRunListQueryOptions(
  workspaceId: string,
  input: ResearchRunListInput & { noteId?: string; threadId?: string },
) {
  const runtime = getQueryRuntime();

  return runtime.trpc.researchRuns.list.queryOptions(
    { workspaceId, ...input },
    {
      enabled: !!workspaceId && runtime.identity?.workspaceId === workspaceId,
      staleTime: 0,
      trpc: { abortOnUnmount: true },
      refetchInterval: (query) =>
        query.state.data?.some((run: ResearchRunDetail) => isResearchRunActive(run.status))
          ? RESEARCH_RUN_ACTIVE_INTERVAL_MS
          : RESEARCH_RUN_SAFETY_INTERVAL_MS,
      refetchIntervalInBackground: false,
    },
  );
}

type RunCache = ResearchRunDetail | undefined;

function preferCurrent(current: RunCache, incoming: ResearchRunDetail) {
  if (!current) {
    return incoming;
  }

  if (current.status === "completed" && incoming.status !== "completed") {
    return current;
  }

  if (Date.parse(current.updatedAt) > Date.parse(incoming.updatedAt)) {
    return current;
  }

  return incoming;
}

function publishRun(runtime: QueryRuntime, incoming: ResearchRunDetail) {
  const { queryClient, trpc } = runtime;
  const detailKey = trpc.researchRuns.get.queryKey({
    workspaceId: incoming.workspaceId,
    runId: incoming.id,
  });
  const detail = preferCurrent(queryClient.getQueryData<ResearchRunDetail>(detailKey), incoming);
  queryClient.setQueryData(detailKey, detail);

  const listFilter = trpc.researchRuns.list.queryFilter({ workspaceId: incoming.workspaceId });
  for (const [key, current] of queryClient.getQueriesData<ResearchRunDetail[]>(listFilter)) {
    if (!current) {
      continue;
    }

    const existing = current.find((run) => run.id === incoming.id);
    if (!existing) {
      continue;
    }

    const next = preferCurrent(existing, incoming);
    queryClient.setQueryData(
      key,
      current.map((run) => (run.id === incoming.id ? next : run)),
    );
  }

  return detail;
}

async function invalidateRunQueries(runtime: QueryRuntime, workspaceId: string, runId: string) {
  if (runtime !== getQueryRuntime() || runtime.identity?.workspaceId !== workspaceId) {
    return;
  }

  const { queryClient, trpc } = runtime;
  const detailFilter = trpc.researchRuns.get.queryFilter({ workspaceId, runId });
  const listFilter = trpc.researchRuns.list.queryFilter({ workspaceId });
  await Promise.all([
    queryClient.cancelQueries(detailFilter),
    queryClient.cancelQueries(listFilter),
  ]);

  if (runtime !== getQueryRuntime()) {
    return;
  }

  await Promise.all([
    queryClient.invalidateQueries(detailFilter),
    queryClient.invalidateQueries(listFilter),
  ]);
}

/** Cancel only publishes server acknowledgement; pending feedback stays in mutation state. */
export async function cancelResearchRun(workspaceId: string, runId: string) {
  const runtime = getQueryRuntime();
  if (runtime.identity?.workspaceId !== workspaceId) {
    throw new Error("This research run belongs to a previous workspace session.");
  }

  const { queryClient, trpc } = runtime;
  const detailFilter = trpc.researchRuns.get.queryFilter({ workspaceId, runId });
  const listFilter = trpc.researchRuns.list.queryFilter({ workspaceId });
  await Promise.all([
    queryClient.cancelQueries(detailFilter),
    queryClient.cancelQueries(listFilter),
  ]);
  if (runtime !== getQueryRuntime()) {
    throw new Error("The workspace session changed before cancellation.");
  }

  const detailKey = trpc.researchRuns.get.queryKey({ workspaceId, runId });
  const previousDetail = queryClient.getQueryData<ResearchRunDetail>(detailKey);
  if (previousDetail?.status === "completed" || previousDetail?.status === "cancelled") {
    return previousDetail;
  }

  const mutation = new MutationObserver(
    queryClient,
    trpc.researchRuns.cancel.mutationOptions({ retry: false }),
  );

  try {
    const result = await rpcCall(() => mutation.mutate({ workspaceId, runId }));
    if (runtime !== getQueryRuntime()) {
      return result;
    }

    publishRun(runtime, result);

    return result;
  } finally {
    mutation.reset();
    void invalidateRunQueries(runtime, workspaceId, runId).catch(() => {});
  }
}
