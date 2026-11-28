import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, it } from "node:test";

import { assistantToolSchemas, assistantToolSchemasV3 } from "../../src/ai/assistant/tools";
import { WorkspaceError } from "../../src/contracts/workspace";
import { createAssistantRepository } from "../../src/db/assistant";
import { createContactRepository } from "../../src/db/contacts";
import { db, note, repository, setupDatabase, sql, teardownDatabase, workspace } from "./fixture";

// Reproduce the live tool input shapes using fresh synthetic identities only.
// This suite uses the isolated fixture database, never acceptance proof data.
before(setupDatabase);
after(teardownDatabase);

const assistant = createAssistantRepository(db);

async function fixture() {
  const owner = await workspace();
  const saved = await repository.saveNote(owner.principal, owner.workspaceId, note());
  const thread = await assistant.openThread(
    owner.principal,
    owner.workspaceId,
    randomUUID(),
    saved.id,
  );
  const turnId = randomUUID();
  await assistant.requestTurn(
    owner.principal,
    owner.workspaceId,
    thread.id,
    turnId,
    "Synthetic tool boundary regression",
    { version: 1, model: "test-only", maxSteps: 3 },
  );
  await assistant.beginTurn(owner.workspaceId, turnId);
  return { ...owner, note: saved, thread, context: { turnId } };
}

async function remember(f: Awaited<ReturnType<typeof fixture>>) {
  return assistant.remember(
    f.principal,
    f.workspaceId,
    {
      operationId: randomUUID(),
      ...assistantToolSchemas.memory_remember.parse({
        subjectId: null,
        kind: "preference",
        content: "Prefers interview preparation delivered as a short checklist.",
        provenance: "user-stated",
        sources: [],
        expiresAt: null,
      }),
    },
    f.context,
  );
}

async function profileUpdateCompletion(f: Awaited<ReturnType<typeof fixture>>) {
  const person = await repository.savePerson(f.principal, f.workspaceId, {
    commandId: randomUUID(),
    id: randomUUID(),
    expectedRevision: 0,
    content: { displayName: "Ada", description: "" },
  });
  const oldProfileSource = {
    kind: "person" as const,
    id: person.id,
    label: person.displayName,
    revision: person.revision,
    contactRevision: 0,
  };
  const evidenceSource = {
    kind: "note" as const,
    id: f.note.id,
    label: f.note.title,
    revision: f.note.revision,
  };
  const firstOperationId = randomUUID();
  const firstInput = assistantToolSchemasV3.contacts_update.parse({
    personId: person.id,
    expectedPersonRevision: person.revision,
    expectedContactRevision: 0,
    fields: { role: "Analyst" },
    sources: [evidenceSource],
  });
  const firstResult = await assistant.updateProfile(
    f.principal,
    f.workspaceId,
    { ...firstInput, operationId: firstOperationId },
    { turnId: f.context.turnId, executor: "agent" },
  );
  const secondOperationId = randomUUID();
  const secondInput = assistantToolSchemasV3.contacts_update.parse({
    personId: person.id,
    expectedPersonRevision: person.revision,
    expectedContactRevision: firstResult.contact.revision,
    fields: { organization: "Example Labs" },
    sources: [evidenceSource],
  });
  const secondResult = await assistant.updateProfile(
    f.principal,
    f.workspaceId,
    { ...secondInput, operationId: secondOperationId },
    { turnId: f.context.turnId, executor: "agent" },
  );
  const currentProfileSource = {
    kind: "person" as const,
    id: person.id,
    label: person.displayName,
    revision: person.revision,
    contactRevision: secondResult.contact.revision,
  };

  return {
    person,
    oldProfileSource,
    evidenceSource,
    currentProfileSource,
    completion: {
      text: "Ada is an analyst.",
      tools: [
        {
          id: randomUUID(),
          name: "contacts_get",
          status: "succeeded" as const,
          summary: "Read Ada's current profile.",
          sources: [oldProfileSource],
        },
        {
          id: firstOperationId,
          name: "contacts_update",
          status: "succeeded" as const,
          summary: "Updated Ada's sourced profile facts.",
          sources: [
            ...firstResult.provenance.sources,
            { ...currentProfileSource, contactRevision: firstResult.contact.revision },
          ],
        },
        {
          id: secondOperationId,
          name: "contacts_update",
          status: "succeeded" as const,
          summary: "Updated Ada's sourced organization.",
          sources: [...secondResult.provenance.sources, currentProfileSource],
        },
      ],
      sources: [
        oldProfileSource,
        ...firstResult.provenance.sources,
        ...secondResult.provenance.sources,
        currentProfileSource,
      ],
      profileMutations: [
        {
          name: "contacts_update" as const,
          operationId: firstOperationId,
          input: firstInput,
        },
        {
          name: "contacts_update" as const,
          operationId: secondOperationId,
          input: secondInput,
        },
      ],
    },
  };
}

