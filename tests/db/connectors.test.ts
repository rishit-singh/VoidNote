import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createAssistantRepository } from "../../src/db/assistant";
import { createConnectorRepository } from "../../src/db/connectors/repository";
import { connectorConnections } from "../../src/db/connectors-schema";
import {
  db,
  note,
  repository as workspaceRepository,
  setupDatabase,
  teardownDatabase,
  workspace,
} from "./fixture";

void before(setupDatabase);
void after(teardownDatabase);

function isUniqueConstraint(error: unknown, name: string) {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint_name" in current &&
      current.constraint_name === name
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

void test("share receipt fences replay, changed intent, and concurrent writes", async () => {
  const { principal, workspaceId } = await workspace();
  const operationId = randomUUID();
  const artifact = await createAssistantRepository(db).createArtifact(principal, workspaceId, {
    operationId: randomUUID(),
    kind: "file",
    noteId: null,
    name: "Guest brief",
    mediaType: "text/markdown",
    content: "# Guest brief\n\nValidated source-backed brief.",
    sources: [],
  });
  assert.ok(artifact.id);
  await db.insert(connectorConnections).values({
    workspaceId,
    actorId: principal.id,
    provider: "slack",
    connectedAccountId: "ca_test_owned",
    status: "connected",
  });

  const repository = createConnectorRepository(db);
  const input = {
    principal,
    workspaceId,
    operationId,
    briefId: artifact.id,
    channelId: "C_TEST",
    origin: "https://voidnote.example",
  };
  const first = await repository.beginShare(input);
  assert.equal(first.replay, false);
  assert.equal(first.receipt.status, "in_flight");

  const replay = await repository.beginShare(input);
  assert.equal(replay.replay, true);
  assert.equal(replay.receipt.status, "in_flight");

  await assert.rejects(
    repository.beginShare({ ...input, channelId: "C_CHANGED" }),
    (error: unknown) => error instanceof Error && error.name === "WorkspaceError",
  );
  await assert.rejects(
    repository.beginShare({ ...input, origin: "https://attacker.example" }),
    (error: unknown) => error instanceof Error && error.name === "WorkspaceError",
  );

  await assert.rejects(
    repository.beginShare({ ...input, operationId: randomUUID() }),
    (error: unknown) => isUniqueConstraint(error, "connector_one_in_flight_per_workspace"),
  );
  // The workspace-level unique partial index allows only one active external write.
  const receipts = await repository.listReceipts(principal, workspaceId);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.status, "in_flight");
});

void test("link receipt binds exact intent and never replays an unknown provider result", async () => {
  const { principal, workspaceId } = await workspace();
  const otherWorkspace = await workspace();
  const repository = createConnectorRepository(db);
  const linkInput = {
    principal,
    workspaceId,
    operationId: randomUUID(),
    origin: "https://voidnote.example",
    authConfigId: "auth_config_test",
  };
  const link = await repository.beginLink(linkInput);
  assert.equal(link.replay, false);
  const linkReplay = await repository.beginLink(linkInput);
  assert.equal(linkReplay.replay, true);
  await assert.rejects(
    repository.beginLink({ ...linkInput, origin: "https://attacker.example" }),
    (error: unknown) => error instanceof Error && error.name === "WorkspaceError",
  );
  await assert.rejects(
    repository.beginLink({ ...linkInput, authConfigId: "another_auth_config" }),
    (error: unknown) => error instanceof Error && error.name === "WorkspaceError",
  );
  await assert.rejects(
    repository.beginLink({
      ...linkInput,
      workspaceId: otherWorkspace.workspaceId,
      operationId: randomUUID(),
    }),
    (error: unknown) => error instanceof Error && error.name === "WorkspaceError",
  );
  await repository.finishLink(workspaceId, linkInput.operationId, { status: "unknown" });
  const unknownReplay = await repository.beginLink(linkInput);
  assert.equal(unknownReplay.replay, true);
  assert.equal(unknownReplay.receipt.status, "unknown");
  const receipts = await repository.listLinkReceipts(principal, workspaceId);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.status, "unknown");
});

void test("sent share receipt replays after source revision changes without resending", async () => {
  const { principal, workspaceId } = await workspace();
  const savedNote = await workspaceRepository.saveNote(principal, workspaceId, note());
  const artifact = await createAssistantRepository(db).createArtifact(principal, workspaceId, {
    operationId: randomUUID(),
    kind: "file",
    noteId: null,
    name: "Source-backed brief",
    mediaType: "text/markdown",
    content: "# Source-backed brief",
    sources: [
      {
        kind: "note",
        id: savedNote.id,
        label: savedNote.title,
        revision: savedNote.revision,
      },
    ],
  });
  await db.insert(connectorConnections).values({
    workspaceId,
    actorId: principal.id,
    provider: "slack",
    connectedAccountId: "ca_source_change",
    status: "connected",
  });

  const repository = createConnectorRepository(db);
  const input = {
    principal,
    workspaceId,
    operationId: randomUUID(),
    briefId: artifact.id,
    channelId: "C_SOURCE",
    origin: "https://voidnote.example",
  };
  const first = await repository.beginShare(input);
  assert.equal(first.replay, false);
  await repository.finishShare(workspaceId, input.operationId, {
    status: "sent",
    providerRequestId: "req_test",
    remoteMessageId: "msg_test",
    messageUrl: "https://slack.example/message",
  });
  await workspaceRepository.saveNote(
    principal,
    workspaceId,
    note({
      id: savedNote.id,
      expectedRevision: savedNote.revision,
      content: { title: "Updated source", transcript: "Changed after share." },
    }),
  );

  const replay = await repository.beginShare(input);
  assert.equal(replay.replay, true);
  assert.equal(replay.receipt.status, "sent");
  await assert.rejects(
    repository.beginShare({ ...input, channelId: "C_CHANGED" }),
    (error: unknown) => error instanceof Error && error.name === "WorkspaceError",
  );
});
