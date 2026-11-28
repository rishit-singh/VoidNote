import assert from "node:assert/strict";
import { after, before, it } from "node:test";

import { createAssistantReaders } from "../../src/ai/assistant-context";
import { createAssistantServices } from "../../src/ai/assistant-services";
import { assistantModelEvidence } from "../../src/ai/assistant/evidence";
import { assistantPolicySchema } from "../../src/config/assistant";
import { assistantSourceSchema } from "../../src/contracts/assistant";
import { WorkspaceError } from "../../src/contracts/workspace";
import {
  createAssistantEvidenceRepository,
  createAssistantRepository,
} from "../../src/db/assistant";
import { createRecordingRepository } from "../../src/db/recording-repository";
import { db, note, repository, setupDatabase, teardownDatabase, workspace } from "./fixture";

before(setupDatabase);
after(teardownDatabase);

void it("context tool uses the accepted thread and returns real paged transcript evidence within the budget", async () => {
  const owner = await workspace();
  const saved = await repository.saveNote(owner.principal, owner.workspaceId, note());
  const recordings = createRecordingRepository(db);
  const recordingId = crypto.randomUUID();
  await recordings.initialize(owner.principal, owner.workspaceId, saved.id, {
    id: recordingId,
    sha256: "a".repeat(64),
    bytes: 20,
    durationSeconds: 7200,
    mimeType: "audio/webm",
  });
  await recordings.acknowledge(owner.principal, owner.workspaceId, saved.id, recordingId, 20);
  const run = await recordings.requestProcessing(
    owner.principal,
    owner.workspaceId,
    saved.id,
    recordingId,
    crypto.randomUUID(),
  );
  await recordings.claimSubmission(owner.workspaceId, run.id);
  await recordings.bindJob(owner.workspaceId, run.id, crypto.randomUUID());
  await recordings.publish(
    owner.workspaceId,
    run.id,
    "private/test-context.json",
    Array.from({ length: 120 }, (_, index) => ({
      start: index * 4,
      end: index * 4 + 3,
      speaker: "SPEAKER_01",
      text: `Evidence passage ${index}. ` + "Bounded grounded evidence. ".repeat(30),
    })),
  );
  const assistant = createAssistantRepository(db);
  const thread = await assistant.openThread(
    owner.principal,
    owner.workspaceId,
    crypto.randomUUID(),
    saved.id,
  );
  const turnId = crypto.randomUUID();
  const policy = assistantPolicySchema.parse({
    version: "assistant-v1",
    skillVersion: "assistant-skills-v5",
    model: "@cf/fixture/local-only",
    budgetId: crypto.randomUUID(),
    rateVersionId: crypto.randomUUID(),
  });
  await assistant.requestTurn(
    owner.principal,
    owner.workspaceId,
    thread.id,
    turnId,
    "Read the transcript.",
    policy,
  );
  await assistant.beginTurn(owner.workspaceId, turnId);
  const services = createAssistantServices({
    HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! },
    ASSISTANT_ENABLED: "true",
    ASSISTANT_MODEL: policy.model,
    ASSISTANT_BUDGET_ID: policy.budgetId,
    ASSISTANT_RATE_VERSION_ID: policy.rateVersionId,
  } as Cloudflare.Env);
  const scope = {
    workspaceId: owner.workspaceId,
    threadId: thread.id,
    turnId,
    principal: owner.principal,
    toolCallId: "grounding",
    operationId: crypto.randomUUID(),
  };
  const output = await services.executeTool("context_read", {}, scope);
  assert.ok(
    Buffer.byteLength(JSON.stringify(assistantModelEvidence(output))) <= policy.maxToolResultBytes,
  );
  const data = output.data as Awaited<
    ReturnType<ReturnType<typeof createAssistantReaders>["readContext"]>
  >;
  assert.ok(data.note && "note" in data.note);
  assert.equal(data.note.note.id, saved.id);
  assert.ok(data.transcript && "coverage" in data.transcript);
  assert.equal(data.transcript.coverage, "partial-page");
  assert.ok(data.transcript.nextCursor);
  assert.ok(data.transcript.passages[0]?.text.includes("Evidence passage 0."));
  assert.equal(data.transcript.passages[0]?.speakerLabel, "SPEAKER_01");
  assert.ok(data.currentUser);
  assert.ok(data.transcript.passages.every((passage) => passage.personId === null));
  assert.ok(
    output.sources.some((source) => source.kind === "transcript" && source.runId === run.id),
  );
  await assert.rejects(
    services.executeTool("context_read", { noteId: crypto.randomUUID() }, scope),
  );
  await assert.rejects(
    services.executeTool("context_read", {}, { ...scope, threadId: crypto.randomUUID() }),
    (error: unknown) => error instanceof WorkspaceError && error.code === "forbidden",
  );
});

