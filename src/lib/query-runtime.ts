"use client";

import { QueryClient, type QueryFilters } from "@tanstack/react-query";
import { createTRPCClient, httpLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { z } from "zod";

import { RPC_BASE_PATH } from "@/config/api";
import { queryPolicy } from "@/config/query";
import type { ActivityItem } from "@/contracts/activity";
import type { AppRouter } from "@/contracts/rpc";

import { ApiError, asApiError } from "./api-error";

export type QueryIdentity = { userId: string; workspaceId: string; epoch: number };
let identityReader: () => QueryIdentity | null = () => null;
export function configureQueryIdentity(reader: () => QueryIdentity | null) {
  identityReader = reader;
}

const identityKey = (identity: QueryIdentity | null) =>
  identity ? `${identity.userId}:${identity.workspaceId}:${identity.epoch}` : "anonymous";

export function createQueryRuntime(identity: QueryIdentity | null = null) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: queryPolicy.staleTimeMs,
        gcTime: queryPolicy.garbageCollectionTimeMs,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: (count, error) => {
          const failure = asApiError(error);

          return (
            count < queryPolicy.readRetryCount &&
            !(failure instanceof ApiError && failure.status < 500)
          );
        },
      },
      mutations: { retry: false },
    },
  });
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: RPC_BASE_PATH,
        fetch: (url, options) =>
          fetch(url, {
            ...options,
            signal: options?.signal ?? null,
            credentials: "same-origin",
            cache: "no-store",
          }),
      }),
    ],
  });
  const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient });

  return { scope: identityKey(identity), identity, queryClient, client, trpc };
}

export type QueryRuntime = ReturnType<typeof createQueryRuntime>;
let browserRuntime: QueryRuntime | undefined;

/** A browser scope owns its cache; server rendering never shares one across requests. */
export function getQueryRuntime(): QueryRuntime {
  if (typeof window === "undefined") {
    return createQueryRuntime();
  }

  const identity = identityReader();
  if (!browserRuntime || browserRuntime.scope !== identityKey(identity)) {
    const previous = browserRuntime;
    browserRuntime = createQueryRuntime(identity);
    if (previous) {
      void previous.queryClient.cancelQueries();
      previous.queryClient.clear();
    }
  }

  return browserRuntime;
}

const changeSchema = z.object({
  resource: z.enum([
    "notes",
    "people",
    "recordings",
    "transcript",
    "summaries",
    "contacts",
    "assistant",
    "research",
    "researchRuns",
  ]),
  workspaceId: z.uuid(),
  id: z.uuid().optional(),
  noteId: z.uuid().optional(),
  runId: z.uuid().optional(),
});

type Change = z.infer<typeof changeSchema>;

let channel: BroadcastChannel | undefined;

async function refreshWorkspaceOverview(runtime: QueryRuntime, workspaceId: string) {
  const filter = runtime.trpc.workspace.overview.queryFilter({ workspaceId });
  // Invalidation alone reuses a pending initial read with no cached data.
  await runtime.queryClient.cancelQueries(filter);
  if (runtime !== getQueryRuntime() || runtime.identity?.workspaceId !== workspaceId) {
    return;
  }

  await runtime.queryClient.invalidateQueries(filter);
}