void it("new authored-note input cannot use the opened note as its destination; rejection commits no effects", async () => {
  const f = await fixture();
  const input = {
    operationId: randomUUID(),
    ...assistantToolSchemas.artifact_create.parse({
      kind: "note",
      noteId: f.note.id,
      name: "Synthetic acceptance checklist",
      mediaType: "text/markdown",
      content: "- [ ] Review pilot permissions\n- [ ] Confirm support owner\n",
      sources: [{ kind: "note", id: f.note.id, noteId: f.note.id, label: "Opened meeting note" }],
    }),
  };
  await assert.rejects(
    assistant.createArtifact(f.principal, f.workspaceId, input, f.context),
    (error: unknown) =>
      error instanceof WorkspaceError &&
      error.code === "conflict" &&
      error.message === "New authored notes require an empty note ID",
  );
  const [rejected] = await sql`
    select
      (select count(*)::int from assistant_operation_receipts where workspace_id=${f.workspaceId}) as receipts,
      (select count(*)::int from assistant_artifacts where workspace_id=${f.workspaceId}) as artifacts,
      (select count(*)::int from notes where workspace_id=${f.workspaceId}) as notes`;
  assert.deepEqual({ ...rejected }, { receipts: 0, artifacts: 0, notes: 1 });

  // A separately identified, corrected command creates a new note. It never
  // overwrites the opened note or changes its transcript.
  const corrected = { ...input, operationId: randomUUID(), noteId: null };
  const result = await assistant.createArtifact(f.principal, f.workspaceId, corrected, f.context);
  assert.equal(result.kind, "note");
  assert.ok(result.noteId);
  assert.notEqual(result.noteId, f.note.id);
  const created = await repository.getNote(f.principal, f.workspaceId, result.noteId);
  assert.equal(created.transcript, "");
  assert.equal(created.title, input.name);
  assert.deepEqual(await repository.getNote(f.principal, f.workspaceId, f.note.id), f.note);
  assert.equal(
    (await assistant.createArtifact(f.principal, f.workspaceId, corrected, f.context)).id,
    result.id,
  );
});

