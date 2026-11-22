"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useNoteStore } from "@/stores/use-note-store";
import { useAudioPlaybackStore } from "@/stores/use-audio-playback-store";
import { useRecordingStore, isOwnedSession } from "@/stores/use-recording-store";
import { getQueryRuntime, notifyQueryChange } from "@/lib/query-runtime";
import {
  processingJobKey,
  queueRecordingProcessing,
  recordingOverviewOptions,
  useProcessingJobs,
  beginProcessingRetryObservation,
  settleProcessingRetryObservation,
} from "@/lib/recording-processing-client";

export interface SelectedProcessingRecording {
  noteId: string;
  recordingId: string;
  source: "local" | "remote";
}

export function useRecordingOverview(noteId?: string, polling = false) {
  const session = useNoteStore((s) => s.session);
  const epoch = useNoteStore((s) => s.epoch);
  const enabled = useNoteStore((s) => {
    if (
      !s.session ||
      !noteId ||
      s.recoveryHydration !== "ready" ||
      s.recoveryEpoch !== s.epoch ||
      s.unavailable[`note:${noteId}`]
    )
      return false;
    const record = s.noteRecords[noteId];
    const draft = s.notes.find((note) => note.id === noteId);
    if (record?.deletedAt || draft?.deletedAt) return false;
    // Direct links can read remotely; known local creations must be acknowledged first.
    // The baseline stays acknowledged while newer title edits are still dirty.
    return !draft || (record?.revision ?? draft.revision ?? 0) > 0;
  });
  const runtime = getQueryRuntime();
  const key =
    session && noteId
      ? processingJobKey(epoch, session.user.id, session.workspace.id, noteId)
      : undefined;
  const retry = useProcessingJobs((s) => (polling && key ? s.jobs[key]?.retry : undefined));
  const query = useQuery({
    ...recordingOverviewOptions(runtime, session?.workspace.id, noteId, polling, retry),
    enabled,
  });
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
  const run = query.data?.runs.find((r) => r.recordingId === recording?.id);
  const mutation = useMutation({
    mutationKey: ["recording-retry", runtime.scope, noteId],
    retry: false,
    mutationFn: async (command: { scope: string; noteId: string }) => {
      if (!session || !owned() || command.scope !== runtime.scope || command.noteId !== noteId)
        throw new Error("Sign in to resume processing.");
      const input = { workspaceId: session.workspace.id, noteId };
      let queued = false;
      try {
        if (run && run.status !== "succeeded") {
          await runtime.client.processing.retry.mutate({ ...input, runId: run.id });
          if (owned())
            beginProcessingRetryObservation(
              processingJobKey(epoch, session.user.id, session.workspace.id, noteId),
              run,
            );
        } else if (local?.status === "finalized" && (!recording || recording.status !== "ready")) {
          queued = true;
          await queueRecordingProcessing(local.id);
        } else if (recording && !run) {
          await runtime.client.processing.start.mutate({
            ...input,
            command: { id: recording.id, recordingId: recording.id },
          });
        }
      } finally {
        // Keep the invocation's runtime across navigation and uncertain responses.
        if (!queued && owned())
          void notifyQueryChange("recordings", input, runtime).catch(() => {
            // Query state owns refresh errors; a hanging read must not hold the retry UI busy.
          });
      }
    },
  });
  const currentMutation =
    mutation.variables?.scope === runtime.scope && mutation.variables.noteId === noteId;
  const busy = (currentMutation && mutation.isPending) || !!job?.busy || !!job?.retry;
  const retry = async () => {
    if (busy || !owned()) return;
    await mutation.mutateAsync({ scope: runtime.scope, noteId }).catch(() => {
      // useMutation owns the error displayed by the existing UI.
    });
  };
  const refresh = async () => {
    if (!session || !owned()) return;
    await runtime.queryClient.invalidateQueries({
      queryKey: runtime.trpc.recordings.overview.queryKey({
        workspaceId: session.workspace.id,
        noteId,
      }),
      exact: true,
    });
  };
  return {
    recording,
    run,
    local,
    loaded: !!query.data,
    busy,
    progress: job?.progress,
    error:
      (currentMutation ? mutation.error?.message : undefined) ?? job?.error ?? query.error?.message,
    retry,
    refresh,
  };
}
