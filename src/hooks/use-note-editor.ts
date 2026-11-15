"use client";

import { useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNoteStore } from "@/stores/use-note-store";
import { getQueryRuntime } from "@/lib/query-runtime";
import { ApiError, asApiError } from "@/lib/api-error";
import { createNoteModel } from "@/lib/types";

export function useNoteEditor(noteId: string) {
  const draft = useNoteStore((state) => state.notes.find((item) => item.id === noteId));
  const edit = useNoteStore((state) => state.edits[`note:${noteId}`]);
  const epoch = useNoteStore((state) => state.epoch);
  const session = useNoteStore((state) => state.session);
  const storedUnavailable = useNoteStore((state) => state.unavailable[`note:${noteId}`]);
  const runtime = getQueryRuntime();
  const query = useQuery(
    runtime.trpc.notes.get.queryOptions(
      { workspaceId: session?.workspace.id ?? "", id: noteId, includeDeleted: false },
      {
        enabled: !!session && (!draft || !!draft.revision),
        trpc: { abortOnUnmount: true },
      },
    ),
  );
  const failure = query.status === "error" && query.error ? asApiError(query.error) : null;
  const detailUnavailable =
    failure instanceof ApiError && (failure.status === 403 || failure.status === 404)
      ? failure.status === 403
        ? "forbidden"
        : "missing"
      : undefined;
  const unavailable = detailUnavailable ?? storedUnavailable;
  const note =
    !unavailable && query.status === "success" && query.data && !edit?.dirty && !edit?.pending
      ? createNoteModel({ ...query.data, scopeEpoch: epoch })
      : unavailable
        ? undefined
        : draft;

  useEffect(() => {
    const state = useNoteStore.getState();
    if (state.epoch !== epoch) return;
    if (detailUnavailable)
      state.reconcileUnavailable("note", noteId, detailUnavailable, epoch, query.errorUpdatedAt);
    else if (query.status === "success" && !query.error && query.data)
      state.reconcileNote(query.data, epoch, query.dataUpdatedAt);
    state.selectNote(noteId);
  }, [
    noteId,
    query.data,
    query.status,
    query.error,
    query.dataUpdatedAt,
    query.errorUpdatedAt,
    detailUnavailable,
    epoch,
  ]);

  const update = useCallback(
    (changes: Partial<Pick<NonNullable<typeof note>, "title" | "transcript">>) => {
      const state = useNoteStore.getState();
      const current = state.notes.find((item) => item.id === noteId);
      if (state.epoch !== epoch || !current) return;
      state.upsertNote({ ...current, ...changes });
    },
    [noteId, epoch],
  );

  const retry = query.refetch;
  return {
    note,
    edit,
    unavailable,
    error: failure?.message,
    update,
    retry,
    locked: false,
  };
}
