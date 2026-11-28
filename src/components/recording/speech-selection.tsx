"use client";
import { useState } from "react";
import { Play } from "lucide-react";
import type { CorrectedTurn } from "@/contracts/transcript-corrections";
import type { TranscriptCorrections } from "@/hooks/use-transcript-corrections";
import { playAudioRange } from "@/stores/use-audio-playback-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { SpeakerAssignment } from "./speaker-assignment";
import { cn } from "@/lib/utils";

import { estimatedRange, type SpeechRange } from "@/lib/speech-selection";
export { estimatedRange, type SpeechRange } from "@/lib/speech-selection";
export function SpeechSelection({
  noteId,
  turn,
  initial,
  api,
  onSaved,
}: {
  noteId: string;
  turn: CorrectedTurn;
  initial: SpeechRange;
  api: TranscriptCorrections;
  onSaved: () => void;
}) {
  const [range, setRange] = useState(initial);
  const [anchor, setAnchor] = useState<number | null>(null);
  const locked = api.busy || !!api.pending || !api.ready;
  const epsilon = Math.min(0.01, (turn.endSeconds - turn.startSeconds) / 1000);
  const whole = range.startOffset === 0 && range.endOffset === turn.text.length;
  const valid =
    whole ||
    (epsilon > 0 &&
      range.endSeconds > range.startSeconds &&
      (range.startOffset === 0 || range.startSeconds > turn.startSeconds) &&
      (range.endOffset === turn.text.length || range.endSeconds < turn.endSeconds));
  const replay = (selected: SpeechRange) =>
    void playAudioRange(noteId, turn.recordingId, selected.startSeconds, selected.endSeconds);
  const words = Array.from(turn.text.matchAll(/\S+\s*/g));
  return (
    <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">
      <p className="text-meta text-muted-foreground">
        Select words, then adjust the audio range while listening.
      </p>
      <div
        className="flex flex-wrap gap-x-1 gap-y-2 rounded-md border p-3"
        aria-label="Select spoken words"
      >
        {words.map((match) => {
          const start = match.index,
            end = start + match[0].length;
          const selected = start < range.endOffset && end > range.startOffset;
          return (
            <button
              key={start}
              type="button"
              disabled={locked}
              aria-pressed={selected}
              className={cn(
                "rounded px-1 text-body",
                selected ? "bg-primary text-primary-foreground" : "hover:bg-accent",
              )}
              onClick={() => {
                const next = estimatedRange(
                  turn,
                  anchor === null ? start : Math.min(anchor, start),
                  anchor === null ? end : Math.max(range.endOffset, end),
                );
                setAnchor(anchor === null ? start : null);
                setRange(next);
                replay(next);
              }}
            >
              {match[0].trim()}
            </button>
          );
        })}
      </div>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="selection-start">
            Audio start · {range.startSeconds.toFixed(1)}s
          </FieldLabel>
          <Input
            id="selection-start"
            className="accent-primary"
            type="range"
            min={turn.startSeconds + epsilon}
            max={range.endSeconds - epsilon}
            step="any"
            value={range.startSeconds}
            disabled={locked || range.startOffset === 0}
            onChange={(event) =>
              setRange((r) => ({ ...r, startSeconds: Number(event.target.value) }))
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="selection-end">
            Audio end · {range.endSeconds.toFixed(1)}s
          </FieldLabel>
          <Input
            id="selection-end"
            className="accent-primary"
            type="range"
            min={range.startSeconds + epsilon}
            max={turn.endSeconds - epsilon}
            step="any"
            value={range.endSeconds}
            disabled={locked || range.endOffset === turn.text.length}
            onChange={(event) =>
              setRange((r) => ({ ...r, endSeconds: Number(event.target.value) }))
            }
          />
        </Field>
      </FieldGroup>
      <Button variant="outline" className="self-start" onClick={() => replay(range)}>
        <Play />
        Replay selection
      </Button>
      <SpeakerAssignment
        disabled={!valid}
        allowPropagation={false}
        turn={turn}
        api={api}
        onSaved={onSaved}
        onAssign={(assignment, guest, options) => {
          if (range.startOffset === 0 && range.endOffset === turn.text.length)
            return api.submit(
              {
                kind: "assign",
                commandId: crypto.randomUUID(),
                targets: [{ id: turn.id, expectedAttributionRevision: turn.attributionRevision }],
                assignment,
              },
              guest,
              options,
            );
          return api.submit(
            {
              kind: "split",
              commandId: crypto.randomUUID(),
              utteranceId: turn.id,
              expectedRevision: turn.revision,
              splitSeconds: range.endSeconds,
              textOffset: range.endOffset,
              leftId: crypto.randomUUID(),
              rightId: crypto.randomUUID(),
              selection: { ...range, selectedId: crypto.randomUUID(), assignment },
            },
            guest,
            options,
          );
        }}
      />
    </div>
  );
}