void it("grounds opened-note context through authorized readers with bounded evidence and continuation", async () => {
  const owner = await workspace();
  const saved = await repository.saveNote(
    owner.principal,
    owner.workspaceId,
    note({ content: { title: "Grounding", transcript: "evidence ".repeat(4000) } }),
  );
  const readers = createAssistantReaders(
    { HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! } },
    owner.principal,
    owner.workspaceId,
  );
  const context = await readers.readContext(saved.id);
  assert.ok(context.note && "note" in context.note);
  assert.equal(context.note.note.id, saved.id);
  assert.ok(context.note.note.nextOffset);
  assert.equal(context.note.coverage, "partial");
  assert.ok(context.transcript && "unavailable" in context.transcript);
  assert.equal(context.transcript.unavailable, "No completed transcript.");
  assert.equal(context.sources[0]?.revision, saved.revision);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ data: context, sources: context.sources })) < 24_000,
  );

  const next = await repository.saveNote(
    owner.principal,
    owner.workspaceId,
    note({
      id: saved.id,
      expectedRevision: saved.revision,
      content: { title: "Renamed", transcript: "Current evidence." },
    }),
  );
  const fresh = await readers.readContext(saved.id);
  assert.equal(fresh.sources[0]?.revision, next.revision);
  assert.ok(fresh.note && "note" in fresh.note);
  assert.equal(fresh.note.note.text, "Current evidence.");

  const outsider = await workspace();
  await assert.rejects(
    createAssistantReaders(
      { HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! } },
      outsider.principal,
      outsider.workspaceId,
    ).readContext(saved.id),
    (error: unknown) => error instanceof WorkspaceError && error.code === "not_found",
  );
  const empty = await readers.readContext(null);
  assert.equal(empty.note, null);
  assert.equal(empty.transcript, null);
  assert.deepEqual(
    empty.sources,
    context.sources.filter((source) => source.kind === "person"),
  );
});

void it("provides the signed-in user's own profile without inventing a transcript speaker assignment", async () => {
  const owner = await workspace();
  const self = await repository.getSelfProfile(owner.principal, owner.workspaceId);
  assert.ok(self);
  const readers = createAssistantReaders(
    { HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! } },
    owner.principal,
    owner.workspaceId,
  );
  const context = await readers.readContext(null);
  assert.equal(context.currentUser?.personId, self.id);
  assert.equal(context.currentUser?.displayName, self.displayName);
  assert.equal(context.transcript, null);
  assert.deepEqual(context.sources, [
    {
      kind: "person",
      id: self.id,
      label: `Your profile · ${self.displayName}`,
      revision: self.revision,
    },
  ]);
  const other = await workspace();
  const otherSelf = await repository.getSelfProfile(other.principal, other.workspaceId);
  assert.ok(otherSelf);
  const otherContext = await createAssistantReaders(
    { HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! } },
    other.principal,
    other.workspaceId,
  ).readContext(null);
  assert.equal(otherContext.currentUser?.personId, otherSelf.id);
  assert.notEqual(otherSelf.id, self.id);
});

