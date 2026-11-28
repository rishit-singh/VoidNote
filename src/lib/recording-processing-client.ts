"use client";

import { z } from "zod";
import { create } from "zustand";
import { skipToken } from "@tanstack/react-query";
import {
  MAX_RECORDING_BYTES,
  MAX_RECORDING_SECONDS,
  RECORDING_SIZE_LABEL,
  RECORDING_UPLOAD_PART_BYTES,
  recordingInputSchema,
  recordingSchema,
  recordingUploadSchema,
  uploadPartSchema,
  type ProcessingRun,
  type RemoteRecording,
} from "@/contracts/recording-processing";
import { getQueryRuntime, notifyQueryChange, type QueryRuntime } from "@/lib/query-runtime";
import {
  acknowledgeRecordingProcessing,
  buildRecordingBlob,
  getRecordingSession,
} from "@/lib/idb-recordings";
import type { LocalRecordingSession } from "@/lib/recording-schemas";
import { hashRecording, recordingPart } from "@/lib/recording-upload";
import { recordingMimeType } from "@/lib/recording-media";
import { useNoteStore } from "@/stores/use-note-store";
import { isOwnedSession, useRecordingStore } from "@/stores/use-recording-store";

export async function recordingRequest<T>(path: string, schema: z.ZodType<T>, init?: RequestInit) {
  const response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store" });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(data);
    throw new Error(
      error.success ? error.data.error : "Could not process the recording. Please retry.",
    );
  }
  return schema.parse(data);
}

/** All recording consumers share this key; only the shell enables polling. */
export function recordingOverviewOptions(
  runtime: Pick<ReturnType<typeof getQueryRuntime>, "trpc">,
  workspaceId: string | undefined,
  noteId: string | undefined,
  polling = false,
  retry?: ProcessingRetryObservation,
  pendingRecordingId?: string,
) {
  return runtime.trpc.recordings.overview.queryOptions(
    workspaceId && noteId ? { workspaceId, noteId } : skipToken,
    {
      staleTime: 15_000,
      trpc: { abortOnUnmount: true },
      refetchInterval: polling
        ? (query) =>
            query.state.data?.runs.some((run) => isActiveProcessingRun(run)) ||
            (pendingRecordingId &&
              !query.state.error &&
              !query.state.data?.runs.some((run) => run.recordingId === pendingRecordingId)) ||
            (retry &&
              retry.expiresAt > Date.now() &&
              !processingRetryObserved(retry, query.state.data?.runs))
              ? 4000
              : false
        : false,
    },
  );
}

async function audioDuration(blob: Blob): Promise<number> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<number>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Could not read this audio. Try another audio format.")),
        8000,
      );
      const check = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) resolve(audio.duration);
      };
      audio.onloadedmetadata = () => {
        check();
        if (!Number.isFinite(audio.duration)) audio.currentTime = 1e10;
      };
      audio.ondurationchange = check;
      audio.ontimeupdate = check;
      audio.onerror = () => reject(new Error("This browser cannot decode the audio file."));
      audio.preload = "metadata";
      audio.src = url;
    });
  } finally {
    clearTimeout(timer);
    audio.onloadedmetadata = audio.ondurationchange = audio.ontimeupdate = audio.onerror = null;
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
  }
}

export type ProcessingRetryObservation = {
  runId: string;
  previousStatus: ProcessingRun["status"];
  previousUpdatedAt: string;
  expiresAt: number;
};
type Job = {
  busy: boolean;
  progress: string | null;
  error: string | null;
  stage?: "uploading" | "submitting" | "accepted" | "uncertain" | "failed";
  // A start response proves acceptance, not the run's current status.
  acceptance?: { recordingId: string; runId: string; receivedAt: number };
  retry?: ProcessingRetryObservation | undefined;
};
export const useProcessingJobs = create<{ jobs: Record<string, Job> }>(() => ({ jobs: {} }));
export const processingJobKey = (
  epoch: number,
  userId: string,
  workspaceId: string,
  noteId: string,
) => `${epoch}:${userId}:${workspaceId}:${noteId}`;
const flights = new Map<string, Promise<void>>();

const isActiveProcessingRun = (run: ProcessingRun) =>
  ["queued", "submitting", "submitted", "running"].includes(run.status);

export type RecordingProcessingPhase =
  | "loading"
  | "idle"
  | "uploading"
  | "submitting"
  | "accepted"
  | "processing"
  | "ready"
  | "uncertain"
  | "failed"
  | "blocked";

