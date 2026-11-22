import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { createRecordingRepository } from "../../../src/db/recording-repository";
import { createWorkspaceRepository } from "../../../src/db/repository";
import * as schema from "../../../src/db/schema";
import { createTranscriptCorrectionRepository } from "../../../src/db/transcript-correction-repository";
import { conversation, proof } from "./fixture";

const url = new URL(process.env.SUMMARY_PROOF_DATABASE_URL ?? "");
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
assert.equal(url.pathname, "/voidnote_summary_proof_test");
const client = postgres(url.toString(), { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema });

try {
  const existing = await client`
    select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname not in ('pg_catalog','information_schema')
      and n.nspname not like 'pg_toast%' and c.relkind in ('r','p','v','m','S')`;
  assert.equal(existing.length, 0, "Refusing to reseed or migrate a nonempty proof database.");
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)),
  });
  await db.insert(schema.userProfiles).values(proof.principal);
  await db.insert(schema.workspaces).values({ id: proof.workspaceId, ownerId: proof.principal.id });
  await db.insert(schema.workspaceMemberships).values({
    workspaceId: proof.workspaceId,
    userId: proof.principal.id,
    role: "owner",
  });
  const workspace = createWorkspaceRepository(db);
  await workspace.saveNote(proof.principal, proof.workspaceId, {
    id: proof.noteId,
    commandId: randomUUID(),
    expectedRevision: 0,
    content: { title: "Synthetic Maple pilot decision", transcript: "" },
  });
  // The proof starts at finalized transcript publication; it does not claim
  // uploaded audio, transcription-provider output or acoustic verification.
  await db.insert(schema.recordings).values({
    workspaceId: proof.workspaceId,
    id: proof.recordingId,
    noteId: proof.noteId,
    actorId: proof.principal.id,
    sha256: "a".repeat(64),
    bytes: 1,
    mimeType: "audio/webm",
    durationSeconds: 120,
    objectKey: "synthetic/no-audio",
    status: "ready",
  });
  await db.insert(schema.processingRuns).values({
    workspaceId: proof.workspaceId,
    id: proof.runId,
    noteId: proof.noteId,
    recordingId: proof.recordingId,
    actorId: proof.principal.id,
    config: { model: "synthetic", transcriptionModel: "synthetic" },
    status: "submitted",
    providerJobId: randomUUID(),
  });
  await createRecordingRepository(db).publish(
    proof.workspaceId,
    proof.runId,
    "synthetic/no-provider-payload",
    conversation,
  );
  const turns = await db
    .select()
    .from(schema.transcriptUtterances)
    .where(eq(schema.transcriptUtterances.runId, proof.runId));
  const corrections = createTranscriptCorrectionRepository(db);
  for (const person of proof.people) {
    await workspace.savePerson(proof.principal, proof.workspaceId, {
      id: person.id,
      commandId: randomUUID(),
      expectedRevision: 0,
      content: { displayName: person.name, description: person.role },
    });
    await corrections.command(proof.principal, proof.workspaceId, proof.noteId, proof.runId, {
      kind: "assign",
      commandId: randomUUID(),
      targets: turns
        .filter((turn) => turn.speakerLabel === person.track)
        .map((turn) => ({ id: turn.id, expectedAttributionRevision: 0 })),
      assignment: { kind: "person", personId: person.id },
    });
  }
  console.log(
    JSON.stringify({ seeded: true, workspaceId: proof.workspaceId, passages: turns.length }),
  );
} finally {
  await client.end({ timeout: 5 });
}
