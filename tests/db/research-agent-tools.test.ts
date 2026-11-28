import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ResearchAgentScope } from "../../src/contracts/research/agent";
import {
  createResearchAgentTools,
  type ResearchAgentToolPorts,
} from "../../src/ai/research/agent-tools";

const sourceId = "44444444-4444-4444-8444-444444444444";
const questionId = "66666666-6666-4666-8666-666666666666";
const retrievedAt = "2020-01-01T00:00:00.000Z";
const pageText = "Evidence.".repeat(700);
const source = {
  id: sourceId,
  requestedUrl: "https://example.org/source",
  url: "https://example.org/source",
  text: pageText,
  retrievedAt,
  digest: "a".repeat(64),
};
const scope: ResearchAgentScope = {
  runId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  actorId: "33333333-3333-4333-8333-333333333333",
  operationId: "research:run-1",
  question: "What happened?",
  questions: [{ id: questionId, question: "What happened?" }],
  noteId: null,
  personId: null,
  sourceUrls: [source.url],
  discoverSources: false,
  timeframe: { mode: "historical", asOf: retrievedAt },
  maxAgeDays: 30,
};

type PortOverrides = Omit<Partial<ResearchAgentToolPorts>, "evidence"> & {
  evidence?: Partial<ResearchAgentToolPorts["evidence"]>;
};

function makePorts(overrides: PortOverrides = {}): ResearchAgentToolPorts {
  return {
    searchSources: () => Promise.resolve([]),
    retrieveSource: () => Promise.resolve({ source }),
    recordFindings: async () => {},
    publishReport: () => Promise.resolve({ published: true }),
    ...overrides,
    evidence: {
      lookup: () => Promise.resolve([]),
      read: (_scope, input) =>
        Promise.resolve({
          source: {
            id: source.id,
            requestedUrl: source.requestedUrl,
            url: source.url,
            retrievedAt: source.retrievedAt,
            digest: source.digest,
          },
          startOffset: input.startOffset,
          text: source.text.slice(input.startOffset, input.startOffset + input.limit),
          totalLength: source.text.length,
        }),
      source: () => Promise.resolve(source),
      ...overrides.evidence,
    },
  };
}

const operationIdFor = (tool: string, input: unknown) =>
  `${scope.operationId}:${tool}:${JSON.stringify(input)}`;

