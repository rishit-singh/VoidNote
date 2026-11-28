import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { and, eq } from "drizzle-orm";

import type { AssistantSource } from "../../src/contracts/assistant";
import type { AssistantMemoryMutation } from "../../src/contracts/assistant/lineage";
import { conversationSummaryPolicySchema } from "../../src/contracts/conversation-summaries";
import { WorkspaceError } from "../../src/contracts/workspace";
import { createAssistantRepository } from "../../src/db/assistant";
import { assistantMessages } from "../../src/db/assistant-schema";
import { createConversationSummaryRepository } from "../../src/db/conversation-summaries";
import { db, note, repository, setupDatabase, teardownDatabase, workspace } from "./fixture";

before(setupDatabase);
after(teardownDatabase);

const assistant = createAssistantRepository(db);
const summaries = createConversationSummaryRepository(db);
const policy = conversationSummaryPolicySchema.parse({
  version: "conversation-summary-v1",
  promptVersion: "conversation-summary-v1",
  model: "test-only",
  budgetId: randomUUID(),
  rateVersionId: randomUUID(),
});
const conflict = (error: unknown) => error instanceof WorkspaceError && error.code === "conflict";

async function fixture(name: AssistantMemoryMutation["name"] = "memory_revise") {
  const owner = await workspace();
  const saved = await repository.saveNote(owner.principal, owner.workspaceId, note());
  const evidence = await repository.saveNote(owner.principal, owner.workspaceId, note());
  const thread = await assistant.openThread(
    owner.principal,
    owner.workspaceId,
    randomUUID(),
    saved.id,
  );
  const memory = await assistant.remember(owner.principal, owner.workspaceId, {
    operationId: randomUUID(),
    subjectId: null,
    kind: "preference",
    content: "Use long replies.",
    provenance: "user-stated",
    sources: [],
    expiresAt: null,
  });
  const noteSource: AssistantSource = {
    kind: "note",
    id: saved.id,
    label: saved.title,
    revision: saved.revision,
  };
  let previousMessageId = "";
  for (let index = 0; index < 10; index++) {
    const turnId = randomUUID();
    await assistant.requestTurn(
      owner.principal,
      owner.workspaceId,
      thread.id,
      turnId,
      "A question",
      {},
    );
    await assistant.beginTurn(owner.workspaceId, turnId);
    await assistant.completeTurn(owner.workspaceId, turnId, {
      text: "Historical answer",
      tools: [],
      sources:
        index === 0
          ? [
              noteSource,
              { kind: "memory", id: memory.id, label: memory.kind, revision: memory.revision },
            ]
          : index === 1
            ? [{ kind: "message", id: previousMessageId, label: "Earlier answer" }]
            : [],
    });
    const history = await assistant.history(owner.principal, owner.workspaceId, thread.id);
    previousMessageId = history.messages.find(
      (message) => message.turnId === turnId && message.role === "assistant",
    )!.id;
  }
  await db
    .update(assistantMessages)
    .set({ createdAt: new Date(Date.now() - policy.idleMs - 60_000) })
    .where(
      and(
        eq(assistantMessages.workspaceId, owner.workspaceId),
        eq(assistantMessages.threadId, thread.id),
      ),
    );
  const key = (await summaries.enqueueIdle(policy, 100)).find(
    (entry) => entry.threadId === thread.id,
  )!;
  assert.ok(key);
  assert.equal(await summaries.begin(key), true);
  await summaries.publish(key, "The user had requested long replies.");
  const hydrated = await summaries.contextSummary(owner.workspaceId, thread.id);
  assert.equal(hydrated?.status, "succeeded");

  const turnId = randomUUID();
  await assistant.requestTurn(
    owner.principal,
    owner.workspaceId,
    thread.id,
    turnId,
    "Correct my preference.",
    {},
  );
  await assistant.beginTurn(owner.workspaceId, turnId);
  const input = {
    memoryId: memory.id,
    expectedRevision: memory.revision,
    reason:
      name === "memory_invalidate"
        ? "  The user requested forgetting.  "
        : "The user corrected their preference.",
  };
  const mutation: AssistantMemoryMutation =
    name === "memory_revise"
      ? {
          name,
          operationId: randomUUID(),
          // Deliberately unpinned input: receipt verification must use original inputs,
          // while current provenance validation uses the repository-pinned sources.
          input: {
            ...input,
            content: "Use short replies.",
            sources: [{ kind: "note", id: evidence.id, label: evidence.title }],
          },
        }
      : { name, operationId: randomUUID(), input };
  const current =
    mutation.name === "memory_revise"
      ? await assistant.reviseMemory(
          owner.principal,
          owner.workspaceId,
          memory.id,
          input.expectedRevision,
          mutation.input.content,
          mutation.input.sources,
          input.reason,
          mutation.operationId,
          { turnId },
        )
      : await assistant.invalidateMemory(
          owner.principal,
          owner.workspaceId,
          memory.id,
          input.expectedRevision,
          input.reason,
          mutation.operationId,
          { turnId },
        );
  const currentSources: AssistantSource[] =
    mutation.name === "memory_revise"
      ? [{ kind: "memory", id: memory.id, label: memory.kind, revision: current.revision }]
      : [];
  const output = {
    text: "Updated your preference.",
    tools: [
      {
        id: mutation.operationId,
        name,
        status: "succeeded" as const,
        summary: "Memory updated.",
        sources: currentSources,
      },
    ],
    sources: [...hydrated.sources, ...currentSources],
    memoryMutations: [mutation],
  };
  return {
    ...owner,
    thread,
    turnId,
    saved,
    evidence,
    memory,
    current,
    mutation,
    output,
    noteSource,
  };
}

