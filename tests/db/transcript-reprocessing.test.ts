import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapTranscriptReprocessing,
  type ReprocessingSourceTurn,
  type ReprocessingTarget,
} from "../../src/lib/transcript-reprocessing";

function source(
  id: string,
  startSeconds: number,
  endSeconds: number,
  overrides: Partial<ReprocessingSourceTurn> = {},
): ReprocessingSourceTurn {
  return {
    id,
    startSeconds,
    endSeconds,
    recordingId: "recording",
    runId: "original-run",
    sourceUtteranceId: `provider-${id}`,
    parentId: null,
    revision: 2,
    attributionRevision: 3,
    originalStartSeconds: startSeconds,
    originalEndSeconds: endSeconds,
    text: "Source speech",
    originalText: "Source speech",
    speakerLabel: "SPEAKER_00",
    assignment: { kind: "person", personId: "alice" },
    assignmentSource: "manual",
    reviewState: "confirmed",
    ...overrides,
  };
}

function target(id: string, startSeconds: number, endSeconds: number): ReprocessingTarget {
  return { id, startSeconds, endSeconds, recordingId: "recording", runId: "future-run" };
}

function map(
  sourceTurns: ReprocessingSourceTurn[],
  targetTurns: ReprocessingTarget[],
  currentSourceTurns = sourceTurns,
) {
  return mapTranscriptReprocessing({ sourceTurns, currentSourceTurns, targetTurns });
}