void describe("research agent tool boundaries", () => {
  void it("supports lookup followed by exact bounded reads without guessed passage handles", async () => {
    const tools = createResearchAgentTools(
      makePorts({
        evidence: {
          lookup: () =>
            Promise.resolve([
              {
                sourceId,
                title: "Saved page",
                url: source.url,
                retrievedAt,
                revision: "r1",
                freshness: "eligible",
                totalLength: source.text.length,
              },
            ]),
          read: (_scope, input) =>
            Promise.resolve({
              source: {
                id: source.id,
                requestedUrl: source.requestedUrl,
                url: source.url,
                retrievedAt: source.retrievedAt,
                digest: source.digest,
              },
              startOffset: input.startOffset,
              text: source.text.slice(input.startOffset, input.startOffset + input.limit),
              totalLength: source.text.length,
            }),
        },
      }),
      scope,
      operationIdFor,
    );

    const lookup = await tools.evidence_lookup({ query: "event" });
    assert.equal(lookup.ok, true);
    if (!lookup.ok) {
      return;
    }
    assert.equal(lookup.evidence[0]?.sourceId, sourceId);
    assert.equal("passageId" in (lookup.evidence[0] ?? {}), false);

    const first = await tools.evidence_read({ sourceId, startOffset: 0, limit: 2000 });
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    assert.equal(first.startOffset, 0);
    assert.equal(first.endOffset, 2000);
    assert.equal(first.totalLength, source.text.length);
    assert.equal(first.truncated, true);
    assert.equal(first.nextOffset, 2000);

    const next = await tools.evidence_read({
      sourceId,
      startOffset: first.nextOffset,
      limit: 2000,
    });
    assert.equal(next.ok, true);
    if (next.ok) {
      assert.equal(next.startOffset, 2000);
      assert.equal(next.text, source.text.slice(2000, 4000));
    }
  });

  void it("returns a bounded first retrieval page with an explicit continuation", async () => {
    const tools = createResearchAgentTools(makePorts(), scope, operationIdFor);
    const first = await tools.retrieve_source({ url: source.url });
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    assert.equal(first.startOffset, 0);
    assert.equal(first.endOffset, 4000);
    assert.equal(first.totalLength, source.text.length);
    assert.equal(first.truncated, true);
    assert.equal(first.nextOffset, 4000);

    const next = await tools.evidence_read({
      sourceId: first.source.sourceId,
      startOffset: first.nextOffset,
      limit: 2000,
    });
    assert.equal(next.ok, true);
    if (next.ok) {
      assert.equal(next.text, source.text.slice(4000, 6000));
    }
  });

  void it("rejects model-supplied authority and invalid source handles", async () => {
    const tools = createResearchAgentTools(makePorts(), scope, operationIdFor);
    const withWorkspace = await tools.evidence_lookup({
      query: "history",
      workspaceId: scope.workspaceId,
    });
    assert.equal(withWorkspace.ok, false);
    if (!withWorkspace.ok) {
      assert.equal(withWorkspace.code, "invalid-input");
    }

    const invalid = await tools.evidence_read({ sourceId, startOffset: -1 });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.code, "invalid-input");
    }
  });

  void it("blocks discovery and retrieval beyond an explicit source set", async () => {
    let searched = false;
    let retrieved = false;
    const tools = createResearchAgentTools(
      makePorts({
        searchSources: () => {
          searched = true;
          return Promise.resolve([]);
        },
        retrieveSource: () => {
          retrieved = true;
          return Promise.resolve({ source });
        },
      }),
      { ...scope, discoverSources: true },
      operationIdFor,
    );

    const search = await tools.search_sources({ query: "some research query" });
    const result = await tools.retrieve_source({ url: "https://outside.org/page" });
    assert.equal(search.ok, false);
    assert.equal(retrieved, false);
    assert.equal(searched, false);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "out-of-scope");
    }
  });

  void it("omits stale and out-of-scope saved sources", async () => {
    const tools = createResearchAgentTools(
      makePorts({
        evidence: {
          lookup: () =>
            Promise.resolve([
              {
                sourceId,
                title: "Old source",
                url: source.url,
                retrievedAt,
                revision: "r1",
                freshness: "stale",
                totalLength: source.text.length,
              },
              {
                sourceId: "55555555-5555-4555-8555-555555555555",
                title: "Excluded source",
                url: "https://outside.org/page",
                retrievedAt,
                revision: "r2",
                freshness: "eligible",
                totalLength: 10,
              },
            ]),
        },
      }),
      scope,
      operationIdFor,
    );
    const result = await tools.evidence_lookup({ query: "what happened" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.evidence.length, 0);
      assert.equal(result.omittedIneligibleCount, 2);
    }
  });

  void it("rejects answered publication without supported cited findings", async () => {
    const tools = createResearchAgentTools(makePorts(), scope, operationIdFor);
    const result = await tools.publish_report({
      answer: "A definitive answer.",
      quality: "answered",
      findings: [],
      gaps: [],
      stopReason: "evidence-sufficient",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "invalid-input");
    }
  });

  void it("requires publication coverage for every admitted question and explicit insufficiency", async () => {
    const secondQuestionId = "77777777-7777-4777-8777-777777777777";
    const twoQuestionScope = {
      ...scope,
      questions: [...scope.questions, { id: secondQuestionId, question: "Why did it happen?" }],
    };
    const tools = createResearchAgentTools(makePorts(), twoQuestionScope, operationIdFor);
    const omitted = await tools.publish_report({
      answer: "A partial answer.",
      quality: "partial",
      findings: [
        {
          questionId,
          outcome: "supported",
          statement: "It happened.",
          classification: "direct-evidence",
          explanation: "The source supports this.",
          citations: [],
        },
      ],
      gaps: ["Why did it happen?"],
      stopReason: "insufficient-evidence",
    });
    assert.equal(omitted.ok, false);

    const partial = await tools.publish_report({
      answer: "One question is supported; the other remains unresolved.",
      quality: "partial",
      findings: [
        {
          questionId,
          outcome: "supported",
          statement: "It happened.",
          classification: "direct-evidence",
          explanation: "The source supports this.",
          citations: [],
        },
        {
          questionId: secondQuestionId,
          outcome: "insufficient-evidence",
          statement: null,
          classification: null,
          explanation: "No source in the permitted set addresses why.",
          citations: [],
        },
      ],
      gaps: ["Why did it happen?"],
      stopReason: "insufficient-evidence",
    });
    assert.equal(partial.ok, true);
  });

  void it("requires every answered finding to be supported and cited with no gaps", async () => {
    const tools = createResearchAgentTools(makePorts(), scope, operationIdFor);
    const result = await tools.publish_report({
      answer: "An answer.",
      quality: "answered",
      findings: [
        {
          questionId,
          outcome: "supported",
          statement: "It happened.",
          classification: "direct-evidence",
          explanation: "The source supports this.",
          citations: [],
        },
      ],
      gaps: [],
      stopReason: "evidence-sufficient",
    });
    assert.equal(result.ok, false);
  });

  void it("accepts validated redirects from an allowed requested URL, not an adapter alias", async () => {
    const redirectedSource = {
      ...source,
      requestedUrl: "https://example.org/source",
      url: "https://cdn.example.net/canonical",
    };
    const tools = createResearchAgentTools(
      makePorts({ retrieveSource: () => Promise.resolve({ source: redirectedSource }) }),
      scope,
      operationIdFor,
    );
    const redirected = await tools.retrieve_source({ url: source.url });
    assert.equal(redirected.ok, true);
    if (redirected.ok) {
      assert.equal(redirected.source.requestedUrl, redirectedSource.requestedUrl);
      assert.equal(redirected.source.url, redirectedSource.url);
    }

    const aliased = createResearchAgentTools(
      makePorts({
        retrieveSource: () =>
          Promise.resolve({
            source: { ...redirectedSource, requestedUrl: "https://other.example/alias" },
          }),
      }),
      scope,
      operationIdFor,
    );
    const rejected = await aliased.retrieve_source({ url: source.url });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.code, "out-of-scope");
    }
  });

  void it("reports clipped search metadata and omitted candidate counts", async () => {
    const tools = createResearchAgentTools(
      makePorts({
        searchSources: () =>
          Promise.resolve(
            Array.from({ length: 7 }, (_, index) => ({
              url: `https://example.org/${index}`,
              title: "t".repeat(301),
              snippet: "s".repeat(501),
              publishedAt: null,
            })),
          ),
      }),
      { ...scope, sourceUrls: [], discoverSources: true },
      operationIdFor,
    );
    const result = await tools.search_sources({ query: "some research query" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.returnedCount, 6);
      assert.equal(result.omittedCount, 1);
      assert.equal(result.candidates[0]?.titleTruncated, true);
      assert.equal(result.candidates[0]?.snippetTruncated, true);
    }
  });

  void it("resolves admitted question IDs and generates stable finding identity server-side", async () => {
    let storedFinding: { id: string; questionId: string; question: string } | undefined;
    const tools = createResearchAgentTools(
      makePorts({
        recordFindings: (_scope, input) => {
          const finding = input.findings[0];
          storedFinding = finding
            ? {
                id: finding.id,
                questionId: finding.questionId,
                question: finding.question,
              }
            : undefined;
          return Promise.resolve();
        },
      }),
      scope,
      operationIdFor,
    );
    const result = await tools.record_findings({
      findings: [
        {
          questionId,
          outcome: "insufficient-evidence",
          statement: null,
          classification: null,
          explanation: "No qualifying source was available.",
          citations: [],
        },
      ],
      gaps: ["Find a primary source."],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(storedFinding, {
      id: questionId,
      questionId,
      question: "What happened?",
    });
  });

  void it("rejects findings whose citation is not an exact stored-source excerpt", async () => {
    let recorded = false;
    const tools = createResearchAgentTools(
      makePorts({
        recordFindings: () => {
          recorded = true;
          return Promise.resolve();
        },
      }),
      scope,
      operationIdFor,
    );
    const result = await tools.record_findings({
      findings: [
        {
          questionId,
          outcome: "supported",
          statement: "A supported claim.",
          classification: "direct-evidence",
          explanation: "The source states this.",
          citations: [
            {
              sourceId,
              url: source.url,
              excerpt: "Invented quote",
              startOffset: 0,
              endOffset: 13,
              retrievedAt,
            },
          ],
        },
      ],
      gaps: [],
    });
    assert.equal(result.ok, false);
    assert.equal(recorded, false);
    if (!result.ok) {
      assert.equal(
        result.message,
        "Finding citations did not validate against permitted evidence.",
      );
    }
  });
});
