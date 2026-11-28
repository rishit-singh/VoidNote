"use client";

import { MutationObserver, type QueryFilters } from "@tanstack/react-query";

import { queryPolicy } from "@/config/query";
import {
  assistantOutputLeaseSchema,
  type AssistantOutputScope,
  type AssistantThread,
  type AssistantTurn,
} from "@/contracts/assistant";
import { ApiError, asApiError, rpcCall } from "@/lib/api-error";
import { getQueryRuntime, notifyQueryChange, type QueryRuntime } from "@/lib/query-runtime";
import {
  type AssistantCancellation,
  type AssistantRecoveryScope,
  pendingAssistant,
  type PendingAssistantTurn,
} from "@/stores/pending-assistant";

const ACTIVE_INTERVAL_MS = 1_500;
const CONVERSATION_SUMMARY_INTERVAL_MS = 30_000;
const CONVERSATION_SUMMARY_STALE_MS = 60_000;
const flights = new WeakMap<QueryRuntime, Map<string, Promise<AssistantTurn>>>();

/** Leases are credentials, not cached query records or durable commands. */
export async function requestAssistantOutputLease(
  scope: AssistantOutputScope,
  runtime = getQueryRuntime(),
) {
  if (runtime !== getQueryRuntime() || runtime.identity?.workspaceId !== scope.workspaceId) {
    throw new Error("The Assistant output session changed.");
  }

  const mutation = new MutationObserver(
    runtime.queryClient,
    runtime.trpc.assistant.outputLease.mutationOptions({ retry: false, gcTime: 0 }),
  );
  try {
    const lease = await rpcCall(() => mutation.mutate(scope));
    if (runtime !== getQueryRuntime()) {
      throw new Error("The Assistant output session changed.");
    }

    return assistantOutputLeaseSchema.parse(lease);
  } finally {
    mutation.reset();
  }
}

/** Socket terminal hints refresh SQL-backed records; they never publish text. */
export async function refreshAssistantOutput(
  scope: AssistantOutputScope & { noteId: string },
  runtime = getQueryRuntime(),
) {
  if (runtime !== getQueryRuntime() || runtime.identity?.workspaceId !== scope.workspaceId) {
    return;
  }

  const filters: QueryFilters[] = [
    runtime.trpc.assistant.history.queryFilter({
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
    }),
    runtime.trpc.assistant.history.infiniteQueryFilter({
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
    }),
    runtime.trpc.assistant.artifacts.queryFilter({
      workspaceId: scope.workspaceId,
      noteId: scope.noteId,
    }),
  ];
  await Promise.all(filters.map((filter) => runtime.queryClient.cancelQueries(filter)));
  if (runtime !== getQueryRuntime()) {
    return;
  }

  await Promise.all(filters.map((filter) => runtime.queryClient.invalidateQueries(filter)));
}

export function assistantAvailabilityQueryOptions(workspaceId: string) {
  return getQueryRuntime().trpc.assistant.availability.queryOptions(
    { workspaceId },
    { staleTime: queryPolicy.staleTimeMs, trpc: { abortOnUnmount: true } },
  );
}

export function assistantThreadsQueryOptions(workspaceId: string, noteId: string) {
  return getQueryRuntime().trpc.assistant.threads.queryOptions(
    { workspaceId, noteId },
    { staleTime: 0, trpc: { abortOnUnmount: true } },
  );
}

export function assistantConversationSummaryQueryOptions(
  workspaceId: string,
  threadId: string,
  verifiedThread: boolean,
) {
  const runtime = getQueryRuntime();

  return runtime.trpc.assistant.conversationSummary.queryOptions(
    { workspaceId, threadId },
    {
      enabled: verifiedThread && !!threadId && runtime.identity?.workspaceId === workspaceId,
      staleTime: CONVERSATION_SUMMARY_STALE_MS,
      refetchInterval: CONVERSATION_SUMMARY_INTERVAL_MS,
      refetchIntervalInBackground: false,
      trpc: { abortOnUnmount: true },
    },
  );
}

