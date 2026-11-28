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
  void it("groups consecutive turns by effective identity without changing edit targets", () => {
    const person = {
      assignment: { kind: "person", personId: "p" },
      assignmentSource: "manual",
    } as const;
    const unknown = { assignment: { kind: "unknown" }, assignmentSource: "manual" } as const;
    const firstPage = [turn("a", 0, 1)];
    const secondPage = [
      turn("b", 20, 21),
      turn("c", 3, 4, person),
      turn("d", 4, 5, { ...person, speakerLabel: "B" }),
      turn("e", 5, 6, unknown),
      turn("f", 6, 7, { ...unknown, speakerLabel: "C" }),
    ];
    const turns = [...firstPage, ...secondPage];
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
      endSeconds: 21,
      text: "a b",
    });
    assert.equal(groups[0].turns[0], turns[0]);
    assert.deepEqual(turns, original);
    assert.deepEqual(groupTranscriptPassages([]), []);
  });

  void it("splits at intervening identities and run or recording boundaries but retains pauses and overlaps", () => {
    const turns = [
      turn("a", 0, 1),
      turn("b", 30, 31),
      turn("c", 30, 31, {
        assignment: { kind: "person", personId: "same-person" },
        speakerLabel: "PROVIDER_A",
      }),
      turn("d", 29, 93, {
        assignment: { kind: "person", personId: "same-person" },
        speakerLabel: "PROVIDER_B",
      }),
      turn("e", 90, 92, {
        assignment: { kind: "person", personId: "same-person" },
        speakerLabel: "PROVIDER_B",
      }),
      turn("f", 91, 94, { speakerLabel: "B" }),
      turn("g", 95, 96, {
        assignment: { kind: "person", personId: "same-person" },
        speakerLabel: "PROVIDER_C",
      }),
      turn("h", 97, 98, {
        assignment: { kind: "person", personId: "same-person" },
        speakerLabel: "PROVIDER_D",
        runId: "another-run",
      }),
      turn("i", 98, 99, {
        assignment: { kind: "person", personId: "same-person" },
        runId: "another-run",
        recordingId: "another-recording",
      }),
    ];
    const groups = groupTranscriptPassages(turns);
    assert.deepEqual(
      groups.map((group) => group.turnIds),
      [["a", "b"], ["c", "d", "e"], ["f"], ["g"], ["h"], ["i"]],
    );
    const samePersonPassage = groups[1];
    assert.ok(samePersonPassage);
    assert.equal(samePersonPassage.startSeconds, 30);
    assert.equal(samePersonPassage.endSeconds, 93);
    assert.equal(samePersonPassage.text, "c d e");
  });
});
