"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import {
  correctedTurnSchema,
  type CorrectionCommand,
  correctionCommandSchema,
  type CorrectionReceipt,
  MAX_CORRECTION_TARGETS,
} from "@/contracts/transcript-corrections";
import { type SavePerson, savePersonSchema } from "@/contracts/workspace";
import { asApiError } from "@/lib/api-error";
import { getQueryRuntime } from "@/lib/query-runtime";
import { ApiError, workspaceApi } from "@/lib/workspace-api";
import { reconcilePersonSnapshot } from "@/queries/people";
import {
  flattenTranscriptPages,
  optimisticCorrection,
  submitCorrection,
  transcriptQueryOptions,
} from "@/queries/transcript-corrections";
import { useNoteStore } from "@/stores/use-note-store";

const undoPreviewSchema = z.object({
  before: z.array(correctedTurnSchema).max(MAX_CORRECTION_TARGETS),
  after: z.array(correctedTurnSchema).max(MAX_CORRECTION_TARGETS),
});

type UndoPreview = z.infer<typeof undoPreviewSchema>;

export type CorrectionPreviewOptions = {
  personName?: string;
  onPending?: () => void;
};

const pendingSchema = z.object({
  command: correctionCommandSchema,
  guest: savePersonSchema.optional(),
  personName: z.string().max(200).optional(),
  undo: undoPreviewSchema.optional(),
  rejection: z
    .object({
      message: z.string(),
      conflict: z.boolean(),
      affectedTargets: z.array(z.string()).max(MAX_CORRECTION_TARGETS),
    })
    .optional(),
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
  const transcript = useInfiniteQuery(transcriptQueryOptions(input));
  const historyQuery = useInfiniteQuery(
    runtime.trpc.transcripts.history.infiniteQueryOptions(input, {
      enabled: false,
      trpc: { abortOnUnmount: true },
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
  );
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
  const [undoPreview, setUndoPreview] = useState<UndoPreview | undefined>();
  const currentTurns = flattenTranscriptPages(transcript.data?.pages ?? []);
  const { refetch, fetchNextPage } = transcript;
  const refresh = useCallback(
    async (after?: string) => {
      if (after) {
        await fetchNextPage();
      } else {
        await refetch();
      }
    },
    [refetch, fetchNextPage],
  );
  const loadHistory = async (after?: string) => {
    if (after) {
      await historyQuery.fetchNextPage();
    } else {
      await historyQuery.refetch();
    }
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled || !owned()) {
        return;
      }

      try {
        const raw = localStorage.getItem(key);
        const saved = raw ? pendingSchema.parse(JSON.parse(raw) as unknown) : null;
        pendingRef.current = saved;
        setPending(saved);
        setRejected(!!saved?.rejection);
        setConflict(saved?.rejection?.conflict ?? false);
        setAffectedTargets(saved?.rejection?.affectedTargets ?? []);
        setError(saved?.rejection?.message ?? null);
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

  const submit = async (
    command?: CorrectionCommand,
    guest?: SavePerson,
    options: CorrectionPreviewOptions = {},
  ) => {
    if (!owned() || !ready || inFlight.current) {
      return false;
    }

    // A retry must use the original payload, including guest and split IDs.
    let saved = pendingRef.current;
    const replaying = saved !== null;
    if (saved?.rejection) {
      return false;
    }

    if (saved && command) {
      return false;
    }

    if (!saved && !command) {
      return false;
    }

    inFlight.current = true;
    setBusy(true);
    setError(null);
    setConflict(false);
    setRejected(false);
    setAffectedTargets([]);
    const before =
      command && command.kind !== "undo"
        ? currentTurns.filter((turn) =>
            command.kind === "assign"
              ? command.targets.some((target) => target.id === turn.id)
              : command.utteranceId === turn.id,
          )
        : [];
    try {
      if (!saved) {
        saved = pendingSchema.parse({
          command,
          guest,
          personName: options.personName ?? guest?.content.displayName,
          undo: command?.kind === "undo" ? undoPreview : undefined,
        });
        localStorage.setItem(key, JSON.stringify(saved)); // persist before any external effect
        pendingRef.current = saved;
        setPending(saved);
        options.onPending?.();
      }

      if (saved.guest) {
        const receipt = await workspaceApi.savePerson(workspaceId, saved.guest, { replaying });
        if (!owned()) {
          return false;
        }

        // Inline creation is also a durable command: its receipt may predate a
        // rename/deletion. Bypass freshness before publishing replayed state.
        const current = replaying
          ? await workspaceApi.person(workspaceId, saved.guest.id, true)
          : receipt;
        if (!owned()) {
          return false;
        }

        if (current.id !== saved.guest.id || current.workspaceId !== workspaceId) {
          throw new Error("Unexpected profile returned by server.");
        }

        if (replaying) {
          await reconcilePersonSnapshot(current, runtime);
        }

        if (!owned()) {
          return false;
        }

        useNoteStore.getState().reconcilePerson(current, epoch);
      }

      const result = await submitCorrection(input, saved.command, runtime);
      if (!owned()) {
        return false;
      } // Keep recovery for receipt replay on return.

      setReceipt(result.receipt);
      const expectedBeforeCount =
        saved.command.kind === "assign" ? saved.command.targets.length : 1;
      // Attribution tokens permit intervening text edits. Undoing an assignment
      // must preview the current text, rather than a potentially older cached copy.
      const undoBefore =
        saved.command.kind === "assign"
          ? before.map((turn) => {
              const current = result.current.items.find((item) => item.id === turn.id);

              return current
                ? {
                    ...current,
                    assignment: turn.assignment,
                    assignmentSource: turn.assignmentSource,
                    personName: turn.personName,
                    reviewState: turn.reviewState,
                    providerScore: turn.providerScore,
                    sampleSuitability: turn.sampleSuitability,
                  }
                : turn;
            })
          : before;
      setUndoPreview(
        !replaying &&
          saved.command.kind !== "undo" &&
          result.current.complete &&
          before.length === expectedBeforeCount
          ? { before: undoBefore, after: result.current.items }
          : undefined,
      );
      localStorage.removeItem(key);
      pendingRef.current = null;
      setPending(null);

      return true;
    } catch (error) {
      const failure = asApiError(error);
      if (owned()) {
        const definitelyRejected =
          failure instanceof ApiError &&
          [400, 403, 404, 409, 413, 415, 422].includes(failure.status);
        const isConflict =
          failure instanceof ApiError &&
          failure.status === 409 &&
          failure.code !== "command_reused";
        const targets = failure instanceof ApiError ? failure.affectedTargets : [];
        setError(message(failure));
        setConflict(isConflict);
        setRejected(definitelyRejected);
        setAffectedTargets(targets);
        if (definitelyRejected && pendingRef.current) {
          const rejectedPending: Pending = {
            ...pendingRef.current,
            rejection: {
              message: message(failure),
              conflict: isConflict,
              affectedTargets: targets,
            },
          };
          pendingRef.current = rejectedPending;
          setPending(rejectedPending);
          try {
            localStorage.setItem(key, JSON.stringify(rejectedPending));
          } catch {
            setError(
              "This change was rejected, but its recovery status could not be saved. Review speech before leaving this note.",
            );
          }
        }
      }

      return false;
    } finally {
      inFlight.current = false;
      if (owned()) {
        setBusy(false);
      }
    }
  };

  const reviewConflict = async () => {
    if (!rejected || inFlight.current || !owned()) {
      return false;
    }

    inFlight.current = true;
    setBusy(true);
    try {
      const result = await refetch();
      if (!owned()) {
        return false;
      }

      if (result.error) {
        throw new Error(message(result.error), { cause: result.error });
      }

      localStorage.removeItem(key);
      pendingRef.current = null;
      setPending(null);
      setError(null);
      setConflict(false);
      setRejected(false);

      return true;
    } catch (failure) {
      if (owned()) {
        setError(message(failure));
      }

      return false;
    } finally {
      inFlight.current = false;
      if (owned()) {
        setBusy(false);
      }
    }
  };

  return {
    turns:
      pending && !rejected
        ? optimisticCorrection(currentTurns, pending.command, {
            ...(pending.personName ? { personName: pending.personName } : {}),
            ...(pending.undo ? { undo: pending.undo } : {}),
          })
        : currentTurns,
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
