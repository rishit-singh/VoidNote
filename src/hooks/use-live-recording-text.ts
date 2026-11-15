"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import {
  defaultRecordingPreferences,
  recordingPreferenceKey,
  useRecordingPreferences,
} from "@/stores/use-recording-preferences";
import { useCaptureStore } from "@/stores/use-capture-store";
import { useNoteStore } from "@/stores/use-note-store";
import type { SpeechStatus } from "@/hooks/useSpeechRecognition";

let requestRetry: (() => void) | null = null;
export const useLiveRecordingTextState = create<{
  status: SpeechStatus;
  error: string | null;
}>()(() => ({ status: "off", error: null }));

/** Retry live speech recognition only; this never starts or restarts microphone recording. */
export function retryLiveRecordingText() {
  requestRetry?.();
}

export function useLiveRecordingText() {
  const status = useCaptureStore((state) => state.status);
  const noteId = useCaptureStore((state) => state.noteId);
  const epoch = useNoteStore((state) => state.epoch);
  const session = useNoteStore((state) => state.session);
  const preferences = useRecordingPreferences((state) => state.byOwner);
  const liveText = (preferences[recordingPreferenceKey()] ?? defaultRecordingPreferences).liveText;
  const ownerKey = `${epoch}:${session?.user.id ?? ""}:${session?.workspace.id ?? ""}:${noteId ?? ""}`;
  const recognition = useSpeechRecognition({
    ownerKey,
    onResult: (text) => useCaptureStore.getState().appendText(text),
  });
  const {
    startListening,
    stopListening,
    retryListening,
    error,
    status: speechStatus,
  } = recognition;
  const enabled = status === "recording" && liveText;

  useEffect(() => {
    requestRetry = () => {
      const preferences = useRecordingPreferences.getState().byOwner[recordingPreferenceKey()];
      if (preferences?.liveText && useCaptureStore.getState().status === "recording")
        retryListening();
    };
    return () => {
      requestRetry = null;
      useLiveRecordingTextState.setState({ status: "off", error: null });
    };
  }, [retryListening]);

  useEffect(() => {
    if (enabled) startListening();
    else stopListening();
    return () => {
      if (!enabled) return;
      stopListening();
    };
  }, [enabled, ownerKey, startListening, stopListening]);

  useEffect(() => {
    const message = enabled ? error : null;
    useCaptureStore.setState({ liveTextError: message });
    useLiveRecordingTextState.setState({
      status: enabled ? speechStatus : "off",
      error: message,
    });
  }, [enabled, error, speechStatus]);

  return { ...recognition, retry: retryLiveRecordingText };
}