void it("self-sourced memory revision is rejected atomically; independent provenance revises the same identity once", async () => {
  const f = await fixture();
  const memory = await remember(f);
  const input = assistantToolSchemas.memory_revise.parse({
    memoryId: memory.id,
    expectedRevision: 1,
    content: "User prefers interview preparation delivered as a short narrative, not a checklist.",
    sources: [
      {
        kind: "memory",
        id: memory.id,
        label: "interview preparation format preference",
        revision: 1,
      },
    ],
    reason: "User explicitly changed their preferred interview preparation format.",
  });
  const operationId = randomUUID();
  await assert.rejects(
    assistant.reviseMemory(
      f.principal,
      f.workspaceId,
      input.memoryId,
      input.expectedRevision,
      input.content,
      input.sources,
      input.reason,
      operationId,
      f.context,
    ),
    (error: unknown) =>
      error instanceof WorkspaceError &&
      error.code === "conflict" &&
      error.message === "Memory cannot depend on its own revision",
  );
  assert.deepEqual(await assistant.recall(f.principal, f.workspaceId, ""), [memory]);
  const [rejected] = await sql`
    select
      (select count(*)::int from assistant_operation_receipts where workspace_id=${f.workspaceId} and operation_id=${operationId}) as receipts,
      (select count(*)::int from assistant_memory_revisions where workspace_id=${f.workspaceId}) as revisions`;
  assert.deepEqual({ ...rejected }, { receipts: 0, revisions: 1 });

  const correctedOperationId = randomUUID();
  const revise = () =>
    assistant.reviseMemory(
      f.principal,
      f.workspaceId,
      memory.id,
      1,
      input.content,
      [],
      input.reason,
      correctedOperationId,
      f.context,
    );
  const revised = await revise();
  assert.equal(revised.id, memory.id);
  assert.equal(revised.status, "active");
  assert.equal(revised.provenance, "user-stated");
  assert.equal(revised.revision, 2);
  assert.deepEqual(await revise(), revised);
  assert.deepEqual(await assistant.recall(f.principal, f.workspaceId, ""), [revised]);
  const [counts] = await sql`
    select
      (select count(*)::int from assistant_memories where workspace_id=${f.workspaceId}) as memories,
      (select count(*)::int from assistant_memory_revisions where workspace_id=${f.workspaceId}) as revisions`;
  assert.deepEqual({ ...counts }, { memories: 1, revisions: 2 });
});

void it("acknowledged same-turn profile update replaces the prior contact revision at publication", async () => {
  const f = await fixture();
  const { completion, currentProfileSource, oldProfileSource, evidenceSource } =
    await profileUpdateCompletion(f);

  assert.equal(
    (await assistant.completeTurn(f.workspaceId, f.context.turnId, completion))?.status,
    "succeeded",
  );
  const history = await assistant.history(f.principal, f.workspaceId, f.thread.id);
  const published = history.messages.find(
    (message) => message.turnId === f.context.turnId && message.role === "assistant",
  )!;
  assert.ok(
    published.sources.some(
      (source) =>
        source.kind === "person" &&
        source.id === currentProfileSource.id &&
        source.revision === currentProfileSource.revision &&
        source.contactRevision === currentProfileSource.contactRevision,
    ),
  );
  assert.ok(
    !published.sources.some(
      (source) =>
        source.kind === "person" &&
        source.id === oldProfileSource.id &&
        source.contactRevision === oldProfileSource.contactRevision,
    ),
  );
  assert.ok(
    published.sources.some((source) => source.kind === "note" && source.id === evidenceSource.id),
    "independent profile evidence remains in published lineage",
  );
});

void it("a later user contact edit prevents profile source supersession", async () => {
  const f = await fixture();
  const proof = await profileUpdateCompletion(f);
  await createContactRepository(db).save(f.principal, {
    workspaceId: f.workspaceId,
    personId: proof.person.id,
    operationId: randomUUID(),
    expectedRevision: proof.currentProfileSource.contactRevision,
    fields: { organization: "User-authored", role: "Lead", links: [] },
  });

  await assert.rejects(
    assistant.completeTurn(f.workspaceId, f.context.turnId, proof.completion),
    (error: unknown) => error instanceof WorkspaceError && error.code === "conflict",
  );
});

void it("zero literal recall matches do not imply an active memory was removed", async () => {
  const f = await fixture();
  const memory = await remember(f);
  const input = assistantToolSchemas.memory_recall.parse({
    subjectId: null,
    query: "interview preparation format preference",
    limit: 10,
  });
  assert.deepEqual(
    await assistant.recall(f.principal, f.workspaceId, input.query, input.subjectId ?? undefined),
    [],
  );
  assert.deepEqual(await assistant.recall(f.principal, f.workspaceId, "interview preparation"), [
    memory,
  ]);
  assert.deepEqual(await assistant.recall(f.principal, f.workspaceId, ""), [memory]);
});
