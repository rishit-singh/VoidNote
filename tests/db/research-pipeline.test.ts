import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { aggregateResearchStatus, requestResearchSchema } from "../../src/contracts/research";
import { readResearchPolicy, researchPolicySchema } from "../../src/config/research";
import {
  runResearchItem,
  validateResearchExtraction,
  type ResearchExecution,
  type ResearchExtractionInput,
  type ResearchPipelinePorts,
  type ResearchSource,
} from "../../src/ai/research";

function fixture() {
  const policy = researchPolicySchema.parse({
    version: "research-v1",
    promptVersion: "research-extract-v1",
    provider: "workers-ai",
    model: "configured-test-model",
    budgetId: randomUUID(),
    rateVersionId: randomUUID(),
  });
  const personId = randomUUID();
  const source: ResearchSource = {
    id: "source-1",
    requestedUrl: "https://public-source.org/ada",
    url: "https://public-source.org/ada",
    text: "Ada Lovelace is the research director at Analytical Engines. Published November 25, 2026.",
    digest: "test-source-digest",
    retrievedAt: "2026-11-25T12:00:00.000Z",
  };
  const requestedFacts = [
    { key: "role", question: "What is Ada's professional role?" },
    { key: "email", question: "What is Ada's public email?" },
  ];
  const execution: ResearchExecution = {
    workspaceId: randomUUID(),
    batchId: randomUUID(),
    personId,
    actorId: randomUUID(),
    generation: 1,
    request: { personId, expectedProfileRevision: 2, sourceUrls: [source.url], requestedFacts },
    person: {
      id: personId,
      revision: 2,
      displayName: "Ada Lovelace",
      description: "Research at Analytical Engines",
      professional: { revision: 0, organization: "", role: "", links: [] },
    },
    policy,
    status: "queued",
    sources: [],
    facts: requestedFacts.map((fact) => ({
      key: fact.key,
      state: "pending",
      operationId: randomUUID(),
      finding: null,
      usage: null,
      settled: false,
    })),
    discovery: {
      state: "pending",
      operationId: randomUUID(),
      creditsUsed: null,
      settled: false,
    },
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const counters = { fetch: 0, extraction: 0, admit: 0, settle: 0 };
  const terminalErrors: (string | null)[] = [];
  const supported = {
    identity: "confirmed",
    identityEvidence: [
      {
        sourceId: source.id,
        excerpt: "Ada Lovelace is the research director at Analytical Engines.",
        asOf: null,
      },
    ],
    status: "supported",
    answer: "Research director at Analytical Engines",
    explanation: "The supplied professional source explicitly lists this role.",
    citations: [
      {
        sourceId: source.id,
        excerpt: "Ada Lovelace is the research director at Analytical Engines.",
        asOf: "2026-11-25T00:00:00.000Z",
      },
    ],
  };
  const active = () => ["queued", "running"].includes(execution.status);
  const ports: ResearchPipelinePorts = {
    enabled: () => true,
    store: {
      load: () => Promise.resolve(active() ? structuredClone(execution) : null),
      start: () => {
        execution.status = "running";
        return Promise.resolve(true);
      },
      saveSource: (_key, fetched) => {
        execution.sources.push(fetched);
        return Promise.resolve(active());
      },
      claimDiscovery: () => {
        if (execution.discovery.state !== "pending") return Promise.resolve(false);
        execution.discovery.state = "reserving";
        return Promise.resolve(true);
      },
      markDiscoveryReserved: () => {
        execution.discovery.state = "reserved";
        return Promise.resolve(true);
      },
      resetDiscoveryReservation: () => {
        execution.discovery.state = "pending";
        return Promise.resolve(true);
      },
      claimDiscoverySubmission: () => {
        execution.discovery.state = "started";
        return Promise.resolve(true);
      },
      saveDiscoveredSources: (_key, sources, creditsUsed) => {
        if (execution.discovery.state !== "started") return Promise.resolve(false);
        execution.sources.push(...sources);
        execution.discovery.state = "completed";
        execution.discovery.creditsUsed = creditsUsed;
        execution.discovery.settled = false;
        return Promise.resolve(active());
      },
      markDiscoverySettled: () => {
        execution.discovery.settled = true;
        return Promise.resolve();
      },
      claimFact: (_key, factKey) => {
        const fact = execution.facts.find((entry) => entry.key === factKey)!;
        if (fact.state !== "pending" || !active()) return Promise.resolve(false);
        fact.state = "started";
        return Promise.resolve(true);
      },
      saveFinding: (_key, factKey, finding, usage) => {
        if (!active()) return Promise.resolve(false);
        Object.assign(
          execution.facts.find((fact) => fact.key === factKey)!,
          { state: "completed", finding, usage },
        );
        return Promise.resolve(true);
      },
      saveRejectedFailure: (_key, factKey, failureCode, usage) => {
        Object.assign(
          execution.facts.find((fact) => fact.key === factKey)!,
          {
            state: "rejected",
            finding: null,
            usage,
            settled: false,
            failureCode,
          },
        );
        return Promise.resolve(active());
      },
      markSettled: (_key, factKey) => {
        execution.facts.find((fact) => fact.key === factKey)!.settled = true;
        return Promise.resolve();
      },
      finish: (_key, status, error) => {
        if (active()) {
          execution.status = status;
          terminalErrors.push(error);
        }
        return Promise.resolve();
      },
    },
    sources: {
      retrieve: () => {
        counters.fetch++;
        return Promise.resolve(source);
      },
    },
    extraction: {
      extract: (input) => {
        counters.extraction++;
        return Promise.resolve({
          output:
            input.fact.key === "role"
              ? supported
              : {
                  identity: "confirmed",
                  identityEvidence: supported.identityEvidence,
                  status: "not-found",
                  answer: null,
                  explanation: "No email appears in the supplied source.",
                  citations: [],
                },
          usage: { inputTokens: 100, outputTokens: 50 },
        });
      },
    },
    admission: {
      admit: () => {
        counters.admit++;
        return Promise.resolve();
      },
      settle: () => {
        counters.settle++;
        return Promise.resolve();
      },
    },
  };
  const input: ResearchExtractionInput = {
    operationId: execution.facts[0]!.operationId,
    person: execution.person,
    policy,
    fact: requestedFacts[0]!,
    sources: [source],
  };
  return { execution, source, ports, counters, supported, input, terminalErrors };
}

void describe("targeted research checkpoints", () => {
  void it("answers each fact separately and treats not-found as an honest completed result", async () => {
    const { execution, ports, counters } = fixture();
    await runResearchItem(execution, ports);
    assert.equal(execution.status, "completed");
    assert.deepEqual(
      execution.facts.map((fact) => fact.finding?.status),
      ["supported", "not-found"],
    );
    assert.equal(execution.facts[1]!.finding!.answer, null);
    assert.equal(execution.facts[0]!.finding!.citations[0]!.url, "https://public-source.org/ada");
    assert.deepEqual(counters, { fetch: 1, extraction: 2, admit: 2, settle: 2 });
    await runResearchItem(execution, ports);
    assert.equal(counters.extraction, 2);
  });

  void it("restarts publication/settlement without rerunning committed extraction", async () => {
    const { execution, ports, counters } = fixture();
    const settle = ports.admission.settle.bind(ports.admission);
    let fail = true;
    ports.admission.settle = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error("ledger outage");
      }
      await settle(...args);
    };
    await assert.rejects(runResearchItem(execution, ports), /ledger outage/);
    assert.equal(execution.facts[0]!.state, "completed");
    assert.equal(execution.facts[0]!.settled, false);
    assert.equal(execution.status, "running");
    await runResearchItem(execution, ports);
    assert.equal(execution.status, "completed");
    assert.deepEqual(counters, { fetch: 1, extraction: 2, admit: 2, settle: 2 });
  });

  void it("checkpoints rejected output and usage before settlement, then recovers without extraction replay", async () => {
    const { execution, ports, counters, supported } = fixture();
    ports.extraction.extract = () => {
      counters.extraction++;
      return Promise.resolve({
        output: {
          ...supported,
          citations: [{ sourceId: "untrusted", excerpt: "invented", asOf: null }],
        },
        usage: { inputTokens: 88, outputTokens: 21 },
      });
    };
    const settle = ports.admission.settle.bind(ports.admission);
    let failSettlement = true;
    let settleAttempts = 0;
    ports.admission.settle = async (...args) => {
      settleAttempts++;
      if (failSettlement) {
        failSettlement = false;
        throw new Error("ledger unavailable");
      }
      await settle(...args);
    };

    await assert.rejects(runResearchItem(execution, ports), /ledger unavailable/);
    const rejected = execution.facts[0]!;
    assert.equal(rejected.state, "rejected");
    assert.equal(rejected.failureCode, "unknown_source");
    assert.deepEqual(rejected.usage, { inputTokens: 88, outputTokens: 21 });
    assert.equal(rejected.finding, null);
    assert.equal(rejected.settled, false);
    assert.equal(execution.status, "running");

    await runResearchItem(execution, ports);
    assert.equal(execution.status, "needs-input");
    assert.equal(execution.facts[0]!.settled, true);
    assert.equal(execution.facts[0]!.finding, null);
    assert.equal(counters.extraction, 2);
    assert.equal(settleAttempts, 3);
  });

  void it("settles a known per-fact rejection and continues independent facts", async () => {
    const { execution, ports, counters, supported } = fixture();
    ports.extraction.extract = (input) => {
      counters.extraction++;
      return Promise.resolve({
        output:
          input.fact.key === "role"
            ? { ...supported, citations: [{ ...supported.citations[0], sourceId: "untrusted" }] }
            : {
                ...supported,
                status: "not-found",
                answer: null,
                citations: [],
                explanation: "No email appears in the source.",
              },
        usage: { inputTokens: 30, outputTokens: 10 },
      });
    };

    await runResearchItem(execution, ports);

    assert.equal(execution.status, "partial");
    assert.equal(execution.facts[0]!.state, "rejected");
    assert.equal(execution.facts[0]!.settled, true);
    assert.equal(execution.facts[1]!.state, "completed");
    assert.equal(counters.extraction, 2);
    assert.equal(counters.settle, 2);
  });

  void it("settles rejected output after cancellation without publishing a failure checkpoint", async () => {
    const { execution, ports, counters, supported } = fixture();
    ports.extraction.extract = () =>
      Promise.resolve({
        output: { ...supported, citations: [{ sourceId: "unknown", excerpt: "bad", asOf: null }] },
        usage: { inputTokens: 55, outputTokens: 13 },
      });
    ports.store.saveRejectedFailure = () => {
      execution.status = "cancelled";
      return Promise.resolve(false);
    };

    await runResearchItem(execution, ports);
    assert.equal(execution.status, "cancelled");
    assert.equal(counters.settle, 1);
    assert.equal(execution.facts[0]!.state, "started");
    assert.equal(execution.facts[0]!.finding, null);
  });

  void it("a crash after paid submission never replays an uncertain fact", async () => {
    const { execution, ports, counters } = fixture();
    execution.facts[0]!.state = "started";
    await runResearchItem(execution, ports);
    assert.equal(execution.status, "needs-input");
    assert.equal(counters.extraction, 0);
    assert.equal(counters.admit, 0);
    assert.equal(execution.facts[0]!.state, "started");
    assert.equal(execution.facts[0]!.settled, false);
  });

  void it("stops a rejected admission before the provider", async () => {
    const { execution, ports, counters } = fixture();
    ports.admission.admit = () => Promise.reject(new Error("budget exhausted"));
    await runResearchItem(execution, ports);
    assert.equal(execution.status, "needs-input");
    assert.equal(counters.extraction, 0);
    assert.equal(execution.facts[0]!.state, "started");
  });

  void it("settles an already issued call after disablement and stops before another fact", async () => {
    const { execution, ports, counters } = fixture();
    let enabled = true;
    ports.enabled = () => enabled;
    const extract = ports.extraction.extract.bind(ports.extraction);
    ports.extraction.extract = async (...args) => {
      const result = await extract(...args);
      enabled = false;
      return result;
    };
    await runResearchItem(execution, ports);
    assert.equal(execution.status, "needs-input");
    assert.equal(counters.extraction, 1);
    assert.equal(counters.settle, 1);
    assert.equal(execution.facts[0]!.state, "completed");
    assert.equal(execution.facts[0]!.settled, true);
    assert.equal(execution.facts[1]!.state, "pending");
  });

  void it("cancellation during a call fences publication and subsequent facts", async () => {
    const { execution, ports, counters } = fixture();
    const extract = ports.extraction.extract.bind(ports.extraction);
    ports.extraction.extract = async (...args) => {
      const result = await extract(...args);
      execution.status = "cancelled";
      return result;
    };
    await runResearchItem(execution, ports);
    assert.equal(execution.status, "cancelled");
    assert.equal(counters.extraction, 1);
    assert.equal(counters.settle, 1);
    assert.ok(execution.facts.every((fact) => fact.finding === null));
  });

  void it("missing URLs and disabled inference make no provider calls", async () => {
    const { execution, ports, counters } = fixture();
    execution.request.sourceUrls = [];
    await runResearchItem(execution, ports);
    assert.equal(execution.status, "needs-input");
    assert.deepEqual(counters, { fetch: 0, extraction: 0, admit: 0, settle: 0 });
    execution.status = "queued";
    ports.enabled = () => false;
    await runResearchItem(execution, ports);
    assert.equal(counters.extraction, 0);
    assert.equal(readResearchPolicy({}), null);
    assert.equal(readResearchPolicy({ RESEARCH_ENABLED: "true" }), null);
  });

  void it("does not treat a failed durable source checkpoint as an optional URL failure", async () => {
    const f = fixture();
    const save = f.ports.store.saveSource.bind(f.ports.store);
    f.ports.store.saveSource = () => Promise.reject(new Error("Database unavailable"));
    await assert.rejects(runResearchItem(f.execution, f.ports), /Database unavailable/);
    assert.equal(f.counters.extraction, 0);
    assert.equal(f.execution.status, "running");
    f.ports.store.saveSource = save;
    await runResearchItem(f.execution, f.ports);
    assert.equal(f.execution.status, "completed");
  });

  void it("retrieval retry preserves earlier source checkpoints", async () => {
    const { execution, ports, counters, source } = fixture();
    execution.request.sourceUrls.push("https://second-source.org/ada");
    const retrieve = ports.sources.retrieve.bind(ports.sources);
    ports.sources.retrieve = (url, ...args) =>
      url.includes("second-source")
        ? Promise.reject(new Error("source unavailable"))
        : retrieve(url, ...args);
    await runResearchItem(execution, ports);
    assert.equal(execution.status, "completed");
    assert.equal(execution.sources.length, 1);
    assert.equal(counters.extraction, 2);
    execution.status = "queued";
    execution.generation++;
    ports.sources.retrieve = (url) => {
      counters.fetch++;
      return Promise.resolve({ ...source, id: "source-2", requestedUrl: url, url });
    };
    await runResearchItem(execution, ports);
    assert.equal(counters.fetch, 2);
    assert.equal(execution.status, "completed");
  });
});

