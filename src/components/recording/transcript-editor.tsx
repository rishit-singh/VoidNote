"use client";
import { Fragment, useRef, useState } from "react";
import { Play, Scissors, Undo2 } from "lucide-react";
import { useNoteStore } from "@/stores/use-note-store";
import { useTranscriptCorrections } from "@/hooks/use-transcript-corrections";
import type { CorrectedTurn } from "@/contracts/transcript-corrections";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { SpeakerAssignment } from "./speaker-assignment";
import { SpeechSelection, estimatedRange, type SpeechRange } from "./speech-selection";
import { playAudioRange, stopAudioRange } from "@/stores/use-audio-playback-store";
import { groupTranscriptPassages } from "@/lib/transcript-passages";
import { TranscriptDownload } from "./transcript-download";

export const transcriptTimestamp = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
const identity = (turn: CorrectedTurn) =>
  turn.assignment.kind === "unknown"
    ? "Unknown speaker"
    : turn.assignment.kind === "person"
      ? (turn.personName ?? "Speaker")
      : turn.speakerLabel.replace(
          /^SPEAKER_0*(\d+)$/i,
          (_, number: string) => `Speaker ${Number(number) + 1}`,
        );
type Props = {
  noteId: string;
  runId: string;
  onSeek?: ((seconds: number, recordingId: string) => void) | undefined;
};
export function TranscriptEditor(props: Props) {
  const session = useNoteStore((s) => s.session);
  const epoch = useNoteStore((s) => s.epoch);
  return session ? (
    <ScopedTranscriptEditor
      key={`${epoch}:${session.user.id}:${session.workspace.id}:${props.noteId}:${props.runId}`}
      {...props}
    />
  ) : null;
}
function ScopedTranscriptEditor({ noteId, runId, onSeek }: Props) {
  const api = useTranscriptCorrections(noteId, runId);
  const [editing, setEditing] = useState<{
    turn: CorrectedTurn;
    range?: SpeechRange;
    turns?: CorrectedTurn[];
    endSeconds?: number;
  } | null>(null);
  const initiator = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLElement | null>(null);
  const locked = api.busy || !!api.pending || !api.ready;
  const saved = () => {
    setEditing(null);
    stopAudioRange();
  };
  function selectText(turn: CorrectedTurn, element: HTMLElement) {
    if (locked) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const selected = selection.getRangeAt(0);
    if (!element.contains(selected.startContainer) || !element.contains(selected.endContainer))
      return;
    const prefix = document.createRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(selected.startContainer, selected.startOffset);
    const startOffset = prefix.toString().length,
      endOffset = startOffset + selected.toString().length;
    if (!turn.text.slice(startOffset, endOffset).trim()) return;
    const range = estimatedRange(turn, startOffset, endOffset);
    initiator.current = element;
    setEditing({ turn, range });
    void playAudioRange(noteId, turn.recordingId, range.startSeconds, range.endSeconds);
  }
  const recovery = (api.error || api.pending) && (
    <Alert variant={api.error ? "destructive" : "default"}>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>
          {api.busy
            ? api.pending?.command.kind === "undo"
              ? "Undoing…"
              : "Saving… Undo is available after confirmation."
            : api.error ||
              (api.conflict
                ? "This speech changed. Review it and try again."
                : "Could not confirm your change.")}
        </span>
        {!api.busy && api.pending && (
          <Button
            variant="outline"
            onClick={() => {
              if (api.rejected)
                void api.reviewConflict().then((ok) => {
                  if (ok) saved();
                });
              else
                void api.submit().then((ok) => {
                  if (ok) saved();
                });
            }}
          >
            {api.rejected ? "Review speech" : "Retry"}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
  return (
    <section
      ref={heading}
      tabIndex={-1}
      aria-label="Corrected transcript"
      className="flex min-w-0 flex-col gap-6"
    >
      <div className="flex justify-end">
        <TranscriptDownload noteId={noteId} runId={runId} disabled={locked} />
      </div>
      {!editing && recovery}
      {api.receipt && !api.pending && (
        <div role="status" className="flex items-center gap-2 text-meta text-muted-foreground">
          <span>{api.receipt.kind === "undo" ? "Undone" : "Speaker updated"}</span>
          {api.receipt.kind !== "undo" && (
            <Button
              variant="ghost"
              size="sm"
              disabled={locked}
              onClick={() =>
                void api.submit({
                  kind: "undo",
                  commandId: crypto.randomUUID(),
                  correctionId: api.receipt!.id,
                })
              }
            >
              <Undo2 />
              Undo
            </Button>
          )}
        </div>
      )}
      {api.readError && (
        <Alert variant="destructive">
          <AlertDescription>
            {api.readError}
            <Button variant="link" onClick={() => void api.refresh()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {api.loading && !api.turns.length && (
        <Skeleton className="h-24 w-full" aria-label="Loading transcript" />
      )}
      {!api.loading && !api.readError && !api.turns.length && (
        <p className="text-body text-muted-foreground">No speech was detected.</p>
      )}
      <ol className="flex flex-col gap-8" aria-label="Timestamped transcript">
        {groupTranscriptPassages(api.turns).map((passage) => {
          const turn = passage.turns[0]!;
          return (
            <li key={passage.id} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!onSeek}
                  aria-label={`Play at ${transcriptTimestamp(turn.startSeconds)}`}
                  onClick={() => onSeek?.(turn.startSeconds, turn.recordingId)}
                >
                  <Play />
                  {transcriptTimestamp(turn.startSeconds)}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  aria-label={`Assign speaker at ${transcriptTimestamp(turn.startSeconds)}: ${identity(turn)}`}
                  onClick={(event) => {
                    initiator.current = event.currentTarget;
                    setEditing({ turn, turns: passage.turns, endSeconds: passage.endSeconds });
                  }}
                >
                  <span className="max-w-48 truncate">{identity(turn)}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto"
                  disabled={locked}
                  title="Select speech"
                  aria-label={`Select speech at ${transcriptTimestamp(turn.startSeconds)}`}
                  onClick={(event) => {
                    initiator.current = event.currentTarget;
                    setEditing({ turn, range: estimatedRange(turn, 0, turn.text.length) });
                  }}
                >
                  <Scissors />
                </Button>
              </div>
              {passage.turns.length === 1 ? (
                <p
                  tabIndex={0}
                  className="select-text whitespace-pre-wrap break-words text-body"
                  onPointerUp={(event) => selectText(turn, event.currentTarget)}
                  onKeyUp={(event) => {
                    if (event.key === "Shift") selectText(turn, event.currentTarget);
                  }}
                >
                  {turn.text}
                </p>
              ) : (
                <p className="select-text whitespace-pre-wrap break-words text-body">
                  {passage.turns.map((segment, index) => (
                    <Fragment key={segment.id}>
                      {index > 0 && " "}
                      <span
                        tabIndex={locked ? -1 : 0}
                        role="button"
                        aria-disabled={locked}
                        aria-label={`Select speech at ${transcriptTimestamp(segment.startSeconds)}`}
                        className="cursor-text rounded-sm focus-visible:outline focus-visible:outline-ring"
                        onPointerUp={(event) => selectText(segment, event.currentTarget)}
                        onClick={(event) => {
                          if (locked || !window.getSelection()?.isCollapsed) return;
                          initiator.current = event.currentTarget;
                          setEditing({
                            turn: segment,
                            range: estimatedRange(segment, 0, segment.text.length),
                          });
                        }}
                        onKeyUp={(event) => {
                          if (event.key === "Shift") selectText(segment, event.currentTarget);
                        }}
                        onKeyDown={(event) => {
                          if (locked || (event.key !== "Enter" && event.key !== " ")) return;
                          event.preventDefault();
                          initiator.current = event.currentTarget;
                          setEditing({
                            turn: segment,
                            range: estimatedRange(segment, 0, segment.text.length),
                          });
                        }}
                      >
                        {segment.text}
                      </span>
                    </Fragment>
                  ))}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {api.cursor && (
        <Button variant="link" disabled={api.loading} onClick={() => void api.refresh(api.cursor!)}>
          Load more
        </Button>
      )}
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) saved();
        }}
      >
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl flex-col overflow-hidden p-4 sm:p-6"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (initiator.current?.isConnected) initiator.current.focus();
            else heading.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing?.range ? "Assign selected speech" : "Choose speaker"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? `${transcriptTimestamp(editing.turn.startSeconds)}–${transcriptTimestamp(editing.endSeconds ?? editing.turn.endSeconds)}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {recovery}
          {editing &&
            (editing.range ? (
              <SpeechSelection
                key={editing.turn.id}
                noteId={noteId}
                turn={editing.turn}
                initial={editing.range}
                api={api}
                onSaved={saved}
              />
            ) : (
              <SpeakerAssignment
                key={editing.turn.id}
                turn={editing.turn}
                api={api}
                onAssign={
                  editing.turns && editing.turns.length > 1
                    ? (assignment, guest, options) =>
                        api.submit(
                          {
                            kind: "assign",
                            commandId: crypto.randomUUID(),
                            targets: editing.turns!.map((segment) => ({
                              id: segment.id,
                              expectedAttributionRevision: segment.attributionRevision,
                            })),
                            assignment,
                          },
                          guest,
                          options,
                        )
                    : undefined
                }
                onSaved={saved}
              />
            ))}
        </DialogContent>
      </Dialog>
    </section>
  );
}
