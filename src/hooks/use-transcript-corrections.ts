"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { z } from "zod";
import {
  correctionCommandSchema,
  type CorrectionCommand,
  type CorrectionReceipt,
} from "@/contracts/transcript-corrections";
import { savePersonSchema, type SavePerson } from "@/contracts/workspace";
import { ApiError, workspaceApi } from "@/lib/workspace-api";
import { asApiError } from "@/lib/api-error";
import { getQueryRuntime, notifyQueryChange } from "@/lib/query-runtime";
import { useNoteStore } from "@/stores/use-note-store";

const pendingSchema = z.object({
  command: correctionCommandSchema,
  guest: savePersonSchema.optional(),
});
type Pending = z.infer<typeof pendingSchema>;
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Could not save this correction.";

/** A mounted editor is keyed by epoch/account/workspace/note/run by its parent. */
export function useTranscriptCorrections(noteId: string, runId: string) {
  const session = useNoteStore((state) => state.session);
  const epoch = useNoteStore((state) => state.epoch);
  const workspaceId = session?.workspace.id ?? "";
  const userId = session?.user.id ?? "";
  const runtime = getQueryRuntime();
  const input = { workspaceId, noteId, runId };
  const transcript = useInfiniteQuery(
    runtime.trpc.transcripts.page.infiniteQueryOptions(input, {
      enabled: !!session,
      trpc: { abortOnUnmount: true },
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
  );
  const historyQuery = useInfiniteQuery(
    runtime.trpc.transcripts.history.infiniteQueryOptions(input, {
      enabled: false,
      trpc: { abortOnUnmount: true },
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
  );
  const mutation = useMutation(runtime.trpc.transcripts.command.mutationOptions());
  // Epoch gates completions; stable identity keys retain exact commands across reload/sign-in.
  const key = `voidnote:corrections:v1:${userId}:${workspaceId}:${noteId}:${runId}`;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const owned = useCallback(() => {
    const state = useNoteStore.getState();
    return (
      mounted.current &&
      state.epoch === epoch &&
      state.session?.user.id === userId &&
      state.session?.workspace.id === workspaceId
    );
  }, [epoch, userId, workspaceId]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [conflict, setConflict] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [affectedTargets, setAffectedTargets] = useState<string[]>([]);
  const [receipt, setReceipt] = useState<CorrectionReceipt | null>(null);
  const { refetch, fetchNextPage } = transcript;
  const refresh = useCallback(
    async (after?: string) => {
      if (after) await fetchNextPage();
      else await refetch();
    },
    [refetch, fetchNextPage],
  );
  const loadHistory = async (after?: string) => {
    if (after) await historyQuery.fetchNextPage();
    else await historyQuery.refetch();
  };
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled || !owned()) return;
      try {
        const raw = localStorage.getItem(key);
        const saved = raw ? pendingSchema.parse(JSON.parse(raw) as unknown) : null;
        pendingRef.current = saved;
        setPending(saved);
        setReady(true);
      } catch {
        setError(
          "Correction recovery could not be read. Saving is paused to protect the pending command.",
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, owned]);

  const submit = async (command?: CorrectionCommand, guest?: SavePerson) => {
    if (!owned() || !ready || inFlight.current) return false;
    // A retry must use the original payload, including guest and split IDs.
    let saved = pendingRef.current;
    if (saved && command) return false;
    if (!saved && !command) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setConflict(false);
    setRejected(false);
    setAffectedTargets([]);
    try {
      if (!saved) {
        saved = pendingSchema.parse({ command, ...(guest ? { guest } : {}) });
        localStorage.setItem(key, JSON.stringify(saved)); // persist before any external effect
        pendingRef.current = saved;
        setPending(saved);
      }
      if (saved.guest) {
        await workspaceApi.savePerson(workspaceId, saved.guest);
        if (!owned()) return false;
        await useNoteStore.getState().ensurePerson(saved.guest.id);
        if (!owned()) return false;
      }
      const result = await mutation.mutateAsync({ ...input, command: saved.command });
      if (!owned()) return false; // Keep recovery for receipt replay on return.
      setReceipt(result);
      localStorage.removeItem(key);
      pendingRef.current = null;
      setPending(null);
      await notifyQueryChange("transcript", input, runtime);
      return owned();
    } catch (error) {
      const failure = asApiError(error);
      if (owned()) {
        setError(message(failure));
        setConflict(
          failure instanceof ApiError &&
            failure.status === 409 &&
            failure.code !== "command_reused",
        );
        setRejected(
          failure instanceof ApiError &&
            [400, 403, 404, 409, 413, 415, 422].includes(failure.status),
        );
        setAffectedTargets(failure instanceof ApiError ? failure.affectedTargets : []);
      }
      return false;
    } finally {
      inFlight.current = false;
      if (owned()) setBusy(false);
    }
  };
  const reviewConflict = async () => {
    if (!rejected || busy || !owned()) return;
    try {
      localStorage.removeItem(key);
      pendingRef.current = null;
      setPending(null);
      setError(null);
      setConflict(false);
      setRejected(false);
      await refresh();
    } catch (failure) {
      if (owned()) setError(message(failure));
    }
  };
  return {
    turns: transcript.data?.pages.flatMap((page) => page.items) ?? [],
    cursor: transcript.data?.pages.at(-1)?.nextCursor ?? null,
    loading: transcript.isFetching,
    readError: transcript.error ? message(transcript.error) : null,
    error,
    pending,
    busy,
    conflict,
    rejected,
    affectedTargets,
    receipt,
    ready,
    history: historyQuery.data
      ? {
          items: historyQuery.data.pages.flatMap((page) => page.items),
          nextCursor: historyQuery.data.pages.at(-1)?.nextCursor ?? null,
        }
      : null,
    historyError: historyQuery.error ? message(historyQuery.error) : null,
    historyLoading: historyQuery.isFetching,
    refresh,
    loadHistory,
    submit,
    reviewConflict,
    owned,
    workspaceId,
    preview: (params: URLSearchParams) =>
      runtime.queryClient.fetchQuery(
        runtime.trpc.transcripts.targets.queryOptions(
          {
            ...input,
            ...(params.has("speakerLabel") ? { speakerLabel: params.get("speakerLabel")! } : {}),
            ...(params.has("startSeconds")
              ? { startSeconds: Number(params.get("startSeconds")) }
              : {}),
            ...(params.has("endSeconds") ? { endSeconds: Number(params.get("endSeconds")) } : {}),
            ...(params.has("includeManual")
              ? { includeManual: params.get("includeManual") === "true" }
              : {}),
          },
          { staleTime: 0, trpc: { abortOnUnmount: true } },
        ),
      ),
  };
}

export type TranscriptCorrections = ReturnType<typeof useTranscriptCorrections>;