void describe("research evidence validation", () => {
  void it("accepts the retained George Hotz biography's literal founder phrase", () => {
    const { input, supported, source } = fixture();
    const biography =
      "George Hotz is a programmer, hacker, and the founder of comma-ai and tiny corp.";
    input.person.displayName = "George Hotz";
    input.person.description = "Programmer and hacker; founder of comma.ai and tiny corp.";
    input.fact.question =
      "Which companies does Lex Fridman's episode biography identify George Hotz as the founder of?";
    source.text = biography;
    source.url = "https://lexfridman.com/george-hotz-3/";
    const evidence = [{ sourceId: source.id, excerpt: biography, asOf: null }];
    const result = validateResearchExtraction(input, {
      ...supported,
      identityEvidence: evidence,
      answer: "comma-ai and tiny corp",
      citations: evidence,
    });
    assert.equal(result.status, "supported");
    assert.equal(result.answer, "comma-ai and tiny corp");
    assert.equal(result.citations[0]!.excerpt, biography);
  });

  void it("resolves only an explicitly pinned verified alias in the new extraction version", () => {
    const { input, supported, source } = fixture();
    input.policy = {
      ...input.policy,
      promptVersion: "research-extract-v2",
    };
    input.person.displayName = "George Hotz";
    input.person.verifiedAliases = ["geohot"];
    source.text = "geohot is a software engineer at Analytical Engines.";
    const evidence = [
      {
        sourceId: source.id,
        excerpt: "geohot is a software engineer at Analytical Engines.",
        asOf: null,
      },
    ];
    const result = validateResearchExtraction(input, {
      ...supported,
      identityEvidence: evidence,
      citations: evidence,
      answer: "software engineer",
    });
    assert.equal(result.status, "supported");
    assert.equal(result.citations[0]?.url, source.url);
  });

  void it("rejects fabricated quotes, unknown sources and unsupported answers", () => {
    const { input, supported } = fixture();
    assert.throws(
      () =>
        validateResearchExtraction(input, {
          ...supported,
          citations: [
            { sourceId: "source-1", excerpt: "Ada's email is ada@example.org", asOf: null },
          ],
        }),
      /nonliteral/,
    );
    assert.throws(
      () =>
        validateResearchExtraction(input, {
          ...supported,
          citations: [{ sourceId: "invented", excerpt: "Ada Lovelace", asOf: null }],
        }),
      /unknown source/,
    );
    assert.throws(
      () =>
        validateResearchExtraction(input, {
          ...supported,
          status: "not-found",
        }),
      /asserted answer/,
    );
    assert.throws(
      () =>
        validateResearchExtraction(input, {
          ...supported,
          answer: "Chief executive at an invented company",
        }),
      /extractive text/,
    );
  });

  void it("requires selected-person identity evidence and two sources for conflicts", () => {
    const { input, supported } = fixture();
    assert.throws(
      () => validateResearchExtraction(input, { ...supported, identityEvidence: [] }),
      /identity/,
    );
    assert.throws(
      () =>
        validateResearchExtraction(input, {
          ...supported,
          status: "conflicting",
          answer: null,
        }),
      /two sources/,
    );
    const ambiguous = validateResearchExtraction(input, {
      ...supported,
      identity: "ambiguous",
      identityEvidence: [],
      status: "ambiguous",
      answer: null,
    });
    assert.equal(ambiguous.answer, null);
    assert.equal(ambiguous.status, "ambiguous");
  });

  void it("does not use retrieval time as proof of freshness", () => {
    const { input, supported } = fixture();
    input.fact.maxAgeDays = 30;
    const result = validateResearchExtraction(input, {
      ...supported,
      citations: supported.citations.map((citation) => ({ ...citation, asOf: null })),
    });
    assert.equal(result.status, "ambiguous");
    assert.equal(result.answer, null);
    assert.throws(
      () =>
        validateResearchExtraction(input, {
          ...supported,
          citations: supported.citations.map((citation) => ({
            ...citation,
            asOf: "2026-11-24T00:00:00.000Z",
          })),
        }),
      /explicit source text/,
    );
  });

  void it("validates selected-person batches and reports partial sibling success", () => {
    const { execution } = fixture();
    assert.throws(() =>
      requestResearchSchema.parse({
        workspaceId: execution.workspaceId,
        requestId: execution.batchId,
        people: [execution.request, execution.request],
      }),
    );
    assert.equal(aggregateResearchStatus(["completed", "failed"]), "partial");
    assert.equal(aggregateResearchStatus(["completed", "needs-input"]), "partial");
    assert.equal(aggregateResearchStatus(["completed", "completed"]), "completed");
  });
});

