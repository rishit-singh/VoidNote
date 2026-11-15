import type { Assignment, CorrectedTurn } from "../contracts/transcript-corrections";

/** Both the frozen job input and the latest source transcript must be supplied. */
export type ReprocessingSourceTurn = Pick<
  CorrectedTurn,
  | "id"
  | "runId"
  | "recordingId"
  | "sourceUtteranceId"
  | "parentId"
  | "revision"
  | "attributionRevision"
  | "startSeconds"
  | "endSeconds"
  | "originalStartSeconds"
  | "originalEndSeconds"
  | "text"
  | "originalText"
  | "speakerLabel"
  | "assignment"
  | "assignmentSource"
  | "reviewState"
>;

export type ReprocessingTarget = Pick<
  CorrectedTurn,
  "id" | "runId" | "recordingId" | "startSeconds" | "endSeconds"
>;

export type ReprocessingSourceReference = Pick<
  ReprocessingSourceTurn,
  | "id"
  | "runId"
  | "recordingId"
  | "sourceUtteranceId"
  | "parentId"
  | "revision"
  | "attributionRevision"
  | "startSeconds"
  | "endSeconds"
  | "originalStartSeconds"
  | "originalEndSeconds"
>;

export type ReprocessingReviewReason =
  | "source_changed"
  | "source_needs_review"
  | "unassigned_source"
  | "mixed_identities"
  | "overlapping_sources"
  | "incomplete_coverage"
  | "no_matching_target"
  | "partially_mapped"
  | "text_correction_requires_review";

export interface ReprocessingOriginal {
  /** Frozen input, including the expected content and attribution revisions. */
  jobInput: ReprocessingSourceTurn | null;
  /** Latest source; null means it was removed/replaced after job input. */
  current: ReprocessingSourceTurn | null;
  reviewState: "confirmed" | "needs_review";
  reasons: ReprocessingReviewReason[];
  mappedTargets: ReprocessingTarget[];
  reviewTargets: ReprocessingTarget[];
  /** Text is retained for explicit reconciliation, never copied to new segments. */
  textCorrections: {
    source: ReprocessingSourceReference;
    originalText: string;
    correctedText: string;
  }[];
}

export interface ReprocessingMappingResult {
  policy: "exact-audio-coverage-v1";
  assignments: {
    target: ReprocessingTarget;
    assignment: Exclude<Assignment, { kind: "unassigned" }>;
    assignmentSource: "manual";
    reviewState: "confirmed" | "needs_review";
    sources: ReprocessingSourceReference[];
    textReviewSources: ReprocessingSourceReference[];
  }[];
  reviews: {
    target: ReprocessingTarget;
    reviewState: "needs_review";
    reasons: ReprocessingReviewReason[];
    sources: ReprocessingSourceReference[];
  }[];
  /** Every input/current source survives here, including completely unmatched ones. */
  originals: ReprocessingOriginal[];
}

function key(turn: ReprocessingTarget): string {
  return JSON.stringify([turn.recordingId, turn.runId, turn.id]);
}

function reference(turn: ReprocessingSourceTurn): ReprocessingSourceReference {
  const {
    id,
    runId,
    recordingId,
    sourceUtteranceId,
    parentId,
    revision,
    attributionRevision,
    startSeconds,
    endSeconds,
    originalStartSeconds,
    originalEndSeconds,
  } = turn;
  return {
    id,
    runId,
    recordingId,
    sourceUtteranceId,
    parentId,
    revision,
    attributionRevision,
    startSeconds,
    endSeconds,
    originalStartSeconds,
    originalEndSeconds,
  };
}

function overlaps(a: ReprocessingTarget, b: ReprocessingTarget): boolean {
  return (
    a.recordingId === b.recordingId &&
    a.startSeconds < b.endSeconds &&
    b.startSeconds < a.endSeconds
  );
}

function validate(turns: readonly ReprocessingTarget[]): void {
  const keys = new Set<string>();
  for (const turn of turns) {
    if (
      !Number.isFinite(turn.startSeconds) ||
      !Number.isFinite(turn.endSeconds) ||
      turn.startSeconds < 0 ||
      turn.endSeconds <= turn.startSeconds
    ) {
      throw new RangeError("Reprocessing requires finite, positive-length audio spans");
    }
    if (keys.has(key(turn))) throw new Error("Duplicate reprocessing turn reference");
    keys.add(key(turn));
  }
}

function sourceChanged(original: ReprocessingOriginal): boolean {
  return (
    !original.jobInput ||
    !original.current ||
    original.jobInput.revision !== original.current.revision ||
    original.jobInput.attributionRevision !== original.current.attributionRevision
  );
}

function versions(original: ReprocessingOriginal): ReprocessingSourceTurn[] {
  if (!original.jobInput) return original.current ? [original.current] : [];
  if (original.current && sourceChanged(original)) return [original.jobInput, original.current];
  return [original.jobInput];
}

function fullyCovered(source: ReprocessingTarget, targets: readonly ReprocessingTarget[]): boolean {
  let cursor = source.startSeconds;
  for (const target of [...targets].sort((a, b) => a.startSeconds - b.startSeconds)) {
    if (!overlaps(source, target)) continue;
    if (target.startSeconds > cursor) return false;
    cursor = Math.max(cursor, target.endSeconds);
  }
  return cursor >= source.endSeconds;
}