export function assistantHistoryQueryOptions(workspaceId: string, threadId: string) {
  const runtime = getQueryRuntime();
  const options = runtime.trpc.assistant.history.infiniteQueryOptions(
    { workspaceId, threadId, limit: 30 },
    {
      enabled: !!threadId,
      staleTime: 0,
      trpc: { abortOnUnmount: true },
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      refetchInterval: (query) =>
        isAssistantTurnActive(query.state.data?.pages[0]?.activeTurn) ? ACTIVE_INTERVAL_MS : false,
    },
  );
  const queryFn = options.queryFn;

  return {
    ...options,
    queryFn: async (context: Parameters<NonNullable<typeof queryFn>>[0]) => {
      if (!queryFn) {
        throw new Error("Assistant history has no query function.");
      }

      const page = await queryFn(context);
      if (!context.pageParam && runtime === getQueryRuntime()) {
        const previous = runtime.queryClient.getQueryData(options.queryKey)?.pages[0];
        const previousTools = new Set(
          previous?.messages.flatMap((message) =>
            message.tools.filter((tool) => tool.status === "succeeded").map((tool) => tool.id),
          ),
        );
        const createdItem = page.messages.some((message) =>
          message.tools.some(
            (tool) =>
              tool.name === "artifact_create" &&
              tool.status === "succeeded" &&
              !previousTools.has(tool.id),
          ),
        );
        if (
          createdItem ||
          (isAssistantTurnActive(previous?.activeTurn) && !isAssistantTurnActive(page.activeTurn))
        ) {
          const filters: QueryFilters[] = [
            runtime.trpc.assistant.artifacts.queryFilter({
              workspaceId,
              ...(page.thread.noteId ? { noteId: page.thread.noteId } : {}),
            }),
          ];
          if (createdItem) {
            filters.push(
              runtime.trpc.notes.list.queryFilter({ workspaceId }),
              runtime.trpc.notes.list.infiniteQueryFilter({ workspaceId }),
              runtime.trpc.workspace.overview.queryFilter({ workspaceId }),
            );
          }

          // Refresh related projections after saved tool results/terminal snapshots.
          // Do not invalidate this in-flight history read from within itself.
          void Promise.all(
            filters.map(async (filter) => {
              await runtime.queryClient.cancelQueries(filter);
              if (runtime === getQueryRuntime()) {
                await runtime.queryClient.invalidateQueries(filter);
              }
            }),
          ).catch(() => {});
        }
      }

      return page;
    },
  };
}

export function assistantArtifactsQueryOptions(workspaceId: string, noteId: string) {
  return getQueryRuntime().trpc.assistant.artifacts.queryOptions(
    { workspaceId, noteId },
    {
      staleTime: 0,
      trpc: { abortOnUnmount: true },
      // Saved tool results and terminal history/socket snapshots refresh this list.
      // History polling also covers lost sockets; a second timer duplicates those reads.
    },
  );
}

export function assistantArtifactQueryOptions(workspaceId: string, id: string) {
  return getQueryRuntime().trpc.assistant.artifact.queryOptions(
    { workspaceId, id },
    { enabled: !!id, staleTime: 0, trpc: { abortOnUnmount: true } },
  );
}

export function isAssistantTurnActive(turn: AssistantTurn | null | undefined) {
  return turn?.status === "queued" || turn?.status === "running";
}

type SendInput = { workspaceId: string; threadId: string; turnId: string; text: string };

type OpenInput = { workspaceId: string; threadId: string; noteId: string | null };

type Dependencies = {
  getRuntime: () => QueryRuntime;
  open: (runtime: QueryRuntime, input: OpenInput) => Promise<AssistantThread>;
  send: (runtime: QueryRuntime, input: SendInput) => Promise<AssistantTurn>;
  cancel: (
    runtime: QueryRuntime,
    input: { workspaceId: string; turnId: string },
  ) => Promise<AssistantTurn>;
  notify: (
    runtime: QueryRuntime,
    scope: AssistantRecoveryScope,
    threadId: string,
  ) => void | Promise<void>;
};

const defaults: Dependencies = {
  getRuntime: getQueryRuntime,
  open: async (runtime, input) => {
    const mutation = new MutationObserver(
      runtime.queryClient,
      runtime.trpc.assistant.open.mutationOptions({ retry: false }),
    );
    try {
      return await rpcCall(() => mutation.mutate(input));
    } finally {
      mutation.reset();
    }
  },
  send: async (runtime, input) => {
    const mutation = new MutationObserver(
      runtime.queryClient,
      runtime.trpc.assistant.send.mutationOptions({ retry: false }),
    );
    try {
      return await rpcCall(() => mutation.mutate(input));
    } finally {
      mutation.reset();
    }
  },
  cancel: async (runtime, input) => {
    const mutation = new MutationObserver(
      runtime.queryClient,
      runtime.trpc.assistant.cancel.mutationOptions({ retry: false }),
    );
    try {
      return await rpcCall(() => mutation.mutate(input));
    } finally {
      mutation.reset();
    }
  },
  notify: (runtime, scope, threadId) =>
    notifyQueryChange(
      "assistant",
      { workspaceId: scope.workspaceId, noteId: scope.noteId, id: threadId },
      runtime,
    ),
};

function requireOwner(runtime: QueryRuntime, scope: AssistantRecoveryScope) {
  if (
    runtime.identity?.userId !== scope.userId ||
    runtime.identity.workspaceId !== scope.workspaceId
  ) {
    throw new Error("This message belongs to a previous workspace session.");
  }
}

