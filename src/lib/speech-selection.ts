import type { CorrectedTurn } from "@/contracts/transcript-corrections";

export type SpeechRange = {
  startOffset: number;
  endOffset: number;
  startSeconds: number;
  endSeconds: number;
};

/** Turn-level timing is an editable estimate, never a word-alignment claim. */
export function estimatedRange(
  turn: CorrectedTurn,
  startOffset: number,
  endOffset: number,
): SpeechRange {
  if (!turn.text.slice(0, startOffset).trim()) startOffset = 0;
  if (!turn.text.slice(endOffset).trim()) endOffset = turn.text.length;
  const duration = turn.endSeconds - turn.startSeconds;
  return {
    startOffset,
    endOffset,
    startSeconds:
      startOffset === 0
        ? turn.startSeconds
        : turn.startSeconds + (duration * startOffset) / turn.text.length,
    endSeconds:
      endOffset === turn.text.length
        ? turn.endSeconds
        : turn.startSeconds + (duration * endOffset) / turn.text.length,
  };
}