/**
 * Future-rerun preparation only: no persistence, provider publication or runnable
 * rerun route. Supply complete source snapshots for the same audio timeline;
 * source edits must advance revision and/or attributionRevision. Invalid spans
 * and duplicate references throw rather than produce a usable mapping.
 *
 * Half-open spans use exact seconds (no rounding, tolerance, text/track guessing).
 * A target must be fully covered by non-overlapping, contiguous manual sources
 * with one explicit identity. Contained splits and same-identity merges qualify.
 * Missing/changed source revisions block affected targets, including both old
 * and new locations of a moved span. All originals and unmatched portions remain
 * reviewable. Speaker mapping never transfers or replaces corrected text.
 *
 * A future publisher must recheck these source revisions atomically at commit;
 * this pure snapshot calculation cannot guard edits made after it returns.
 */
export function mapTranscriptReprocessing(input: {
  sourceTurns: readonly ReprocessingSourceTurn[];
  currentSourceTurns: readonly ReprocessingSourceTurn[];
  targetTurns: readonly ReprocessingTarget[];
}): ReprocessingMappingResult {
  validate(input.sourceTurns);
  validate(input.currentSourceTurns);
  validate(input.targetTurns);
  const originals = new Map<string, ReprocessingOriginal>();
  const empty = (): ReprocessingOriginal => ({
    jobInput: null,
    current: null,
    reviewState: "confirmed",
    reasons: [],
    mappedTargets: [],
    reviewTargets: [],
    textCorrections: [],
  });
  for (const turn of input.sourceTurns) originals.set(key(turn), { ...empty(), jobInput: turn });
  for (const turn of input.currentSourceTurns) {
    const original = originals.get(key(turn)) ?? empty();
    original.current = turn;
    originals.set(key(turn), original);
  }
  for (const original of originals.values()) {
    if (sourceChanged(original)) original.reasons.push("source_changed");
    original.textCorrections = versions(original)
      .filter((turn) => turn.text !== turn.originalText)
      .map((turn) => ({
        source: reference(turn),
        originalText: turn.originalText,
        correctedText: turn.text,
      }));
    if (original.textCorrections.length) original.reasons.push("text_correction_requires_review");
  }

  const result: ReprocessingMappingResult = {
    policy: "exact-audio-coverage-v1",
    assignments: [],
    reviews: [],
    originals: [...originals.values()],
  };
  for (const target of input.targetTurns) {
    const candidates = result.originals.filter((original) =>
      versions(original).some((turn) => overlaps(turn, target)),
    );
    const sources = candidates.flatMap((original) => versions(original).map(reference));
    const reasons = new Set<ReprocessingReviewReason>();
    if (candidates.some(sourceChanged)) reasons.add("source_changed");
    const turns = candidates
      .flatMap((original) => (original.current ? [original.current] : []))
      .filter((turn) => overlaps(turn, target))
      .sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
    const identities = new Set<string>();
    let cursor = target.startSeconds;
    for (const turn of turns) {
      if (turn.reviewState === "needs_review") reasons.add("source_needs_review");
      if (turn.assignmentSource !== "manual" || turn.assignment.kind === "unassigned") {
        reasons.add("unassigned_source");
      } else {
        identities.add(
          turn.assignment.kind === "unknown" ? "unknown" : `person:${turn.assignment.personId}`,
        );
      }
      const start = Math.max(target.startSeconds, turn.startSeconds);
      if (start < cursor) reasons.add("overlapping_sources");
      if (start > cursor) reasons.add("incomplete_coverage");
      cursor = Math.max(cursor, Math.min(target.endSeconds, turn.endSeconds));
    }
    if (cursor < target.endSeconds) reasons.add("incomplete_coverage");
    if (identities.size > 1) reasons.add("mixed_identities");
    const assignment = turns[0]?.assignment;
    if (reasons.size || !assignment || assignment.kind === "unassigned") {
      result.reviews.push({ target, reviewState: "needs_review", reasons: [...reasons], sources });
      for (const original of candidates) {
        original.reviewTargets.push(target);
        original.reasons.push(...reasons);
      }
    } else {
      const textReviewSources = candidates.flatMap((original) =>
        original.textCorrections.map((correction) => correction.source),
      );
      result.assignments.push({
        target,
        assignment,
        assignmentSource: "manual",
        sources,
        reviewState: textReviewSources.length ? "needs_review" : "confirmed",
        textReviewSources,
      });
      for (const original of candidates) original.mappedTargets.push(target);
    }
  }

  for (const original of result.originals) {
    if (!original.mappedTargets.length && !original.reviewTargets.length) {
      original.reasons.push("no_matching_target");
    } else if (versions(original).some((turn) => !fullyCovered(turn, original.mappedTargets))) {
      original.reasons.push("partially_mapped");
    }
    original.reasons = [...new Set(original.reasons)];
    original.reviewState = original.reasons.length ? "needs_review" : "confirmed";
  }
  // Own the returned audit records so later caller mutations cannot change the plan.
  return structuredClone(result);
}