function currentOwner(runtime: QueryRuntime, dependencies: Dependencies) {
  return dependencies.getRuntime() === runtime;
}

/** Replay only a persisted, identical intent. Ordinary query retries never send a turn. */
export function requestAssistantTurn(
  command: PendingAssistantTurn,
  overrides: Partial<Dependencies> = {},
) {
  const dependencies = { ...defaults, ...overrides };
  const runtime = dependencies.getRuntime();
  requireOwner(runtime, command);
  const pending = pendingAssistant(command).read().pending;
  if (
    !pending ||
    pending.turnId !== command.turnId ||
    pending.threadId !== command.threadId ||
    pending.text !== command.text ||
    pending.status !== "pending"
  ) {
    return Promise.reject(new Error("This message is no longer pending."));
  }

  const runtimeFlights = flights.get(runtime) ?? new Map<string, Promise<AssistantTurn>>();
  flights.set(runtime, runtimeFlights);
  const existing = runtimeFlights.get(command.turnId);
  if (existing) {
    return existing;
  }

  const flight = sendOnce(runtime, command, dependencies).finally(() => {
    runtimeFlights.delete(command.turnId);
  });
  runtimeFlights.set(command.turnId, flight);

  return flight;
}

async function sendOnce(
  runtime: QueryRuntime,
  command: PendingAssistantTurn,
  dependencies: Dependencies,
) {
  const recovery = pendingAssistant(command);
  let accepted = false;
  try {
    const thread = await dependencies.open(runtime, {
      workspaceId: command.workspaceId,
      threadId: command.threadId,
      noteId: command.noteId,
    });
    if (!currentOwner(runtime, dependencies)) {
      throw new Error("This message belongs to a previous workspace session.");
    }

    await runtime.queryClient.cancelQueries(
      runtime.trpc.assistant.threads.queryFilter({
        workspaceId: command.workspaceId,
        noteId: command.noteId,
      }),
    );
    if (!currentOwner(runtime, dependencies)) {
      throw new Error("This message belongs to a previous workspace session.");
    }

    runtime.queryClient.setQueryData(
      runtime.trpc.assistant.threads.queryKey({
        workspaceId: command.workspaceId,
        noteId: command.noteId,
      }),
      (threads: AssistantThread[] | undefined) => [
        thread,
        ...(threads ?? []).filter((item) => item.id !== thread.id),
      ],
    );
    const turn = await dependencies.send(runtime, {
      workspaceId: command.workspaceId,
      threadId: command.threadId,
      turnId: command.turnId,
      text: command.text,
    });
    accepted = true;
    if (!currentOwner(runtime, dependencies)) {
      return turn;
    }

    await recovery.acknowledge(command);
    if (currentOwner(runtime, dependencies)) {
      // A receipt may describe an earlier state; refresh persisted history instead of
      // overwriting it with the receipt or manufacturing an assistant message.
      void Promise.resolve(dependencies.notify(runtime, command, command.threadId)).catch(() => {});
    }

    return turn;
  } catch (error) {
    const failure = asApiError(error);
    if (
      !accepted &&
      currentOwner(runtime, dependencies) &&
      failure instanceof ApiError &&
      [400, 403, 404, 409, 422].includes(failure.status)
    ) {
      await recovery.reject(command, failure.message);
    }

    throw failure;
  }
}

export function cancelAssistantTurn(
  scope: AssistantRecoveryScope,
  command: AssistantCancellation,
  overrides: Partial<Dependencies> = {},
) {
  const dependencies = { ...defaults, ...overrides };
  const runtime = dependencies.getRuntime();
  requireOwner(runtime, scope);
  const recovery = pendingAssistant(scope);
  const saved = recovery.prepareCancellation(command);
  const runtimeFlights = flights.get(runtime) ?? new Map<string, Promise<AssistantTurn>>();
  flights.set(runtime, runtimeFlights);
  const key = `stop:${saved.turnId}`;
  const existing = runtimeFlights.get(key);
  if (existing) {
    return existing;
  }

  const flight = cancelOnce(runtime, scope, saved, dependencies).finally(() => {
    runtimeFlights.delete(key);
  });
  runtimeFlights.set(key, flight);

  return flight;
}

async function cancelOnce(
  runtime: QueryRuntime,
  scope: AssistantRecoveryScope,
  saved: AssistantCancellation,
  dependencies: Dependencies,
) {
  const turn = await dependencies.cancel(runtime, {
    workspaceId: scope.workspaceId,
    turnId: saved.turnId,
  });
  if (currentOwner(runtime, dependencies)) {
    await pendingAssistant(scope).acknowledgeCancellation(saved);
    if (currentOwner(runtime, dependencies)) {
      void Promise.resolve(dependencies.notify(runtime, scope, saved.threadId)).catch(() => {});
    }
  }

  return turn;
}
