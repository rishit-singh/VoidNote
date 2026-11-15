"use client";
import { useInfiniteQuery } from "@tanstack/react-query";

import { notesQueryOptions } from "@/queries/notes";
import { peopleQueryOptions } from "@/queries/people";
import { useNoteStore } from "@/stores/use-note-store";

export function useNotesQuery(search = "") {
  const workspaceId = useNoteStore((state) => state.session?.workspace.id);

  return useInfiniteQuery(notesQueryOptions(workspaceId, search));
}

export function usePeopleQuery(search = "") {
  const workspaceId = useNoteStore((state) => state.session?.workspace.id);

  return useInfiniteQuery(peopleQueryOptions(workspaceId, search));
}
