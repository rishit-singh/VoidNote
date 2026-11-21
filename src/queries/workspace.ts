"use client";

import { skipToken, useQuery } from "@tanstack/react-query";

import { getQueryRuntime } from "@/lib/query-runtime";
import { useNoteStore } from "@/stores/use-note-store";

/** Home-only aggregate; shares the authenticated runtime and normal read policy. */
export function useWorkspaceOverview() {
  const workspaceId = useNoteStore((state) => state.session?.workspace.id);

  return useQuery(
    getQueryRuntime().trpc.workspace.overview.queryOptions(
      workspaceId ? { workspaceId } : skipToken,
      { trpc: { abortOnUnmount: true } },
    ),
  );
}
