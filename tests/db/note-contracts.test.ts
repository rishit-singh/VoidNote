import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import {
  noteContentSchema,
  noteListItemSchema,
  noteListSchema,
  noteSchema,
  notesQuerySchema,
  saveNoteSchema,
} from "../../src/contracts/notes";
import type { NoteListItem, NoteRecord, SaveNote } from "../../src/contracts/notes";
import * as workspace from "../../src/contracts/workspace";

const record: NoteRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  title: "Long recording",
  transcript: "speech ".repeat(70_000),
  revision: 7,
  createdAt: "2026-11-14T00:00:00.000Z",
  updatedAt: "2026-11-14T01:00:00.000Z",
  deletedAt: null,
};
const metadata: NoteListItem = {
  id: record.id,
  workspaceId: record.workspaceId,
  title: record.title,
  revision: record.revision,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  deletedAt: record.deletedAt,
};

void describe("note contracts (no database)", () => {
  void it("omits large transcript content while preserving list identity, revision and cursor", (t) => {
    const previous = { items: [record], nextCursor: "opaque-query-bound-cursor" };
    const result = noteListSchema.parse(previous);

    assert.deepEqual(result, { items: [metadata], nextCursor: previous.nextCursor });
    assert.equal(Object.hasOwn(result.items[0]!, "transcript"), false);
    assert.deepEqual(noteListItemSchema.parse({ ...record, transcript: "" }), metadata);

    const beforeBytes = Buffer.byteLength(JSON.stringify(previous));
    const afterBytes = Buffer.byteLength(JSON.stringify(result));
    assert.ok(beforeBytes - afterBytes >= record.transcript.length);
    t.diagnostic(
      `Fixture-only JSON payload: ${beforeBytes} bytes before, ${afterBytes} bytes after; no production timing measurement.`,
    );
  });

  void it("requires the full transcript for detail and retains it in save commands", () => {
    const command: SaveNote = {
      commandId: "00000000-0000-4000-8000-000000000003",
      id: record.id,
      expectedRevision: record.revision,
      content: { title: record.title, transcript: record.transcript },
    };

    assert.deepEqual(noteSchema.parse(record), record);
    assert.equal(noteSchema.safeParse(metadata).success, false);
    assert.deepEqual(saveNoteSchema.parse(command), command);
    assert.equal(
      saveNoteSchema.safeParse({ ...command, content: { title: record.title } }).success,
      false,
    );
    assert.equal(saveNoteSchema.safeParse({ ...command, extra: true }).success, false);
    assert.equal(
      noteContentSchema.safeParse({ title: "", transcript: "x".repeat(500_000) }).success,
      true,
    );
    assert.equal(
      noteContentSchema.safeParse({ title: "", transcript: "x".repeat(500_001) }).success,
      false,
    );
  });

  void it("preserves the mixed workspace facade and bounded title-prefix query contract", () => {
    assert.equal(workspace.noteSchema, noteSchema);
    assert.equal(workspace.noteContentSchema, noteContentSchema);
    assert.equal(workspace.noteListItemSchema, noteListItemSchema);
    assert.equal(workspace.noteListSchema, noteListSchema);
    assert.equal(workspace.saveNoteSchema, saveNoteSchema);
    assert.equal(workspace.notesQuerySchema, notesQuerySchema);
    assert.deepEqual(notesQuerySchema.parse({}), { limit: 30, q: "" });
    assert.deepEqual(notesQuerySchema.parse({ limit: "50", cursor: "opaque", q: "A%_" }), {
      limit: 50,
      cursor: "opaque",
      q: "A%_",
    });
    assert.equal(notesQuerySchema.safeParse({ limit: 51 }).success, false);
    assert.equal(notesQuerySchema.safeParse({ limit: 0 }).success, false);
    assert.equal(notesQuerySchema.safeParse({ limit: 1.5 }).success, false);
    assert.equal(notesQuerySchema.safeParse({ cursor: "x".repeat(501) }).success, false);
    assert.equal(notesQuerySchema.safeParse({ q: "x".repeat(301) }).success, false);
  });
});
