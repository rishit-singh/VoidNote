"use client";

import Link from "next/link";
import { Download, Mic, Pause, Play, Square } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { LiveWaveform } from "@/assets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useAudioPlayback } from "@/hooks/use-audio-playback";
import { retryLiveRecordingText, useLiveRecordingTextState } from "@/hooks/use-live-recording-text";
import { useAudioPlaybackStore } from "@/stores/use-audio-playback-store";
import { useCaptureStore } from "@/stores/use-capture-store";
import { useNoteStore } from "@/stores/use-note-store";
import { useRecordingStore, isOwnedSession } from "@/stores/use-recording-store";

const clock = (seconds: number | null) =>
  seconds === null
    ? "--:--"
    : `${Math.floor(seconds / 60)
        .toString()
        .padStart(2, "0")}:${Math.floor(seconds % 60)
        .toString()
        .padStart(2, "0")}`;
const extension = (mimeType: string) =>
  !mimeType
    ? "audio"
    : mimeType.includes("mp4")
      ? "m4a"
      : mimeType.includes("mpeg")
        ? "mp3"
        : mimeType.includes("wav")
          ? "wav"
          : mimeType.includes("ogg")
            ? "ogg"
            : "webm";

function Waveform() {
  const levels = useCaptureStore((state) => state.waveformLevels);
  if (!levels.length) return null;
  return <LiveWaveform levels={levels} />;
}
function CaptureReadout() {
  const elapsed = useCaptureStore((state) => state.elapsedMs);
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <span className="text-sm tabular-nums">{clock(elapsed / 1000)}</span>
    </div>
  );
}
function LiveTextStatus() {
  const speech = useLiveRecordingTextState(
    useShallow((state) => ({ status: state.status, error: state.error })),
  );
  const captureStatus = useCaptureStore((state) => state.status);
  if (
    !["recording", "paused"].includes(captureStatus) ||
    (!speech.error && speech.status !== "disconnected")
  )
    return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p role="status" className="text-xs text-muted-foreground">
        Live preview paused. Audio is still recording.
      </p>
      {(speech.status === "disconnected" || speech.status === "error") && (
        <Button
          variant="outline"
          size="sm"
          disabled={captureStatus !== "recording"}
          onClick={retryLiveRecordingText}
        >
          Retry live text
        </Button>
      )}
    </div>
  );
}
function PlaybackControls({ noteId }: { noteId?: string | undefined }) {
  const playback = useAudioPlayback(noteId);
  const selected = !!playback.owner && !!playback.url;
  const canSeek = selected && playback.seekEnd > playback.seekStart;
  return (
    <div
      className="flex min-w-0 flex-1 flex-wrap items-center gap-3"
      aria-label="Audio player controls"
    >
      {selected && (
        <>
          <Button
            variant="outline"
            size="icon"
            className="rounded-full"
            aria-label={playback.status === "playing" ? "Pause playback" : "Play audio"}
            disabled={playback.status === "loading"}
            onClick={() => {
              if (playback.status === "playing") useAudioPlaybackStore.getState().pause();
              else void useAudioPlaybackStore.getState().play();
            }}
          >
            {playback.status === "playing" ? <Pause /> : <Play />}
          </Button>
          <div className="flex min-w-[130px] flex-1 flex-col gap-1">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="dock-audio-seek" className="sr-only">
                  Seek audio
                </FieldLabel>
                <Input
                  id="dock-audio-seek"
                  className="accent-primary"
                  type="range"
                  min={playback.seekStart}
                  max={canSeek ? playback.seekEnd : 1}
                  step="0.1"
                  value={Math.min(
                    canSeek ? playback.seekEnd : 1,
                    Math.max(playback.seekStart, playback.currentTime),
                  )}
                  disabled={!canSeek}
                  onChange={(event) =>
                    useAudioPlaybackStore.getState().seek(Number(event.currentTarget.value))
                  }
                />
              </Field>
            </FieldGroup>
            <span className="text-xs tabular-nums text-muted-foreground" aria-label="Playback time">
              {clock(playback.currentTime)} / {clock(playback.duration)}
            </span>
          </div>
          <Button asChild variant="ghost" size="icon">
            <a
              href={playback.url ?? undefined}
              download={`recording.${extension(playback.mimeType)}`}
              aria-label="Download audio"
              title="Download audio"
            >
              <Download />
            </a>
          </Button>
        </>
      )}
      {!selected && (
        <p role="status" className="text-sm text-muted-foreground">
          {playback.status === "loading" ? "Loading local audio…" : "Ready to record"}
        </p>
      )}
    </div>
  );
}

