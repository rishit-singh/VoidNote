import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { and, eq } from "drizzle-orm";

import { pinResearchRunPolicy } from "../../src/config/research-runs";
import { runResearchRun, type ResearchRunEnvironment } from "../../src/ai/research/runs/runtime";
import { createResearchRunsRepository } from "../../src/db/research/runs";
import { inferenceBudgets, inferenceRates, inferenceReceipts } from "../../src/db/inference-schema";
import { applicationEvents } from "../../src/db/activity-schema";
import { serviceBudgetOperations, serviceBudgets } from "../../src/db/service-budget-schema";
import { db, setupDatabase, sql, teardownDatabase, workspace } from "./fixture";

const model = "test/research-run-runtime";
const sourceUrl = "https://example.org/runtime-evidence";
const sourceText = "The organization confirmed that the public program launched in November 2026.";
const excerpt = "the public program launched in November 2026.";
const excerptStart = sourceText.indexOf(excerpt);
const retrievedAt = new Date().toISOString();

function makePolicy(discovery = false, maxSources = 2) {
  return pinResearchRunPolicy({
    version: "research-v1",
    promptVersion: "research-extract-v2",
    provider: "workers-ai",
    sourceProvider: discovery ? "firecrawl" : "direct",
    ...(discovery ? { serviceBudgetId: randomUUID(), searchUnitBound: 10 } : {}),
    model,
    budgetId: randomUUID(),
    rateVersionId: randomUUID(),
    maxOutputTokens: 1024,
    maxInputTokens: 16_000,
    contextWindowTokens: 32_000,
    maxSourceBytes: 16_000,
    maxDiscoveryBytes: 32_000,
    maxSources,
    maxEvidenceBytes: 8_000,
  });
}

type ProviderResponse = {
  response: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

type RuntimeFixtureOptions = {
  missingUsage?: boolean;
  waitForModel?: boolean;
  invalidResponse?: boolean;
  discoverSources?: boolean;
  question?: string;
  maxSources?: number;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function modelResponse(sourceId: string): ProviderResponse {
  return {
    response: JSON.stringify({
      outcome: "supported",
      statement: "The public program launched in November 2026.",
      classification: "direct-evidence",
      explanation: "The saved source directly states the launch month.",
      citations: [
        {
          sourceId,
          url: sourceUrl,
          excerpt,
          startOffset: excerptStart,
          endOffset: excerptStart + excerpt.length,
          retrievedAt,
        },
      ],
    }),
    usage: { prompt_tokens: 23, completion_tokens: 11 },
  };
}

async function fixture(options: RuntimeFixtureOptions = {}) {
  const scope = await workspace();
  const policy = makePolicy(options.discoverSources, options.maxSources);
  const rateVersionId = policy.rateVersionId;
  const budgetId = policy.budgetId;
  await db.insert(inferenceRates).values({
    id: rateVersionId,
    provider: "workers-ai",
    model,
    currency: "USD",
    inputMicroUsdPerMillionTokens: 1_000_000,
    outputMicroUsdPerMillionTokens: 1_000_000,
  });
  await db.insert(inferenceBudgets).values({
    workspaceId: scope.workspaceId,
    id: budgetId,
    rateVersionId,
    limitMicroUsd: 1_000_000,
    approvedAt: new Date(),
  });
  if (options.discoverSources && policy.serviceBudgetId) {
    await db.insert(serviceBudgets).values({
      workspaceId: scope.workspaceId,
      provider: "firecrawl",
      id: policy.serviceBudgetId,
      limitUnits: 100,
      approvedAt: new Date(),
    });
  }

  const repository = createResearchRunsRepository(db);
  const request = {
    workspaceId: scope.workspaceId,
    commandId: randomUUID(),
    question: options.question ?? "When did the public program launch?",
    subquestions: [],
    sourceUrls: [sourceUrl],
    discoverSources: options.discoverSources ?? false,
  };
  const run = await repository.request(scope.principal, request, policy);
  const key = { workspaceId: scope.workspaceId, runId: run.id };
  assert.equal(await repository.claim(key), true);

  const sourceId = randomUUID();
  assert.equal(
    await repository.saveSource(key, {
      id: sourceId,
      requestedUrl: sourceUrl,
      url: sourceUrl,
      digest: createHash("sha256").update(sourceText).digest("hex"),
      retrievedAt,
      text: sourceText,
    }),
    true,
  );

  const calls = { count: 0 };
  const started = deferred<void>();
  const gate = deferred<ProviderResponse>();
  const answer = modelResponse(sourceId);
  const ai = {
    run: async () => {
      calls.count += 1;
      started.resolve();
      const response = options.waitForModel ? await gate.promise : structuredClone(answer);
      if (options.invalidResponse) {
        return {
          response: null,
          usage: response.usage,
        } as unknown as ProviderResponse;
      }
      if (options.missingUsage) {
        return { response: response.response };
      }
      return response;
    },
  } as unknown as Ai;
  const env: ResearchRunEnvironment = {
    HYPERDRIVE: {
      connectionString: process.env.TEST_DATABASE_URL!,
    } as unknown as NonNullable<ResearchRunEnvironment["HYPERDRIVE"]>,
    AI: ai,
    RESEARCH_ENABLED: "true",
  };

  return {
    ...scope,
    policy,
    env,
    key,
    run,
    sourceId,
    repository,
    calls,
    started: started.promise,
    releaseModel: gate.resolve,
  };
}

async function inferenceReceipt(workspaceId: string, requestId: string) {
  const [receipt] = await db
    .select()
    .from(inferenceReceipts)
    .where(
      and(
        eq(inferenceReceipts.workspaceId, workspaceId),
        eq(inferenceReceipts.requestId, requestId),
      ),
    );
  assert.ok(receipt);
  return receipt;
}

before(setupDatabase);
let originalFetch: typeof globalThis.fetch;
let networkAttempts = 0;
before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    networkAttempts += 1;
    return Promise.reject(new Error("Unexpected network access in research-run runtime test."));
  };
});
after(async () => {
  globalThis.fetch = originalFetch;
  await teardownDatabase();
});

