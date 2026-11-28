import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { and, eq } from "drizzle-orm";

import { readAssistantTranscriptEvidence } from "../../src/db/assistant";
import { createRecordingRepository } from "../../src/db/recording-repository";
import { recordings as recordingRows } from "../../src/db/schema";
import { createTranscriptCorrectionRepository } from "../../src/db/transcript-correction-repository";
import {
  db,
  note,
  person,
  repository,
  setupDatabase,
  teardownDatabase,
  workspace,
} from "./fixture";

before(setupDatabase);
after(teardownDatabase);

void it("applies transcript filters before pagination and binds cursors to scope and generation", async () => {
  const owner = await workspace();
  const saved = await repository.saveNote(owner.principal, owner.workspaceId, note());
  const recordings = createRecordingRepository(db);
  const recordingId = crypto.randomUUID();
  await recordings.initialize(owner.principal, owner.workspaceId, saved.id, {
    id: recordingId,
    sha256: "b".repeat(64),
    bytes: 20,
    durationSeconds: 60,
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
  await recordings.publish(owner.workspaceId, run.id, "private/transcript-filter.json", [
    { start: 0, end: 3, speaker: "SPEAKER_01", text: "first matching passage" },
    { start: 4, end: 7, speaker: "SPEAKER_02", text: "different speaker passage" },
    { start: 8, end: 11, speaker: "SPEAKER_01", text: "second matching passage" },
  ]);

  const input = {
    noteId: saved.id,
    speakerLabel: "SPEAKER_01",
    startSeconds: 0,
    endSeconds: 12,
    limit: 1,
  };
  const first = await readAssistantTranscriptEvidence(
    db,
    owner.principal,
    owner.workspaceId,
    input,
  );
  assert.equal(first.passages.length, 1);
  assert.match(first.passages[0]!.text, /first matching/);
  assert.equal(first.coverage, "partial-page");
  assert.ok(first.nextCursor);

  const second = await readAssistantTranscriptEvidence(db, owner.principal, owner.workspaceId, {
    ...input,
    cursor: first.nextCursor,
  });
  assert.equal(second.passages.length, 1);
  assert.match(second.passages[0]!.text, /second matching/);
  assert.equal(second.coverage, "final-page");
  await assert.rejects(
    readAssistantTranscriptEvidence(db, owner.principal, owner.workspaceId, {
      ...input,
      speakerLabel: "SPEAKER_02",
      cursor: first.nextCursor,
    }),
    (error: { code?: string }) => error.code === "invalid_cursor",
  );
  assert.ok(first.sources[0]?.sourceUtteranceId);
  assert.equal(first.sources[0]?.revision, first.generation);
  assert.equal(first.appliedFilters.runId, run.id);
  const timeFiltered = await readAssistantTranscriptEvidence(
    db,
    owner.principal,
    owner.workspaceId,
    {
      noteId: saved.id,
      runId: run.id,
      startSeconds: 7,
      endSeconds: 12,
    },
  );
  assert.equal(timeFiltered.passages.length, 1);
  assert.equal(timeFiltered.passages[0]?.id, second.passages[0]?.id);

  // A historical recording was removed before its replacement was admitted.
  // Preserve one live recording per note while exercising implicit run selection.
  await db
    .update(recordingRows)
    .set({ deletedAt: new Date() })
    .where(
      and(eq(recordingRows.workspaceId, owner.workspaceId), eq(recordingRows.id, recordingId)),
    );
  const successorRecordingId = crypto.randomUUID();
  await recordings.initialize(owner.principal, owner.workspaceId, saved.id, {
    id: successorRecordingId,
    sha256: "c".repeat(64),
    bytes: 20,
    durationSeconds: 60,
    mimeType: "audio/webm",
  });
  await recordings.acknowledge(
    owner.principal,
    owner.workspaceId,
    saved.id,
    successorRecordingId,
    20,
  );
  const successorRun = await recordings.requestProcessing(
    owner.principal,
    owner.workspaceId,
    saved.id,
    successorRecordingId,
    crypto.randomUUID(),
  );
  await recordings.claimSubmission(owner.workspaceId, successorRun.id);
  await recordings.bindJob(owner.workspaceId, successorRun.id, crypto.randomUUID());
  await recordings.publish(
    owner.workspaceId,
    successorRun.id,
    "private/transcript-successor.json",
    [
      { start: 0, end: 3, speaker: "SPEAKER_01", text: "successor first matching passage" },
      { start: 4, end: 7, speaker: "SPEAKER_02", text: "successor different speaker passage" },
      { start: 8, end: 11, speaker: "SPEAKER_01", text: "successor second matching passage" },
    ],
  );

  const latest = await readAssistantTranscriptEvidence(
    db,
    owner.principal,
    owner.workspaceId,
    input,
  );
  assert.equal(latest.appliedFilters.runId, successorRun.id);
  assert.equal(latest.generation, first.generation);
  assert.equal(latest.passages[0]?.startSeconds, first.passages[0]?.startSeconds);
  assert.notEqual(latest.passages[0]?.id, first.passages[0]?.id);
  await assert.rejects(
    readAssistantTranscriptEvidence(db, owner.principal, owner.workspaceId, {
      ...input,
      cursor: first.nextCursor,
    }),
    (error: { code?: string }) => error.code === "invalid_cursor",
  );
  const speaker = await repository.savePerson(owner.principal, owner.workspaceId, person());
  await createTranscriptCorrectionRepository(db).command(
    owner.principal,
    owner.workspaceId,
    saved.id,
    successorRun.id,
    {
      kind: "assign",
      commandId: crypto.randomUUID(),
      targets: [
        {
          id: latest.passages[0]!.id,
          expectedAttributionRevision: latest.passages[0]!.attributionRevision,
        },
      ],
      assignment: { kind: "person", personId: speaker.id },
    },
  );
  const assigned = await readAssistantTranscriptEvidence(db, owner.principal, owner.workspaceId, {
    noteId: saved.id,
    personId: speaker.id,
  });
  assert.equal(assigned.passages.length, 1);
  assert.equal(assigned.passages[0]?.id, latest.passages[0]?.id);
  assert.equal(assigned.passages[0]?.personId, speaker.id);
  const other = await workspace();
  await assert.rejects(
    readAssistantTranscriptEvidence(db, other.principal, owner.workspaceId, { noteId: saved.id }),
    (error: { code?: string }) => error.code === "forbidden",
  );
});