// The shell mounts one dock, even when a different route is being viewed.
export function RecordingDock({ noteId }: { noteId?: string | undefined }) {
  const capture = useCaptureStore(
    useShallow((state) => ({
      status: state.status,
      supported: state.supported,
      noteId: state.noteId,
      error: state.error,
    })),
  );
  const playback = useAudioPlaybackStore(
    useShallow((state) => ({ owner: state.owner, error: state.error })),
  );
  const active = ["starting", "recording", "paused", "stopping"].includes(capture.status);
  const hasLocal = useRecordingStore((state) =>
    Object.values(state.sessions).some(
      (s) => s.noteId === noteId && s.chunkCount > 0 && isOwnedSession(s),
    ),
  );
  const hasAudio = hasLocal || playback.owner?.noteId === noteId;
  const ownerId = active ? capture.noteId : noteId;
  const title = useNoteStore(
    (state) =>
      state.notes.find((note) => note.id === ownerId)?.title ??
      state.noteRecords[ownerId ?? ""]?.title,
  );
  const canRecord = useNoteStore((state) => {
    if (!noteId || !state.session || state.unavailable[`note:${noteId}`]) return false;
    const note = state.noteRecords[noteId] ?? state.notes.find((note) => note.id === noteId);
    return !!note && !note.deletedAt && note.workspaceId === state.session.workspace.id;
  });
  if (!noteId && !active) return null;
  return (
    <section
      aria-label="Audio recorder"
      className="sticky bottom-0 z-[2] flex w-full flex-col gap-3 bg-vn-page px-[clamp(24px,5.5vw,80px)] pb-[18px] pt-3 [@media(max-width:760px)]:px-4 [@media(max-width:760px)]:pb-3 [@media(max-width:760px)]:pt-2"
    >
      <div className="flex min-h-[80px] w-full flex-wrap items-center gap-3 rounded-md border border-border bg-card px-4 py-3 sm:min-h-[68px] sm:gap-5">
        <div className="flex shrink-0 items-center gap-2">
          {capture.status === "recording" || capture.status === "paused" ? (
            <>
              <Button
                variant="outline"
                size="icon"
                className="rounded-full"
                aria-label={capture.status === "paused" ? "Resume recording" : "Pause recording"}
                onClick={() => {
                  const state = useCaptureStore.getState();
                  if (state.status === "paused") state.resume();
                  else state.pause();
                }}
              >
                {capture.status === "paused" ? <Play /> : <Pause />}
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="rounded-full"
                aria-label="Stop recording"
                onClick={() => void useCaptureStore.getState().stop()}
              >
                <Square />
              </Button>
            </>
          ) : capture.status === "starting" ? (
            <Button variant="outline" onClick={() => void useCaptureStore.getState().stop()}>
              Cancel
            </Button>
          ) : capture.status === "stopping" ? null : noteId && !hasAudio ? (
            <Button
              disabled={!canRecord || capture.supported === false}
              onClick={() => {
                void useCaptureStore.getState().start(noteId);
              }}
            >
              <Mic data-icon="inline-start" />
              Record
            </Button>
          ) : null}
        </div>
        {active ? (
          <>
            <div className="min-w-0 flex-1">
              <p role="status" className="text-sm">
                {capture.status === "recording"
                  ? "Recording"
                  : capture.status === "paused"
                    ? "Paused"
                    : capture.status === "starting"
                      ? "Preparing microphone…"
                      : "Saving audio…"}
              </p>
              {ownerId && (
                <Link
                  href={`/notes/${encodeURIComponent(ownerId)}`}
                  aria-label="Open recording note"
                  className="block truncate text-xs text-muted-foreground"
                >
                  {title || "Untitled note"} ↗
                </Link>
              )}
            </div>
            <CaptureReadout />
            {capture.status === "recording" && <Waveform />}
          </>
        ) : (
          <PlaybackControls noteId={noteId} />
        )}
      </div>
      {capture.supported === false && noteId && (
        <p className="text-sm text-muted-foreground">
          Microphone capture is unavailable here. Use a current browser over HTTPS with Web Locks
          and local storage support.
        </p>
      )}
      {capture.error && capture.noteId === noteId && (
        <Alert variant="destructive">
          <AlertTitle>Audio needs attention</AlertTitle>
          <AlertDescription>{capture.error} Existing audio is retained.</AlertDescription>
        </Alert>
      )}
      {playback.error && playback.owner?.noteId === noteId && (
        <Alert variant="destructive">
          <AlertTitle>Playback needs attention</AlertTitle>
          <AlertDescription>{playback.error}</AlertDescription>
        </Alert>
      )}
      <LiveTextStatus />
    </section>
  );
}