function invalidate(runtime: QueryRuntime, change: Change, detailUpdated = false) {
  const { queryClient: cache, trpc } = runtime;
  const scope = { workspaceId: change.workspaceId };

  if (change.resource === "researchRuns") {
    const filters: QueryFilters[] = [
      trpc.researchRuns.list.queryFilter(scope),
      trpc.researchRuns.get.queryFilter({
        ...scope,
        ...(change.id ? { runId: change.id } : {}),
      }),
    ];

    return Promise.all(filters.map((filter) => cache.cancelQueries(filter))).then(async () => {
      if (runtime === getQueryRuntime()) {
        await Promise.all(filters.map((filter) => cache.invalidateQueries(filter)));
      }
    });
  }

  if (change.resource === "research") {
    const filter = trpc.research.list.queryFilter({
      ...scope,
      ...(change.id ? { personId: change.id } : {}),
    });

    return cache.cancelQueries(filter).then(async () => {
      if (runtime === getQueryRuntime()) {
        await cache.invalidateQueries(filter);
      }
    });
  }

  if (change.resource === "contacts" || change.resource === "assistant") {
    const filters: QueryFilters[] =
      change.resource === "contacts"
        ? [
            trpc.contacts.get.queryFilter({
              ...scope,
              ...(change.id ? { personId: change.id } : {}),
            }),
          ]
        : [
            trpc.assistant.threads.queryFilter({
              ...scope,
              ...(change.noteId ? { noteId: change.noteId } : {}),
            }),
            trpc.assistant.history.queryFilter({
              ...scope,
              ...(change.id ? { threadId: change.id } : {}),
            }),
            trpc.assistant.history.infiniteQueryFilter({
              ...scope,
              ...(change.id ? { threadId: change.id } : {}),
            }),
            trpc.assistant.conversationSummary.queryFilter({
              ...scope,
              ...(change.id ? { threadId: change.id } : {}),
            }),
            trpc.assistant.artifacts.queryFilter({
              ...scope,
              ...(change.noteId ? { noteId: change.noteId } : {}),
            }),
          ];

    return Promise.all(
      filters.map(async (filter) => {
        await cache.cancelQueries(filter);

        if (runtime === getQueryRuntime()) {
          await cache.invalidateQueries(filter);
        }
      }),
    ).then(() => {});
  }

  const transcriptScope = {
    ...scope,
    ...(change.noteId ? { noteId: change.noteId } : {}),
    ...(change.runId ? { runId: change.runId } : {}),
  };
  const tasks: Promise<void>[] = [];
  if (change.resource !== "transcript" && change.resource !== "summaries") {
    tasks.push(refreshWorkspaceOverview(runtime, change.workspaceId));
  }

  tasks.push(refreshSummaries(runtime, change));

  switch (change.resource) {
    case "notes":
      tasks.push(cache.invalidateQueries(trpc.notes.list.queryFilter(scope)));
      tasks.push(cache.invalidateQueries(trpc.notes.list.infiniteQueryFilter(scope)));
      if (!detailUpdated) {
        tasks.push(
          cache.invalidateQueries(
            trpc.notes.get.queryFilter({ ...scope, ...(change.id ? { id: change.id } : {}) }),
          ),
        );
      }

      tasks.push(cache.invalidateQueries(trpc.people.appearances.queryFilter(scope)));
      tasks.push(cache.invalidateQueries(trpc.people.appearances.infiniteQueryFilter(scope)));
      tasks.push(
        cache.invalidateQueries(
          trpc.workspace.history.queryFilter({
            ...scope,
            entityType: "note",
            ...(change.id ? { entityId: change.id } : {}),
          }),
        ),
      );
      break;
    case "people":
      tasks.push(
        (async () => {
          const self = trpc.selfProfile.get.queryFilter(scope);
          await cache.cancelQueries(self);

          if (runtime === getQueryRuntime()) {
            await cache.invalidateQueries(self);
          }
        })(),
      );
      tasks.push(cache.invalidateQueries(trpc.people.list.queryFilter(scope)));
      tasks.push(cache.invalidateQueries(trpc.people.list.infiniteQueryFilter(scope)));
      if (!detailUpdated) {
        tasks.push(
          cache.invalidateQueries(
            trpc.people.get.queryFilter({ ...scope, ...(change.id ? { id: change.id } : {}) }),
          ),
        );
      }

      // Names are currently materialized in corrected transcript DTOs.
      tasks.push(cache.invalidateQueries(trpc.transcripts.page.queryFilter(scope)));
      tasks.push(cache.invalidateQueries(trpc.transcripts.page.infiniteQueryFilter(scope)));
      tasks.push(
        cache.invalidateQueries(
          trpc.workspace.history.queryFilter({
            ...scope,
            entityType: "person",
            ...(change.id ? { entityId: change.id } : {}),
          }),
        ),
      );
      break;
    case "recordings":
      tasks.push(
        cache.invalidateQueries(
          trpc.recordings.overview.queryFilter({
            ...scope,
            ...(change.noteId ? { noteId: change.noteId } : {}),
          }),
        ),
      );
      break;
    case "transcript":
      tasks.push(
        cache.invalidateQueries(trpc.transcripts.page.infiniteQueryFilter(transcriptScope)),
      );
      tasks.push(
        cache.invalidateQueries(trpc.transcripts.history.infiniteQueryFilter(transcriptScope)),
      );
      tasks.push(cache.invalidateQueries(trpc.people.appearances.infiniteQueryFilter(scope)));
      tasks.push(
        cache.invalidateQueries(
          trpc.transcripts.page.queryFilter({
            ...scope,
            ...(change.noteId ? { noteId: change.noteId } : {}),
            ...(change.runId ? { runId: change.runId } : {}),
          }),
        ),
      );
      tasks.push(
        cache.invalidateQueries(
          trpc.transcripts.history.queryFilter({
            ...scope,
            ...(change.noteId ? { noteId: change.noteId } : {}),
            ...(change.runId ? { runId: change.runId } : {}),
          }),
        ),
      );
      tasks.push(
        cache.invalidateQueries(
          trpc.transcripts.targets.queryFilter({
            ...scope,
            ...(change.noteId ? { noteId: change.noteId } : {}),
            ...(change.runId ? { runId: change.runId } : {}),
          }),
        ),
      );
      tasks.push(cache.invalidateQueries(trpc.people.appearances.queryFilter(scope)));
      break;
    case "summaries":
      tasks.push(cache.invalidateQueries(trpc.summaries.job.queryFilter(scope)));
      break;
  }

  return Promise.all(tasks).then(() => {});
}

