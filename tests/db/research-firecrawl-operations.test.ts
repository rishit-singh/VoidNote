import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { pinResearchRunPolicy } from "../../src/config/research-runs";
import { createResearchRunsRepository } from "../../src/db/research/runs";
import { createServiceBudgetRepository } from "../../src/db/service-budgets";
import { createOperations, type ResearchRunEnvironment } from "../../src/server/research/worker";
import { db, setupDatabase, sql, teardownDatabase, workspace } from "./fixture";

before(setupDatabase);
after(teardownDatabase);

void test("V3 retrieval persists Firecrawl evidence and usage once across exact replay", async () => {
  const member = await workspace();
  const budgetId = randomUUID();
  await sql`
    insert into service_budgets (workspace_id, provider, id, limit_units, approved_at)
    values (${member.workspaceId}, 'firecrawl', ${budgetId}, 10, now())
  `;
  const connectionString = process.env.TEST_DATABASE_URL!;
  const databaseUrl = new URL(connectionString);
  const env: ResearchRunEnvironment = {
    RESEARCH_ENABLED: "true",
    RESEARCH_AGENT_ENABLED: "true",
    FIRECRAWL_API_KEY: "isolated-test-key",
    HYPERDRIVE: {
      connectionString,
      host: databaseUrl.hostname,
      ip: "127.0.0.1",
      port: Number(databaseUrl.port),
      user: databaseUrl.username,
      password: databaseUrl.password,
      database: databaseUrl.pathname.slice(1),
      connect() {
        throw new Error("This test uses the isolated Postgres connection.");
      },
    },
  };
  const policy = pinResearchRunPolicy(
    {
      version: "research-v1",
      promptVersion: "research-extract-v2",
      provider: "workers-ai",
      model: "isolated-test-model",
      budgetId: randomUUID(),
      rateVersionId: randomUUID(),
      sourceProvider: "firecrawl",
      serviceBudgetId: budgetId,
      searchUnitBound: 7,
    },
    "research-workflow-v3",
  );
  const url = "https://example.org/primary";
  const secondUrl = "https://example.org/secondary";
  const runs = createResearchRunsRepository(db);
  const run = await runs.request(
    member.principal,
    {
      workspaceId: member.workspaceId,
      commandId: randomUUID(),
      question: "When did the program launch?",
      sourceUrls: [url, secondUrl],
      subquestions: [],
      discoverSources: false,
    },
    policy,
  );
  const key = { workspaceId: member.workspaceId, runId: run.id };
  const operations = createOperations(env);
  assert.equal(await operations.beginRun(key), true);
  const { scope } = await operations.execution(key);
  const context = { ...scope, operationId: randomUUID() };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (input: RequestInfo | URL) => {
    assert.equal(
      input instanceof Request ? input.url : input.toString(),
      "https://api.firecrawl.dev/v2/scrape",
    );
    calls++;
    return Promise.resolve(
      Response.json({
        success: true,
        data: {
          markdown: "The program launched on 12 November 2026.",
          metadata: {
            url,
            sourceURL: url,
            statusCode: 200,
            contentType: "text/html",
            provider: { creditsCost: 1 },
          },
        },
      }),
    );
  };
  try {
    const result = await operations.executeTool("retrieve_source", { url }, context);
    assert.equal((result as { ok: boolean }).ok, true);
    assert.deepEqual(await operations.executeTool("retrieve_source", { url }, context), result);
    assert.equal(calls, 1);
    assert.equal((await runs.loadWork(key))?.sources.length, 1);
    const [budget] = await sql`
      select reserved_units, settled_units from service_budgets
      where workspace_id=${member.workspaceId} and id=${budgetId}
    `;
    assert.equal(Number(budget!.reserved_units), 0);
    assert.equal(Number(budget!.settled_units), 1);

    const reservedOperationId = randomUUID();
    await createServiceBudgetRepository(db).reserve({
      workspaceId: member.workspaceId,
      provider: "firecrawl",
      budgetId,
      operationId: reservedOperationId,
      maximumUnits: 1,
    });
    const blocked = await operations.executeTool(
      "retrieve_source",
      { url: secondUrl },
      { ...scope, operationId: reservedOperationId },
    );
    assert.equal((blocked as { ok: boolean }).ok, false);
    assert.equal(calls, 1, "An existing provider reservation must not authorize another call.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
