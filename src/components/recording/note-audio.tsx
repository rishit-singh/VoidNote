"use client";
import { useRef } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useCaptureStore } from "@/stores/use-capture-store";
import { useRecordingProcessing } from "@/hooks/use-recording-processing";
import { useRecordingStore } from "@/stores/use-recording-store";

export function NoteAudio({ noteId }: { noteId: string }) {
  const file = useRef<HTMLInputElement>(null);
  const p = useRecordingProcessing(noteId);
  const status = useCaptureStore((s) => s.status);
  const storageError = useRecordingStore((s) => s.error);
  const busy = !["idle", "error"].includes(status);
  const interrupted = p.local && p.local.status !== "finalized" && p.local.chunkCount > 0;
  return (
    <section aria-label="Note audio" className="flex flex-col gap-4">
      {!p.recording && !p.local && (
        <>
          <input
            ref={file}
            type="file"
            accept="audio/*"
            aria-label="Upload audio"
            className="sr-only"
            disabled={busy || !p.loaded}
            onChange={(event) => {
              const audio = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (audio) void useCaptureStore.getState().upload(noteId, audio);
            }}
          />
          <Button
            variant="outline"
            className="self-start"
            disabled={busy || !p.loaded}
            onClick={() => file.current?.click()}
          >
            <Upload data-icon="inline-start" />
            Upload audio
          </Button>
        </>
      )}
      {interrupted && !busy && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            Recording interrupted. Your saved audio is available.
            <Button
              variant="outline"
              onClick={() => void useCaptureStore.getState().recover(p.local!.id)}
            >
              Recover audio
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {storageError && (
        <Alert variant="destructive">
          <AlertDescription>{storageError}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
