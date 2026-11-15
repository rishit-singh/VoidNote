import { z } from "zod";
import { type DeleteCommand, type SaveNote, type SavePerson } from "@/contracts/workspace";
import { getQueryRuntime, notifyQueryChange } from "./query-runtime";
import { ApiError, rpcCall } from "./api-error";
export { ApiError } from "./api-error";

/** Compatibility boundary for durable draft commands; remote reads live in QueryClient. */
export const workspaceApi = {
  session: () =>
    rpcCall(() => {
      const { queryClient, trpc } = getQueryRuntime();
      return queryClient.fetchQuery(
        trpc.workspace.session.queryOptions(undefined, {
          staleTime: 30_000,
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
    if (!response.ok) throw new ApiError("Sign-out could not be confirmed.", response.status);
    return z.object({ ok: z.literal(true) }).parse(await response.json());
  },
  notes: (workspaceId: string, cursor?: string | null, q?: string) =>
    rpcCall(() => {
      const { queryClient, trpc } = getQueryRuntime();
      return queryClient.fetchQuery(
        trpc.notes.list.queryOptions(
          { workspaceId, ...(cursor ? { cursor } : {}), ...(q ? { q } : {}), limit: 30 },
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
          { staleTime: includeDeleted ? 0 : 30_000, trpc: { abortOnUnmount: true } },
        ),
      );
    }),
  saveNote: (workspaceId: string, command: SaveNote) =>
    rpcCall(async () => {
      const runtime = getQueryRuntime();
      const note = await runtime.client.notes.save.mutate({ workspaceId, command });
      if (runtime !== getQueryRuntime()) return note;
      await runtime.queryClient.cancelQueries(
        runtime.trpc.notes.get.queryFilter({ workspaceId, id: note.id }),
      );
      runtime.queryClient.setQueryData(
        runtime.trpc.notes.get.queryKey({ workspaceId, id: note.id, includeDeleted: false }),
        (previous) => (previous && previous.revision > note.revision ? previous : note),
      );
      await notifyQueryChange("notes", { workspaceId, id: note.id }, runtime, true);
      return note;
    }),
  deleteNote: (workspaceId: string, command: DeleteCommand) =>
    rpcCall(async () => {
      const runtime = getQueryRuntime();
      const note = await runtime.client.notes.delete.mutate({ workspaceId, command });
      if (runtime !== getQueryRuntime()) return note;
      await runtime.queryClient.cancelQueries(
        runtime.trpc.notes.get.queryFilter({ workspaceId, id: note.id }),
      );
      await runtime.queryClient.cancelQueries(
        runtime.trpc.recordings.overview.queryFilter({ workspaceId, noteId: note.id }),
      );
      await runtime.queryClient.cancelQueries(
        runtime.trpc.transcripts.page.queryFilter({ workspaceId, noteId: note.id }),
      );
      await runtime.queryClient.cancelQueries(
        runtime.trpc.transcripts.page.infiniteQueryFilter({ workspaceId, noteId: note.id }),
      );
      runtime.queryClient.removeQueries(
        runtime.trpc.notes.get.queryFilter({ workspaceId, id: note.id }),
      );
      runtime.queryClient.removeQueries(
        runtime.trpc.recordings.overview.queryFilter({ workspaceId, noteId: note.id }),
      );
      runtime.queryClient.removeQueries(
        runtime.trpc.transcripts.page.queryFilter({ workspaceId, noteId: note.id }),
      );
      runtime.queryClient.removeQueries(
        runtime.trpc.transcripts.page.infiniteQueryFilter({ workspaceId, noteId: note.id }),
      );
      await notifyQueryChange("notes", { workspaceId, id: note.id }, runtime);
      return note;
    }),
  people: (workspaceId: string, cursor?: string | null, q?: string) =>
    rpcCall(() => {
      const { queryClient, trpc } = getQueryRuntime();
      return queryClient.fetchQuery(
        trpc.people.list.queryOptions(
          { workspaceId, ...(cursor ? { cursor } : {}), ...(q ? { q } : {}), limit: 30 },
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
          { staleTime: includeDeleted ? 0 : 30_000, trpc: { abortOnUnmount: true } },
        ),
      );
    }),
  savePerson: (workspaceId: string, command: SavePerson) =>
    rpcCall(async () => {
      const runtime = getQueryRuntime();
      const person = await runtime.client.people.save.mutate({ workspaceId, command });
      if (runtime !== getQueryRuntime()) return person;
      await runtime.queryClient.cancelQueries(
        runtime.trpc.people.get.queryFilter({ workspaceId, id: person.id }),
      );
      runtime.queryClient.setQueryData(
        runtime.trpc.people.get.queryKey({ workspaceId, id: person.id, includeDeleted: false }),
        (previous) => (previous && previous.revision > person.revision ? previous : person),
      );
      await notifyQueryChange("people", { workspaceId, id: person.id }, runtime, true);
      return person;
    }),
  deletePerson: (workspaceId: string, command: DeleteCommand) =>
    rpcCall(async () => {
      const runtime = getQueryRuntime();
      const person = await runtime.client.people.delete.mutate({ workspaceId, command });
      if (runtime !== getQueryRuntime()) return person;
      await runtime.queryClient.cancelQueries(
        runtime.trpc.people.get.queryFilter({ workspaceId, id: person.id }),
      );
      runtime.queryClient.removeQueries(
        runtime.trpc.people.get.queryFilter({ workspaceId, id: person.id }),
      );
      await notifyQueryChange("people", { workspaceId, id: person.id }, runtime);
      return person;
    }),
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
