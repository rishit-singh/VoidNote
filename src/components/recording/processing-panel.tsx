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
  const failed = p.run && ["failed", "submission_unknown"].includes(p.run.status);
  const retryable =
    failed || p.error || (p.loaded && !p.run && (!!p.recording || p.local?.status === "finalized"));
  return (
    <section aria-label="Transcript" className="flex flex-col gap-6 py-6">
      <h2 className="text-section">Transcript</h2>
      {p.run?.status === "succeeded" ? (
        <TranscriptEditor noteId={noteId} runId={p.run.id} onSeek={onSeek} />
      ) : (
        <>
          {liveText && (
            <div className="flex flex-col gap-2">
              <p className="text-meta text-muted-foreground">Live preview</p>
              <p className="whitespace-pre-wrap text-body">{liveText}</p>
            </div>
          )}
          {p.busy || (p.run && !failed) ? (
            <p role="status" className="text-body text-muted-foreground">
              {p.progress || "Transcribing…"}
            </p>
          ) : !p.loaded ? (
            <Skeleton className="h-16 w-full" aria-label="Loading transcript" />
          ) : !retryable && !liveText ? (
            <p className="text-body text-muted-foreground">
              Your transcript will appear here after recording.
            </p>
          ) : null}
          {retryable && !p.busy && (
            <Alert variant={p.error || failed ? "destructive" : "default"}>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  {p.error ||
                    (failed
                      ? "Transcription needs attention. Your audio is saved."
                      : "Ready to finish processing your audio.")}
                </span>
                <Button variant="outline" size="sm" onClick={() => void p.retry()}>
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
    </section>
  );
}
