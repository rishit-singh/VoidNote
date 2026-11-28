import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ResearchAgentScope } from "../../src/contracts/research/agent";
import {
  createResearchAgentEvidenceTools,
  researchAgentTemporalEligibility,
} from "../../src/ai/research/agent-evidence";

const scope: ResearchAgentScope = {
  runId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  actorId: "33333333-3333-4333-8333-333333333333",
  operationId: "11111111-1111-4111-8111-111111111111",
  question: "What happened?",
  questions: [
    {
      id: "66666666-6666-4666-8666-666666666666",
      question: "What happened?",
    },
  ],
  noteId: null,
  personId: null,
  sourceUrls: [],
  discoverSources: true,
  timeframe: { mode: "unspecified" },
  maxAgeDays: 7,
};

void describe("research agent evidence adapter preflight", () => {
  void it("requires a known publication time within the historical scope", () => {
    const historicalScope = {
      ...scope,
      timeframe: { mode: "historical" as const, asOf: "2020-01-01T00:00:00.000Z" },
    };

    assert.equal(
      researchAgentTemporalEligibility(
        { url: "https://example.com", publishedAt: null },
        historicalScope,
      ),
      "unknown",
    );
    assert.equal(
      researchAgentTemporalEligibility(
        { url: "https://example.com", publishedAt: "2020-01-02T00:00:00.000Z" },
        historicalScope,
      ),
      "stale",
    );
    assert.equal(
      researchAgentTemporalEligibility(
        { url: "https://example.com", publishedAt: "2019-12-31T00:00:00.000Z" },
        historicalScope,
      ),
      "eligible",
    );
    assert.equal(
      researchAgentTemporalEligibility({ url: "https://example.com", publishedAt: null }, scope),
      "eligible",
    );
  });

  void it("returns canonical handlers without opening external connections", async () => {
    const tools = await createResearchAgentEvidenceTools(
      {},
      scope,
      "77777777-7777-4777-8777-777777777777",
    );

    assert.deepEqual(Object.keys(tools), [
      "evidence_lookup",
      "evidence_read",
      "search_sources",
      "retrieve_source",
      "record_findings",
      "publish_report",
    ]);
  });

  void it("surfaces missing application Firecrawl credentials explicitly", async () => {
    const tools = await createResearchAgentEvidenceTools(
      { RESEARCH_DISCOVERY_ENABLED: "true" },
      scope,
      "77777777-7777-4777-8777-777777777777",
    );

    await assert.rejects(
      tools.search_sources({ query: "primary source search" }),
      /application Firecrawl credential or discovery setting is missing/u,
    );
  });

  void it("rejects unsupported retrieval URLs before database or network access", async () => {
    const tools = await createResearchAgentEvidenceTools(
      {},
      scope,
      "77777777-7777-4777-8777-777777777777",
    );
    const result = await tools.retrieve_source({ url: "http://127.0.0.1/private" });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "invalid-input");
      assert.equal(result.message, "Source URL must be a public HTTPS address.");
    }
  });
});
