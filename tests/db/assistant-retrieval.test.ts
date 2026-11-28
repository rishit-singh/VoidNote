import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import type { AssistantSource, AssistantToolResult } from "../../src/contracts/assistant";
import { WorkspaceError } from "../../src/contracts/workspace";
import { createAssistantRepository } from "../../src/db/assistant";
import { assistantMessages } from "../../src/db/assistant-schema";
import { createContactRepository } from "../../src/db/contacts";
import { workspaceMemberships } from "../../src/db/schema";
import {
  db,
  note,
  person,
  repository,
  setupDatabase,
  teardownDatabase,
  workspace,
} from "./fixture";

// Main runs this fixture's migration lifecycle on its exclusively coordinated
// empty test database. This file never reads application environment settings.
before(setupDatabase);
after(teardownDatabase);

const assistant = createAssistantRepository(db);
const policy = { version: 1, model: "test-only", maxSteps: 3 };
const code = (expected: WorkspaceError["code"]) => (error: unknown) =>
  error instanceof WorkspaceError && error.code === expected;

async function fixture() {
  const owner = await workspace();
  const saved = await repository.saveNote(owner.principal, owner.workspaceId, note());
  const thread = await assistant.openThread(
    owner.principal,
    owner.workspaceId,
    randomUUID(),
    saved.id,
  );
  return { ...owner, note: saved, thread };
}

async function complete(
  f: Awaited<ReturnType<typeof fixture>>,
  question: string,
  text: string,
  sources: AssistantSource[] = [],
  tools: AssistantToolResult[] = [],
) {
  const id = randomUUID();
  await assistant.requestTurn(f.principal, f.workspaceId, f.thread.id, id, question, policy);
  await assistant.beginTurn(f.workspaceId, id);
  await assistant.completeTurn(f.workspaceId, id, { text, sources, tools });
}

