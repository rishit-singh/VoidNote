import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CorrectedTurn } from "../../src/contracts/transcript-corrections";
import { groupTranscriptPassages } from "../../src/lib/transcript-passages";

const turn = (
  id: string,
  startSeconds: number,
  endSeconds: number,
  overrides: Partial<CorrectedTurn> = {},
): CorrectedTurn => ({
  id,
  runId: "run",
  recordingId: "recording",
  sequence: 0,
  sourceUtteranceId: id,
  orderKey: "",
  parentId: null,
  revision: 1,
  attributionRevision: 1,
  assignment: { kind: "unassigned" },
  assignmentSource: "unassigned",
  personName: null,
  reviewState: "unreviewed",
  providerScore: null,
  sampleSuitability: "not_evaluated",
  speakerLabel: "A",
  text: ` ${id} `,
  startSeconds,
  endSeconds,
  originalText: id,
  originalStartSeconds: startSeconds,
  originalEndSeconds: endSeconds,
  ...overrides,
});

void describe("transcript passages", () => {
  void it("groups by effective identity with inclusive one-second gaps without changing edit targets", () => {
    const person = {
      assignment: { kind: "person", personId: "p" },
      assignmentSource: "manual",
    } as const;
    const unknown = { assignment: { kind: "unknown" }, assignmentSource: "manual" } as const;
    const turns = [
      turn("a", 0, 1),
      turn("b", 2, 3),
      turn("c", 3, 4, person),
      turn("d", 4, 5, { ...person, speakerLabel: "B" }),
      turn("e", 5, 6, unknown),
      turn("f", 6, 7, { ...unknown, speakerLabel: "C" }),
    ];
    const original = structuredClone(turns);
    const groups = groupTranscriptPassages(turns);
    assert.deepEqual(
      groups.map((group) => group.turnIds),
      [
        ["a", "b"],
        ["c", "d"],
        ["e", "f"],
      ],
    );
    assert.deepEqual(groups[0], {
      id: "a",
      turnIds: ["a", "b"],
      turns: [turns[0], turns[1]],
      startSeconds: 0,
      endSeconds: 3,
      text: "a b",
    });
    assert.equal(groups[0].turns[0], turns[0]);
    assert.deepEqual(turns, original);
    assert.deepEqual(groupTranscriptPassages([]), []);
  });

  void it("breaks on intervening speakers, overlaps, long gaps, backwards time, and run boundaries", () => {
    const turns = [
      turn("a", 0, 1),
      turn("b", 1, 2, { speakerLabel: "B" }),
      turn("c", 2, 4),
      turn("d", 3, 5),
      turn("e", 6.01, 7),
      turn("f", 1, 2),
      turn("g", 2, 3, { runId: "another-run" }),
      turn("h", 3, 4, { runId: "another-run", recordingId: "another-recording" }),
    ];
    assert.deepEqual(
      groupTranscriptPassages(turns).map((group) => group.turnIds),
      turns.map((item) => [item.id]),
    );
  });
});
