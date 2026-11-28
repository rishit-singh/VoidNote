import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateRunCitations } from "../../src/ai/research/runs/validation";

void describe("research run citation validation", () => {
  const sources = [
    {
      sourceId: "source-1",
      url: "https://example.com/page",
      text: "Historical price was $100 in 2020.",
      retrievedAt: "2026-11-27T00:00:00.000Z",
    },
  ];

  void it("accepts an exact excerpt with matching immutable source metadata", () => {
    assert.deepEqual(
      validateRunCitations(
        [
          {
            sourceId: "source-1",
            url: sources[0]!.url,
            excerpt: "price was $100",
            startOffset: 11,
            endOffset: 25,
            retrievedAt: sources[0]!.retrievedAt,
          },
        ],
        sources,
      ),
      { valid: true },
    );
  });

  void it("rejects fabricated excerpts and a changed retrieval date", () => {
    assert.deepEqual(
      validateRunCitations(
        [
          {
            sourceId: "source-1",
            url: sources[0]!.url,
            excerpt: "$80 today",
            startOffset: 11,
            endOffset: 20,
            retrievedAt: sources[0]!.retrievedAt,
          },
        ],
        sources,
      ),
      { valid: false, reason: "excerpt-offset-mismatch" },
    );
    assert.deepEqual(
      validateRunCitations(
        [
          {
            sourceId: "source-1",
            url: sources[0]!.url,
            excerpt: "price was $100",
            startOffset: 11,
            endOffset: 25,
            retrievedAt: "2026-11-28T00:00:00.000Z",
          },
        ],
        sources,
      ),
      { valid: false, reason: "unknown-or-mismatched-source" },
    );
  });
});