/** Command intent never substitutes for the current server projection. */
export function recordingProcessingView(input: {
  run: ProcessingRun | undefined;
  recording: RemoteRecording | undefined;
  local: LocalRecordingSession | undefined;
  job: Job | undefined;
  loaded: boolean;
  loading: boolean;
  dataUpdatedAt: number;
  statusError: string | undefined;
  mutationPending: boolean;
  mutationError: string | undefined;
}): { phase: RecordingProcessingPhase; retryAction: "processing" | "status" | null } {
  const { run, job, local, statusError } = input;
  const statusRetry = statusError ? "status" : null;
  if (run?.status === "succeeded") return { phase: "ready", retryAction: statusRetry };
  if (run && isActiveProcessingRun(run)) return { phase: "processing", retryAction: statusRetry };
  if (job?.busy || input.mutationPending)
    return {
      phase: job?.stage === "uploading" ? "uploading" : "submitting",
      retryAction: null,
    };
  if (job?.retry) return { phase: "accepted", retryAction: statusRetry };
  if (run?.status === "blocked") return { phase: "blocked", retryAction: "processing" };
  if (run?.status === "failed") return { phase: "failed", retryAction: "processing" };
  if (run?.status === "submission_unknown")
    return { phase: "uncertain", retryAction: "processing" };
  if (job?.acceptance) {
    const missingAfterRefresh = input.dataUpdatedAt > job.acceptance.receivedAt;
    return statusError || missingAfterRefresh
      ? { phase: "uncertain", retryAction: "status" }
      : { phase: "accepted", retryAction: null };
  }
  if (job?.stage === "uncertain" || input.mutationError)
    return { phase: "uncertain", retryAction: "processing" };
  if (job?.error) return { phase: "failed", retryAction: "processing" };
  if (input.loading) return { phase: "loading", retryAction: null };
  if (statusError) return { phase: "uncertain", retryAction: "status" };
  // Reloading a submitted manifest is recovery, not an active network request.
  if (local?.processing === "submitted") return { phase: "uncertain", retryAction: "status" };
  if (local?.status === "finalized") return { phase: "uncertain", retryAction: "processing" };
  if (!input.loaded) return { phase: "loading", retryAction: null };
  return {
    phase: "idle",
    retryAction: input.recording?.status === "ready" ? "processing" : null,
  };
}

function updateProcessingJob(key: string, changes: Partial<Job>) {
  useProcessingJobs.setState(({ jobs }) => ({
    jobs: {
      ...jobs,
      [key]: { busy: false, progress: null, error: null, ...jobs[key], ...changes },
    },
  }));
}

/** Cancellation also replaces a data-less initial read; invalidation alone does not. */
export async function refreshRecordingProcessing(
  input: { workspaceId: string; noteId: string },
  runtime = getQueryRuntime(),
) {
  if (runtime !== getQueryRuntime()) return;
  const scope = { workspaceId: input.workspaceId, noteId: input.noteId };
  await runtime.queryClient.cancelQueries(runtime.trpc.recordings.overview.queryFilter(scope));
  if (runtime !== getQueryRuntime()) return;
  await notifyQueryChange("recordings", scope, runtime);
}

/** The immutable recording identity is also the exact, replayable start command ID. */
export async function submitRecordingProcessing(
  runtime: QueryRuntime,
  input: { workspaceId: string; noteId: string; recordingId: string },
  key: string,
  owned: () => boolean,
) {
  if (!owned()) return;
  updateProcessingJob(key, {
    busy: true,
    stage: "submitting",
    progress: "Requesting transcription…",
    error: null,
  });
  try {
    const run = await runtime.client.processing.start.mutate({
      workspaceId: input.workspaceId,
      noteId: input.noteId,
      command: { id: input.recordingId, recordingId: input.recordingId },
    });
    if (!owned()) return;
    // Even an exact replay can return an older run snapshot. Retain only acknowledgement
    // evidence; never replace a newer/terminal query projection with that receipt.
    updateProcessingJob(key, {
      busy: false,
      stage: "accepted",
      progress: null,
      error: null,
      acceptance: { recordingId: run.recordingId, runId: run.id, receivedAt: Date.now() },
    });
    // Both queue recovery and explicit Retry use this boundary. A successful direct
    // retry must settle its durable intent too, or reload will replay it again.
    const local = useRecordingStore.getState().sessions[input.recordingId];
    if (
      local &&
      runtime.identity &&
      local.userId === runtime.identity.userId &&
      local.workspaceId === input.workspaceId &&
      local.noteId === input.noteId
    ) {
      const submitted = await acknowledgeRecordingProcessing({
        id: input.recordingId,
        userId: runtime.identity.userId,
        workspaceId: input.workspaceId,
        noteId: input.noteId,
      });
      if (submitted && owned())
        useRecordingStore.setState(({ sessions }) => {
          const current = sessions[input.recordingId];
          if (!current || current.status !== "finalized" || !isOwnedSession(current))
            return { sessions };
          return {
            sessions: {
              ...sessions,
              [current.id]: { ...current, processing: "submitted" },
            },
          };
        });
    }
    return run;
  } catch (error) {
    if (owned())
      updateProcessingJob(key, {
        busy: false,
        stage: "uncertain",
        progress: null,
        error: error instanceof Error ? error.message : "Transcription was not confirmed.",
      });
    throw error;
  } finally {
    if (owned())
      void refreshRecordingProcessing(input, runtime).catch(() => {
        // Query state owns refresh errors; accepted work never waits for a status read.
      });
  }
}

