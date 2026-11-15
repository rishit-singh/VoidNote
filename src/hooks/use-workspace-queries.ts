"use client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { getQueryRuntime } from "@/lib/query-runtime";
import { useNoteStore } from "@/stores/use-note-store";

export function useNotesQuery(search = "") {
  const workspaceId = useNoteStore((state) => state.session?.workspace.id);
  const { trpc } = getQueryRuntime();
  return useInfiniteQuery(
    trpc.notes.list.infiniteQueryOptions(
      { workspaceId: workspaceId ?? "", q: search, limit: 30 },
      {
        enabled: !!workspaceId,
        trpc: { abortOnUnmount: true },
        getNextPageParam: (last) => last.nextCursor ?? undefined,
      },
    ),
  );
}

export function usePeopleQuery(search = "") {
  const workspaceId = useNoteStore((state) => state.session?.workspace.id);
  const { trpc } = getQueryRuntime();
  return useInfiniteQuery(
    trpc.people.list.infiniteQueryOptions(
      { workspaceId: workspaceId ?? "", q: search, limit: 30 },
      {
        enabled: !!workspaceId,
        trpc: { abortOnUnmount: true },
        getNextPageParam: (last) => last.nextCursor ?? undefined,
      },
    ),
  );
}
