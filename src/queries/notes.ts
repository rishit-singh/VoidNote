"use client";

import type { InfiniteData, QueryKey } from "@tanstack/react-query";
import { MutationObserver } from "@tanstack/react-query";
import { z } from "zod";

import { queryPolicy } from "@/config/query";
import type { NoteListItem, NoteRecord, SaveNote } from "@/contracts/notes";
import { noteListItemSchema } from "@/contracts/notes";
import { rpcCall } from "@/lib/api-error";
import type { QueryRuntime } from "@/lib/query-runtime";
import { getQueryRuntime, notifyQueryChange } from "@/lib/query-runtime";

type NotePage = { items: NoteListItem[]; nextCursor: string | null };

// Read the input from generated tRPC keys; never construct query keys ourselves.
const listKeyOptions = z.object({
  input: z.object({
    q: z.string().optional(),
    cursor: z.string().nullish(),
  }),
});

export function notesQueryOptions(workspaceId: string | undefined, search = "") {
  return getQueryRuntime().trpc.notes.list.infiniteQueryOptions(
    { workspaceId: workspaceId ?? "", q: search, limit: queryPolicy.notesPageSize },
    {
      enabled: !!workspaceId,
      trpc: { abortOnUnmount: true },
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
}

/** Keep loaded rows/cursors intact until refresh, even when the saved row moves to the head. */
function reconcilePages(pages: NotePage[], key: QueryKey, incoming: NoteListItem): NotePage[] {
  const options = listKeyOptions.safeParse(key.at(-1));

  if (!options.success || pages.length === 0) {
    return pages;
  }

  const current = pages.flatMap((page) => page.items).find((item) => item.id === incoming.id);
  const note = current && current.revision > incoming.revision ? current : incoming;
  const matches =
    note.deletedAt === null &&
    note.title.toLowerCase().startsWith((options.data.input.q ?? "").toLowerCase());
  const next = pages.map((page) => ({
    ...page,
    items: page.items.filter((item) => item.id !== note.id),
  }));

  // A standalone cursor page cannot determine whether an unseen row belongs to it.
  // Infinite queries start at the head and retain every loaded row without truncation.
  if (matches && (!options.data.input.cursor || current)) {
    const first = next[0];

    if (first) {
      first.items = [note, ...first.items];
      first.items.sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
      );
    }
  }

  return next;
}

export async function reconcileNoteSnapshot(
  incoming: NoteRecord,
  runtime: QueryRuntime = getQueryRuntime(),
) {
  if (runtime !== getQueryRuntime() || runtime.identity?.workspaceId !== incoming.workspaceId) {
    return;
  }

  const { queryClient: cache, trpc } = runtime;
  const scope = { workspaceId: incoming.workspaceId };

  // Cancel reads started before acknowledgement, including searched/infinite variants.
  await Promise.all([
    cache.cancelQueries(trpc.notes.get.queryFilter({ ...scope, id: incoming.id })),
    cache.cancelQueries(trpc.notes.list.queryFilter(scope)),
    cache.cancelQueries(trpc.notes.list.infiniteQueryFilter(scope)),
  ]);

  if (runtime !== getQueryRuntime()) {
    return;
  }

  const detailKey = trpc.notes.get.queryKey({ ...scope, id: incoming.id, includeDeleted: false });
  const previous = cache.getQueryData(detailKey);
  const verified = cache.getQueryData(
    trpc.notes.get.queryKey({ ...scope, id: incoming.id, includeDeleted: true }),
  );
  const note = [previous, verified].reduce<NoteRecord>(
    (latest, candidate) => (candidate && candidate.revision > latest.revision ? candidate : latest),
    incoming,
  );
  cache.setQueryData(detailKey, note);
  const item = noteListItemSchema.parse(note);

  for (const [key, page] of cache.getQueriesData<NotePage>(trpc.notes.list.queryFilter(scope))) {
    if (page) {
      cache.setQueryData(key, reconcilePages([page], key, item)[0]);
    }
  }

  for (const [key, data] of cache.getQueriesData<InfiniteData<NotePage>>(
    trpc.notes.list.infiniteQueryFilter(scope),
  )) {
    if (data) {
      cache.setQueryData(key, { ...data, pages: reconcilePages(data.pages, key, item) });
    }
  }

  // Query observers expose refresh failures. A follow-up read cannot turn a committed
  // command into an uncertain mutation, and must not hold draft acknowledgement open.
  void notifyQueryChange("notes", { ...scope, id: note.id }, runtime, true).catch(() => {});
}

/** Durable intent/optimistic drafts belong to the caller; Query owns acknowledgement caches. */
export function saveNote(
  workspaceId: string,
  command: SaveNote,
  { replaying = false }: { replaying?: boolean } = {},
) {
  const runtime = getQueryRuntime();
  const mutation = new MutationObserver(
    runtime.queryClient,
    runtime.trpc.notes.save.mutationOptions({
      retry: false,
      onSuccess: (note) => {
        // A replay receipt proves the original command, not the current projection.
        // The durable-command owner verifies current state before reconciling it.
        if (!replaying) {
          return reconcileNoteSnapshot(note, runtime);
        }
      },
    }),
  );

  return rpcCall(() => mutation.mutate({ workspaceId, command }));
}