void describe("bounded research rejection diagnostics", () => {
  const privatePayload = "PRIVATE_PROVIDER_VALUE_DO_NOT_PERSIST";
  const cases: {
    name: string;
    output: (supported: ReturnType<typeof fixture>["supported"]) => unknown;
    reason: string;
  }[] = [
    {
      name: "non-JSON text",
      output: () => privatePayload,
      reason: "schema-invalid:output:invalid_type",
    },
    {
      name: "invalid enum",
      output: (supported) => ({ ...supported, identity: privatePayload }),
      reason: "schema-invalid:identity:invalid_value",
    },
    {
      name: "unknown output key",
      output: (supported) => ({ ...supported, [privatePayload]: privatePayload }),
      reason: "schema-invalid:output:unrecognized_keys",
    },
    {
      name: "unknown nested key",
      output: (supported) => ({
        ...supported,
        citations: [{ ...supported.citations[0], [privatePayload]: privatePayload }],
      }),
      reason: "schema-invalid:citations.[]:unrecognized_keys",
    },
    {
      name: "invalid citation date shape",
      output: (supported) => ({
        ...supported,
        citations: [{ ...supported.citations[0], asOf: privatePayload }],
      }),
      reason: "schema-invalid:citations.[].asOf:invalid_format",
    },
    {
      name: "unknown source ID",
      output: (supported) => ({
        ...supported,
        citations: [{ ...supported.citations[0], sourceId: privatePayload }],
      }),
      reason: "unknown-source:citations",
    },
    {
      name: "nonliteral identity excerpt",
      output: (supported) => ({
        ...supported,
        identityEvidence: [{ ...supported.identityEvidence[0], excerpt: privatePayload }],
      }),
      reason: "nonliteral-excerpt:identityEvidence",
    },
    {
      name: "nonliteral citation excerpt",
      output: (supported) => ({
        ...supported,
        citations: [{ ...supported.citations[0], excerpt: privatePayload }],
      }),
      reason: "nonliteral-excerpt:citations",
    },
    {
      name: "future fact date",
      output: (supported) => ({
        ...supported,
        citations: [{ ...supported.citations[0], asOf: "2027-01-01T00:00:00.000Z" }],
      }),
      reason: "fact-date-after-retrieval:citations",
    },
    {
      name: "unestablished fact date",
      output: (supported) => ({
        ...supported,
        citations: [{ ...supported.citations[0], asOf: "2026-11-24T00:00:00.000Z" }],
      }),
      reason: "fact-date-not-in-source:citations",
    },
    {
      name: "identity excerpt without the selected full name",
      output: (supported) => ({
        ...supported,
        identityEvidence: [{ sourceId: "source-1", excerpt: "Analytical Engines", asOf: null }],
      }),
      reason: "identity-name-missing:identityEvidence",
    },
    {
      name: "supported answer with unconfirmed identity",
      output: (supported) => ({ ...supported, identity: "unconfirmed", identityEvidence: [] }),
      reason: "supported-evidence-missing:output",
    },
    {
      name: "non-extractive answer",
      output: (supported) => ({ ...supported, answer: privatePayload }),
      reason: "answer-not-extractive:output",
    },
    {
      name: "asserted answer for an unresolved fact",
      output: (supported) => ({ ...supported, status: "not-found" }),
      reason: "unresolved-answer:output",
    },
    {
      name: "conflict without two distinct sources",
      output: (supported) => ({ ...supported, status: "conflicting", answer: null }),
      reason: "conflict-sources-missing:output",
    },
  ];

  for (const scenario of cases) {
    void it(`persists only a bounded reason for ${scenario.name} and never replays inference`, async () => {
      const { execution, ports, counters, supported, terminalErrors } = fixture();
      const operationId = execution.facts[0]!.operationId;
      const settled: string[] = [];
      const settle = ports.admission.settle.bind(ports.admission);
      ports.admission.settle = async (id, usage) => {
        settled.push(id);
        await settle(id, usage);
      };
      ports.extraction.extract = () => {
        counters.extraction++;
        return Promise.resolve({
          output: scenario.output(supported),
          usage: { inputTokens: 100, outputTokens: 50 },
        });
      };
      await runResearchItem(execution, ports);
      assert.equal(execution.status, "needs-input");
      const failureCode = scenario.reason.startsWith("schema-invalid:")
        ? "invalid_output_schema"
        : scenario.reason.split(":")[0]!.replaceAll("-", "_");
      assert.deepEqual(terminalErrors, [
        `The extraction failed validation (${failureCode}). No finding was published.`,
      ]);
      assert.ok(!terminalErrors[0]!.includes(privatePayload));
      assert.ok(terminalErrors[0]!.length < 256);
      assert.deepEqual(settled, [operationId, execution.facts[1]!.operationId]);
      assert.equal(execution.facts[0]!.state, "rejected");
      assert.equal(execution.facts[0]!.failureCode, failureCode);
      assert.deepEqual(execution.facts[0]!.usage, { inputTokens: 100, outputTokens: 50 });
      assert.equal(execution.facts[0]!.finding, null);
      await runResearchItem(execution, ports);
      execution.status = "queued";
      execution.generation++;
      await runResearchItem(execution, ports);
      assert.equal(execution.status, "needs-input");
      assert.equal(execution.facts[0]!.operationId, operationId);
      assert.deepEqual(counters, { fetch: 1, extraction: 2, admit: 2, settle: 2 });
    });
  }

  void it("retains the hold when invalid output has no complete usage receipt", async () => {
    const { execution, ports, counters } = fixture();
    ports.extraction.extract = () => {
      counters.extraction++;
      return Promise.resolve({ output: privatePayload, usage: null });
    };
    await runResearchItem(execution, ports);
    assert.equal(execution.status, "needs-input");
    assert.equal(counters.settle, 0);
    assert.equal(execution.facts[0]!.state, "rejected");
    assert.equal(execution.facts[0]!.failureCode, "invalid_output_schema");
    assert.equal(execution.facts[0]!.usage, null);
  });
});
