"use client";

import { create } from "zustand";
import { z } from "zod";
import type { LocalRecordingSession } from "@/lib/recording-schemas";
import { withCaptureLock } from "@/lib/recorder";
import { useNoteStore } from "@/stores/use-note-store";
import { isOwnedSession, useRecordingStore } from "@/stores/use-recording-store";
import { recordingContainerDuration } from "@/lib/recording-duration";

type PlaybackOwnerScope = {
  noteId: string;
  userId: string;
  workspaceId: string;
  epoch: number;
};
type PlaybackOwner = PlaybackOwnerScope &
  (
    | { source: "local"; sessionId: string; recordingId?: never }
    | { source: "remote"; recordingId: string; sessionId?: never }
  );
export type RemotePlaybackInput = {
  noteId: string;
  recordingId: string;
  mimeType?: string | undefined;
};
type PlaybackStatus = "idle" | "loading" | "ready" | "playing" | "paused" | "ended" | "error";
interface AudioPlaybackState {
  owner: PlaybackOwner | null;
  url: string | null;
  mimeType: string;
  status: PlaybackStatus;
  duration: number | null;
  currentTime: number;
  seekStart: number;
  seekEnd: number;
  error: string | null;
  loadSession: (id: string) => Promise<void>;
  /** Resolves after selecting the URL/queuing the timestamp, not after network/media loading. */
  loadRemote: (recording: RemotePlaybackInput, startSeconds?: number) => Promise<boolean>;
  selectRecording: (session: LocalRecordingSession, blob: Blob, epoch: number) => void;
  play: () => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => void;
  reset: () => void;
  restoreSelection: () => Promise<void>;
}
let element: HTMLAudioElement | null = null;
// Immutable backing data for the active local URL, released with that source.
let localPlaybackBlob: Blob | null = null;
let generation = 0;
let playAttempt = 0;
let pendingSeek: { generation: number; url: string; seconds: number } | null = null;
let playbackRoute: string | null | undefined;
let rangeEnd: number | null = null;
export function stopAudioRange() {
  rangeEnd = null;
  useAudioPlaybackStore.getState().pause();
}
export function setPlaybackRoute(noteId: string | null) {
  playbackRoute = noteId;
  if (useAudioPlaybackStore.getState().owner?.noteId !== noteId)
    useAudioPlaybackStore.getState().reset();
}
export async function playAudioRange(
  noteId: string,
  recordingId: string,
  start: number,
  end: number,
) {
  const player = useAudioPlaybackStore.getState();
  if (await player.loadRemote({ noteId, recordingId }, start)) {
    rangeEnd = end;
    await player.play();
  }
}
const remoteInputSchema = z.object({
  noteId: z.uuid(),
  recordingId: z.uuid(),
  mimeType: z.string().max(200).optional(),
});
const selectionSchema = z.union([
  z.object({
    source: z.literal("local").default("local"),
    noteId: z.uuid(),
    sessionId: z.string().min(1),
  }),
  remoteInputSchema.extend({ source: z.literal("remote") }),
]);
function revokePlaybackUrl(url: string | null) {
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
}
function selectionKey() {
  const session = useNoteStore.getState().session;
  return session ? `voidnote-audio-selection-v1:${session.user.id}:${session.workspace.id}` : null;
}
function forgetSelection(owner: PlaybackOwner) {
  try {
    const key = `voidnote-audio-selection-v1:${owner.userId}:${owner.workspaceId}`;
    const raw = sessionStorage.getItem(key);
    const selection = raw ? selectionSchema.safeParse(JSON.parse(raw) as unknown) : null;
    if (
      selection?.success &&
      selection.data.source === owner.source &&
      (selection.data.source === "local"
        ? selection.data.sessionId === owner.sessionId
        : selection.data.recordingId === owner.recordingId)
    )
      sessionStorage.removeItem(key);
  } catch {
    /* The bookmark is optional, unlike the IndexedDB audio commit. */
  }
}
const emptyPlayback = {
  owner: null,
  url: null,
  mimeType: "",
  status: "idle" as const,
  duration: null,
  currentTime: 0,
  seekStart: 0,
  seekEnd: 0,
  error: null,
};
function ownsPlayback(owner: PlaybackOwner) {
  const state = useNoteStore.getState();
  const record = state.noteRecords[owner.noteId];
  return (
    state.epoch === owner.epoch &&
    state.session?.user.id === owner.userId &&
    state.session.workspace.id === owner.workspaceId &&
    !!record &&
    !record.deletedAt &&
    record.workspaceId === owner.workspaceId &&
    !state.unavailable[`note:${owner.noteId}`] &&
    (playbackRoute === undefined || playbackRoute === owner.noteId)
  );
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : "This audio could not be played.";

// Keep the request until the browser can apply it. It cannot seek a replacement
// source, and a transient lack of metadata/seekable ranges never drops a timestamp.
function applyPendingSeek() {
  const request = pendingSeek;
  const player = element;
  const state = useAudioPlaybackStore.getState();
  if (!request) return;
  if (
    request.generation !== generation ||
    request.url !== state.url ||
    !state.owner ||
    !ownsPlayback(state.owner)
  ) {
    pendingSeek = null;
    rangeEnd = null;
    return;
  }
  if (
    !player ||
    player.currentSrc !== request.url ||
    player.readyState < HTMLMediaElement.HAVE_METADATA
  )
    return;
  const ranges = player.seekable;
  const duration = Number.isFinite(player.duration) ? player.duration : state.duration;
  if (!ranges.length && duration === null) return;
  const target = Math.max(
    ranges.length ? ranges.start(0) : 0,
    Math.min(duration ?? request.seconds, request.seconds),
  );
  if (
    player.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    Math.abs(player.currentTime - target) < 0.05
  ) {
    pendingSeek = null;
    return;
  }
  try {
    player.currentTime = target;
    for (let index = 0; index < ranges.length; index++) {
      if (target >= ranges.start(index) && target <= ranges.end(index)) {
        pendingSeek = null;
        break;
      }
    }
  } catch {
    /* Retry on metadata/progress/canplay events. */
  }
}

export const useAudioPlaybackStore = create<AudioPlaybackState>((set, get) => {
  const replaceSource = (owner: PlaybackOwner, url: string, mimeType: string, blob?: Blob) => {
    if (!ownsPlayback(owner)) {
      revokePlaybackUrl(url);
      return;
    }
    pendingSeek = null;
    const oldUrl = get().url;
    element?.pause();
    localPlaybackBlob = blob ?? null;
    set({
      ...emptyPlayback,
      owner,
      url,
      mimeType,
      status: "loading",
    });
    try {
      const key = selectionKey();
      if (key)
        sessionStorage.setItem(
          key,
          JSON.stringify(
            owner.source === "local"
              ? { source: "local", noteId: owner.noteId, sessionId: owner.sessionId }
              : {
                  source: "remote",
                  noteId: owner.noteId,
                  recordingId: owner.recordingId,
                  ...(mimeType ? { mimeType } : {}),
                },
          ),
        );
    } catch {
      /* Audio is still persisted; only automatic selection after reload is unavailable. */
    }
    if (element) {
      element.src = url;
      element.load();
    }
    revokePlaybackUrl(oldUrl);
  };
  const localOwner = (session: LocalRecordingSession, epoch: number): PlaybackOwner => ({
    source: "local",
    noteId: session.noteId,
    sessionId: session.id,
    userId: session.userId,
    workspaceId: session.workspaceId,
    epoch,
  });
  return {
    ...emptyPlayback,
    restoreSelection: async () => {
      const key = selectionKey();
      const epoch = useNoteStore.getState().epoch;
      if (!key || get().owner) return;
      const request = generation;
      try {
        const raw = sessionStorage.getItem(key);
        if (!raw) return;
        const result = selectionSchema.safeParse(JSON.parse(raw) as unknown);
        if (!result.success) {
          sessionStorage.removeItem(key);
          return;
        }
        const selected = result.data;
        if (selected.source === "local") await useRecordingStore.getState().recoverDraftSessions();
        if (request !== generation || epoch !== useNoteStore.getState().epoch || get().owner)
          return;
        if (!useNoteStore.getState().noteRecords[selected.noteId])
          await useNoteStore.getState().ensureNote(selected.noteId);
        if (request !== generation || epoch !== useNoteStore.getState().epoch || get().owner)
          return;
        if (selected.source === "remote") {
          await get().loadRemote(selected);
          return;
        }
        const session = useRecordingStore.getState().sessions[selected.sessionId];
        if (!session || session.noteId !== selected.noteId || !isOwnedSession(session)) {
          sessionStorage.removeItem(key);
          return;
        }
        await get().loadSession(session.id);
      } catch {
        /* A broken selection bookmark never prevents local capture or explicit recovery. */
      }
    },
    selectRecording: (session, blob, epoch) => {
      if (useNoteStore.getState().epoch !== epoch || !isOwnedSession(session)) return;
      const owner = localOwner(session, epoch);
      if (!ownsPlayback(owner)) return;
      generation++;
      replaceSource(owner, URL.createObjectURL(blob), session.mimeType, blob);
    },
    loadSession: async (id) => {
      const session = useRecordingStore.getState().sessions[id];
      if (get().owner?.source === "local" && get().owner?.sessionId === id && get().url) return;
      const request = ++generation;
      const epoch = useNoteStore.getState().epoch;
      get().pause();
      set({ status: "loading", error: null });
      try {
        if (!session || !isOwnedSession(session))
          throw new Error("This recording is not available in the active workspace.");
        const load = () => useRecordingStore.getState().loadSessionPlayback(id);
        const playback =
          session.status === "finalized" ? await load() : await withCaptureLock(load);
        if (
          request !== generation ||
          useNoteStore.getState().epoch !== epoch ||
          !isOwnedSession(session)
        ) {
          URL.revokeObjectURL(playback.url);
          if (request === generation) get().reset();
          return;
        }
        replaceSource(localOwner(session, epoch), playback.url, session.mimeType, playback.blob);
      } catch (error) {
        if (request === generation && useNoteStore.getState().epoch === epoch)
          set({ status: "error", error: message(error) });
      }
    },
    loadRemote: (input, startSeconds) => {
      try {
        const recording = remoteInputSchema.parse(input);
        if (startSeconds !== undefined && (!Number.isFinite(startSeconds) || startSeconds < 0))
          throw new Error("Choose a valid playback timestamp.");
        const state = useNoteStore.getState();
        if (!state.session || typeof window === "undefined")
          throw new Error("Sign in before playing saved audio.");
        const owner: PlaybackOwner = {
          source: "remote",
          noteId: recording.noteId,
          recordingId: recording.recordingId,
          userId: state.session.user.id,
          workspaceId: state.session.workspace.id,
          epoch: state.epoch,
        };
        if (!ownsPlayback(owner))
          throw new Error("This note is not available in the active workspace.");
        const url = new URL(
          `/api/workspaces/${encodeURIComponent(owner.workspaceId)}/notes/${encodeURIComponent(owner.noteId)}/recordings/${encodeURIComponent(owner.recordingId)}/audio`,
          window.location.origin,
        ).href;
        const previous = get();
        const sameSource =
          previous.url === url &&
          previous.owner?.source === "remote" &&
          previous.owner.epoch === owner.epoch;
        generation++;
        pendingSeek = null;
        if (!sameSource) replaceSource(owner, url, recording.mimeType ?? "");
        else set({ error: null, ...(recording.mimeType ? { mimeType: recording.mimeType } : {}) });
        if (startSeconds !== undefined) get().seek(startSeconds);
        return Promise.resolve(true);
      } catch (error) {
        get().pause();
        set({ error: message(error), status: "error" });
        return Promise.resolve(false);
      }
    },
    play: async () => {
      const state = get();
      const player = element;
      if (!state.url || !state.owner || !ownsPlayback(state.owner)) {
        get().reset();
        return;
      }
      if (!player) {
        set({ error: "The audio player is not mounted. Please try again.", status: "error" });
        return;
      }
      const request = generation;
      const attempt = ++playAttempt;
      set({ error: null });
      try {
        applyPendingSeek();
        if (player.ended && !pendingSeek) player.currentTime = 0;
        await player.play(); // UI follows media events, never a hopeful button click.
      } catch (error) {
        if (request === generation && attempt === playAttempt && get().url === state.url)
          set({ status: "error", error: `Playback could not start: ${message(error)}` });
      }
    },
    pause: () => {
      playAttempt++;
      element?.pause();
    },
    seek: (seconds) => {
      rangeEnd = null;
      const state = get();
      if (
        !state.owner ||
        !ownsPlayback(state.owner) ||
        !state.url ||
        !Number.isFinite(seconds) ||
        seconds < 0
      )
        return;
      pendingSeek = { generation, url: state.url, seconds };
      try {
        // The default playback start position can be assigned before metadata,
        // but only after load() has detached the previous resource.
        if (
          element?.getAttribute("src") === state.url &&
          element.readyState === HTMLMediaElement.HAVE_NOTHING
        ) {
          try {
            element.currentTime = seconds;
          } catch {
            /* Metadata events will retry the tagged request. */
          }
        }
        applyPendingSeek();
        // Read the browser's accepted position immediately for keyboard scrubbing;
        // subsequent seeked/timeupdate events remain the authoritative projection.
        if (
          element &&
          element.readyState >= HTMLMediaElement.HAVE_METADATA &&
          Number.isFinite(element.currentTime)
        )
          set({ currentTime: element.currentTime });
      } catch (error) {
        set({ error: `Cannot seek in this audio: ${message(error)}` });
      }
    },
    reset: () => {
      localPlaybackBlob = null;
      rangeEnd = null;
      generation++;
      pendingSeek = null;
      const url = get().url;
      set(emptyPlayback);
      if (element) {
        element.pause();
        element.removeAttribute("src");
        element.load();
      }
      revokePlaybackUrl(url);
    },
  };
});

// Called once by the persistent host. This URL is never shared with note.url:
// list-cache eviction or note-store cleanup cannot revoke the player's resource.
export function bindAudioPlayback(player: HTMLAudioElement) {
  if (element && element !== player) throw new Error("Mount only one persistent audio player.");
  element = player;
  let durationProbeUrl: string | null = null;
  let active = true;
  const sync = () => {
    const state = useAudioPlaybackStore.getState();
    if (!state.url || !state.owner || player.currentSrc !== state.url) return;
    if (!ownsPlayback(state.owner)) {
      state.reset();
      return;
    }
    applyPendingSeek();
    const ranges = player.seekable;
    if (rangeEnd !== null && !pendingSeek && player.currentTime >= rangeEnd) {
      rangeEnd = null;
      player.pause();
    }
    const seekStart = ranges.length ? ranges.start(0) : 0;
    const seekEnd = ranges.length ? ranges.end(ranges.length - 1) : 0;
    const duration = Number.isFinite(player.duration) ? player.duration : state.duration;
    useAudioPlaybackStore.setState({
      currentTime:
        player.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(player.currentTime)
          ? player.currentTime
          : state.currentTime,
      duration,
      seekStart: Number.isFinite(seekStart) ? seekStart : 0,
      seekEnd: Number.isFinite(seekEnd) ? seekEnd : (duration ?? 0),
      ...(player.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        ? {
            status: player.ended
              ? ("ended" as const)
              : player.paused
                ? state.status === "loading"
                  ? ("ready" as const)
                  : ("paused" as const)
                : ("playing" as const),
          }
        : {}),
    });
  };
  const probeDuration = () => {
    const state = useAudioPlaybackStore.getState();
    const blob = localPlaybackBlob;
    if (
      !blob ||
      durationProbeUrl === state.url ||
      state.owner?.source !== "local" ||
      !state.url ||
      player.currentSrc !== state.url ||
      Number.isFinite(player.duration)
    )
      return;
    const url = state.url;
    const owner = state.owner;
    durationProbeUrl = url;
    const check = () => {
      if (
        !active ||
        localPlaybackBlob !== blob ||
        useAudioPlaybackStore.getState().url !== url ||
        player.currentSrc !== url ||
        !ownsPlayback(owner) ||
        (Number.isFinite(player.duration) && player.duration > 0)
      ) {
        throw new Error("Playback duration parsing is no longer needed.");
      }
    };
    // Headerless recordings need timing, not an out-of-range seek. The parser
    // never moves the player or prevents ordinary media events/playback.
    void recordingContainerDuration(blob, check)
      .then((duration) => {
        check();
        if (!Number.isFinite(player.duration)) useAudioPlaybackStore.setState({ duration });
        sync();
      })
      .catch(() => {
        // Optional timing failure must not turn playable audio into a playback error.
      });
  };
  const sourceChanged = () => {
    if (durationProbeUrl !== useAudioPlaybackStore.getState().url) durationProbeUrl = null;
  };
  const failed = () => {
    pendingSeek = null;
    const state = useAudioPlaybackStore.getState();
    if (state.url && player.currentSrc === state.url)
      useAudioPlaybackStore.setState({
        status: "error",
        error:
          state.owner?.source === "remote"
            ? "Saved audio could not be loaded or decoded. Check your access and try again."
            : "This browser could not decode the saved audio. Download it or try another supported audio file.",
      });
  };
  const events = [
    "loadedmetadata",
    "loadeddata",
    "durationchange",
    "canplay",
    "timeupdate",
    "progress",
    "playing",
    "pause",
    "ended",
    "seeked",
  ] as const;
  events.forEach((event) => player.addEventListener(event, sync));
  player.addEventListener("error", failed);
  player.addEventListener("loadedmetadata", probeDuration);
  player.addEventListener("loadstart", sourceChanged);
  const url = useAudioPlaybackStore.getState().url;
  if (url) {
    player.src = url;
    player.load();
  }
  return () => {
    active = false;
    events.forEach((event) => player.removeEventListener(event, sync));
    player.removeEventListener("error", failed);
    player.removeEventListener("loadedmetadata", probeDuration);
    player.removeEventListener("loadstart", sourceChanged);
    if (element === player) {
      useAudioPlaybackStore.getState().reset();
      element = null;
    }
  };
}

export function watchAudioPlaybackOwner() {
  const check = () => {
    const state = useAudioPlaybackStore.getState();
    if (state.owner && !ownsPlayback(state.owner)) {
      if (useNoteStore.getState().epoch === state.owner.epoch) forgetSelection(state.owner);
      state.reset();
    }
  };
  check();
  const stopNotes = useNoteStore.subscribe(check);
  const stopSessions = useRecordingStore.subscribe((state, previous) => {
    const owner = useAudioPlaybackStore.getState().owner;
    if (
      owner?.source === "local" &&
      previous.sessions[owner.sessionId] &&
      !state.sessions[owner.sessionId]
    ) {
      if (useNoteStore.getState().epoch === owner.epoch) forgetSelection(owner);
      useAudioPlaybackStore.getState().reset();
    }
  });
  return () => {
    stopNotes();
    stopSessions();
  };
}
