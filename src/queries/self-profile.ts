"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import { selfProfileCreateSchema, selfProfileLinkSchema } from "@/contracts/self-profile";
import { ApiError, asApiError, rpcCall } from "@/lib/api-error";
import { getQueryRuntime, notifyQueryChange } from "@/lib/query-runtime";
import { useNoteStore } from "@/stores/use-note-store";

export function selfProfileQueryOptions(workspaceId: string | undefined) {
  return getQueryRuntime().trpc.selfProfile.get.queryOptions(
    { workspaceId: workspaceId ?? "" },
    { enabled: !!workspaceId, trpc: { abortOnUnmount: true } },
  );
}

const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), input: selfProfileCreateSchema }).strict(),
  z.object({ kind: z.literal("link"), input: selfProfileLinkSchema }).strict(),
]);

type SelfProfileCommand = z.infer<typeof commandSchema>;

/** One scoped pending intent, stored before transmission; remote identity stays in Query. */
export function useSelfProfileMutation() {
  const runtime = getQueryRuntime();
  const storageKey = runtime.identity
    ? `voidnote:self-profile:v1:${runtime.identity.userId}:${runtime.identity.workspaceId}`
    : null;
  // The owning control is keyed by account epoch and workspace. Recover once
  // on mount; recovery only exposes Retry and never dispatches a command.
  const [recovery] = useState(() => {
    try {
      const raw =
        storageKey && typeof window !== "undefined" ? localStorage.getItem(storageKey) : null;
      const command = raw ? commandSchema.parse(JSON.parse(raw)) : null;
      if (command && command.input.workspaceId !== runtime.identity?.workspaceId) {
        throw new Error("Saved profile change belongs to another workspace.");
      }

      return { command, error: null };
    } catch {
      return {
        command: null,
        error: "Your saved profile change could not be recovered. Reload to try again.",
      };
    }
  });
  const [pending, setPending] = useState<SelfProfileCommand | null>(recovery.command);

  function refreshSelf(workspaceId: string) {
    const filter = runtime.trpc.selfProfile.get.queryFilter({ workspaceId });
    void runtime.queryClient.cancelQueries(filter).then(() => {
      if (runtime === getQueryRuntime()) {
        return runtime.queryClient.invalidateQueries(filter);
      }
    });
  }

  function clearPending(command: SelfProfileCommand) {
    if (storageKey && localStorage.getItem(storageKey) === JSON.stringify(command)) {
      localStorage.removeItem(storageKey);
    }

    setPending(null);
  }

  const mutation = useMutation({
    mutationKey: runtime.trpc.selfProfile.create.mutationKey(),
    retry: false,
    mutationFn: async (command: SelfProfileCommand) => {
      if (
        runtime !== getQueryRuntime() ||
        runtime.identity?.workspaceId !== command.input.workspaceId
      ) {
        throw new Error("Your workspace changed. Reopen My profile to continue.");
      }

      if (recovery.error || !storageKey) {
        throw new Error("Your saved profile change is not ready.");
      }

      // A storage failure must stop transmission, preserving exact retry semantics.
      localStorage.setItem(storageKey, JSON.stringify(command));
      setPending(command);

      return rpcCall(() =>
        command.kind === "create"
          ? runtime.client.selfProfile.create.mutate(command.input)
          : runtime.client.selfProfile.link.mutate(command.input),
      );
    },
    onSuccess: (_person, command) => {
      if (runtime !== getQueryRuntime()) {
        return;
      }

      // Receipts may be historical on exact retry. Read the current relationship
      // rather than promoting a replayed person into the self identity cache.
      clearPending(command);
      void notifyQueryChange("people", { workspaceId: command.input.workspaceId }, runtime).catch(
        () => {},
      );
    },
    onError: (error, command) => {
      if (runtime !== getQueryRuntime()) {
        return;
      }

      const failure = asApiError(error);
      if (failure instanceof ApiError && failure.status === 401 && runtime.identity) {
        useNoteStore.getState().reportError(failure, runtime.identity.epoch);

        return;
      }

      // Authorization may fail before receipt lookup: a 403 cannot establish
      // whether an earlier request committed. Retain that exact intent.
      if (failure instanceof ApiError && [400, 404, 409].includes(failure.status)) {
        clearPending(command);
        refreshSelf(command.input.workspaceId);
      }
    },
  });

  return { ...mutation, pending, recoveryError: recovery.error };
}
