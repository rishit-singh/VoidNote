"use client";

import { MutationObserver } from "@tanstack/react-query";

import { queryPolicy } from "@/config/query";
import type { AnalysisJob, SummaryOverview } from "@/contracts/analysis";
import { ApiError, asApiError, rpcCall } from "@/lib/api-error";
import { getQueryRuntime, notifyQueryChange, type QueryRuntime } from "@/lib/query-runtime";

const ACTIVE_INTERVAL_MS = 1_500;
const summaryRequestFlights = new Map<string, Promise<AnalysisJob>>();

export function summaryOverviewQueryOptions(workspaceId: string, noteId: string) {
  return getQueryRuntime().trpc.summaries.overview.queryOptions(
    { workspaceId, noteId },
    {
      enabled: !!workspaceId && !!noteId,
      staleTime: queryPolicy.staleTimeMs,
      trpc: { abortOnUnmount: true },
    },
  );
}

export function summaryJobQueryOptions(
  workspaceId: string,
  jobId: string,
  dependencies: {
    getRuntime: () => QueryRuntime;
    notifyChange: (
      runtime: QueryRuntime,
      workspaceId: string,
      noteId: string,
    ) => void | Promise<void>;
    fetchJob?: () => Promise<AnalysisJob>;
  } = {
    getRuntime: getQueryRuntime,
    notifyChange: notifySummaryChange,
  },
) {
  const runtime = dependencies.getRuntime();
  const options = runtime.trpc.summaries.job.queryOptions(
    { workspaceId, jobId },
    {
      enabled: !!workspaceId && !!jobId,
      staleTime: queryPolicy.staleTimeMs,
      trpc: { abortOnUnmount: true },
      refetchInterval: (query) =>
        query.state.data?.status === "queued" || query.state.data?.status === "running"
          ? ACTIVE_INTERVAL_MS
          : false,
    },
  );
  const queryFn = options.queryFn;

  return {
    ...options,
    queryFn: async (context: Parameters<NonNullable<typeof queryFn>>[0]) => {
      if (!queryFn) {
        throw new Error("Summary job query has no query function.");
      }

      const job = dependencies.fetchJob ? await dependencies.fetchJob() : await queryFn(context);
      const previous = runtime.queryClient.getQueryData<AnalysisJob>(
        runtime.trpc.summaries.job.queryKey({ workspaceId, jobId }),
      );
      if (
        runtime === dependencies.getRuntime() &&
        (!previous || isActive(previous.status)) &&
        !isActive(job.status)
      ) {
        // Publish terminal state before workspace invalidation reaches this observer.
        runtime.queryClient.setQueryData(
          runtime.trpc.summaries.job.queryKey({ workspaceId, jobId }),
          job,
        );
        void dependencies.notifyChange(runtime, workspaceId, job.noteId);
      }

      return job;
    },
  };
}

export function summaryResultQueryOptions(workspaceId: string, jobId: string) {
  return getQueryRuntime().trpc.summaries.result.queryOptions(
    { workspaceId, jobId },
    {
      enabled: !!workspaceId && !!jobId,
      staleTime: queryPolicy.staleTimeMs,
      trpc: { abortOnUnmount: true },
    },
  );
}

export function summaryEvidenceQueryOptions(workspaceId: string, jobId: string) {
  return getQueryRuntime().trpc.summaries.evidence.queryOptions(
    { workspaceId, jobId },
    {
      enabled: !!workspaceId && !!jobId,
      staleTime: queryPolicy.staleTimeMs,
      trpc: { abortOnUnmount: true },
    },
  );
}

export function summaryHistoryQueryOptions(workspaceId: string, noteId: string) {
  return getQueryRuntime().trpc.summaries.history.infiniteQueryOptions(
    { workspaceId, noteId, limit: 30 },
    {
      enabled: !!workspaceId && !!noteId,
      staleTime: queryPolicy.staleTimeMs,
      trpc: { abortOnUnmount: true },
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    },
  );
}

export function requestSummary(
  workspaceId: string,
  command: { commandId: string; noteId: string; userId: string },
  dependencies: {
    getRuntime: () => QueryRuntime;
    notifyChange: (
      runtime: QueryRuntime,
      workspaceId: string,
      noteId: string,
    ) => void | Promise<void>;
    send: (
      runtime: QueryRuntime,
      workspaceId: string,
      command: { commandId: string; noteId: string },
    ) => Promise<{ job: AnalysisJob }>;
  } = {
    getRuntime: getQueryRuntime,
    notifyChange: notifySummaryChange,
    send: sendSummaryRequest,
  },
) {
  const runtime = dependencies.getRuntime();
  if (runtime.identity?.workspaceId !== workspaceId || runtime.identity.userId !== command.userId) {
    return Promise.reject(new Error("This summary belongs to a previous workspace session."));
  }

  const flightKey = JSON.stringify([
    command.userId,
    workspaceId,
    command.noteId,
    command.commandId,
  ]);
  const existing = summaryRequestFlights.get(flightKey);
  if (existing) {
    return existing;
  }

  const flight = requestSummaryOnce(workspaceId, command, dependencies).finally(() => {
    if (summaryRequestFlights.get(flightKey) === flight) {
      summaryRequestFlights.delete(flightKey);
    }
  });
  summaryRequestFlights.set(flightKey, flight);

  return flight;
}

