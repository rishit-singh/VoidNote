"use client";

import {
  useRecordingProcessing,
  type SelectedProcessingRecording,
} from "@/hooks/use-recording-processing";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useCaptureStore } from "@/stores/use-capture-store";
import { TranscriptEditor } from "./transcript-editor";

export interface ProcessingPanelProps {
  noteId: string;
  onSeek?: (seconds: number, recordingId: string) => void;
  selectedRecording?: SelectedProcessingRecording | undefined;
}
export function ProcessingPanel({ noteId, onSeek, selectedRecording }: ProcessingPanelProps) {
  const p = useRecordingProcessing(noteId, selectedRecording);
  const liveText = useCaptureStore((state) => (state.noteId === noteId ? state.liveText : ""));
  const audioSaved = p.recording?.status === "ready" || p.local?.status === "finalized";
  const status = {
    loading: "Loading transcript…",
    idle:
      p.retryAction === "processing"
        ? "Transcription has not started."
        : liveText
          ? null
          : "Your transcript will appear here after recording.",
    uploading: p.progress || "Uploading audio…",
    submitting: "Requesting transcription…",
    accepted: p.progress || "Transcription requested…",
    processing: "Transcribing…",
    ready: null,
    uncertain: null,
    failed: null,
    blocked: null,
  }[p.phase];
  const attentionMessage = {
    uncertain: "Transcription status is not confirmed.",
    failed: "Transcription needs attention.",
    blocked: "Transcription is unavailable.",
  };
  return (
    <section aria-label="Transcript content" className="flex flex-col gap-6 py-6">
      {p.phase === "ready" && p.run ? (
        <TranscriptEditor noteId={noteId} runId={p.run.id} onSeek={onSeek} />
      ) : (
        <>
          {liveText && (
            <div className="flex flex-col gap-2">
              <p className="text-meta text-muted-foreground">Live preview</p>
              <p className="whitespace-pre-wrap text-body">{liveText}</p>
            </div>
          )}
          {status && (
            <div className="flex flex-col gap-4">
              <p role="status" aria-live="polite" className="text-body text-muted-foreground">
                {status}
              </p>
              {p.phase === "loading" && <Skeleton className="h-16 w-full" aria-hidden="true" />}
              {p.phase === "idle" && p.retryAction === "processing" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={p.busy}
                  onClick={() => void p.retry()}
                >
                  Transcribe audio
                </Button>
              )}
            </div>
          )}
          {(p.phase === "uncertain" || p.phase === "failed" || p.phase === "blocked") && (
            <Alert variant={p.phase === "failed" ? "destructive" : "default"}>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <p>{attentionMessage[p.phase]}</p>
                  {audioSaved && <p>Your audio is saved.</p>}
                  {p.error && <p>{p.error}</p>}
                </div>
                {p.retryAction === "processing" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={p.busy}
                    onClick={() => void p.retry()}
                  >
                    Retry
                  </Button>
                )}
                {p.retryAction === "status" && !p.statusError && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={p.busy}
                    onClick={() => void p.refresh()}
                  >
                    Retry status
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}
          {p.statusError && (
            <Alert>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <p>Could not refresh transcription status.</p>
                  <p>{p.statusError}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={p.busy}
                  onClick={() => void p.refresh()}
                >
                  Retry status
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
    </section>
  );
}
