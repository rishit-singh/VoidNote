"use client";

import { create } from "zustand";
import {
  appendRecordingChunk,
  buildRecordingBlob,
  deleteRecordingSessionData,
  getRecordingSession,
  getRecordingSessions,
  putRecordingSession,
} from "@/lib/idb-recordings";
import type { LocalRecordingSession } from "@/lib/recording-schemas";
import { withCaptureLock } from "@/lib/recorder";
import { useNoteStore } from "@/stores/use-note-store";
import type { RecoveryHydration } from "@/stores/workspace-recovery";

export function isOwnedSession(session: LocalRecordingSession) {
  const state = useNoteStore.getState();
  const record = state.noteRecords[session.noteId];
  return (
    !!state.session &&
    session.userId === state.session.user.id &&
    session.workspaceId === state.session.workspace.id &&
    !!record &&
    !record.deletedAt &&
    !state.unavailable[`note:${session.noteId}`] &&
    record.workspaceId === session.workspaceId
  );
}
interface RecordingStore {
  sessions: Record<string, LocalRecordingSession>;
  activeSessionId: string | null;
  error: string | null;
  hydration: RecoveryHydration;
  hydratedEpoch: number | null;
  startSession(
    noteId: string,
    mimeType?: string,
    source?: "microphone" | "file",
  ): Promise<LocalRecordingSession>;
  appendChunk(sessionId: string, chunk: Blob): Promise<void>;
  failSession(sessionId: string, error: string, visibleEpoch?: number | null): Promise<void>;
  finalizeSession(sessionId: string, lease?: () => void): Promise<{ blob: Blob; url: string }>;
  loadSessionPlayback(sessionId: string): Promise<{ blob: Blob; url: string }>;
  recoverDraftSessions(): Promise<void>;
  discardSession(sessionId: string): Promise<void>;
}
export const useRecordingStore = create<RecordingStore>((set, get) => {
  let hydrationTask: { epoch: number; promise: Promise<void> } | null = null;
  const remember = (session: LocalRecordingSession) => {
    if (isOwnedSession(session))
      set((state) => ({ sessions: { ...state.sessions, [session.id]: session } }));
  };
  const requireOwned = (id: string) => {
    const session = get().sessions[id];
    if (!session || !isOwnedSession(session))
      throw new Error("This audio does not belong to the active workspace note.");
    return session;
  };
  return {
    sessions: {},
    activeSessionId: null,
    error: null,
    hydration: "idle",
    hydratedEpoch: null,
    startSession: async (noteId, mimeType = "", source = "microphone") => {
      const state = useNoteStore.getState();
      const owner = state.session;
      if (state.status !== "ready" || state.recoveryHydration !== "ready")
        throw new Error("Wait for local draft recovery before capturing audio.");
      if (!owner || !state.noteRecords[noteId] || state.noteRecords[noteId].deletedAt)
        throw new Error("Save this note before capturing audio.");
      const now = new Date().toISOString();
      const session: LocalRecordingSession = {
        id: crypto.randomUUID(),
        noteId,
        userId: owner.user.id,
        workspaceId: owner.workspace.id,
        status: "recording",
        mimeType,
        source,
        chunkCount: 0,
        byteCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      await putRecordingSession(session);
      if (useNoteStore.getState().epoch !== state.epoch || !isOwnedSession(session))
        throw new Error("The workspace changed before capture started.");
      remember(session);
      return session;
    },
    appendChunk: async (id, chunk) => {
      // An in-flight capture keeps its immutable owner on disk even after sign-out.
      remember(await appendRecordingChunk(id, chunk));
    },
    failSession: async (id, error, visibleEpoch = useNoteStore.getState().epoch) => {
      const session = await getRecordingSession(id);
      const failed = {
        ...session,
        status: "failed" as const,
        error,
        updatedAt: new Date().toISOString(),
      };
      remember(failed);
      if (useNoteStore.getState().epoch === visibleEpoch && isOwnedSession(session)) {
        set((state) => ({
          error,
          activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
        }));
      }
      await putRecordingSession(failed);
    },
    finalizeSession: (id, lease) =>
      withCaptureLock(async () => {
        const epoch = useNoteStore.getState().epoch;
        if (!lease) requireOwned(id);
        const session = await getRecordingSession(id);
        if (!session || session.status === "failed")
          throw new Error(session?.error || "Audio could not be saved.");
        const blob = await buildRecordingBlob(id, session.mimeType);
        if (!lease && (useNoteStore.getState().epoch !== epoch || !isOwnedSession(session)))
          throw new Error("Workspace changed before finalizing audio.");
        const finalized = {
          ...session,
          status: "finalized" as const,
          processing: session.processing ?? ("pending" as const),
          updatedAt: new Date().toISOString(),
        };
        await putRecordingSession(finalized);
        remember(finalized);
        if (isOwnedSession(session))
          set((state) => ({
            activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
          }));
        return { blob, url: URL.createObjectURL(blob) };
      }, lease),
    loadSessionPlayback: async (id) => {
      const session = requireOwned(id);
      const epoch = useNoteStore.getState().epoch;
      const blob = await buildRecordingBlob(id, session.mimeType);
      if (useNoteStore.getState().epoch !== epoch || !isOwnedSession(session))
        throw new Error("Workspace changed while loading audio.");
      return { blob, url: URL.createObjectURL(blob) };
    },
    recoverDraftSessions: () => {
      const epoch = useNoteStore.getState().epoch;
      const owner = useNoteStore.getState().session;
      if (!owner || (get().hydratedEpoch === epoch && get().hydration === "ready"))
        return Promise.resolve();
      if (hydrationTask?.epoch === epoch) return hydrationTask.promise;
      const initialSessions = get().sessions;
      set({ hydration: "loading", error: null, hydratedEpoch: null });
      const promise = (async () => {
        try {
          // Cache account-owned metadata once per scope. A note need not yet be in
          // a search/list projection; isOwnedSession still gates actual access.
          const sessions = (await getRecordingSessions()).filter(
            (session) =>
              session.userId === owner.user.id && session.workspaceId === owner.workspace.id,
          );
          if (useNoteStore.getState().epoch !== epoch) return;
          set((state) => {
            const merged = Object.fromEntries(sessions.map((session) => [session.id, session]));
            // A manifest changed during the read wins regardless of wall-clock
            // timestamps. A concurrent discard must not resurrect from the scan.
            for (const id of Object.keys(initialSessions)) {
              if (!state.sessions[id]) delete merged[id];
            }
            for (const session of Object.values(state.sessions)) {
              const persisted = merged[session.id];
              if (
                session.userId === owner.user.id &&
                session.workspaceId === owner.workspace.id &&
                (session !== initialSessions[session.id] ||
                  !persisted ||
                  session.updatedAt >= persisted.updatedAt)
              )
                merged[session.id] = session;
            }
            return { sessions: merged, error: null, hydration: "ready", hydratedEpoch: epoch };
          });
        } catch (error) {
          if (useNoteStore.getState().epoch === epoch)
            set({
              hydration: "error",
              hydratedEpoch: null,
              error: error instanceof Error ? error.message : "Local audio could not be loaded.",
            });
        } finally {
          if (hydrationTask?.epoch === epoch) hydrationTask = null;
        }
      })();
      hydrationTask = { epoch, promise };
      return promise;
    },
    discardSession: async (id) => {
      const epoch = useNoteStore.getState().epoch;
      try {
        await withCaptureLock(async () => {
          const session = requireOwned(id);
          if (useNoteStore.getState().epoch !== epoch)
            throw new Error("Workspace changed before discarding audio.");
          await deleteRecordingSessionData(id);
          if (useNoteStore.getState().epoch !== epoch) return;
          const state = useNoteStore.getState();
          const note = state.notes.find((note) => note.id === session.noteId);
          if (note?.recordingSessionId === id) {
            state.upsertNote({ ...note, audio: null, url: null, recordingSessionId: null });
            if (note.url?.startsWith("blob:")) URL.revokeObjectURL(note.url);
          }
          set((state) => {
            const sessions = { ...state.sessions };
            delete sessions[id];
            return { sessions, error: null };
          });
        });
      } catch (error) {
        if (useNoteStore.getState().epoch === epoch)
          set({
            error: error instanceof Error ? error.message : "Local audio could not be discarded.",
          });
        throw error;
      }
    },
  };
});