async function refreshSummaries(runtime: QueryRuntime, change: Change) {
  const { queryClient: cache, trpc } = runtime;
  const workspaceId = change.workspaceId;
  const noteId = change.resource === "notes" ? change.id : change.noteId;
  const input = { workspaceId, ...(noteId ? { noteId } : {}) };
  const resultFilter = {
    ...trpc.summaries.result.queryFilter({ workspaceId }),
    predicate: (query: { state: { data: unknown } }) => {
      const value = query.state.data as { summary?: { noteId?: string } } | undefined;
      // Unresolved reads must also be cancelled: their source note is not known yet.

      return !noteId || !value?.summary || value.summary.noteId === noteId;
    },
  };
  const filters: QueryFilters[] = [
    trpc.summaries.overview.queryFilter(input),
    trpc.summaries.history.infiniteQueryFilter(input),
    resultFilter,
  ];
  await Promise.all(filters.map((filter) => cache.cancelQueries(filter)));
  if (runtime !== getQueryRuntime() || runtime.identity?.workspaceId !== workspaceId) {
    return;
  }

  if (change.resource === "transcript" || change.resource === "notes") {
    cache.setQueriesData<{ summary: unknown; freshness: "current" | "stale" }>(
      resultFilter,
      (current) => current && { ...current, freshness: "stale" },
    );
  }

  await Promise.all(filters.map((filter) => cache.invalidateQueries(filter)));
}

export async function notifyQueryChange(
  resource: Change["resource"],
  input: Omit<Change, "resource">,
  runtime = getQueryRuntime(),
  detailUpdated = false,
) {
  if (runtime !== getQueryRuntime() || runtime.identity?.workspaceId !== input.workspaceId) {
    return;
  }

  const change = changeSchema.parse({ resource, ...input });
  channel?.postMessage({ userId: runtime.identity.userId, change });
  await invalidate(runtime, change, detailUpdated);
}

/** Saved events are invalidation hints; authorized queries still own the records. */
export async function applyActivityChanges(
  workspaceId: string,
  items: ActivityItem[],
  runtime = getQueryRuntime(),
) {
  if (runtime !== getQueryRuntime() || runtime.identity?.workspaceId !== workspaceId) {
    return;
  }

  const changes = new Map<string, Change>();
  for (const item of items) {
    const add = (resource: Change["resource"], id?: string, noteId?: string) => {
      const change = {
        resource,
        workspaceId,
        ...(id ? { id } : {}),
        ...(noteId ? { noteId } : {}),
      };
      changes.set(`${resource}:${id ?? ""}:${noteId ?? ""}`, change);
    };

    switch (item.type) {
      case "note.changed":
        add("notes", item.noteId ?? undefined, item.noteId ?? undefined);
        break;
      case "profile.changed":
        add("people", item.personId ?? undefined);
        add("contacts", item.personId ?? undefined);
        break;
      case "transcript.ready":
        add("recordings", undefined, item.noteId ?? undefined);
        add("transcript", undefined, item.noteId ?? undefined);
        break;
      case "transcript.corrected":
        add("transcript", undefined, item.noteId ?? undefined);
        break;
      case "summary.published":
      case "summary.failed":
        add("summaries", undefined, item.noteId ?? undefined);
        break;
      case "research.completed":
      case "research.failed":
        if (item.runId) {
          add("researchRuns", item.runId);
        } else {
          add("research", item.personId ?? undefined);
          add("contacts", item.personId ?? undefined);
        }

        break;
    }
  }

  // Each browser receives its own feed; avoid rebroadcasting the same page.
  await Promise.all([...changes.values()].map((change) => invalidate(runtime, change)));
}

/** Only the persistent provider owns the cross-tab listener. Messages carry no records. */
export function watchQueryChanges() {
  if (typeof BroadcastChannel === "undefined") {
    return () => {};
  }

  const local = new BroadcastChannel("voidnote-query-invalidation-v1");
  channel = local;
  local.onmessage = (event: MessageEvent<unknown>) => {
    const parsed = z.object({ userId: z.uuid(), change: changeSchema }).safeParse(event.data);
    if (!parsed.success) {
      return;
    }

    const runtime = getQueryRuntime();
    if (
      runtime.identity?.userId !== parsed.data.userId ||
      runtime.identity.workspaceId !== parsed.data.change.workspaceId
    ) {
      return;
    }

    void invalidate(runtime, parsed.data.change);
  };

  return () => {
    local.close();
    if (channel === local) {
      channel = undefined;
    }
  };
}
