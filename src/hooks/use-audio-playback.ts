"use client";

import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  bindAudioPlayback,
  useAudioPlaybackStore,
  watchAudioPlaybackOwner,
  setPlaybackRoute,
} from "@/stores/use-audio-playback-store";
import { useNoteStore } from "@/stores/use-note-store";
import { isOwnedSession, useRecordingStore } from "@/stores/use-recording-store";
import { useRecordingOverview } from "@/hooks/use-recording-processing";

export function usePersistentAudioPlayback(noteId?: string) {
  const ref = useRef<HTMLAudioElement>(null);
  const epoch = useNoteStore((s) => s.epoch);
  const session = useNoteStore((s) => s.session);
  const available = useNoteStore((s) => {
    const record = noteId ? s.noteRecords[noteId] : undefined;
    return !!record && !record.deletedAt;
  });
  const overview = useRecordingOverview(noteId);
  const recording = overview.data?.recordings.find((r) => r.status === "ready");
  const sessions = useRecordingStore((s) => s.sessions);
  const latest = Object.values(sessions)
    .filter((s) => s.noteId === noteId && s.status === "finalized" && isOwnedSession(s))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]?.id;
  useEffect(() => {
    if (!ref.current) return;
    const unbind = bindAudioPlayback(ref.current);
    const unwatch = watchAudioPlaybackOwner();
    return () => {
      unwatch();
      unbind();
    };
  }, []);
  useEffect(() => {
    setPlaybackRoute(noteId ?? null);
    return () => setPlaybackRoute(null);
  }, [noteId, epoch]);
  useEffect(() => {
    if (!noteId || !session || !available) return;
    const player = useAudioPlaybackStore.getState();
    if (player.owner?.noteId === noteId && player.owner.epoch === epoch) return;
    if (latest) {
      void player.loadSession(latest);
      return;
    }
    if (recording)
      void player.loadRemote({
        noteId,
        recordingId: recording.id,
        mimeType: recording.mimeType,
      });
  }, [noteId, session, available, epoch, latest, recording]);
  return ref;
}

// Consumers never project another note's global player state.
export function useAudioPlayback(noteId?: string) {
  const epoch = useNoteStore((s) => s.epoch);
  return useAudioPlaybackStore(
    useShallow((s) => {
      const matches = s.owner?.noteId === noteId && s.owner?.epoch === epoch;
      return {
        owner: matches ? s.owner : null,
        url: matches ? s.url : null,
        mimeType: matches ? s.mimeType : "",
        status: matches ? s.status : "idle",
        duration: matches ? s.duration : null,
        currentTime: matches ? s.currentTime : 0,
        seekStart: matches ? s.seekStart : 0,
        seekEnd: matches ? s.seekEnd : 0,
        error: matches ? s.error : null,
      };
    }),
  );
}
