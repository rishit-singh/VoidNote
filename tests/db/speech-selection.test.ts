import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CorrectedTurn } from "../../src/contracts/transcript-corrections";
import { estimatedRange } from "../../src/lib/speech-selection";

void describe("speech selection endpoint regressions", () => {
  const turn = (text: string, startSeconds = 0, endSeconds = 0.21) =>
    ({ text, startSeconds, endSeconds }) as CorrectedTurn;
  void it("uses exact endpoints for suffixes, including decimals that interpolation rounds differently", () => {
    const source = turn("Hello Alex. Hello Sam.");
    const selected = estimatedRange(source, 18, source.text.length);
    assert.equal(selected.endSeconds, source.endSeconds);
    assert.ok(selected.startSeconds > source.startSeconds);
  });
  void it("expands word selections to absorb whitespace-only siblings from previous splits", () => {
    const source = turn(" hello ", 1, 2);
    assert.deepEqual(estimatedRange(source, 1, 6), {
      startOffset: 0,
      endOffset: 7,
      startSeconds: 1,
      endSeconds: 2,
    });
    const partial = estimatedRange(turn("Hello Ada hello", 0, 12), 6, 9);
    assert.equal(partial.startOffset, 6);
    assert.equal(partial.endOffset, 9);
  });
});