async function requestSummaryOnce(
  workspaceId: string,
  command: { commandId: string; noteId: string; userId: string },
  dependencies: {
    getRuntime: () => QueryRuntime;
    notifyChange: (
      runtime: QueryRuntime,
      workspaceId: string,
      noteId: string,
    ) => void | Promise<void>;
    send: (
      runtime: QueryRuntime,
      workspaceId: string,
      command: { commandId: string; noteId: string },
    ) => Promise<{ job: AnalysisJob }>;
  },
) {
  const runtime = dependencies.getRuntime();
  if (runtime.identity?.workspaceId !== workspaceId || runtime.identity.userId !== command.userId) {
    throw new Error("This summary belongs to a previous workspace session.");
  }

  const expectedIdentity = runtime.identity;

  const overviewFilter = runtime.trpc.summaries.overview.queryFilter({
    workspaceId,
    noteId: command.noteId,
  });
  const historyFilter = runtime.trpc.summaries.history.infiniteQueryFilter({
    workspaceId,
    noteId: command.noteId,
  });
  await Promise.all([
    runtime.queryClient.cancelQueries(overviewFilter),
    runtime.queryClient.cancelQueries(historyFilter),
  ]);
  if (
    dependencies.getRuntime() !== runtime ||
    runtime.identity !== expectedIdentity ||
    runtime.identity.epoch !== expectedIdentity.epoch
  ) {
    throw new Error("This summary belongs to a previous workspace session.");
  }

  // Keep recovery-only scope out of the strict public RPC command schema.
  const accepted = await dependencies.send(runtime, workspaceId, {
    commandId: command.commandId,
    noteId: command.noteId,
  });
  if (
    dependencies.getRuntime() !== runtime ||
    runtime.identity !== expectedIdentity ||
    runtime.identity.userId !== command.userId ||
    runtime.identity.epoch !== expectedIdentity.epoch
  ) {
    return accepted.job;
  }

  runtime.queryClient.setQueryData(
    runtime.trpc.summaries.job.queryKey({ workspaceId, jobId: accepted.job.id }),
    accepted.job,
  );
  runtime.queryClient.setQueryData(
    runtime.trpc.summaries.overview.queryKey({ workspaceId, noteId: command.noteId }),
    (current: SummaryOverview | undefined) =>
      current ? { ...current, latestJob: accepted.job } : current,
  );
  void Promise.resolve(dependencies.notifyChange(runtime, workspaceId, command.noteId)).catch(
    () => {},
  );

  return accepted.job;
}

export function isDefiniteSummaryRejection(error: unknown) {
  const failure = asApiError(error);

  return failure instanceof ApiError && failure.status >= 400 && failure.status < 500;
}

export async function cancelSummary(
  workspaceId: string,
  jobId: string,
  dependencies: {
    getRuntime: () => QueryRuntime;
    send: (runtime: QueryRuntime, workspaceId: string, jobId: string) => Promise<AnalysisJob>;
    notifyChange: (
      runtime: QueryRuntime,
      workspaceId: string,
      noteId: string,
    ) => void | Promise<void>;
  } = {
    getRuntime: getQueryRuntime,
    send: sendSummaryCancellation,
    notifyChange: notifySummaryChange,
  },
) {
  const runtime = dependencies.getRuntime();
  if (runtime.identity?.workspaceId !== workspaceId) {
    throw new Error("This summary belongs to a previous workspace session.");
  }

  const expectedIdentity = runtime.identity;

  const job = await dependencies.send(runtime, workspaceId, jobId);
  if (
    runtime === dependencies.getRuntime() &&
    runtime.identity === expectedIdentity &&
    runtime.identity?.epoch === expectedIdentity?.epoch &&
    runtime.identity?.userId === expectedIdentity?.userId &&
    runtime.identity?.workspaceId === expectedIdentity?.workspaceId
  ) {
    runtime.queryClient.setQueryData(
      runtime.trpc.summaries.job.queryKey({ workspaceId, jobId }),
      job,
    );
    void Promise.resolve(dependencies.notifyChange(runtime, workspaceId, job.noteId)).catch(
      () => {},
    );
  }

  return job;
}

function isActive(status: AnalysisJob["status"]) {
  return status === "queued" || status === "running";
}

function notifySummaryChange(runtime: QueryRuntime, workspaceId: string, noteId: string) {
  return notifyQueryChange("summaries", { workspaceId, noteId }, runtime);
}

async function sendSummaryRequest(
  runtime: QueryRuntime,
  workspaceId: string,
  command: { commandId: string; noteId: string },
) {
  const mutation = new MutationObserver(
    runtime.queryClient,
    runtime.trpc.summaries.request.mutationOptions({ retry: false }),
  );
  try {
    return await rpcCall(() => mutation.mutate({ workspaceId, command }));
  } finally {
    mutation.reset();
  }
}

async function sendSummaryCancellation(runtime: QueryRuntime, workspaceId: string, jobId: string) {
  const mutation = new MutationObserver(
    runtime.queryClient,
    runtime.trpc.summaries.cancel.mutationOptions({ retry: false }),
  );
  try {
    return await rpcCall(() => mutation.mutate({ workspaceId, jobId }));
  } finally {
    mutation.reset();
  }
}