function processingRetryObserved(
  retry: ProcessingRetryObservation,
  runs: readonly ProcessingRun[] | undefined,
) {
  const run = runs?.find((item) => item.id === retry.runId);
  return (
    !!run &&
    (isActiveProcessingRun(run) ||
      run.status !== retry.previousStatus ||
      Date.parse(run.updatedAt) > Date.parse(retry.previousUpdatedAt))
  );
}

/** Called only after an accepted retry and an ownership check; never fabricates run state. */
export function beginProcessingRetryObservation(key: string, run: ProcessingRun, now = Date.now()) {
  const retry: ProcessingRetryObservation = {
    runId: run.id,
    previousStatus: run.status,
    previousUpdatedAt: run.updatedAt,
    expiresAt: now + 60_000,
  };
  useProcessingJobs.setState(({ jobs }) => ({
    jobs: {
      ...jobs,
      [key]: {
        busy: false,
        ...jobs[key],
        progress: "Waiting for transcription to restart…",
        error: null,
        retry,
      },
    },
  }));
  return retry;
}

/** The shell settles command observation, including fast terminal completions and timeouts. */
export function settleProcessingRetryObservation(
  key: string,
  retry: ProcessingRetryObservation,
  runs: readonly ProcessingRun[] | undefined,
  now = Date.now(),
) {
  const observed = processingRetryObserved(retry, runs);
  if (!observed && now < retry.expiresAt) return false;
  useProcessingJobs.setState(({ jobs }) => {
    const job = jobs[key];
    // A departed scope or an older timeout cannot settle a newer retry command.
    if (!job || job.retry !== retry) return { jobs };
    return {
      jobs: {
        ...jobs,
        [key]: {
          ...job,
          retry: undefined,
          progress: null,
          error: observed
            ? null
            : "Transcription restart was not confirmed. Your audio is saved. Retry to check again.",
        },
      },
    };
  });
  return true;
}