void describe("research-run runtime with isolated database and local AI binding", () => {
  void it("rehydrates a saved source without network access and settles one published result", async () => {
    const f = await fixture();
    networkAttempts = 0;
    const result = await runResearchRun(f.env, f.key, new AbortController().signal);
    assert.equal(result.status, "completed");
    assert.equal(f.calls.count, 1);
    assert.equal(networkAttempts, 0);

    const stored = await f.repository.get(f.principal, f.workspaceId, f.run.id);
    assert.equal(stored.status, "completed");
    assert.equal(stored.findings.length, 1);
    assert.equal(stored.findings[0]?.outcome, "supported");
    assert.equal(stored.findings[0]?.citations[0]?.sourceId, f.sourceId);

    const work = await f.repository.loadWork(f.key);
    assert.ok(work);
    const receipt = await inferenceReceipt(f.workspaceId, work.questions[0]!.operationId);
    assert.ok(receipt.settledAt);
    assert.equal(receipt.inputTokens, 23);
    assert.equal(receipt.outputTokens, 11);

    const events = await db
      .select()
      .from(applicationEvents)
      .where(
        and(eq(applicationEvents.workspaceId, f.workspaceId), eq(applicationEvents.id, f.run.id)),
      );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "research.completed");

    const replay = await runResearchRun(f.env, f.key, new AbortController().signal);
    assert.equal(replay.status, "completed");
    assert.equal(f.calls.count, 1);
    assert.equal(networkAttempts, 0);
  });

  void it("reuses a completed person-free source for a later run with the same supplied URL", async () => {
    const first = await fixture();
    networkAttempts = 0;
    const firstResult = await runResearchRun(first.env, first.key, new AbortController().signal);
    assert.equal(firstResult.status, "completed");
    assert.equal(first.calls.count, 1);
    assert.equal(networkAttempts, 0);

    const secondRequest = {
      workspaceId: first.workspaceId,
      commandId: randomUUID(),
      question: "What month was the organization's public program launched?",
      subquestions: [],
      sourceUrls: [sourceUrl],
      discoverSources: false,
    };
    const secondRun = await first.repository.request(first.principal, secondRequest, first.policy);
    const secondKey = { workspaceId: first.workspaceId, runId: secondRun.id };
    assert.equal(await first.repository.claim(secondKey), true);

    networkAttempts = 0;
    const secondResult = await runResearchRun(first.env, secondKey, new AbortController().signal);

    assert.equal(secondResult.status, "completed");
    assert.equal(first.calls.count, 2);
    assert.equal(networkAttempts, 0);
    const secondWork = await first.repository.loadWork(secondKey);
    assert.ok(secondWork);
    assert.equal(secondWork.sources.length, 1);
    assert.equal(secondWork.sources[0]?.disposition, "reused");
    assert.equal(secondWork.sources[0]?.originSourceId, first.sourceId);
    const secondSaved = await first.repository.get(
      first.principal,
      first.workspaceId,
      secondRun.id,
    );
    assert.equal(secondSaved.findings[0]?.citations[0]?.sourceId, first.sourceId);
  });

  void it("does not pay for discovery when durable sources already fill the pinned capacity", async () => {
    const f = await fixture({ discoverSources: true, maxSources: 1 });
    f.env.RESEARCH_DISCOVERY_ENABLED = "true";
    f.env.FIRECRAWL_API_KEY = "local-test-only";
    networkAttempts = 0;
    const result = await runResearchRun(f.env, f.key, new AbortController().signal);
    assert.equal(result.status, "completed");
    assert.equal(networkAttempts, 0);
    assert.equal(f.calls.count, 1);
    const work = await f.repository.loadWork(f.key);
    assert.ok(work?.discoveries.every((entry) => entry.state === "pending"));
  });

  void it("does not let common words in unrelated saved evidence suppress needed discovery", async () => {
    const f = await fixture({ discoverSources: true, maxSources: 1 });
    f.env.RESEARCH_DISCOVERY_ENABLED = "true";
    f.env.FIRECRAWL_API_KEY = "local-test-only";
    await runResearchRun(f.env, f.key, new AbortController().signal);
    const next = await f.repository.request(
      f.principal,
      {
        workspaceId: f.workspaceId,
        commandId: randomUUID(),
        question: "What was the organization's revenue?",
        subquestions: [],
        sourceUrls: [],
        discoverSources: true,
      },
      f.policy,
    );
    const previousFetch = globalThis.fetch;
    let searches = 0;
    globalThis.fetch = (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      assert.equal(new URL(url).host, "api.firecrawl.dev");
      searches += 1;
      return Promise.resolve(Response.json({ success: true, data: { web: [] }, creditsUsed: 0 }));
    };
    try {
      const result = await runResearchRun(
        f.env,
        { workspaceId: f.workspaceId, runId: next.id },
        new AbortController().signal,
      );
      assert.equal(result.status, "completed");
      assert.equal(result.quality, "insufficient-evidence");
      assert.ok(searches > 0);
      assert.equal(f.calls.count, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  void it("recovers completed secondary candidates without repeating discovery", async () => {
    const f = await fixture({
      discoverSources: true,
      question: "What is the institution civic initiative inauguration timestamp?",
    });
    const initial = await f.repository.loadWork(f.key);
    assert.ok(initial);
    assert.equal(initial.discoveries.length, 2);

    const primaryCandidate = {
      url: sourceUrl,
      title: "Public program launch",
      snippet: "The public program launched in November.",
      publishedAt: null,
    };
    const secondaryCandidate = {
      url: "https://secondary.example.org/evidence",
      title: "Independent secondary evidence",
      snippet: "A separate source snapshot for retry recovery.",
      publishedAt: null,
    };
    for (const discovery of initial.discoveries) {
      const claim = await f.repository.claimDiscovery(
        f.key,
        discovery.ordinal,
        `saved query ${discovery.ordinal}`,
      );
      assert.ok(claim);
      assert.equal(
        await f.repository.markDiscoveryCompleted(f.key, discovery.ordinal, null, [
          discovery.ordinal === 0 ? primaryCandidate : secondaryCandidate,
        ]),
        true,
      );
    }

    f.env.FIRECRAWL_API_KEY = "local-test-only";
    f.env.RESEARCH_DISCOVERY_ENABLED = "true";
    const previousFetch = globalThis.fetch;
    const fetchUrls: string[] = [];
    globalThis.fetch = (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetchUrls.push(new URL(requestUrl).href);
      assert.equal(
        new URL(requestUrl).href,
        "https://cloudflare-dns.com/dns-query?name=secondary.example.org&type=A",
        "recovery must not repeat Firecrawl search or contact another host",
      );
      return Promise.resolve(new Response("local DNS failure", { status: 503 }));
    };

    let result: Awaited<ReturnType<typeof runResearchRun>>;
    try {
      result = await runResearchRun(f.env, f.key, new AbortController().signal);
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.equal(result.status, "completed");
    assert.equal(f.calls.count, 1);
    assert.deepEqual(fetchUrls, [
      "https://cloudflare-dns.com/dns-query?name=secondary.example.org&type=A",
    ]);
    const recovered = await f.repository.loadWork(f.key);
    assert.ok(recovered);
    assert.deepEqual(
      recovered.discoveries.map((entry) => entry.candidates),
      [[primaryCandidate], [secondaryCandidate]],
    );
  });

  void it("settles known discovery usage when candidate checkpoint retries fail", async () => {
    const f = await fixture({ discoverSources: true });
    const initial = await f.repository.loadWork(f.key);
    assert.ok(initial);
    const primary = initial.discoveries.find((entry) => entry.ordinal === 0);
    assert.ok(primary);

    const previousFetch = globalThis.fetch;
    let searchCalls = 0;
    globalThis.fetch = (input) => {
      searchCalls += 1;
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      assert.equal(new URL(requestUrl).href, "https://api.firecrawl.dev/v2/search");
      return Promise.resolve(
        Response.json({
          success: true,
          data: {
            web: [
              {
                url: sourceUrl,
                title: "Public program launch",
                description: "The public program launched in November.",
              },
            ],
          },
          creditsUsed: 3,
        }),
      );
    };

    const trigger = `test_research_discovery_checkpoint_${randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(`create function public.${trigger}() returns trigger
      language plpgsql as $$
      begin
        if NEW.workspace_id = '${f.workspaceId}'::uuid
          and NEW.run_id = '${f.run.id}'::uuid
          and NEW.ordinal = 0
          and NEW.state = 'completed' then
          raise exception 'injected discovery checkpoint failure';
        end if;
        return NEW;
      end $$`);
    await sql.unsafe(
      `create trigger ${trigger} before update on public.research_run_discoveries
       for each row execute function public.${trigger}()`,
    );

    try {
      f.env.FIRECRAWL_API_KEY = "local-test-only";
      f.env.RESEARCH_DISCOVERY_ENABLED = "true";
      await assert.rejects(
        runResearchRun(f.env, f.key, new AbortController().signal),
        /durable checkpoint failed/i,
      );
    } finally {
      await sql.unsafe(`drop trigger if exists ${trigger} on public.research_run_discoveries`);
      await sql.unsafe(`drop function if exists public.${trigger}()`);
      globalThis.fetch = previousFetch;
    }

    assert.equal(searchCalls, 1);
    assert.equal(f.calls.count, 0);
    const [operation] = await db
      .select()
      .from(serviceBudgetOperations)
      .where(
        and(
          eq(serviceBudgetOperations.workspaceId, f.workspaceId),
          eq(serviceBudgetOperations.provider, "firecrawl"),
          eq(serviceBudgetOperations.operationId, primary.operationId),
        ),
      );
    assert.ok(operation);
    assert.equal(operation.actualUnits, 3);
    assert.ok(operation.settledAt);

    const [budget] = await db
      .select()
      .from(serviceBudgets)
      .where(
        and(
          eq(serviceBudgets.workspaceId, f.workspaceId),
          eq(serviceBudgets.provider, "firecrawl"),
          eq(serviceBudgets.id, f.policy.serviceBudgetId!),
        ),
      );
    assert.ok(budget);
    assert.equal(budget.reservedUnits, 0);
    assert.equal(budget.settledUnits, 3);
  });

  void it("recovers a transient final-publication failure from saved inference without replay", async () => {
    const f = await fixture();
    const trigger = `test_research_publish_failure_${randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(`create function public.${trigger}() returns trigger
      language plpgsql as $$
      begin
        if NEW.workspace_id = '${f.workspaceId}'::uuid
          and NEW.id = '${f.run.id}'::uuid
          and NEW.status = 'completed' then
          raise exception 'injected transient report publication failure';
        end if;
        return NEW;
      end $$`);
    await sql.unsafe(
      `create trigger ${trigger} before update on public.research_runs
       for each row execute function public.${trigger}()`,
    );

    try {
      await assert.rejects(
        runResearchRun(f.env, f.key, new AbortController().signal),
        /durable checkpoint failed/i,
      );
    } finally {
      await sql.unsafe(`drop trigger if exists ${trigger} on public.research_runs`);
      await sql.unsafe(`drop function if exists public.${trigger}()`);
    }

    assert.equal(f.calls.count, 1);
    const beforeRetry = await f.repository.loadWork(f.key);
    assert.ok(beforeRetry);
    assert.equal(beforeRetry.status, "running");
    assert.equal(beforeRetry.questions[0]?.inferenceState, "settled");
    assert.ok(beforeRetry.questions[0]?.inferenceResult);

    const result = await runResearchRun(f.env, f.key, new AbortController().signal);
    assert.equal(result.status, "completed");
    assert.equal(f.calls.count, 1);
    const stored = await f.repository.get(f.principal, f.workspaceId, f.run.id);
    assert.equal(stored.status, "completed");
    assert.equal(stored.findings.length, 1);
  });

  void it("settles known usage after cancellation of an in-flight model call without publishing", async () => {
    const f = await fixture({ waitForModel: true, invalidResponse: true });
    const execution = runResearchRun(f.env, f.key, new AbortController().signal);
    await f.started;

    const cancelled = await f.repository.cancel(f.principal, f.workspaceId, f.run.id);
    assert.equal(cancelled.status, "cancelled");
    f.releaseModel({
      ...modelResponse(f.sourceId),
    });

    const result = await execution;
    assert.equal(result.status, "cancelled");
    assert.equal(f.calls.count, 1);

    const work = await f.repository.loadWork(f.key);
    assert.ok(work);
    const question = work.questions[0]!;
    const receipt = await inferenceReceipt(f.workspaceId, question.operationId);
    assert.ok(receipt.settledAt);
    assert.equal(receipt.inputTokens, 23);
    assert.equal(receipt.outputTokens, 11);
    assert.equal(question.inferenceState, "settled");
    assert.equal(question.inferenceResult, "");

    const stored = await f.repository.get(f.principal, f.workspaceId, f.run.id);
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.report, null);
    assert.equal(stored.findings.length, 0);
    const events = await db
      .select()
      .from(applicationEvents)
      .where(eq(applicationEvents.workspaceId, f.workspaceId));
    assert.equal(events.length, 0);
  });

  void it("keeps an unknown-usage inference hold and does not replay the model", async () => {
    const f = await fixture({ missingUsage: true });
    const first = await runResearchRun(f.env, f.key, new AbortController().signal);
    assert.equal(first.status, "failed");
    assert.equal(f.calls.count, 1);

    const work = await f.repository.loadWork(f.key);
    assert.ok(work);
    const question = work.questions[0]!;
    const receipt = await inferenceReceipt(f.workspaceId, question.operationId);
    assert.equal(receipt.settledAt, null);
    assert.equal(question.inferenceState, "submitted");

    const [budget] = await db
      .select()
      .from(inferenceBudgets)
      .where(
        and(
          eq(inferenceBudgets.workspaceId, f.workspaceId),
          eq(inferenceBudgets.id, f.policy.budgetId),
        ),
      );
    assert.ok(budget);
    assert.ok(budget.reservedMicroUsd > 0);

    const replay = await runResearchRun(f.env, f.key, new AbortController().signal);
    assert.equal(replay.status, "failed");
    assert.equal(f.calls.count, 1);
    const unchanged = await inferenceReceipt(f.workspaceId, question.operationId);
    assert.equal(unchanged.settledAt, null);
  });
});