for (const name of ["memory_revise", "memory_invalidate"] as const) {
  void test(`hydrated summary ${name} publishes with current lineage and exact replay`, async () => {
    const f = await fixture(name);
    assert.equal(
      (await assistant.completeTurn(f.workspaceId, f.turnId, f.output))?.status,
      "succeeded",
    );
    assert.equal(
      (await assistant.completeTurn(f.workspaceId, f.turnId, f.output))?.status,
      "succeeded",
    );
    const history = await assistant.history(f.principal, f.workspaceId, f.thread.id);
    const reply = history.messages.find(
      (message) => message.turnId === f.turnId && message.role === "assistant",
    )!;
    assert.ok(
      reply.sources.some(
        (source) => source.kind === "note" && source.id === f.saved.id && source.revision === 1,
      ),
    );
    assert.ok(!reply.sources.some((source) => source.kind === "memory" && source.revision === 1));
    assert.equal(
      reply.sources.some((source) => source.kind === "memory" && source.revision === 2),
      name === "memory_revise",
    );
    assert.ok(
      reply.sources.some((source) => source.kind === "message"),
      "Unchanged message identities remain",
    );
    const context = await assistant.contextHistory(f.workspaceId, f.thread.id, 30);
    assert.ok(
      context.some((message) => message.id === reply.id),
      "Published lineage rehydrates without a special exemption",
    );
  });
}

void test("explicit memory supersession cannot erase an unrelated stale source in a derived message", async () => {
  const f = await fixture();
  await repository.saveNote(
    f.principal,
    f.workspaceId,
    note({
      id: f.saved.id,
      expectedRevision: f.saved.revision,
      content: { title: "Changed source", transcript: f.saved.transcript },
    }),
  );
  await assert.rejects(assistant.completeTurn(f.workspaceId, f.turnId, f.output), conflict);
});

void test("missing or forged mutation proofs cannot bypass the historical source fence", async () => {
  const f = await fixture();
  await assert.rejects(
    assistant.completeTurn(f.workspaceId, f.turnId, { ...f.output, memoryMutations: [] }),
    conflict,
  );
  const forged = structuredClone(f.output);
  forged.memoryMutations[0]!.input.reason = "A different mutation";
  await assert.rejects(assistant.completeTurn(f.workspaceId, f.turnId, forged), conflict);
});

void test("a receipt from another turn cannot authorize predecessor publication", async () => {
  const f = await fixture();
  await assistant.failTurn(f.workspaceId, f.turnId, "failed", "Interrupted");
  const nextTurnId = randomUUID();
  await assistant.requestTurn(f.principal, f.workspaceId, f.thread.id, nextTurnId, "Next", {});
  await assistant.beginTurn(f.workspaceId, nextTurnId);
  await assert.rejects(assistant.completeTurn(f.workspaceId, nextTurnId, f.output), conflict);
});

