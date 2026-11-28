import assert from "node:assert/strict";
import { test } from "node:test";

import { assistantModelEvidence } from "../../src/ai/assistant/evidence";

void test("model evidence removes repeated provenance without losing IDs, revisions, cursors or text", () => {
  const sources = Array.from({ length: 100 }, (_, index) => ({
    kind: "transcript",
    id: `segment-${index}`,
    noteId: "opened-note",
    recordingId: "recording",
    runId: "run",
    revision: 7,
    label: `Speaker 01 · ${index}s`,
    startSeconds: index,
    endSeconds: index + 1,
  }));
  const passages = sources.map((source) => ({
    sourceId: source.id,
    personId: "person",
    text: `Evidence from ${source.startSeconds}.`,
  }));
  const output = {
    summary: "Read current context.",
    data: {
      transcript: { passages, sources, coverage: "partial-page", nextCursor: "opaque-cursor" },
      sources,
    },
    sources,
  };
  const projected = assistantModelEvidence(output);
  assert.deepEqual(projected, {
    summary: output.summary,
    data: {
      transcript: { passages, coverage: "partial-page", nextCursor: "opaque-cursor" },
    },
    sources,
  });
  assert.ok(JSON.stringify(projected).length < JSON.stringify(output).length / 2);
  assert.equal(output.data.transcript.sources, sources, "durable evidence is not mutated");
});

void test("does not discard distinct nested evidence absent from the publication envelope", () => {
  const output = {
    data: { sources: [{ kind: "note", id: "different", revision: 4 }] },
    sources: [{ kind: "note", id: "current", revision: 3 }],
  };
  assert.deepEqual(assistantModelEvidence(output), output);
});