void describe("conservative future transcript reprocessing (pure; no rerun API)", () => {
  void it("preserves exact explicit manual unknown and versioned audio provenance", () => {
    const original = source("old", 1, 4, {
      assignment: { kind: "unknown" },
      parentId: "parent",
      originalStartSeconds: 0.5,
      originalEndSeconds: 5,
    });
    const next = target("new", 1, 4);
    const result = map([original], [next]);
    assert.deepEqual(
      result.assignments.map((item) => item.assignment),
      [{ kind: "unknown" }],
    );
    assert.equal(result.assignments[0]?.assignmentSource, "manual");
    assert.deepEqual(result.assignments[0]?.sources, [
      {
        id: "old",
        sourceUtteranceId: "provider-old",
        parentId: "parent",
        runId: "original-run",
        recordingId: "recording",
        revision: 2,
        attributionRevision: 3,
        startSeconds: 1,
        endSeconds: 4,
        originalStartSeconds: 0.5,
        originalEndSeconds: 5,
      },
    ]);
    assert.deepEqual(result.reviews, []);
    assert.deepEqual(result.originals[0]?.jobInput, original);
    assert.equal(result.originals[0]?.reviewState, "confirmed");
    assert.deepEqual(result.originals[0]?.mappedTargets, [next]);
  });

  void it("maps one corrected source to several contained segments without losing lineage", () => {
    const result = map([source("old", 0, 6)], [target("a", 0, 2), target("b", 2, 6)]);
    assert.equal(result.assignments.length, 2);
    assert.deepEqual(
      result.assignments.map((item) => item.sources.map((ref) => ref.id)),
      [["old"], ["old"]],
    );
    assert.equal(result.originals[0]?.reviewState, "confirmed");
    assert.deepEqual(
      result.originals[0]?.mappedTargets.map((turn) => turn.id),
      ["a", "b"],
    );
  });

  void it("maps a contiguous same-person merge even across different provider tracks", () => {
    const result = map(
      [source("b", 2, 4, { speakerLabel: "SPEAKER_09" }), source("a", 0, 2)],
      [target("merged", 0, 4)],
    );
    assert.deepEqual(result.assignments[0]?.assignment, { kind: "person", personId: "alice" });
    assert.deepEqual(
      result.assignments[0]?.sources.map((ref) => ref.id),
      ["b", "a"],
    );
    assert.equal(result.assignments[0]?.sources.length, 2);
    assert.ok(result.originals.every((item) => item.reviewState === "confirmed"));
  });

  void it("reviews mixed-person and person/unknown merges without choosing a majority", () => {
    for (const assignment of [{ kind: "person", personId: "bob" }, { kind: "unknown" }] as const) {
      const sources = [source("alice", 0, 8), source("other", 8, 10, { assignment })];
      const result = map(sources, [target("mixed", 0, 10)]);
      assert.deepEqual(result.assignments, []);
      assert.equal(result.reviews[0]?.reviewState, "needs_review");
      assert.ok(result.reviews[0]?.reasons.includes("mixed_identities"));
      assert.deepEqual(
        result.reviews[0]?.sources.map((ref) => ref.id),
        ["alice", "other"],
      );
      assert.deepEqual(
        result.originals.map((item) => item.jobInput),
        sources,
      );
      assert.ok(result.originals.every((item) => item.reviewTargets[0]?.id === "mixed"));
    }
  });

  void it("reviews overlapping source assignments even when identities agree", () => {
    const result = map([source("a", 0, 3), source("b", 2, 5)], [target("overlap", 0, 5)]);
    assert.deepEqual(result.assignments, []);
    assert.ok(result.reviews[0]?.reasons.includes("overlapping_sources"));
    assert.equal(result.originals.length, 2);
  });

  void it("does not bridge gaps or guess shifted boundaries, even by a tiny amount", () => {
    const fixtures = [
      { sources: [source("a", 0, 2), source("b", 3, 5)], next: target("gap", 0, 5) },
      { sources: [source("a", 1, 5)], next: target("shifted", 1.001, 5.001) },
      { sources: [source("a", 1, 5)], next: target("expanded", 0.999, 5) },
    ];
    for (const fixture of fixtures) {
      const result = map(fixture.sources, [fixture.next]);
      assert.deepEqual(result.assignments, []);
      assert.ok(result.reviews[0]?.reasons.includes("incomplete_coverage"));
      assert.ok(result.originals.every((item) => item.reviewState === "needs_review"));
    }
  });

  void it("maps contained coverage but retains uncovered original portions for review", () => {
    const result = map([source("old", 0, 10)], [target("contained", 2, 8)]);
    assert.equal(result.assignments.length, 1);
    assert.deepEqual(result.originals[0]?.reasons, ["partially_mapped"]);
    assert.equal(result.originals[0]?.jobInput?.startSeconds, 0);
    assert.equal(result.originals[0]?.jobInput?.endSeconds, 10);
  });

  void it("retains entirely unmatched corrections, including when no targets exist", () => {
    const sources = [source("old", 0, 2, { assignment: { kind: "unknown" } })];
    for (const targets of [[], [target("unrelated", 2, 4)]]) {
      const result = map(sources, targets);
      assert.deepEqual(result.assignments, []);
      assert.deepEqual(result.originals[0]?.jobInput, sources[0]);
      assert.deepEqual(result.originals[0]?.reasons, ["no_matching_target"]);
      assert.equal(result.originals[0]?.reviewState, "needs_review");
      assert.equal(result.reviews.length, targets.length);
    }
  });

  void it("does not infer identity from provider labels or map across recordings", () => {
    const unassigned = source("old", 0, 2, {
      assignment: { kind: "unassigned" },
      assignmentSource: "unassigned",
    });
    const result = map([unassigned], [target("new", 0, 2)]);
    assert.deepEqual(result.assignments, []);
    assert.ok(result.reviews[0]?.reasons.includes("unassigned_source"));
    const other = map([source("old", 0, 2)], [{ ...target("new", 0, 2), recordingId: "other" }]);
    assert.deepEqual(other.assignments, []);
    assert.deepEqual(other.reviews[0]?.sources, []);
    assert.deepEqual(other.originals[0]?.reasons, ["no_matching_target"]);
  });

  void it("blocks late jobs after attribution or content revisions change, retaining both versions", () => {
    const before = source("old", 0, 4);
    for (const after of [
      { ...before, attributionRevision: 4, assignment: { kind: "unknown" } as const },
      { ...before, revision: 3, text: "Manually corrected text" },
      { ...before, attributionRevision: 4 }, // Even a change back to the same identity is stale.
    ]) {
      const result = map([before], [target("new", 0, 4)], [after]);
      assert.deepEqual(result.assignments, []);
      assert.ok(result.reviews[0]?.reasons.includes("source_changed"));
      assert.deepEqual(result.originals[0]?.jobInput, before);
      assert.deepEqual(result.originals[0]?.current, after);
      assert.equal(result.reviews[0]?.sources.length, 2);
    }
  });

  void it("reviews removed, newly inserted and moved sources at both old and current spans", () => {
    const before = source("old", 0, 2);
    const after = { ...before, revision: 3, startSeconds: 4, endSeconds: 6 };
    const moved = map([before], [target("old-place", 0, 2), target("new-place", 4, 6)], [after]);
    assert.deepEqual(moved.assignments, []);
    assert.ok(moved.reviews.every((item) => item.reasons.includes("source_changed")));
    assert.equal(moved.reviews.length, 2);
    const removed = map([before], [target("new", 0, 2)], []);
    assert.deepEqual(removed.assignments, []);
    assert.equal(removed.originals[0]?.current, null);
    assert.ok(removed.reviews[0]?.reasons.includes("source_changed"));
    const inserted = map([], [target("new", 0, 2)], [before]);
    assert.deepEqual(inserted.assignments, []);
    assert.equal(inserted.originals[0]?.jobInput, null);
    assert.ok(inserted.reviews[0]?.reasons.includes("source_changed"));
  });

  void it("keeps text corrections separate even when speaker mappings are unambiguous", () => {
    const original = source("old", 0, 4, { originalText: "wrong words", text: "Corrected words" });
    const result = map([original], [target("a", 0, 2), target("b", 2, 4)]);
    assert.equal(result.assignments.length, 2);
    assert.ok(result.assignments.every((item) => item.reviewState === "needs_review"));
    assert.ok(result.assignments.every((item) => item.textReviewSources[0]?.id === "old"));
    assert.ok(result.assignments.every((item) => !("text" in item) && !("text" in item.target)));
    assert.deepEqual(
      result.originals[0]?.textCorrections.map((item) => [item.originalText, item.correctedText]),
      [["wrong words", "Corrected words"]],
    );
    assert.deepEqual(result.originals[0]?.reasons, ["text_correction_requires_review"]);
  });

  void it("keeps existing review-required assignments under review", () => {
    const result = map(
      [source("old", 0, 2, { reviewState: "needs_review" })],
      [target("new", 0, 2)],
    );
    assert.deepEqual(result.assignments, []);
    assert.ok(result.reviews[0]?.reasons.includes("source_needs_review"));
  });

  void it("is deterministic, leaves inputs untouched, and returns detached audit snapshots", () => {
    const sources = [source("old", 0, 4)];
    const targets = [target("new", 0, 4)];
    const snapshot = structuredClone({ sources, targets });
    const result = map(sources, targets);
    assert.deepEqual(result, map(sources, targets));
    assert.deepEqual({ sources, targets }, snapshot);
    sources[0]!.assignment = { kind: "unknown" };
    targets[0]!.endSeconds = 10;
    assert.deepEqual(result.assignments[0]?.assignment, { kind: "person", personId: "alice" });
    assert.equal(result.assignments[0]?.target.endSeconds, 4);
    assert.deepEqual(result.originals[0]?.jobInput, snapshot.sources[0]);
  });

  void it("rejects invalid spans and duplicate references rather than guessing", () => {
    for (const end of [0, -1, NaN, Infinity]) {
      assert.throws(() => map([source("old", 0, end)], []), RangeError);
      assert.throws(() => map([], [target("new", 0, end)]), RangeError);
    }
    assert.throws(() => map([source("old", 0, 2), source("old", 2, 4)], []), /Duplicate/);
    assert.throws(() => map([], [target("new", 0, 2), target("new", 2, 4)]), /Duplicate/);
  });
});
