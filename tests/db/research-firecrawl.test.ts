import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
  createFirecrawlResearchDiscovery,
  type FirecrawlFetch,
  type ResearchExecution,
  type ResearchPipelinePorts,
  runResearchItem,
} from "../../src/ai/research";
import { readResearchPolicy, researchPolicySchema } from "../../src/config/research";
import type { ResearchSource } from "../../src/ai/research";
import { WorkspaceError } from "../../src/contracts/workspace";

const policy = researchPolicySchema.parse({
  version: "research-v1",
  promptVersion: "research-extract-v2",
  provider: "workers-ai",
  sourceProvider: "firecrawl",
  model: "fixture",
  budgetId: randomUUID(),
  rateVersionId: randomUUID(),
  serviceBudgetId: randomUUID(),
  searchUnitBound: 7,
  maxSourceBytes: 1000,
  maxDiscoveryBytes: 20_000,
  maxDiscoveredSources: 2,
});

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

const page = {
  url: "https://example.org/profile",
  title: "Profile",
  markdown: "Ada Lovelace (known as Ada) is a research director.",
};

void describe("bounded Firecrawl research adapter", () => {
  void it("does not choose discovery without its credential, budget, and conservative bound", () => {
    const base = {
      RESEARCH_ENABLED: "true",
      RESEARCH_MODEL: "fixture",
      RESEARCH_BUDGET_ID: randomUUID(),
      RESEARCH_RATE_VERSION_ID: randomUUID(),
      RESEARCH_DISCOVERY_ENABLED: "true",
      FIRECRAWL_API_KEY: "test-secret",
    };
    assert.equal(readResearchPolicy(base)?.sourceProvider, "direct");
    assert.equal(
      readResearchPolicy({
        ...base,
        RESEARCH_SERVICE_BUDGET_ID: randomUUID(),
        RESEARCH_SEARCH_UNIT_BOUND: "6",
      })?.sourceProvider,
      "direct",
    );
    const configured = readResearchPolicy({
      ...base,
      RESEARCH_SERVICE_BUDGET_ID: randomUUID(),
      RESEARCH_SEARCH_UNIT_BOUND: "7",
    });
    assert.equal(configured?.sourceProvider, "firecrawl");
    assert.equal(configured?.searchUnitBound, 7);
  });

  void it("requests full-page markdown once and returns bounded source artifacts, not snippets", async () => {
    let calls = 0;
    let requestBody: Record<string, unknown> | undefined;
    const fetcher: FirecrawlFetch = async (_input, init) => {
      calls++;
      requestBody = JSON.parse(await new Request(_input, init).text()) as Record<string, unknown>;
      return response({
        success: true,
        data: {
          web: [
            page,
            { ...page, url: "https://example.org/profile#copy" },
            { url: "https://example.org/snippet", description: "snippet-only result" },
          ],
        },
        creditsUsed: 2,
      });
    };
    const provider = createFirecrawlResearchDiscovery({
      apiKey: "test-secret",
      canExecute: () => true,
      fetcher,
    });
    const discovery = await provider.discover(
      {
        person: {
          id: randomUUID(),
          revision: 1,
          displayName: "Ada Lovelace",
          description: "",
          verifiedAliases: ["Ada"],
          professional: { revision: 0, organization: "Analytical Engines", role: "", links: [] },
        },
        facts: [{ key: "role", question: "What is the role?" }],
      },
      policy,
      AbortSignal.timeout(1000),
    );
    assert.equal(calls, 1);
    assert.equal(requestBody?.limit, 5);
    assert.deepEqual((requestBody?.scrapeOptions as { formats: string[] }).formats, ["markdown"]);
    assert.equal((requestBody?.query as string).includes("Ada"), true);
    assert.equal(discovery.sources.length, 1);
    assert.equal(discovery.sources[0]?.text, page.markdown);
    assert.match(discovery.sources[0]?.digest ?? "", /^[a-f0-9]{64}$/);
    assert.equal(discovery.sources[0]?.url, "https://example.org/profile");
    assert.equal(discovery.creditsUsed, 2);
  });

  void it("skips an oversized early page without hiding a later usable candidate", async () => {
    const oversizedPage = {
      url: "https://example.org/large",
      markdown: "x".repeat(1001),
    };
    const laterPage = {
      url: "https://example.org/later",
      markdown: "Later page with useful evidence.",
    };
    const provider = createFirecrawlResearchDiscovery({
      apiKey: "test-secret",
      canExecute: () => true,
      fetcher: () =>
        Promise.resolve(response({ success: true, data: { web: [oversizedPage, laterPage] } })),
    });
    const discovery = await provider.discover(
      {
        person: {
          id: randomUUID(),
          revision: 1,
          displayName: "Ada Lovelace",
          description: "",
          professional: { revision: 0, organization: "", role: "", links: [] },
        },
        facts: [{ key: "role", question: "What is the role?" }],
      },
      policy,
      AbortSignal.timeout(1000),
    );

    assert.deepEqual(
      discovery.sources.map((source) => source.url),
      ["https://example.org/later"],
    );
  });

  void it("rejects malformed and oversized payloads without leaking credentials", async () => {
    const malformed = createFirecrawlResearchDiscovery({
      apiKey: "secret-do-not-leak",
      canExecute: () => true,
      fetcher: () => Promise.resolve(new Response("not-json")),
    });
    const input = {
      person: {
        id: randomUUID(),
        revision: 1,
        displayName: "Ada",
        description: "",
        professional: { revision: 0, organization: "", role: "", links: [] },
      },
      facts: [{ key: "role", question: "What is the role?" }],
    };
    await assert.rejects(malformed.discover(input, policy, AbortSignal.timeout(1000)), (error) => {
      assert.equal((error as Error).message, "Firecrawl discovery returned malformed JSON.");
      assert.equal((error as Error).message.includes("secret-do-not-leak"), false);
      return true;
    });

    const oversized = createFirecrawlResearchDiscovery({
      apiKey: "secret-do-not-leak",
      canExecute: () => true,
      fetcher: () => Promise.resolve(new Response("x".repeat(20_001))),
    });
    await assert.rejects(
      oversized.discover(input, policy, AbortSignal.timeout(1000)),
      /byte limit/,
    );
  });

  void it("propagates provider timeouts without retrying", async () => {
    let calls = 0;
    const provider = createFirecrawlResearchDiscovery({
      apiKey: "test-secret",
      canExecute: () => true,
      fetcher: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          calls++;
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    const input = {
      person: {
        id: randomUUID(),
        revision: 1,
        displayName: "Ada",
        description: "",
        professional: { revision: 0, organization: "", role: "", links: [] },
      },
      facts: [{ key: "role", question: "What is the role?" }],
    };
    await assert.rejects(provider.discover(input, policy, AbortSignal.timeout(5)));
    assert.equal(calls, 1);
  });

  void it("rechecks the discovery flag at the outbound HTTP boundary", async () => {
    let allowed = true;
    let calls = 0;
    const provider = createFirecrawlResearchDiscovery({
      apiKey: "test-secret",
      canExecute: () => allowed,
      fetcher: () => {
        calls++;
        return Promise.resolve(response({ success: true, data: { web: [] } }));
      },
    });
    const input = {
      person: {
        id: randomUUID(),
        revision: 1,
        displayName: "Ada",
        description: "",
        professional: { revision: 0, organization: "", role: "", links: [] },
      },
      facts: [{ key: "role", question: "What is the role?" }],
    };
    allowed = false;
    await assert.rejects(provider.discover(input, policy, AbortSignal.timeout(1000)), /disabled/);
    assert.equal(calls, 0);
  });
});

void describe("durable source discovery fence", () => {
  void it("recovers a lost reservation acknowledgement and refuses an uncertain search replay", async () => {
    const personId = randomUUID();
    const source: ResearchSource = {
      id: "source-one",
      requestedUrl: "https://example.org/profile",
      url: "https://example.org/profile",
      text: "Ada Lovelace is a research director.",
      retrievedAt: new Date().toISOString(),
      digest: "fixture",
    };
    const execution: ResearchExecution = {
      workspaceId: randomUUID(),
      batchId: randomUUID(),
      personId,
      actorId: randomUUID(),
      generation: 1,
      request: {
        personId,
        expectedProfileRevision: 1,
        requestedFacts: [{ key: "role", question: "What is the role?" }],
        sourceUrls: [],
      },
      person: {
        id: personId,
        revision: 1,
        displayName: "Ada Lovelace",
        description: "",
        professional: { revision: 0, organization: "", role: "", links: [] },
      },
      policy,
      status: "queued",
      sources: [],
      facts: [
        {
          key: "role",
          state: "pending",
          operationId: randomUUID(),
          finding: null,
          usage: null,
          settled: false,
        },
      ],
      discovery: {
        state: "pending",
        operationId: randomUUID(),
        creditsUsed: null,
        settled: false,
      },
      deadline: new Date(Date.now() + 60_000).toISOString(),
    };
    let searches = 0;
    let reserveAttempts = 0;
    const serviceStages: string[] = [];
    const active = () => ["queued", "running"].includes(execution.status);
    const ports: ResearchPipelinePorts = {
      enabled: () => true,
      store: {
        load: () => Promise.resolve(active() ? structuredClone(execution) : null),
        start: () => {
          execution.status = "running";
          return Promise.resolve(true);
        },
        saveSource: () => Promise.resolve(true),
        claimDiscovery: () => {
          if (execution.discovery.state !== "pending") {
            return Promise.resolve(false);
          }
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
        saveDiscoveredSources: (_key, found, creditsUsed) => {
          execution.sources.push(...found);
          execution.discovery.state = "completed";
          execution.discovery.creditsUsed = creditsUsed;
          execution.discovery.settled = false;
          return Promise.resolve(true);
        },
        markDiscoverySettled: () => {
          execution.discovery.settled = true;
          return Promise.resolve();
        },
        claimFact: () => Promise.resolve(false),
        saveFinding: () => Promise.resolve(false),
        saveRejectedFailure: () => Promise.resolve(false),
        markSettled: () => Promise.resolve(),
        finish: (_key, status) => {
          execution.status = status;
          return Promise.resolve();
        },
      },
      sources: { retrieve: () => Promise.resolve(source) },
      discovery: {
        discover: () => {
          searches++;
          serviceStages.push("search");
          return Promise.reject(new Error("request timed out"));
        },
      },
      extraction: { extract: () => Promise.resolve({ output: {}, usage: null }) },
      admission: { admit: () => Promise.resolve(), settle: () => Promise.resolve() },
      serviceBudget: {
        reserve: () => {
          serviceStages.push("reserve");
          reserveAttempts++;
          if (reserveAttempts === 1) {
            return Promise.reject(
              new WorkspaceError("service_unavailable", "allowance unavailable"),
            );
          }

          if (reserveAttempts === 2) {
            return Promise.reject(new Error("reservation acknowledgement lost"));
          }

          if (reserveAttempts === 3) {
            return Promise.resolve({ status: "existing-held" });
          }
          return Promise.resolve({ status: "created" });
        },
        settle: () => {
          serviceStages.push("settle");
          return Promise.resolve();
        },
      },
    };

    const key = {
      workspaceId: execution.workspaceId,
      batchId: execution.batchId,
      personId,
      generation: 1,
    };
    await runResearchItem(key, ports);
    assert.equal(searches, 0);
    assert.equal(execution.discovery.state, "pending");
    assert.equal(execution.status, "needs-input");

    execution.status = "queued";
    await assert.rejects(runResearchItem(key, ports), /reservation acknowledgement lost/);
    assert.equal(searches, 0);
    assert.equal(execution.discovery.state, "pending");
    assert.equal(execution.status, "running");

    await runResearchItem(key, ports);
    assert.equal(searches, 1);
    assert.deepEqual(serviceStages, ["reserve", "reserve", "reserve", "search"]);
    assert.equal(execution.discovery.state, "started");
    assert.equal(execution.status, "needs-input");

    execution.status = "queued";
    await runResearchItem(key, ports);
    assert.equal(searches, 1);
    assert.equal(execution.status, "needs-input");
  });

  void it("checkpoints known usage before settlement and recovers without replaying search", async () => {
    const personId = randomUUID();
    const discovered: ResearchSource = {
      id: "known-page",
      requestedUrl: "https://example.org/known",
      url: "https://example.org/known",
      text: "Known full page.",
      retrievedAt: new Date().toISOString(),
      digest: "known",
    };
    const execution: ResearchExecution = {
      workspaceId: randomUUID(),
      batchId: randomUUID(),
      personId,
      actorId: randomUUID(),
      generation: 1,
      request: {
        personId,
        expectedProfileRevision: 1,
        requestedFacts: [{ key: "role", question: "What is the role?" }],
        sourceUrls: [],
      },
      person: {
        id: personId,
        revision: 1,
        displayName: "Ada Lovelace",
        description: "",
        professional: { revision: 0, organization: "", role: "", links: [] },
      },
      policy,
      status: "queued",
      sources: [],
      facts: [
        {
          key: "role",
          state: "pending",
          operationId: randomUUID(),
          finding: null,
          usage: null,
          settled: false,
        },
      ],
      discovery: {
        state: "pending",
        operationId: randomUUID(),
        creditsUsed: null,
        settled: false,
      },
      deadline: new Date(Date.now() + 60_000).toISOString(),
    };
    let searches = 0;
    let settlementAttempts = 0;
    const active = () => ["queued", "running"].includes(execution.status);
    const ports: ResearchPipelinePorts = {
      enabled: () => true,
      store: {
        load: () => Promise.resolve(active() ? structuredClone(execution) : null),
        start: () => {
          execution.status = "running";
          return Promise.resolve(true);
        },
        saveSource: () => Promise.resolve(true),
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
          if (execution.discovery.state !== "reserved") return Promise.resolve(false);
          execution.discovery.state = "started";
          return Promise.resolve(true);
        },
        saveDiscoveredSources: (_key, found, creditsUsed) => {
          execution.sources.push(...found);
          execution.discovery = {
            ...execution.discovery,
            state: "completed",
            creditsUsed,
            settled: false,
          };
          return Promise.resolve(true);
        },
        markDiscoverySettled: () => {
          execution.discovery.settled = true;
          return Promise.resolve();
        },
        claimFact: () => Promise.resolve(false),
        saveFinding: () => Promise.resolve(false),
        saveRejectedFailure: () => Promise.resolve(false),
        markSettled: () => Promise.resolve(),
        finish: (_key, status) => {
          execution.status = status;
          return Promise.resolve();
        },
      },
      sources: { retrieve: () => Promise.resolve(discovered) },
      discovery: {
        discover: () => {
          searches++;
          return Promise.resolve({ sources: [discovered], creditsUsed: 4 });
        },
      },
      extraction: { extract: () => Promise.resolve({ output: {}, usage: null }) },
      admission: { admit: () => Promise.resolve(), settle: () => Promise.resolve() },
      serviceBudget: {
        reserve: () => Promise.resolve({ status: "created" }),
        settle: () => {
          settlementAttempts++;
          if (settlementAttempts === 1) return Promise.reject(new Error("database unavailable"));
          return Promise.resolve();
        },
      },
    };
    const key = {
      workspaceId: execution.workspaceId,
      batchId: execution.batchId,
      personId,
      generation: 1,
    };

    await assert.rejects(runResearchItem(key, ports), /database unavailable/);
    assert.equal(searches, 1);
    assert.deepEqual(execution.sources, [discovered]);
    assert.equal(execution.discovery.state, "completed");
    assert.equal(execution.discovery.creditsUsed, 4);
    assert.equal(execution.discovery.settled, false);

    execution.status = "queued";
    await runResearchItem(key, ports);
    assert.equal(searches, 1);
    assert.equal(settlementAttempts, 2);
    assert.equal(execution.discovery.settled, true);
  });
});