/** Route-independent, owner-bound, resumable work. The finalized IDB manifest is the queue. */
export function queueRecordingProcessing(id: string): Promise<void> {
  const state = useNoteStore.getState();
  const account = state.session;
  if (!account) return Promise.resolve();
  const runtime = getQueryRuntime();
  const flightKey = `${state.epoch}:${account.user.id}:${account.workspace.id}:${id}`;
  const existing = flights.get(flightKey);
  if (existing) return existing;
  const work = async () => {
    let key: string | undefined;
    let noteId: string | undefined;
    let startAttempted = false;
    const owned = () => {
      const current = useNoteStore.getState();
      return (
        current.epoch === state.epoch &&
        getQueryRuntime().scope === runtime.scope &&
        current.session?.user.id === account.user.id &&
        current.session.workspace.id === account.workspace.id
      );
    };
    const report = (changes: Partial<Job>) => {
      if (key && owned()) updateProcessingJob(key, changes);
    };
    try {
      const local = await getRecordingSession(id);
      if (
        !owned() ||
        local.userId !== account.user.id ||
        local.workspaceId !== account.workspace.id ||
        local.status !== "finalized"
      )
        return;
      key = processingJobKey(state.epoch, local.userId, local.workspaceId, local.noteId);
      noteId = local.noteId;
      report({ busy: true, stage: "uploading", error: null, progress: "Preparing audio…" });
      await useNoteStore.getState().ensureNote(local.noteId);
      const check = () => {
        if (!owned() || !isOwnedSession(local))
          throw new Error("Upload paused. Sign in to resume.");
      };
      check();
      const root = `/api/workspaces/${local.workspaceId}/notes/${local.noteId}`;
      // Normalize legacy, locally rejected aliases without rewriting the manifest,
      // chunks or recording identity. Already accepted wire types remain unchanged.
      const mimeType = recordingMimeType(local.mimeType);
      const blob = await buildRecordingBlob(id, mimeType);
      if (!blob.size || blob.size > MAX_RECORDING_BYTES)
        throw new Error(`Choose audio up to ${RECORDING_SIZE_LABEL}.`);
      const durationSeconds = await audioDuration(blob);
      if (durationSeconds > MAX_RECORDING_SECONDS)
        throw new Error("Choose audio up to two hours long.");
      const sha256 = await hashRecording(blob, check, (fraction) =>
        report({ progress: `Preparing audio · ${Math.round(fraction * 100)}%` }),
      );
      const input = recordingInputSchema.parse({
        id,
        sha256,
        bytes: blob.size,
        mimeType,
        durationSeconds,
      });
      check();
      const recording = await runtime.client.recordings.initialize.mutate({
        workspaceId: local.workspaceId,
        noteId: local.noteId,
        command: input,
      });
      check();
      if (recording.status !== "ready") {
        if (blob.size <= RECORDING_UPLOAD_PART_BYTES) {
          report({ progress: "Uploading audio…" });
          await recordingRequest(`${root}/recordings/${id}/audio`, recordingSchema, {
            method: "PUT",
            headers: { "Content-Type": input.mimeType },
            body: blob,
          });
        } else {
          const uploadRoot = `${root}/recordings/${id}/upload`;
          const status = await recordingRequest(uploadRoot, recordingUploadSchema);
          const saved = new Map(status.parts.map((part) => [part.index, part.sha256]));
          const total = Math.ceil(blob.size / RECORDING_UPLOAD_PART_BYTES);
          if (!status.ready)
            for (let index = 0; index < total; index++) {
              check();
              const part = recordingPart(blob, index);
              const checksum = await hashRecording(part, check, () => {});
              if (saved.get(index) !== checksum) {
                report({ progress: `Uploading audio · ${Math.round((index / total) * 100)}%` });
                await recordingRequest(`${uploadRoot}/${index}`, uploadPartSchema, {
                  method: "PUT",
                  headers: {
                    "Content-Type": "application/octet-stream",
                    "X-Content-SHA256": checksum,
                  },
                  body: part,
                });
              }
            }
          check();
          report({ progress: "Finishing upload…" });
          await recordingRequest(uploadRoot, recordingSchema, { method: "POST" });
        }
      }
      check();
      // One run per recording: reuse the recording identity even after a lost response.
      startAttempted = true;
      await submitRecordingProcessing(
        runtime,
        { workspaceId: local.workspaceId, noteId: local.noteId, recordingId: id },
        key,
        owned,
      );
      check();
    } catch (error) {
      report({
        ...(!startAttempted ? { stage: "failed" as const } : {}),
        error: error instanceof Error ? error.message : "Upload interrupted. Retry to resume.",
      });
    } finally {
      report({ busy: false, progress: null });
      if (noteId && !startAttempted && owned())
        void refreshRecordingProcessing(
          { workspaceId: account.workspace.id, noteId },
          runtime,
        ).catch(() => {});
    }
  };
  const task = (
    navigator.locks
      ? navigator.locks.request(`voidnote-process:${account.user.id}:${id}`, work)
      : work()
  ).finally(() => flights.delete(flightKey));
  flights.set(flightKey, task);
  return task;
}

export function watchProcessingQueue() {
  const attempted = new Set<string>();
  const check = () => {
    const state = useNoteStore.getState();
    if (!state.session) return;
    for (const local of Object.values(useRecordingStore.getState().sessions)) {
      const key = `${state.epoch}:${local.id}`;
      if (
        local.status !== "finalized" ||
        local.processing !== "pending" ||
        local.userId !== state.session.user.id ||
        local.workspaceId !== state.session.workspace.id ||
        attempted.has(key)
      )
        continue;
      attempted.add(key);
      void queueRecordingProcessing(local.id);
    }
  };
  const stop = useRecordingStore.subscribe(check);
  const stopScope = useNoteStore.subscribe(check);
  const online = () => {
    attempted.clear();
    check();
  };
  window.addEventListener("online", online);
  check();
  return () => {
    stop();
    stopScope();
    window.removeEventListener("online", online);
  };
}
