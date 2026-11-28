import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { researchPolicySchema } from "../../src/config/research";
import { pinResearchRunPolicy } from "../../src/config/research-runs";
import type { RequestResearchRun } from "../../src/contracts/research/runs";
import { createResearchRunsRepository } from "../../src/db/research/runs";
import { db, setupDatabase, teardownDatabase, workspace } from "./fixture";

const runs = createResearchRunsRepository(db);

function policy(limits: { maxSources: number; maxSourceBytes: number; maxDiscoveryBytes: number }) {
  const base = researchPolicySchema.parse({
    version: "research-v1",
    promptVersion: "research-extract-v2",
    provider: "workers-ai",
    model: "isolated-research-source-batch-test-model",
    budgetId: randomUUID(),
    rateVersionId: randomUUID(),
  });

  return pinResearchRunPolicy({ ...base, ...limits }, "research-agent-v2");
}

async function activeRun(runPolicy: ReturnType<typeof policy>) {
  const scope = await workspace();
  const request: RequestResearchRun = {
    workspaceId: scope.workspaceId,
    commandId: randomUUID(),
    question: "Which sources support this claim?",
    subquestions: [],
    sourceUrls: ["https://example.org/evidence"],
    discoverSources: false,
  };
  const run = await runs.request(scope.principal, request, runPolicy);
  const key = { workspaceId: scope.workspaceId, runId: run.id };

  assert.equal(await runs.claim(key), true);

  return { key, run };
}

function source(text: string, digest = randomUUID().replaceAll("-", "").padEnd(64, "0")) {
  return {
    id: randomUUID(),
    requestedUrl: "https://example.org/evidence",
    url: "https://example.org/evidence",
    digest,
    retrievedAt: new Date().toISOString(),
    text,
  };
}

before(setupDatabase);
after(teardownDatabase);

void describe("research run source batches", () => {
  void it("enforces source count and byte capacity while returning canonical digest IDs", async () => {
    const fixture = await activeRun(
      policy({ maxSources: 2, maxSourceBytes: 1000, maxDiscoveryBytes: 2000 }),
    );
    const first = source("first");
    const second = source("second");
    const third = source("third");

    const results = await runs.saveSources(fixture.key, [first, second, third]);

    assert.deepEqual(results, [
      { status: "saved", id: first.id },
      { status: "saved", id: second.id },
      { status: "capacity", id: null },
    ]);

    const duplicate = await runs.saveSources(fixture.key, [{ ...first, id: randomUUID() }]);
    assert.deepEqual(duplicate, [{ status: "existing", id: first.id }]);

    assert.equal(await runs.saveSource(fixture.key, { ...third, id: randomUUID() }), false);
    assert.equal((await runs.loadWork(fixture.key))?.sources.length, 2);
  });

  void it("enforces aggregate snapshot bytes even when source count remains available", async () => {
    const fixture = await activeRun(
      policy({ maxSources: 3, maxSourceBytes: 1000, maxDiscoveryBytes: 1000 }),
    );
    const first = source("é".repeat(300));
    const second = source("a".repeat(501));

    const results = await runs.saveSources(fixture.key, [first, second]);

    assert.deepEqual(results, [
      { status: "saved", id: first.id },
      { status: "capacity", id: null },
    ]);
    assert.equal((await runs.loadWork(fixture.key))?.sources.length, 1);
  });

  void it("serializes concurrent batches against the same pinned capacity", async () => {
    const fixture = await activeRun(
      policy({ maxSources: 2, maxSourceBytes: 1000, maxDiscoveryBytes: 1000 }),
    );
    const left = [source("a".repeat(500)), source("b".repeat(500))];
    const right = [source("c".repeat(500)), source("d".repeat(500))];

    const results = await Promise.all([
      runs.saveSources(fixture.key, left),
      runs.saveSources(fixture.key, right),
    ]);

    assert.equal(results.flat().filter((result) => result?.status === "saved").length, 2);
    assert.equal(results.flat().filter((result) => result?.status === "capacity").length, 2);
    assert.equal((await runs.loadWork(fixture.key))?.sources.length, 2);
  });
});
