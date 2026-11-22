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
} from "@/contracts/recording-processing";
import { getQueryRuntime, notifyQueryChange } from "@/lib/query-runtime";
import {
  buildRecordingBlob,
  getRecordingSession,
  pinRecordingInitialization,
  putRecordingSession,
} from "@/lib/idb-recordings";
import { hashRecording, recordingPart } from "@/lib/recording-upload";
import { recordingDuration } from "@/lib/recording-duration";
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
) {
  return runtime.trpc.recordings.overview.queryOptions(
    workspaceId && noteId ? { workspaceId, noteId } : skipToken,
    {
      staleTime: 15_000,
      trpc: { abortOnUnmount: true },
      refetchInterval: polling
        ? (query) =>
            query.state.data?.runs.some((run) => isActiveProcessingRun(run)) ||
            (retry &&
              retry.expiresAt > Date.now() &&
              !processingRetryObserved(retry, query.state.data?.runs))
              ? 4000
              : false
        : false,
    },
  );
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
      if (key && owned())
        useProcessingJobs.setState(({ jobs }) => ({
          jobs: {
            ...jobs,
            [key!]: {
              busy: false,
              progress: null,
              error: null,
              ...jobs[key!],
              ...changes,
            },
          },
        }));
    };
    try {
      let local = await getRecordingSession(id);
      if (
        !owned() ||
        local.userId !== account.user.id ||
        local.workspaceId !== account.workspace.id ||
        local.status !== "finalized"
      )
        return;
      key = processingJobKey(state.epoch, local.userId, local.workspaceId, local.noteId);
      noteId = local.noteId;
      report({ busy: true, error: null, progress: "Preparing audio…" });
      await useNoteStore.getState().ensureNote(local.noteId);
      const check = () => {
        if (!owned() || !isOwnedSession(local))
          throw new Error("Upload paused. Sign in to resume.");
      };
      check();
      const root = `/api/workspaces/${local.workspaceId}/notes/${local.noteId}`;
      const blob = await buildRecordingBlob(id, local.mimeType);
      if (!blob.size || blob.size > MAX_RECORDING_BYTES)
        throw new Error(`Choose audio up to ${RECORDING_SIZE_LABEL}.`);
      if (!local.initialization) {
        const sha256 = await hashRecording(blob, check, (fraction) =>
          report({ progress: `Preparing audio · ${Math.round(fraction * 100)}%` }),
        );
        check();
        // Older manifests may have been accepted remotely before commands were
        // pinned locally. Recover that exact input rather than changing its timing.
        const overview = await runtime.queryClient.fetchQuery({
          ...recordingOverviewOptions(runtime, local.workspaceId, local.noteId),
          staleTime: 0,
        });
        check();
        const existing = overview.recordings.find((recording) => recording.id === id);
        const mimeType = recordingInputSchema.shape.mimeType.parse(
          (blob.type || local.mimeType).split(";")[0],
        );
        if (
          existing &&
          (existing.sha256 !== sha256 ||
            existing.bytes !== blob.size ||
            existing.mimeType !== mimeType)
        ) {
          throw new Error("Saved upload metadata does not match the local audio.");
        }
        const durationSeconds = existing?.durationSeconds ?? (await recordingDuration(blob, check));
        if (durationSeconds > MAX_RECORDING_SECONDS)
          throw new Error("Choose audio up to two hours long.");
        check();
        local = await pinRecordingInitialization(id, {
          id,
          sha256,
          bytes: blob.size,
          mimeType,
          durationSeconds,
        });
        check();
        useRecordingStore.setState(({ sessions }) => ({
          sessions: { ...sessions, [id]: local },
        }));
      }
      const input = recordingInputSchema.parse(local.initialization);
      if (input.id !== id || input.bytes !== blob.size) {
        throw new Error("Saved upload metadata does not match the local audio.");
      }
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
      report({ progress: "Transcribing…" });
      // One run per recording: reuse the recording identity even after a lost response.
      await runtime.client.processing.start.mutate({
        workspaceId: local.workspaceId,
        noteId: local.noteId,
        command: { id, recordingId: id },
      });
      check();
      const submitted = { ...local, processing: "submitted" as const };
      await putRecordingSession(submitted);
      if (owned())
        useRecordingStore.setState(({ sessions }) => ({
          sessions: { ...sessions, [id]: submitted },
        }));
    } catch (error) {
      report({
        error: error instanceof Error ? error.message : "Upload interrupted. Retry to resume.",
      });
    } finally {
      report({ busy: false, progress: null });
      if (noteId && owned())
        await notifyQueryChange(
          "recordings",
          { workspaceId: account.workspace.id, noteId },
          runtime,
        );
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
