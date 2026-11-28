"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useNoteStore } from "@/stores/use-note-store";
import { useAudioPlaybackStore } from "@/stores/use-audio-playback-store";
import { useRecordingStore, isOwnedSession } from "@/stores/use-recording-store";
import { getQueryRuntime } from "@/lib/query-runtime";
import {
  processingJobKey,
  queueRecordingProcessing,
  recordingOverviewOptions,
  useProcessingJobs,
  beginProcessingRetryObservation,
  settleProcessingRetryObservation,
  recordingProcessingView,
  refreshRecordingProcessing,
  submitRecordingProcessing,
} from "@/lib/recording-processing-client";

export interface SelectedProcessingRecording {
  noteId: string;
  recordingId: string;
  source: "local" | "remote";
}

export function useRecordingOverview(noteId?: string, polling = false) {
  const session = useNoteStore((s) => s.session);
  const epoch = useNoteStore((s) => s.epoch);
  const runtime = getQueryRuntime();
  const key =
    session && noteId
      ? processingJobKey(epoch, session.user.id, session.workspace.id, noteId)
      : undefined;
  const job = useProcessingJobs((s) => (polling && key ? s.jobs[key] : undefined));
  const retry = job?.retry;
  const pendingRecordingId = useRecordingStore((s) => {
    if (!polling || !session || !noteId) return undefined;
    return Object.values(s.sessions).find(
      (local) =>
        local.noteId === noteId &&
        local.userId === session.user.id &&
        local.workspaceId === session.workspace.id &&
        local.status === "finalized" &&
        local.processing === "submitted",
    )?.id;
  });
  const query = useQuery(
    recordingOverviewOptions(
      runtime,
      session?.workspace.id,
      noteId,
      polling,
      retry,
      job?.acceptance?.recordingId ?? pendingRecordingId,
    ),
  );
  useEffect(() => {
    if (!polling || !key || !retry) return;
    if (settleProcessingRetryObservation(key, retry, query.data?.runs)) return;
    // Only the shell owns this deadline, including when a read hangs or the tab is offline.
    const timer = setTimeout(
      () => settleProcessingRetryObservation(key, retry, undefined),
      Math.max(0, retry.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [polling, key, retry, query.data?.runs]);
  return query;
}

export function useRecordingProcessing(noteId: string, selection?: SelectedProcessingRecording) {
  const session = useNoteStore((s) => s.session);
  const epoch = useNoteStore((s) => s.epoch);
  const sessions = useRecordingStore((s) => s.sessions);
  const hydration = useRecordingStore((s) => s.hydration);
  const hydrationError = useRecordingStore((s) => s.error);
  const owner = useAudioPlaybackStore((s) => s.owner);
  const runtime = getQueryRuntime();
  const query = useRecordingOverview(noteId);
  const job = useProcessingJobs((s) =>
    session
      ? s.jobs[processingJobKey(epoch, session.user.id, session.workspace.id, noteId)]
      : undefined,
  );
  const owned = () => {
    const state = useNoteStore.getState();
    return (
      getQueryRuntime().scope === runtime.scope &&
      state.epoch === epoch &&
      state.session?.user.id === session?.user.id &&
      state.session?.workspace.id === session?.workspace.id
    );
  };
  const local = Object.values(sessions)
    .filter((s) => s.noteId === noteId && isOwnedSession(s))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  const selectedId =
    selection?.noteId === noteId
      ? selection.recordingId
      : owner?.noteId === noteId && owner.epoch === epoch
        ? (owner.recordingId ?? owner.sessionId)
        : undefined;
  const recording =
    query.data?.recordings.find((r) => r.id === selectedId) ?? query.data?.recordings[0];
  const recordingId = recording?.id ?? selectedId ?? local?.id ?? job?.acceptance?.recordingId;
  const run = query.data?.runs.find((r) => r.recordingId === recordingId);
  const mutation = useMutation({
    mutationKey: ["recording-retry", runtime.scope, noteId],
    retry: false,
    mutationFn: async (command: { scope: string; noteId: string }) => {
      if (!session || !owned() || command.scope !== runtime.scope || command.noteId !== noteId)
        throw new Error("Sign in to resume processing.");
      const input = { workspaceId: session.workspace.id, noteId };
      let queued = false;
      let started = false;
      try {
        if (run && run.status !== "succeeded") {
          await runtime.client.processing.retry.mutate({ ...input, runId: run.id });
          if (owned())
            beginProcessingRetryObservation(
              processingJobKey(epoch, session.user.id, session.workspace.id, noteId),
              run,
            );
        } else if (
          local?.status === "finalized" &&
          local.processing !== "submitted" &&
          (!recording || recording.status !== "ready")
        ) {
          queued = true;
          await queueRecordingProcessing(local.id);
        } else if (recording && !run) {
          started = true;
          await submitRecordingProcessing(
            runtime,
            { ...input, recordingId: recording.id },
            processingJobKey(epoch, session.user.id, session.workspace.id, noteId),
            owned,
          );
        }
      } finally {
        // Keep the invocation's runtime across navigation and uncertain responses.
        if (!queued && !started && owned())
          void refreshRecordingProcessing(input, runtime).catch(() => {
            // Query state owns refresh errors; a hanging read must not hold the retry UI busy.
          });
      }
    },
  });
  const currentMutation =
    mutation.variables?.scope === runtime.scope && mutation.variables.noteId === noteId;
  const busy = (currentMutation && mutation.isPending) || !!job?.busy || !!job?.retry;
  const statusError =
    query.error?.message ?? (hydration === "error" ? (hydrationError ?? undefined) : undefined);
  const mutationError = currentMutation ? mutation.error?.message : undefined;
  const view = recordingProcessingView({
    run,
    recording,
    local,
    job,
    loaded: !!query.data,
    loading: query.isPending || hydration === "idle" || hydration === "loading",
    dataUpdatedAt: query.dataUpdatedAt,
    statusError,
    mutationPending: !!currentMutation && mutation.isPending,
    mutationError,
  });
  const retry = async () => {
    if (busy || !owned() || view.retryAction !== "processing") return;
    await mutation.mutateAsync({ scope: runtime.scope, noteId }).catch(() => {
      // useMutation owns the error displayed by the existing UI.
    });
  };
  const refresh = async () => {
    if (!session || !owned()) return;
    if (hydration === "error") await useRecordingStore.getState().recoverDraftSessions();
    if (!owned()) return;
    await refreshRecordingProcessing({ workspaceId: session.workspace.id, noteId }, runtime);
  };
  return {
    recording,
    run,
    local,
    loaded: !!query.data,
    busy,
    progress: job?.progress,
    ...view,
    statusError,
    error:
      view.phase === "failed" || view.phase === "blocked" || view.phase === "uncertain"
        ? (run?.error ?? mutationError ?? job?.error ?? undefined)
        : undefined,
    retry,
    refresh,
  };
}