void test("a later memory revision wins over an earlier acknowledged supersession", async () => {
  const f = await fixture();
  await assistant.reviseMemory(
    f.principal,
    f.workspaceId,
    f.memory.id,
    f.current.revision,
    "A newer preference.",
    [],
    "Later edit",
    randomUUID(),
  );
  await assert.rejects(assistant.completeTurn(f.workspaceId, f.turnId, f.output), conflict);
});

void test("current memory provenance remains fenced after predecessor replacement", async () => {
  const f = await fixture();
  await repository.saveNote(
    f.principal,
    f.workspaceId,
    note({
      id: f.evidence.id,
      expectedRevision: f.evidence.revision,
      content: { title: "Changed current evidence", transcript: f.evidence.transcript },
    }),
  );
  await assert.rejects(assistant.completeTurn(f.workspaceId, f.turnId, f.output), conflict);
});

void test("consecutive acknowledged corrections bridge only their exact revision chain", async () => {
  const f = await fixture();
  const mutation: AssistantMemoryMutation = {
    name: "memory_revise",
    operationId: randomUUID(),
    input: {
      memoryId: f.memory.id,
      expectedRevision: f.current.revision,
      content: "Use short numbered lists.",
      sources: [],
      reason: "A more specific correction.",
    },
  };
  await assistant.reviseMemory(
    f.principal,
    f.workspaceId,
    f.memory.id,
    mutation.input.expectedRevision,
    mutation.input.content,
    mutation.input.sources,
    mutation.input.reason,
    mutation.operationId,
    { turnId: f.turnId },
  );
  const output = {
    ...f.output,
    memoryMutations: [...f.output.memoryMutations, mutation],
    tools: [
      ...f.output.tools,
      {
        id: mutation.operationId,
        name: mutation.name,
        status: "succeeded" as const,
        summary: "Corrected again.",
        sources: [],
      },
    ],
  };
  assert.equal(
    (await assistant.completeTurn(f.workspaceId, f.turnId, output))?.status,
    "succeeded",
  );
  const history = await assistant.history(f.principal, f.workspaceId, f.thread.id);
  const reply = history.messages.find(
    (message) => message.turnId === f.turnId && message.role === "assistant",
  )!;
  assert.ok(reply.sources.some((source) => source.kind === "memory" && source.revision === 3));
  assert.ok(!reply.sources.some((source) => source.kind === "memory" && source.revision !== 3));
});

void test("repeated historical DAG edges cannot amplify superseded publication provenance", async () => {
  const f = await fixture();
  const history = await assistant.history(f.principal, f.workspaceId, f.thread.id);
  const replies = history.messages.filter((message) => message.role === "assistant");
  const base = replies[0]!;
  assert.ok(base.sources.some((source) => source.kind === "memory" && source.revision === 1));
  let previous = base;
  // Two levels of 100 repeated edges produce 20,000 expanded dependencies
  // without incremental deduplication, despite only a handful of dependencies.
  // Distinct presentation labels must not turn identical provenance into paths.
  for (const parent of replies.slice(1, 3)) {
    await db
      .update(assistantMessages)
      .set({
        sources: Array.from({ length: 100 }, (_, index) => ({
          kind: "message" as const,
          id: previous.id,
          label: `Historical reference ${index}`,
        })),
      })
      .where(
        and(eq(assistantMessages.workspaceId, f.workspaceId), eq(assistantMessages.id, parent.id)),
      );
    previous = parent;
  }
  const output = {
    ...f.output,
    sources: [{ kind: "message" as const, id: previous.id, label: "Historical context" }],
  };
  assert.equal(
    (await assistant.completeTurn(f.workspaceId, f.turnId, output))?.status,
    "succeeded",
  );
  const published = (
    await assistant.history(f.principal, f.workspaceId, f.thread.id)
  ).messages.find((message) => message.turnId === f.turnId && message.role === "assistant")!;
  assert.equal(published.sources.length, 2);
  assert.deepEqual(
    published.sources.find((source) => source.kind === "note"),
    f.noteSource,
  );
  assert.equal(published.sources.find((source) => source.kind === "memory")?.revision, 2);
  assert.equal(
    (await assistant.completeTurn(f.workspaceId, f.turnId, output))?.status,
    "succeeded",
  );
});
