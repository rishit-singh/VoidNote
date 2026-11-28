import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { and, eq } from "drizzle-orm";

import type { AssistantSource } from "../../src/contracts/assistant";
import { WorkspaceError } from "../../src/contracts/workspace";
import { createAssistantRepository } from "../../src/db/assistant";
import { validateSources } from "../../src/db/assistant/shared";
import { assistantMemories } from "../../src/db/assistant-schema";
import { db, note, repository, setupDatabase, teardownDatabase, workspace } from "./fixture";

before(setupDatabase);
after(teardownDatabase);

const assistant = createAssistantRepository(db);
const conflict = (error: unknown) => error instanceof WorkspaceError && error.code === "conflict";

async function fixture() {
  const owner = await workspace();
  const thread = await assistant.openThread(owner.principal, owner.workspaceId, randomUUID(), null);
  const turnId = randomUUID();
  await assistant.requestTurn(
    owner.principal,
    owner.workspaceId,
    thread.id,
    turnId,
    "Question",
    {},
  );
  await assistant.beginTurn(owner.workspaceId, turnId);
  return { ...owner, thread, turnId };
}

async function remember(f: Awaited<ReturnType<typeof fixture>>, sources: AssistantSource[]) {
  const memory = await assistant.remember(f.principal, f.workspaceId, {
    operationId: randomUUID(),
    subjectId: null,
    kind: "claim",
    content: "A supported claim",
    provenance: sources.length ? "source-supported" : "user-stated",
    sources,
    expiresAt: null,
  });
  return { kind: "memory", id: memory.id, revision: memory.revision, label: "Claim" } as const;
}

void test("48 top-level dependencies sharing evidence publish atomically and replay exactly", async () => {
  const f = await fixture();
  const evidence: AssistantSource[] = [];
  for (let index = 0; index < 6; index++) {
    const saved = await repository.saveNote(f.principal, f.workspaceId, note());
    evidence.push({ kind: "note", id: saved.id, label: saved.title, revision: saved.revision });
  }
  const sources: AssistantSource[] = [];
  for (let index = 0; index < 48; index++) {
    sources.push(
      await remember(
        f,
        evidence.map((source) => ({ ...source, label: `Claim ${index}` })),
      ),
    );
  }
  // Reproduce the occurrence-counting failure independently of the new
  // publication cache: 48 * (1 memory + 6 shared notes) exceeds 256.
  await assert.rejects(
    db.transaction((tx) => validateSources(tx, f.principal, f.workspaceId, sources)),
    (error: unknown) => conflict(error) && (error as Error).message.includes("Too many"),
  );
  const output = {
    text: "Supported answer",
    sources,
    tools: [
      {
        id: "lookup",
        name: "memory_recall",
        status: "succeeded" as const,
        summary: "Found",
        sources,
      },
    ],
  };
  assert.equal(
    (await assistant.completeTurn(f.workspaceId, f.turnId, output))?.status,
    "succeeded",
  );
  assert.equal(
    (await assistant.completeTurn(f.workspaceId, f.turnId, output))?.status,
    "succeeded",
  );
  await assert.rejects(
    assistant.completeTurn(f.workspaceId, f.turnId, { ...output, text: "Different answer" }),
    (error: unknown) => error instanceof WorkspaceError && error.code === "command_reused",
  );
  const history = await assistant.history(f.principal, f.workspaceId, f.thread.id);
  assert.equal(history.messages.filter((message) => message.role === "assistant").length, 1);
});

void test("cached current evidence cannot hide a conflicting revision in a later tool", async () => {
  const f = await fixture();
  const saved = await repository.saveNote(f.principal, f.workspaceId, note());
  const source: AssistantSource = {
    kind: "note",
    id: saved.id,
    label: saved.title,
    revision: saved.revision,
  };
  await assert.rejects(
    assistant.completeTurn(f.workspaceId, f.turnId, {
      text: "Conflicting answer",
      sources: [source],
      tools: [
        {
          id: "lookup",
          name: "notes_get",
          status: "succeeded",
          summary: "Found",
          sources: [{ ...source, revision: saved.revision + 1 }],
        },
      ],
    }),
    conflict,
  );
  const history = await assistant.history(f.principal, f.workspaceId, f.thread.id);
  assert.equal(history.messages.filter((message) => message.role === "assistant").length, 0);
  assert.equal(history.activeTurn?.status, "running");
});

void test("published replies remain historical context after evidence changes or disappears", async () => {
  const f = await fixture();
  const saved = await repository.saveNote(f.principal, f.workspaceId, note());
  await assistant.completeTurn(f.workspaceId, f.turnId, {
    text: "Historical answer",
    tools: [],
    sources: [{ kind: "note", id: saved.id, label: saved.title, revision: saved.revision }],
  });
  const original = await assistant.contextHistory(f.workspaceId, f.thread.id);
  await repository.deleteNote(f.principal, f.workspaceId, {
    id: saved.id,
    expectedRevision: saved.revision,
    commandId: randomUUID(),
  });
  assert.deepEqual(await assistant.contextHistory(f.workspaceId, f.thread.id), original);
  const nextTurnId = randomUUID();
  await assistant.requestTurn(f.principal, f.workspaceId, f.thread.id, nextTurnId, "Next", {});
  await assistant.beginTurn(f.workspaceId, nextTurnId);
  await assert.rejects(
    assistant.completeTurn(f.workspaceId, nextTurnId, {
      text: "Cannot reuse deleted evidence",
      tools: [],
      sources: original.find((message) => message.role === "assistant")!.sources,
    }),
    (error: unknown) => error instanceof WorkspaceError && error.code === "not_found",
  );
});

void test("publication detects a source cycle without treating an in-progress dependency as valid", async () => {
  const f = await fixture();
  const source = await remember(f, []);
  await db
    .update(assistantMemories)
    .set({ sources: [source] })
    .where(
      and(eq(assistantMemories.workspaceId, f.workspaceId), eq(assistantMemories.id, source.id)),
    );
  await assert.rejects(
    assistant.completeTurn(f.workspaceId, f.turnId, {
      text: "Cyclic evidence",
      sources: [source],
      tools: [],
    }),
    (error: unknown) => conflict(error) && (error as Error).message.includes("cycle"),
  );
});

void test("a cached subtree still enforces the depth bound on a longer path", async () => {
  const f = await fixture();
  const memories: AssistantSource[] = [];
  for (let index = 0; index < 10; index++) {
    memories.push(await remember(f, []));
  }
  memories.sort((a, b) => a.id.localeCompare(b.id));
  // The first lexical source is initially validated as a shallow subtree.
  // The second root reaches that same subtree five levels further down.
  const chain = [...memories.slice(1, 6), memories[0]!, ...memories.slice(6)];
  for (let index = 0; index < chain.length - 1; index++) {
    await db
      .update(assistantMemories)
      .set({ sources: [chain[index + 1]!] })
      .where(
        and(
          eq(assistantMemories.workspaceId, f.workspaceId),
          eq(assistantMemories.id, chain[index]!.id),
        ),
      );
  }
  await assert.rejects(
    assistant.completeTurn(f.workspaceId, f.turnId, {
      text: "Too deep",
      sources: [memories[0]!, chain[0]!],
      tools: [],
    }),
    (error: unknown) => conflict(error) && (error as Error).message.includes("depth"),
  );
});