void it("reads authored evidence for another authorized workspace note with bounded content and note lineage", async () => {
  const owner = await workspace();
  const openNote = await repository.saveNote(owner.principal, owner.workspaceId, note());
  const otherNote = await repository.saveNote(owner.principal, owner.workspaceId, {
    commandId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    expectedRevision: 0,
    content: { title: "Related note", transcript: "A".repeat(40_000) },
  });
  const readers = createAssistantReaders(
    { HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! } },
    owner.principal,
    owner.workspaceId,
  );

  const page = await readers.readNote(otherNote.id, "authored", undefined, 24_000, 0, 12_000);
  assert.ok("note" in page);
  assert.equal(page.section, "authored");
  assert.equal(page.note.id, otherNote.id);
  assert.equal(page.note.text.length, 12_000);
  assert.equal(page.note.nextOffset, 12_000);
  assert.equal(page.coverage, "partial");
  assert.deepEqual(assistantSourceSchema.parse(page.sources[0]), {
    kind: "note",
    id: otherNote.id,
    label: "Related note",
    revision: otherNote.revision,
  });
  const finalPage = await readers.readNote(
    otherNote.id,
    "authored",
    undefined,
    24_000,
    otherNote.transcript.length,
    100,
  );
  assert.ok("note" in finalPage);
  assert.equal(finalPage.note.text, "");
  assert.equal(finalPage.note.nextOffset, null);
  assert.equal(finalPage.coverage, "final-page");
  assert.notEqual(openNote.id, page.note.id);
});

void it("does not let workspace authorization expand to another member's note", async () => {
  const owner = await workspace();
  const target = await repository.saveNote(owner.principal, owner.workspaceId, note());
  const outsider = await workspace();
  const readers = createAssistantReaders(
    { HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! } },
    outsider.principal,
    outsider.workspaceId,
  );

  await assert.rejects(
    readers.readNote(target.id, "authored"),
    (error: unknown) => error instanceof WorkspaceError && error.code === "not_found",
  );
});

void it("pages authored Unicode text without skipping supplementary characters", async () => {
  const owner = await workspace();
  const target = await repository.saveNote(
    owner.principal,
    owner.workspaceId,
    note({
      content: { title: "Unicode", transcript: "😀a📝b" },
    }),
  );
  const readers = createAssistantReaders(
    { HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! } },
    owner.principal,
    owner.workspaceId,
  );
  const first = await readers.readNote(target.id, "authored", undefined, 24_000, 0, 2);
  assert.ok("note" in first);
  assert.equal(first.note.text, "😀a");
  assert.equal(first.note.nextOffset, 2);
  assert.equal(first.note.totalCharacters, 4);
  const second = await readers.readNote(
    target.id,
    "authored",
    undefined,
    24_000,
    first.note.nextOffset,
    2,
  );
  assert.ok("note" in second);
  assert.equal(second.note.text, "📝b");
  assert.equal(second.note.nextOffset, null);
  assert.equal(second.coverage, "final-page");
});

void it("searches workspace note content with bounded, query-scoped continuation", async () => {
  const owner = await workspace();
  const first = await repository.saveNote(owner.principal, owner.workspaceId, {
    commandId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    expectedRevision: 0,
    content: { title: "Alpha", transcript: "Contains the launch keyword." },
  });
  const second = await repository.saveNote(owner.principal, owner.workspaceId, {
    commandId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    expectedRevision: 0,
    content: { title: "Beta", transcript: "Also mentions the launch keyword." },
  });
  const evidence = createAssistantEvidenceRepository(db);
  const firstPage = await evidence.searchNotes(owner.principal, owner.workspaceId, {
    q: "launch keyword",
    limit: 1,
  });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);
  const secondPage = await evidence.searchNotes(owner.principal, owner.workspaceId, {
    q: "launch keyword",
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.nextCursor, null);
  assert.deepEqual(
    new Set([firstPage.items[0]?.id, secondPage.items[0]?.id]),
    new Set([first.id, second.id]),
  );
  await assert.rejects(
    evidence.searchNotes(owner.principal, owner.workspaceId, {
      q: "different query",
      limit: 1,
      cursor: firstPage.nextCursor,
    }),
    (error: unknown) => error instanceof WorkspaceError && error.code === "invalid_cursor",
  );
});
