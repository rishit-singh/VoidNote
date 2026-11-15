import type { CorrectedTurn, TranscriptPassage } from "../contracts/transcript-corrections";

export type GroupedTranscriptPassage = TranscriptPassage & { turns: CorrectedTurn[] };

function identity(turn: CorrectedTurn): string {
  switch (turn.assignment.kind) {
    case "person":
      return `person:${turn.assignment.personId}`;
    case "unknown":
      return "unknown";
    case "unassigned":
      return `provider:${turn.speakerLabel}`;
  }
}

/** Presentation-only groups in source order; original turns remain the edit targets.
 * Call with consecutive pages together to also group across their boundaries.
 */
export function groupTranscriptPassages(
  turns: readonly CorrectedTurn[],
): GroupedTranscriptPassage[] {
  const passages: GroupedTranscriptPassage[] = [];
  let previous: CorrectedTurn | undefined;
  let previousIdentity: string | undefined;
  let passage: GroupedTranscriptPassage | undefined;
  let texts: string[] = [];
  for (const turn of turns) {
    const effectiveIdentity = identity(turn);
    const gap = previous ? turn.startSeconds - previous.endSeconds : -1;
    if (
      passage &&
      previous &&
      previous.runId === turn.runId &&
      previous.recordingId === turn.recordingId &&
      previousIdentity === effectiveIdentity &&
      gap >= 0 &&
      gap <= 1
    ) {
      passage.turnIds.push(turn.id);
      passage.turns.push(turn);
      passage.endSeconds = turn.endSeconds;
      texts.push(turn.text.trim());
    } else {
      if (passage) passage.text = texts.join(" ");
      passage = {
        id: turn.id,
        turnIds: [turn.id],
        turns: [turn],
        startSeconds: turn.startSeconds,
        endSeconds: turn.endSeconds,
        text: "",
      };
      passages.push(passage);
      texts = [turn.text.trim()];
    }
    previous = turn;
    previousIdentity = effectiveIdentity;
  }
  if (passage) passage.text = texts.join(" ");
  return passages;
}
