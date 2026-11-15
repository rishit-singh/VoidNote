"use client";

import { useEffect } from "react";
import { useCaptureStore, watchCaptureOwner } from "@/stores/use-capture-store";
import { useNoteStore } from "@/stores/use-note-store";
import { useRecordingStore } from "@/stores/use-recording-store";
import {
  defaultRecordingPreferences,
  recordingPreferenceKey,
  useRecordingPreferences,
} from "@/stores/use-recording-preferences";

// One persistent host owns microphone-side effects. Routes and dock views only
// subscribe to projections; neither can tear down capture, its meter, or listeners.
export function useRecordingSession() {
  const epoch = useNoteStore((state) => state.epoch);
  const status = useCaptureStore((state) => state.status);
  const stream = useCaptureStore((state) => state.stream);
  const preferences = useRecordingPreferences((state) => state.byOwner);
  const waveform = (preferences[recordingPreferenceKey()] ?? defaultRecordingPreferences).waveform;
  useEffect(() => {
    useCaptureStore.getState().checkSupport();
    return watchCaptureOwner();
  }, []);
  useEffect(() => {
    void useRecordingStore.getState().recoverDraftSessions();
  }, [epoch]);
  useEffect(() => {
    if (status !== "recording") return;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (
        useNoteStore.getState().epoch === epoch &&
        useCaptureStore.getState().status === "recording"
      )
        useCaptureStore.setState((state) => ({ elapsedMs: state.elapsedMs + now - previous }));
      previous = now;
    }, 250);
    return () => window.clearInterval(timer);
  }, [status, epoch]);
  useEffect(() => {
    if (!waveform || !stream || status !== "recording" || !window.AudioContext) {
      useCaptureStore.setState({ waveformLevels: [] });
      return;
    }
    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let timer: number | undefined;
    try {
      context = new AudioContext();
      source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      void context.resume().catch(() => {}); // A blocked visual meter must not break capture.
      timer = window.setInterval(() => {
        if (useNoteStore.getState().epoch !== epoch) return;
        analyser.getByteTimeDomainData(samples);
        const levels = Array.from({ length: 24 }, (_, index) => {
          const start = Math.floor((index * samples.length) / 24);
          const end = Math.floor(((index + 1) * samples.length) / 24);
          let peak = 0;
          for (let sample = start; sample < end; sample++)
            peak = Math.max(peak, Math.abs((samples[sample] ?? 128) - 128) / 128);
          return peak;
        });
        useCaptureStore.setState({ waveformLevels: levels });
      }, 100);
    } catch {
      useCaptureStore.setState({ waveformLevels: [] });
    }
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      source?.disconnect();
      if (context) void context.close().catch(() => {});
    };
  }, [stream, waveform, status, epoch]);
  useEffect(() => {
    const flush = () => useCaptureStore.getState().requestData();
    const visibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        ["starting", "recording", "paused", "stopping"].includes(useCaptureStore.getState().status)
      ) {
        flush();
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
}
