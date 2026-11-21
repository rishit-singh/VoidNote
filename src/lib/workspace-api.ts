import { z } from "zod";

import { queryPolicy } from "@/config/query";
import { type DeleteCommand } from "@/contracts/workspace";
import { reconcileNoteSnapshot, saveNote } from "@/queries/notes";
import { deletePerson, savePerson } from "@/queries/people";

import { ApiError, rpcCall } from "./api-error";
import { getQueryRuntime } from "./query-runtime";
export { ApiError } from "./api-error";

/** Compatibility boundary for durable draft commands; remote reads live in QueryClient. */
export const workspaceApi = {
  session: () =>
    rpcCall(() => {
      const { queryClient, trpc } = getQueryRuntime();

      return queryClient.fetchQuery(
        trpc.workspace.session.queryOptions(undefined, {
          staleTime: queryPolicy.staleTimeMs,
          trpc: { abortOnUnmount: true },
        }),
      );
    }),
  signOut: async () => {
    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      throw new ApiError("Sign-out could not be confirmed.", response.status);
    }

    return z.object({ ok: z.literal(true) }).parse(await response.json());
  },
  notes: (workspaceId: string, cursor?: string | null, q?: string) =>
    rpcCall(() => {
      const { queryClient, trpc } = getQueryRuntime();

      return queryClient.fetchQuery(
        trpc.notes.list.queryOptions(
          {
            workspaceId,
            ...(cursor ? { cursor } : {}),
            ...(q ? { q } : {}),
            limit: queryPolicy.notesPageSize,
          },
          { trpc: { abortOnUnmount: true } },
        ),
      );
    }),
  note: (workspaceId: string, id: string, includeDeleted = false) =>
    rpcCall(() => {
      const { queryClient, trpc } = getQueryRuntime();

      return queryClient.fetchQuery(
        trpc.notes.get.queryOptions(
          { workspaceId, id, includeDeleted },
          {
            staleTime: includeDeleted ? 0 : queryPolicy.staleTimeMs,
            trpc: { abortOnUnmount: true },
          },
        ),
      );
    }),
  saveNote,
  deleteNote: (workspaceId: string, command: DeleteCommand) =>
    rpcCall(async () => {
      const runtime = getQueryRuntime();
      const note = await runtime.client.notes.delete.mutate({ workspaceId, command });
      if (runtime !== getQueryRuntime() || runtime.identity?.workspaceId !== workspaceId) {
        return note;
      }

      if (note.workspaceId !== workspaceId || note.id !== command.id) {
        throw new Error("Unexpected deleted record; retry the original command.");
      }

      await Promise.all([
        runtime.queryClient.cancelQueries(
          runtime.trpc.recordings.overview.queryFilter({ workspaceId, noteId: note.id }),
        ),
        runtime.queryClient.cancelQueries(
          runtime.trpc.transcripts.page.queryFilter({ workspaceId, noteId: note.id }),
        ),
        runtime.queryClient.cancelQueries(
          runtime.trpc.transcripts.page.infiniteQueryFilter({ workspaceId, noteId: note.id }),
        ),
      ]);
      if (runtime !== getQueryRuntime()) {
        return note;
      }

      runtime.queryClient.removeQueries(
        runtime.trpc.recordings.overview.queryFilter({ workspaceId, noteId: note.id }),
      );
      runtime.queryClient.removeQueries(
        runtime.trpc.transcripts.page.queryFilter({ workspaceId, noteId: note.id }),
      );
      runtime.queryClient.removeQueries(
        runtime.trpc.transcripts.page.infiniteQueryFilter({ workspaceId, noteId: note.id }),
      );
      // Retain the versioned tombstone and remove loaded list rows before acknowledging.
      // Reconciliation owns the detached refresh, so list latency cannot delay deletion.
      await reconcileNoteSnapshot(note, runtime);

      return note;
    }),
  people: (workspaceId: string, cursor?: string | null, q?: string) =>
    rpcCall(() => {
      const { queryClient, trpc } = getQueryRuntime();

      return queryClient.fetchQuery(
        trpc.people.list.queryOptions(
          {
            workspaceId,
            ...(cursor ? { cursor } : {}),
            ...(q ? { q } : {}),
            limit: queryPolicy.peoplePageSize,
          },
          { trpc: { abortOnUnmount: true } },
        ),
      );
    }),
  person: (workspaceId: string, id: string, includeDeleted = false) =>
    rpcCall(() => {
      const { queryClient, trpc } = getQueryRuntime();

      return queryClient.fetchQuery(
        trpc.people.get.queryOptions(
          { workspaceId, id, includeDeleted },
          {
            staleTime: includeDeleted ? 0 : queryPolicy.staleTimeMs,
            trpc: { abortOnUnmount: true },
          },
        ),
      );
    }),
  savePerson,
  deletePerson,
  history: (
    workspaceId: string,
    entityType: "note" | "person",
    entityId: string,
    cursor?: string | null,
  ) =>
    rpcCall(() => {
      const { queryClient, trpc } = getQueryRuntime();

      return queryClient.fetchQuery(
        trpc.workspace.history.queryOptions(
          { workspaceId, entityType, entityId, ...(cursor ? { cursor } : {}) },
          { trpc: { abortOnUnmount: true } },
        ),
      );
    }),
};
