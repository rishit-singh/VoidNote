"use client";

import { useRecordingSession } from "@/hooks/use-recording-session";
import { usePersistentAudioPlayback } from "@/hooks/use-audio-playback";
import { useLiveRecordingText } from "@/hooks/use-live-recording-text";
import { useEffect } from "react";
import { watchProcessingQueue } from "@/lib/recording-processing-client";
import { useNoteAutosave } from "@/hooks/use-note-autosave";
import { useRecordingOverview } from "@/hooks/use-recording-processing";

// Mount exactly once above the route outlet. This is the only audio element.
export function RecordingController({ noteId }: { noteId?: string | undefined }) {
  useRecordingSession();
  useNoteAutosave();
  useLiveRecordingText();
  useRecordingOverview(noteId, true);
  useEffect(watchProcessingQueue, []);
  const audio = usePersistentAudioPlayback(noteId);
  return (
    <audio
      ref={audio}
      preload="auto"
      aria-label="Persistent audio playback"
      data-testid="persistent-audio"
      className="hidden"
    />
  );
}
