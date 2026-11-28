import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { researchPolicySchema } from "../../src/config/research";
import { createAssistantRepository } from "../../src/db/assistant";
import { createResearchRepository } from "../../src/db/research";
import { createResearchEvidenceRepository } from "../../src/db/research/evidence";
import { db, person, repository, setupDatabase, teardownDatabase, workspace } from "./fixture";

const evidence = createResearchEvidenceRepository(db);
const research = createResearchRepository(db);
const policy = researchPolicySchema.parse({
  version: "research-v1",
  promptVersion: "research-extract-v2",
  provider: "workers-ai",
  model: "isolated-test-model",
  budgetId: randomUUID(),
  rateVersionId: randomUUID(),
});

async function fixture() {
  const scope = await workspace();
  const profile = await repository.savePerson(
    scope.principal,
    scope.workspaceId,
    person({ content: { displayName: "Ada Lovelace", description: "Mathematician" } }),
  );
  const batchId = randomUUID();
  const url = "https://example.org/biography";
  const key = { workspaceId: scope.workspaceId, batchId, personId: profile.id, generation: 1 };
  await research.request(
    scope.principal,
    {
      workspaceId: scope.workspaceId,
      requestId: batchId,
      people: [
        {
          personId: profile.id,
          expectedProfileRevision: profile.revision,
          sourceUrls: [url],
          requestedFacts: [{ key: "role", question: "What was Ada's role?" }],
        },
      ],
    },
    policy,
  );
  await research.execution.start(key);
  const sourceId = randomUUID();
  await research.execution.saveSource(key, {
    id: sourceId,
    url,
    requestedUrl: url,
    text: "Ada Lovelace was a mathematician.",
    digest: "a".repeat(64),
    retrievedAt: new Date().toISOString(),
  });
  await research.execution.claimFact(key, "role");
  await research.execution.saveFinding(
    key,
    "role",
    {
      key: "role",
      question: "What was Ada's role?",
      status: "supported",
      answer: "mathematician",
      explanation: "Supported by the biography.",
      citations: [
        {
          sourceId,
          url,
          excerpt: "Ada Lovelace was a mathematician.",
          retrievedAt: new Date().toISOString(),
          asOf: "2020-01-01T00:00:00.000Z",
        },
      ],
    },
    { inputTokens: 10, outputTokens: 10 },
  );
  await research.execution.finish(key, "completed", null);
  assert.equal(await research.execution.load(key), null);
  assert.deepEqual(await research.executionOutcome(key), { status: "completed" });
  return { ...scope, profile, batchId, sourceId, url };
}

void describe("saved research evidence reuse", () => {
  before(setupDatabase);
  after(teardownDatabase);

  void it("finds existing evidence without confusing recent retrieval with current facts", async () => {
    const scope = await fixture();
    const result = await evidence.lookup(scope.principal, scope.workspaceId, {
      query: "mathematician",
      maxAgeDays: 1,
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.freshness, "stale");
    assert.equal(result.items[0]?.identityCurrent, true);
    assert.equal(result.items[0]?.batchId, scope.batchId);
    assert.equal("sources" in result.items[0], false);
    const sources = await evidence.reusableSources(
      scope.principal,
      scope.workspaceId,
      scope.profile.id,
    );
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.text, "Ada Lovelace was a mathematician.");
    assert.deepEqual(
      await evidence.reusableSources(scope.principal, scope.workspaceId, scope.profile.id, 1),
      [],
    );
  });

  void it("isolates workspaces and refuses reuse after identity revision changes", async () => {
    const scope = await fixture();
    const other = await workspace();
    await assert.rejects(
      evidence.lookup(other.principal, scope.workspaceId, {}),
      /Workspace access denied/,
    );
    await repository.savePerson(scope.principal, scope.workspaceId, {
      commandId: randomUUID(),
      id: scope.profile.id,
      expectedRevision: scope.profile.revision,
      content: { displayName: "Different identity", description: "" },
    });
    const result = await evidence.lookup(scope.principal, scope.workspaceId, {
      personIds: [scope.profile.id],
    });
    assert.equal(result.items[0]?.identityCurrent, false);
    assert.deepEqual(
      await evidence.reusableSources(scope.principal, scope.workspaceId, scope.profile.id),
      [],
    );
  });

  void it("rejects cursors from different filters rather than silently skipping evidence", async () => {
    const scope = await fixture();
    const cursor = btoa(
      JSON.stringify({
        workspaceId: scope.workspaceId,
        filter: "wrong filters",
        updatedAt: new Date().toISOString(),
        batchId: scope.batchId,
        personId: scope.profile.id,
      }),
    );
    await assert.rejects(
      evidence.lookup(scope.principal, scope.workspaceId, { cursor }),
      /filters changed/,
    );
  });

  void it("preserves saved source identity and rejects forged research provenance at publication", async () => {
    const scope = await fixture();
    const assistant = createAssistantRepository(db);
    const source = {
      kind: "url" as const,
      id: scope.sourceId,
      researchBatchId: scope.batchId,
      url: scope.url,
      label: "Saved biography",
    };
    const input = {
      operationId: randomUUID(),
      kind: "file" as const,
      noteId: null,
      name: "Research note",
      mediaType: "text/markdown" as const,
      content: "Ada was a mathematician.",
      sources: [source],
    };
    const saved = await assistant.createArtifact(scope.principal, scope.workspaceId, input);
    assert.deepEqual(saved.sources, [source]);
    await assert.rejects(
      assistant.createArtifact(scope.principal, scope.workspaceId, {
        ...input,
        operationId: randomUUID(),
        sources: [{ ...source, id: randomUUID() }],
      }),
      /research evidence is unavailable/i,
    );
    const other = await workspace();
    await assert.rejects(
      assistant.createArtifact(other.principal, other.workspaceId, {
        ...input,
        operationId: randomUUID(),
      }),
      /research evidence is unavailable/i,
    );
  });
});