void describe("bounded assistant history and artifact retrieval", () => {
  void it("requires current thread ownership, membership and note access", async () => {
    const f = await fixture();
    await complete(f, "Private question", "Private answer");
    const peer = await workspace();
    await db.insert(workspaceMemberships).values({
      workspaceId: f.workspaceId,
      userId: peer.principal.id,
    });
    await assert.rejects(
      assistant.retrieveHistory(peer.principal, f.workspaceId, f.thread.id, "Private"),
      code("not_found"),
    );
    await assert.rejects(
      assistant.retrieveHistory(f.principal, peer.workspaceId, f.thread.id, "Private"),
      code("forbidden"),
    );
    const artifact = await assistant.createArtifact(f.principal, f.workspaceId, {
      operationId: randomUUID(),
      kind: "file",
      noteId: null,
      name: "Private file",
      mediaType: "text/plain",
      content: "Saved bytes",
      sources: [],
    });
    await assert.rejects(
      assistant.getContextArtifact(peer.principal, f.workspaceId, artifact.id),
      code("not_found"),
    );
    await repository.deleteNote(f.principal, f.workspaceId, {
      id: f.note.id,
      expectedRevision: f.note.revision,
      commandId: randomUUID(),
    });
    await assert.rejects(
      assistant.retrieveHistory(f.principal, f.workspaceId, f.thread.id, ""),
      code("not_found"),
    );
    await db
      .update(workspaceMemberships)
      .set({ revokedAt: new Date() })
      .where(eq(workspaceMemberships.userId, f.principal.id));
    await assert.rejects(
      assistant.getContextArtifact(f.principal, f.workspaceId, artifact.id),
      code("forbidden"),
    );
  });

  void it("searches literal text and stored tool outcomes without treating wildcards as patterns", async () => {
    const f = await fixture();
    const literal = "100%_path\\notes";
    await complete(f, "First question", `The literal value is ${literal}.`);
    await complete(
      f,
      "Second question",
      "The decoy value is 100XYpathZnotes.",
      [],
      [
        {
          id: "lookup",
          name: "contacts_get",
          status: "uncertain",
          summary: "A distinct lookup outcome",
          sources: [],
        },
      ],
    );
    const exact = await assistant.retrieveHistory(
      f.principal,
      f.workspaceId,
      f.thread.id,
      literal.toUpperCase(),
    );
    assert.equal(exact.hits.length, 1);
    assert.equal(exact.hits[0]?.text, `The literal value is ${literal}.`);
    const outcome = await assistant.retrieveHistory(
      f.principal,
      f.workspaceId,
      f.thread.id,
      "distinct lookup outcome",
    );
    assert.equal(outcome.hits.length, 1);
    assert.equal(outcome.hits[0]?.tools[0]?.summary, "A distinct lookup outcome");
    assert.equal(outcome.hits[0]?.tools[0]?.status, "uncertain");
    assert.equal(outcome.hits[0]?.tools[0]?.data, null);
    assert.equal(
      (await assistant.retrieveHistory(f.principal, f.workspaceId, f.thread.id, "contacts_get"))
        .hits.length,
      1,
    );
    assert.equal(
      (await assistant.retrieveHistory(f.principal, f.workspaceId, f.thread.id, "uncertain")).hits
        .length,
      1,
    );
  });

  void it("uses sequence keysets across timestamp ties and rejects cursor scope/query changes", async () => {
    const f = await fixture();
    for (let index = 0; index < 4; index += 1) {
      await complete(f, `needle question ${index}`, `needle answer ${index}`);
    }
    await db
      .update(assistantMessages)
      .set({
        createdAt: new Date("2026-11-25T00:00:00.000Z"),
      })
      .where(eq(assistantMessages.workspaceId, f.workspaceId));
    const historical = (await assistant.history(f.principal, f.workspaceId, f.thread.id)).messages
      .map((message) => message.id)
      .reverse();
    const first = await assistant.retrieveHistory(
      f.principal,
      f.workspaceId,
      f.thread.id,
      "needle",
      undefined,
      3,
    );
    assert.equal(first.order, "newest-first");
    assert.ok(first.nextCursor);
    await complete(f, "needle new question", "needle new answer");
    const second = await assistant.retrieveHistory(
      f.principal,
      f.workspaceId,
      f.thread.id,
      "needle",
      first.nextCursor,
      3,
    );
    assert.ok(second.nextCursor);
    const third = await assistant.retrieveHistory(
      f.principal,
      f.workspaceId,
      f.thread.id,
      "needle",
      second.nextCursor,
      3,
    );
    assert.equal(third.nextCursor, null);
    const retrieved = [...first.hits, ...second.hits, ...third.hits].map((hit) => hit.id);
    assert.deepEqual(retrieved, historical);
    assert.equal(new Set(retrieved).size, historical.length);
    await assert.rejects(
      assistant.retrieveHistory(
        f.principal,
        f.workspaceId,
        f.thread.id,
        "different",
        first.nextCursor,
        3,
      ),
      code("invalid_cursor"),
    );
    const other = await assistant.openThread(f.principal, f.workspaceId, randomUUID(), null);
    await assert.rejects(
      assistant.retrieveHistory(
        f.principal,
        f.workspaceId,
        other.id,
        "needle",
        first.nextCursor,
        3,
      ),
      code("invalid_cursor"),
    );
  });

  void it("filters stale tool/contact evidence without losing the next page or public audit history", async () => {
    const f = await fixture();
    const contacts = createContactRepository(db);
    const subject = await repository.savePerson(f.principal, f.workspaceId, person());
    await contacts.save(f.principal, {
      workspaceId: f.workspaceId,
      personId: subject.id,
      expectedRevision: 0,
      operationId: randomUUID(),
      fields: { organization: "Example", role: "Engineer", links: [] },
    });
    const source: AssistantSource = { kind: "person", id: subject.id, label: "Contact" };
    await complete(
      f,
      "needle question",
      "needle contact answer",
      [],
      [
        {
          id: "lookup",
          name: "contacts_get",
          status: "succeeded",
          summary: "Contact is an engineer",
          sources: [source],
        },
      ],
    );
    const valid = await assistant.retrieveHistory(
      f.principal,
      f.workspaceId,
      f.thread.id,
      "needle",
      undefined,
      1,
    );
    assert.equal(valid.hits[0]?.sources[0]?.contactRevision, 1);
    assert.equal(valid.hits[0]?.tools[0]?.sources[0]?.contactRevision, 1);
    await contacts.save(f.principal, {
      workspaceId: f.workspaceId,
      personId: subject.id,
      expectedRevision: 1,
      operationId: randomUUID(),
      fields: { organization: "Example", role: "Manager", links: [] },
    });
    const stale = await assistant.retrieveHistory(
      f.principal,
      f.workspaceId,
      f.thread.id,
      "needle",
      undefined,
      1,
    );
    assert.deepEqual(stale.hits, []);
    assert.equal(stale.omittedCount, 1);
    assert.ok(stale.nextCursor);
    const next = await assistant.retrieveHistory(
      f.principal,
      f.workspaceId,
      f.thread.id,
      "needle",
      stale.nextCursor,
      1,
    );
    assert.equal(next.hits[0]?.role, "user");
    assert.equal(next.hits[0]?.text, "needle question");
    assert.equal(next.nextCursor, null);
    assert.equal(
      (await assistant.history(f.principal, f.workspaceId, f.thread.id)).messages.length,
      2,
    );
  });

  void it("bounds excerpts and tool summaries while retaining matches late in saved content", async () => {
    const f = await fixture();
    const tools: AssistantToolResult[] = Array.from({ length: 12 }, (_, index) => ({
      id: `tool-${index}`,
      name: `lookup_${index}`,
      status: "succeeded",
      summary:
        index === 9 ? `${"x".repeat(2_000)} needle-tool ${"y".repeat(1_500)}` : "Other result",
      sources: [],
    }));
    await complete(
      f,
      "A question",
      `${"x".repeat(6_000)} needle-text ${"y".repeat(6_000)}`,
      [],
      tools,
    );
    const textResult = await assistant.retrieveHistory(
      f.principal,
      f.workspaceId,
      f.thread.id,
      "needle-text",
    );
    assert.ok(textResult.hits[0]?.text.includes("needle-text"));
    assert.ok(textResult.hits[0]!.text.length <= 4_000);
    assert.equal(textResult.hits[0]?.textTruncated, true);
    assert.equal(textResult.hits[0]?.toolsTruncated, true);
    const toolResult = await assistant.retrieveHistory(
      f.principal,
      f.workspaceId,
      f.thread.id,
      "needle-tool",
    );
    assert.equal(toolResult.hits[0]?.tools[0]?.id, "tool-9");
    assert.ok(toolResult.hits[0]?.tools[0]?.summary.includes("needle-tool"));
    assert.ok(toolResult.hits[0].tools[0].summary.length <= 1_000);
    assert.equal(toolResult.hits[0]?.tools[0]?.summaryTruncated, true);
    assert.ok(new TextEncoder().encode(JSON.stringify(toolResult)).byteLength <= 65_536);
  });

  void it("consumes oversized source-heavy matches without dropping evidence or looping cursors", async () => {
    const f = await fixture();
    const sources: AssistantSource[] = Array.from({ length: 22 }, (_, index) => {
      const url = `https://example.invalid/${index}/${"x".repeat(1_650)}`;
      return { kind: "url", id: url, label: `Source ${index}`, url };
    });
    await complete(f, "oversized question", "oversized answer", sources);
    const first = await assistant.retrieveHistory(
      f.principal,
      f.workspaceId,
      f.thread.id,
      "oversized",
      undefined,
      1,
    );
    assert.deepEqual(first.hits, []);
    assert.equal(first.omittedCount, 1);
    assert.ok(first.nextCursor);
    const next = await assistant.retrieveHistory(
      f.principal,
      f.workspaceId,
      f.thread.id,
      "oversized",
      first.nextCursor,
      1,
    );
    assert.equal(next.hits[0]?.role, "user");
    assert.equal(next.nextCursor, null);
  });

  void it("validates saved artifact provenance for model reads while retaining UI audit content", async () => {
    const f = await fixture();
    const subject = await repository.savePerson(f.principal, f.workspaceId, person());
    const artifact = await assistant.createArtifact(f.principal, f.workspaceId, {
      operationId: randomUUID(),
      kind: "file",
      noteId: null,
      name: "Contact notes",
      mediaType: "text/markdown",
      content: "Authored content remains an immutable artifact.",
      sources: [{ kind: "person", id: subject.id, label: "Contact" }],
    });
    assert.deepEqual(
      await assistant.getContextArtifact(f.principal, f.workspaceId, artifact.id),
      artifact,
    );
    await createContactRepository(db).save(f.principal, {
      workspaceId: f.workspaceId,
      personId: subject.id,
      expectedRevision: 0,
      operationId: randomUUID(),
      fields: { organization: "New org", role: "New role", links: [] },
    });
    await assert.rejects(
      assistant.getContextArtifact(f.principal, f.workspaceId, artifact.id),
      code("conflict"),
    );
    assert.deepEqual(
      await assistant.getArtifact(f.principal, f.workspaceId, artifact.id),
      artifact,
    );
  });
});
