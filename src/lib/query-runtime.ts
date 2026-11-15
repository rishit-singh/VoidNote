"use client";

import { createTRPCClient, httpLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import type { AppRouter } from "@/contracts/rpc";
import { asApiError, ApiError } from "./api-error";

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
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: (count, error) => {
          const failure = asApiError(error);
          return count < 1 && !(failure instanceof ApiError && failure.status < 500);
        },
      },
      mutations: { retry: false },
    },
  });
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "/api/trpc",
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
  if (typeof window === "undefined") return createQueryRuntime();
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
  resource: z.enum(["notes", "people", "recordings", "transcript"]),
  workspaceId: z.uuid(),
  id: z.uuid().optional(),
  noteId: z.uuid().optional(),
  runId: z.uuid().optional(),
});
type Change = z.infer<typeof changeSchema>;
let channel: BroadcastChannel | undefined;

function invalidate(runtime: QueryRuntime, change: Change, detailUpdated = false) {
  const { queryClient: cache, trpc } = runtime;
  const scope = { workspaceId: change.workspaceId };
  const transcriptScope = {
    ...scope,
    ...(change.noteId ? { noteId: change.noteId } : {}),
    ...(change.runId ? { runId: change.runId } : {}),
  };
  const tasks: Promise<void>[] = [];
  switch (change.resource) {
    case "notes":
      tasks.push(cache.invalidateQueries(trpc.notes.list.queryFilter(scope)));
      tasks.push(cache.invalidateQueries(trpc.notes.list.infiniteQueryFilter(scope)));
      if (!detailUpdated)
        tasks.push(
          cache.invalidateQueries(
            trpc.notes.get.queryFilter({ ...scope, ...(change.id ? { id: change.id } : {}) }),
          ),
        );
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
      tasks.push(cache.invalidateQueries(trpc.people.list.queryFilter(scope)));
      tasks.push(cache.invalidateQueries(trpc.people.list.infiniteQueryFilter(scope)));
      if (!detailUpdated)
        tasks.push(
          cache.invalidateQueries(
            trpc.people.get.queryFilter({ ...scope, ...(change.id ? { id: change.id } : {}) }),
          ),
        );
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
  }
  return Promise.all(tasks).then(() => {});
}

export async function notifyQueryChange(
  resource: Change["resource"],
  input: Omit<Change, "resource">,
  runtime = getQueryRuntime(),
  detailUpdated = false,
) {
  if (runtime !== getQueryRuntime() || runtime.identity?.workspaceId !== input.workspaceId) return;
  const change = changeSchema.parse({ resource, ...input });
  channel?.postMessage({ userId: runtime.identity.userId, change });
  await invalidate(runtime, change, detailUpdated);
}

/** Only the persistent provider owns the cross-tab listener. Messages carry no records. */
export function watchQueryChanges() {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const local = new BroadcastChannel("voidnote-query-invalidation-v1");
  channel = local;
  local.onmessage = (event: MessageEvent<unknown>) => {
    const parsed = z.object({ userId: z.uuid(), change: changeSchema }).safeParse(event.data);
    if (!parsed.success) return;
    const runtime = getQueryRuntime();
    if (
      runtime.identity?.userId !== parsed.data.userId ||
      runtime.identity.workspaceId !== parsed.data.change.workspaceId
    )
      return;
    void invalidate(runtime, parsed.data.change);
  };
  return () => {
    local.close();
    if (channel === local) channel = undefined;
  };
}
