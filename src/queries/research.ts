"use client";

import { MutationObserver } from "@tanstack/react-query";

import { queryPolicy } from "@/config/query";
import type { ResearchBatch, ResearchStatus } from "@/contracts/research";
import { ApiError, asApiError, rpcCall } from "@/lib/api-error";
import { getQueryRuntime, notifyQueryChange, type QueryRuntime } from "@/lib/query-runtime";
import {
  pendingResearch,
  type PendingResearchCommand,
  type ResearchOperation,
  type ResearchRecoveryScope,
} from "@/stores/pending-research";

const ACTIVE_INTERVAL_MS = 2_000;
const flights = new WeakMap<QueryRuntime, Map<string, Promise<ResearchBatch>>>();

export function isResearchActive(status: ResearchStatus | undefined) {
  return status === "queued" || status === "running";
}

export function researchAvailabilityQueryOptions(workspaceId: string) {
  return getQueryRuntime().trpc.research.availability.queryOptions(
    { workspaceId },
    { staleTime: queryPolicy.staleTimeMs, trpc: { abortOnUnmount: true } },
  );
}

export function researchContactQueryOptions(workspaceId: string, personId: string) {
  return getQueryRuntime().trpc.contacts.get.queryOptions(
    { workspaceId, personId },
    { staleTime: queryPolicy.staleTimeMs, trpc: { abortOnUnmount: true } },
  );
}

export function researchListQueryOptions(workspaceId: string, personId: string) {
  return getQueryRuntime().trpc.research.list.queryOptions(
    { workspaceId, personId },
    {
      staleTime: 0,
      trpc: { abortOnUnmount: true },
      refetchInterval: (query) =>
        query.state.data?.some((batch) =>
          batch.items.some((item) => item.personId === personId && isResearchActive(item.status)),
        )
          ? ACTIVE_INTERVAL_MS
          : false,
    },
  );
}

async function executeOperation(runtime: QueryRuntime, operation: ResearchOperation) {
  switch (operation.kind) {
    case "request": {
      const mutation = new MutationObserver(
        runtime.queryClient,
        runtime.trpc.research.request.mutationOptions({ retry: false }),
      );
      try {
        return await rpcCall(() => mutation.mutate(operation.input));
      } finally {
        mutation.reset();
      }
    }

    case "retry": {
      const mutation = new MutationObserver(
        runtime.queryClient,
        runtime.trpc.research.retry.mutationOptions({ retry: false }),
      );
      try {
        return await rpcCall(() => mutation.mutate(operation.input));
      } finally {
        mutation.reset();
      }
    }

    case "cancel": {
      const mutation = new MutationObserver(
        runtime.queryClient,
        runtime.trpc.research.cancel.mutationOptions({ retry: false }),
      );
      try {
        return await rpcCall(() => mutation.mutate(operation.input));
      } finally {
        mutation.reset();
      }
    }
  }
}

type Dependencies = {
  getRuntime: () => QueryRuntime;
  execute: (runtime: QueryRuntime, operation: ResearchOperation) => Promise<ResearchBatch>;
  notify: (runtime: QueryRuntime, scope: ResearchRecoveryScope) => void | Promise<void>;
};

const defaults: Dependencies = {
  getRuntime: getQueryRuntime,
  execute: executeOperation,
  notify: (runtime, scope) =>
    notifyQueryChange("research", { workspaceId: scope.workspaceId, id: scope.personId }, runtime),
};

export function runResearchCommand(
  scope: ResearchRecoveryScope,
  command: PendingResearchCommand,
  overrides: Partial<Dependencies> = {},
) {
  const dependencies = { ...defaults, ...overrides };
  const runtime = dependencies.getRuntime();
  if (
    runtime.identity?.userId !== scope.userId ||
    runtime.identity.workspaceId !== scope.workspaceId
  ) {
    throw new Error("This research belongs to a previous workspace session.");
  }

  const saved = pendingResearch(scope).read().pending;
  if (!saved || saved.status !== "pending" || JSON.stringify(saved) !== JSON.stringify(command)) {
    return Promise.reject(new Error("This research request is no longer pending."));
  }

  const currentFlights = flights.get(runtime) ?? new Map<string, Promise<ResearchBatch>>();
  flights.set(runtime, currentFlights);
  const existing = currentFlights.get(command.id);
  if (existing) {
    return existing;
  }

  const flight = runOnce(runtime, scope, command, dependencies).finally(() => {
    currentFlights.delete(command.id);
  });
  currentFlights.set(command.id, flight);

  return flight;
}

async function runOnce(
  runtime: QueryRuntime,
  scope: ResearchRecoveryScope,
  command: PendingResearchCommand,
  dependencies: Dependencies,
) {
  const recovery = pendingResearch(scope);
  let accepted = false;
  try {
    const batch = await dependencies.execute(runtime, command.operation);
    accepted = true;
    if (dependencies.getRuntime() !== runtime) {
      return batch;
    }

    recovery.acknowledge(command);
    // A receipt can predate later generations/cancellation. Fetch persisted state;
    // never replace a newer list with the acceptance receipt.
    void Promise.resolve(dependencies.notify(runtime, scope)).catch(() => {});

    return batch;
  } catch (error) {
    const failure = asApiError(error);
    if (
      !accepted &&
      dependencies.getRuntime() === runtime &&
      failure instanceof ApiError &&
      [400, 403, 404, 409, 422].includes(failure.status)
    ) {
      recovery.reject(command, failure.message);
    }

    throw failure;
  }
}
