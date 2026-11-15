"use client";

import { create } from "zustand";
import { acquireCaptureLock, captureSupported } from "@/lib/recorder";
import { createNoteModel } from "@/lib/types";
import { useNoteStore } from "@/stores/use-note-store";
import { useRecordingStore } from "@/stores/use-recording-store";
import {
  defaultRecordingPreferences,
  recordingPreferenceKey,
  useRecordingPreferences,
} from "@/stores/use-recording-preferences";
import { useAudioPlaybackStore } from "@/stores/use-audio-playback-store";
import {
  getRecordingSession,
  getRecordingSessions,
  putRecordingSession,
} from "@/lib/idb-recordings";
import { recordingRequest } from "@/lib/recording-processing-client";
import {
  MAX_RECORDING_BYTES,
  RECORDING_SIZE_LABEL,
  recordingOverviewSchema,
} from "@/contracts/recording-processing";

type Owner = { noteId: string; userId: string; workspaceId: string; epoch: number };
type Runtime = {
  owner: Owner;
  cancelled: boolean;
  started: boolean;
  release?: () => void;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  sessionId?: string;
  tail: Promise<void>;
  failure: Error | null;
  queuedBytes: number;
  stopped: Promise<void>;
  resolveStopped(): void;
  stopTask?: Promise<void>;
};
let runtime: Runtime | null = null;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Audio could not be saved on this device.";
function sameScope(owner: Owner) {
  const state = useNoteStore.getState();
  return (
    state.epoch === owner.epoch &&
    state.session?.user.id === owner.userId &&
    state.session.workspace.id === owner.workspaceId
  );
}
function currentOwner(owner: Owner) {
  const state = useNoteStore.getState();
  const record = state.noteRecords[owner.noteId];
  return (
    sameScope(owner) &&
    !!record &&
    record.workspaceId === owner.workspaceId &&
    !record.deletedAt &&
    !state.unavailable[`note:${owner.noteId}`]
  );
}
function materializeOwner(owner: Owner) {
  if (!currentOwner(owner)) return undefined;
  const state = useNoteStore.getState();
  const existing = state.notes.find((note) => note.id === owner.noteId);
  if (existing) return existing; // A live draft always wins over its saved projection.
  const record = state.noteRecords[owner.noteId];
  if (!record) return undefined;
  const note = createNoteModel({ ...record, scopeEpoch: owner.epoch });
  // Search results are only a list cache. Restore the acknowledged model before
  // using upsertNote, which intentionally accepts updates only to materialized notes.
  useNoteStore.setState({ notes: [...state.notes, note] });
  return useNoteStore.getState().notes.find((note) => note.id === owner.noteId);
}
async function prepareOwner(noteId: string, adding = false): Promise<Owner> {
  const state = useNoteStore.getState();
  if (!state.session) throw new Error("Sign in before recording.");
  const owner = {
    noteId,
    userId: state.session.user.id,
    workspaceId: state.session.workspace.id,
    epoch: state.epoch,
  };
  if (
    !sameScope(owner) ||
    (!state.noteRecords[noteId] && !state.notes.some((note) => note.id === noteId))
  )
    throw new Error("Select a note in this workspace.");
  if (!state.noteRecords[noteId]) {
    while (useNoteStore.getState().edits[`note:${noteId}`]?.saving && sameScope(owner))
      await new Promise((resolve) => setTimeout(resolve, 25));
    if (sameScope(owner)) await state.saveNote(noteId);
  }
  const record = useNoteStore.getState().noteRecords[noteId];
  if (
    !currentOwner(owner) ||
    !record ||
    record.deletedAt ||
    record.workspaceId !== owner.workspaceId
  )
    throw new Error("Save this note successfully before adding audio.");
  if (adding) {
    const locals = await getRecordingSessions();
    const remote = await recordingRequest(
      `/api/workspaces/${owner.workspaceId}/notes/${noteId}/recordings`,
      recordingOverviewSchema,
    );
    if (
      remote.recordings.length ||
      locals.some(
        (s) =>
          s.noteId === noteId &&
          s.userId === owner.userId &&
          s.workspaceId === owner.workspaceId &&
          s.chunkCount > 0,
      )
    )
      throw new Error("This note already has audio. Start a new note to record again.");
  }
  return owner;
}
function attachAudio(owner: Owner, id: string, playback: { blob: Blob; url: string }) {
  const state = useNoteStore.getState();
  const note = materializeOwner(owner);
  if (!currentOwner(owner) || !note) {
    URL.revokeObjectURL(playback.url);
    return;
  }
  state.upsertNote({ ...note, audio: playback.blob, url: playback.url, recordingSessionId: id });
  if (note.url?.startsWith("blob:") && note.url !== playback.url) URL.revokeObjectURL(note.url);
  const session = useRecordingStore.getState().sessions[id];
  if (session)
    useAudioPlaybackStore.getState().selectRecording(session, playback.blob, owner.epoch);
}
interface CaptureState {
  status: "idle" | "starting" | "recording" | "paused" | "stopping" | "error";
  supported: boolean | null;
  noteId: string | null;
  sessionId: string | null;
  stream: MediaStream | null;
  error: string | null;
  liveTextError: string | null;
  elapsedMs: number;
  savedChunks: number;
  waveformLevels: number[];
  checkSupport: () => void;
  start: (noteId: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<void>;
  requestData: () => void;
  upload: (noteId: string, file: File) => Promise<void>;
  recover: (sessionId: string) => Promise<void>;
  appendText: (text: string) => void;
}
export const useCaptureStore = create<CaptureState>((set, get) => {
  const fail = (error: unknown) => set({ status: "error", error: errorMessage(error) });
  const finish = (run: Runtime): Promise<void> => {
    if (run.stopTask) return run.stopTask;
    run.stopTask = (async () => {
      if (sameScope(run.owner) && runtime === run) set({ status: "stopping" });
      try {
        if (run.started && run.recorder && run.recorder.state !== "inactive") run.recorder.stop();
        if (run.started) await run.stopped; // never await stop on a recorder that never started
        await run.tail;
        if (run.failure) throw run.failure;
        if (run.sessionId) {
          const playback = await useRecordingStore
            .getState()
            .finalizeSession(run.sessionId, run.release);
          attachAudio(run.owner, run.sessionId, playback);
        }
        if (sameScope(run.owner) && runtime === run) set({ status: "idle", error: null });
      } catch (error) {
        if (run.sessionId)
          await useRecordingStore
            .getState()
            .failSession(run.sessionId, errorMessage(error), run.owner.epoch)
            .catch(() => {});
        if (sameScope(run.owner) && runtime === run) fail(error);
      } finally {
        run.stream?.getTracks().forEach((track) => track.stop());
        run.release?.();
        if (runtime === run) {
          runtime = null;
          if (sameScope(run.owner)) set({ stream: null });
        }
      }
    })();
    return run.stopTask;
  };
  return {
    status: "idle",
    supported: null,
    noteId: null,
    sessionId: null,
    stream: null,
    error: null,
    liveTextError: null,
    elapsedMs: 0,
    savedChunks: 0,
    waveformLevels: [],
    checkSupport: () => set({ supported: captureSupported() }),
    start: async (noteId) => {
      if (runtime || !["idle", "error"].includes(get().status)) return;
      useAudioPlaybackStore.getState().pause();
      set({
        status: "starting",
        noteId,
        error: null,
        elapsedMs: 0,
        savedChunks: 0,
        waveformLevels: [],
        sessionId: null,
      });
      let run: Runtime | undefined;
      try {
        if (!captureSupported())
          throw new Error(
            "Microphone recording is unsupported here. Use a current browser over HTTPS with Web Locks support.",
          );
        // Claim the local operation synchronously before any network/permission await.
        const state = useNoteStore.getState();
        if (!state.session) throw new Error("Sign in before recording.");
        let resolveStopped = () => {};
        run = {
          owner: {
            noteId,
            userId: state.session.user.id,
            workspaceId: state.session.workspace.id,
            epoch: state.epoch,
          },
          cancelled: false,
          started: false,
          tail: Promise.resolve(),
          failure: null,
          queuedBytes: 0,
          stopped: new Promise<void>((resolve) => {
            resolveStopped = resolve;
          }),
          resolveStopped: () => resolveStopped(),
        };
        runtime = run;
        run.release = await acquireCaptureLock();
        if (run.cancelled) throw new Error("Recording cancelled.");
        run.owner = await prepareOwner(noteId, true);
        if (run.cancelled || !currentOwner(run.owner)) throw new Error("Recording cancelled.");
        const prefs =
          useRecordingPreferences.getState().byOwner[recordingPreferenceKey()] ??
          defaultRecordingPreferences;
        run.stream = await navigator.mediaDevices.getUserMedia({
          audio: prefs.deviceId === "default" ? true : { deviceId: { exact: prefs.deviceId } },
        });
        if (run.cancelled || !currentOwner(run.owner)) throw new Error("Recording cancelled.");
        const recorder = new MediaRecorder(run.stream);
        run.recorder = recorder;
        const session = await useRecordingStore.getState().startSession(noteId, recorder.mimeType);
        run.sessionId = session.id;
        const active = run;
        recorder.ondataavailable = (event) => {
          if (!event.data.size || active.failure) return;
          active.queuedBytes += event.data.size;
          if (active.queuedBytes > 8 * 1024 * 1024) {
            active.failure = new Error(
              "Local storage cannot keep up. Capture stopped; earlier chunks remain available.",
            );
            void finish(active);
            return;
          }
          active.tail = active.tail
            .then(async () => {
              if (active.failure) return;
              await useRecordingStore.getState().appendChunk(session.id, event.data);
              if (sameScope(active.owner) && runtime === active)
                set((state) => ({ savedChunks: state.savedChunks + 1 }));
            })
            .catch((error) => {
              active.failure = new Error(errorMessage(error));
              void finish(active);
            })
            .finally(() => {
              active.queuedBytes -= event.data.size;
            });
        };
        recorder.onstop = () => {
          active.resolveStopped();
          if (!active.stopTask) void finish(active);
        };
        recorder.onerror = () => {
          active.failure = new Error(
            "Microphone capture failed. Earlier audio is retained locally.",
          );
          void finish(active);
        };
        recorder.onpause = () => {
          if (!active.stopTask && sameScope(active.owner) && runtime === active)
            set({ status: "paused" });
        };
        recorder.onresume = () => {
          if (!active.stopTask && sameScope(active.owner) && runtime === active)
            set({ status: "recording" });
        };
        if (run.cancelled || !currentOwner(run.owner)) {
          delete run.recorder;
          throw new Error("Recording cancelled.");
        }
        recorder.start(1000);
        run.started = true;
        useRecordingStore.setState({ activeSessionId: session.id, error: null });
        run.stream.getTracks().forEach((track) =>
          track.addEventListener(
            "ended",
            () => {
              void finish(active);
            },
            { once: true },
          ),
        );
        set({ status: "recording", sessionId: session.id, stream: run.stream });
      } catch (error) {
        run?.stream?.getTracks().forEach((track) => track.stop());
        run?.release?.();
        if (run?.sessionId)
          await useRecordingStore
            .getState()
            .failSession(run.sessionId, errorMessage(error), run.cancelled ? null : run.owner.epoch)
            .catch(() => {});
        if (runtime === run || !run) {
          runtime = null;
          if (!run || (sameScope(run.owner) && !run.cancelled)) fail(error);
        }
      }
    },
    pause: () => {
      if (runtime?.recorder?.state === "recording") {
        runtime.recorder.requestData();
        runtime.recorder.pause();
      }
    },
    resume: () => {
      if (runtime?.recorder?.state === "paused") runtime.recorder.resume();
    },
    stop: async () => {
      const run = runtime;
      if (!run) return;
      if (!run.started) {
        run.cancelled = true;
        run.release?.();
        runtime = null;
        set({ status: "idle", stream: null });
        return;
      }
      await finish(run);
    },
    requestData: () => {
      if (runtime?.recorder && runtime.recorder.state !== "inactive")
        runtime.recorder.requestData();
    },
    upload: async (noteId, file) => {
      if (runtime || !["idle", "error"].includes(get().status)) return;
      useAudioPlaybackStore.getState().pause();
      set({ status: "stopping", noteId, error: null });
      let id: string | undefined;
      const epoch = useNoteStore.getState().epoch;
      let release: (() => void) | undefined;
      try {
        if (!file.size || !file.type.startsWith("audio/"))
          throw new Error("Choose a non-empty audio file.");
        if (file.size > MAX_RECORDING_BYTES)
          throw new Error(`Choose audio up to ${RECORDING_SIZE_LABEL}.`);
        release = await acquireCaptureLock();
        const owner = await prepareOwner(noteId, true);
        if (!currentOwner(owner)) throw new Error("Workspace changed before adding audio.");
        const session = await useRecordingStore.getState().startSession(noteId, file.type, "file");
        id = session.id;
        if (sameScope(owner)) useRecordingStore.setState({ activeSessionId: id, error: null });
        if (sameScope(owner)) set({ status: "stopping", sessionId: id });
        for (let offset = 0; offset < file.size; offset += 1024 * 1024)
          await useRecordingStore
            .getState()
            .appendChunk(id, file.slice(offset, offset + 1024 * 1024, file.type));
        const playback = await useRecordingStore.getState().finalizeSession(id, release);
        attachAudio(owner, id, playback);
        if (sameScope(owner)) set({ status: "idle" });
      } catch (error) {
        if (id)
          await useRecordingStore
            .getState()
            .failSession(id, errorMessage(error), epoch)
            .catch(() => {});
        if (useNoteStore.getState().epoch === epoch) fail(error);
      } finally {
        release?.();
      }
    },
    recover: async (id) => {
      if (runtime || !["idle", "error"].includes(get().status)) return;
      set({ status: "stopping" });
      const epoch = useNoteStore.getState().epoch;
      try {
        const session = useRecordingStore.getState().sessions[id];
        if (!session) throw new Error("Local recording not found.");
        const owner = await prepareOwner(session.noteId);
        if (sameScope(owner)) set({ noteId: session.noteId, error: null });
        // Finalized audio is immutable playback. Interrupted-session recovery must
        // first establish there is no live writer in any tab.
        let playback: { blob: Blob; url: string };
        if (session.status === "finalized")
          playback = await useRecordingStore.getState().loadSessionPlayback(id);
        else {
          const release = await acquireCaptureLock();
          try {
            if (!currentOwner(owner)) throw new Error("Workspace changed before recovery.");
            const stored = await getRecordingSession(id);
            if (stored.status === "failed")
              await putRecordingSession({ ...stored, status: "recoverable" });
            playback = await useRecordingStore.getState().finalizeSession(id, release);
          } finally {
            release();
          }
        }
        attachAudio(owner, id, playback);
        if (sameScope(owner)) set({ status: "idle", error: null });
      } catch (error) {
        if (useNoteStore.getState().epoch === epoch) fail(error);
      }
    },
    appendText: (text) => {
      const run = runtime;
      if (!run || get().status !== "recording" || !currentOwner(run.owner)) return;
      const state = useNoteStore.getState();
      const note = materializeOwner(run.owner);
      if (note)
        state.upsertNote({
          ...note,
          transcript: `${note.transcript}\n${text}`.trim(),
          updatedAt: new Date().toISOString(),
        });
    },
  };
});

// Subscribe only while the persistent authenticated host is mounted.
let observedScope: string | null = null;
export function watchCaptureOwner() {
  const synchronize = () => {
    const state = useNoteStore.getState();
    const scope = `${state.epoch}:${state.session?.user.id ?? ""}:${state.session?.workspace.id ?? ""}`;
    const run = runtime;
    if (
      run &&
      (!sameScope(run.owner) || ((run.started || run.sessionId) && !currentOwner(run.owner)))
    )
      void useCaptureStore.getState().stop();
    if (observedScope !== scope) {
      observedScope = scope;
      useCaptureStore.setState({
        status: "idle",
        noteId: null,
        sessionId: null,
        stream: null,
        error: null,
        liveTextError: null,
        elapsedMs: 0,
        savedChunks: 0,
        waveformLevels: [],
      });
      useRecordingStore.setState({
        sessions: {},
        activeSessionId: null,
        error: null,
        hydration: "idle",
        hydratedEpoch: null,
      });
      useAudioPlaybackStore.getState().reset();
    }
  };
  synchronize();
  return useNoteStore.subscribe(synchronize);
}
