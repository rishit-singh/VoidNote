import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PERSON_DESCRIPTION_PREVIEW_LENGTH,
  peopleQuerySchema,
  personContentSchema,
  personListItemSchema,
  personListSchema,
  personSchema,
  savePersonSchema,
  toPersonListItem,
  type PersonRecord,
  type SavePerson,
} from "../../src/contracts/people";
import * as workspace from "../../src/contracts/workspace";

const record: PersonRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  displayName: "Ada Lovelace",
  description: "Detailed biography. ".repeat(250),
  revision: 7,
  createdAt: "2026-11-14T00:00:00.000Z",
  updatedAt: "2026-11-14T01:00:00.000Z",
  deletedAt: null,
};

void describe("people contracts (no database)", () => {
  void it("projects list identity, revision and timestamps without leaking full descriptions", () => {
    const item = toPersonListItem(record);
    const expected = {
      id: record.id,
      workspaceId: record.workspaceId,
      displayName: record.displayName,
      descriptionPreview: record.description.slice(0, 160),
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt,
    };
    assert.deepEqual(item, expected);
    assert.equal(Object.hasOwn(item, "description"), false);
    assert.deepEqual(personListItemSchema.parse({ ...record, ...item }), expected);
    assert.deepEqual(
      personListSchema.parse({ items: [{ ...record, ...item }], nextCursor: "opaque" }),
      { items: [expected], nextCursor: "opaque" },
    );
    assert.equal(personListItemSchema.safeParse(record).success, false);
    assert.equal(personSchema.safeParse(item).success, false);
  });

  void it("bounds previews by Unicode code points without splitting surrogate pairs", () => {
    assert.equal(PERSON_DESCRIPTION_PREVIEW_LENGTH, 160);
    for (const [description, expected] of [
      ["", ""],
      ["Short biography", "Short biography"],
      ["😀".repeat(161), "😀".repeat(160)],
      [`${"a".repeat(159)}😀tail`, `${"a".repeat(159)}😀`],
      [`${"a".repeat(159)}e\u0301tail`, `${"a".repeat(159)}e`],
    ]) {
      const item = toPersonListItem({ ...record, description: description! });
      assert.equal(item.descriptionPreview, expected);
      assert.equal(personListItemSchema.safeParse(item).success, true);
    }
    assert.equal(
      personListItemSchema.safeParse({
        ...toPersonListItem(record),
        descriptionPreview: "😀".repeat(161),
      }).success,
      false,
    );
  });

  void it("retains full detail and save content with the existing validation bounds", () => {
    const command: SavePerson = {
      commandId: "00000000-0000-4000-8000-000000000003",
      id: record.id,
      expectedRevision: record.revision,
      content: { displayName: record.displayName, description: record.description },
    };
    assert.deepEqual(personSchema.parse(record), record);
    assert.deepEqual(savePersonSchema.parse(command), command);
    assert.equal(savePersonSchema.safeParse({ ...command, extra: true }).success, false);
    assert.equal(
      savePersonSchema.safeParse({ ...command, content: toPersonListItem(record) }).success,
      false,
    );
    assert.deepEqual(personContentSchema.parse({ displayName: " Ada ", description: " " }), {
      displayName: "Ada",
      description: " ",
    });
    for (const [description, valid] of [
      ["x".repeat(5_000), true],
      ["x".repeat(5_001), false],
    ] as const) {
      assert.equal(
        personContentSchema.safeParse({ displayName: "Ada", description }).success,
        valid,
      );
    }
  });

  void it("preserves the explicit workspace facade and bounded prefix-query contract", () => {
    assert.equal(workspace.personSchema, personSchema);
    assert.equal(workspace.personContentSchema, personContentSchema);
    assert.equal(workspace.personListItemSchema, personListItemSchema);
    assert.equal(workspace.personListSchema, personListSchema);
    assert.equal(workspace.savePersonSchema, savePersonSchema);
    assert.equal(workspace.peopleQuerySchema, peopleQuerySchema);
    assert.equal(workspace.toPersonListItem, toPersonListItem);
    assert.equal(workspace.PERSON_DESCRIPTION_PREVIEW_LENGTH, PERSON_DESCRIPTION_PREVIEW_LENGTH);
    assert.deepEqual(peopleQuerySchema.parse({}), { limit: 30, q: "" });
    assert.deepEqual(peopleQuerySchema.parse({ limit: "50", cursor: "opaque", q: "A%_" }), {
      limit: 50,
      cursor: "opaque",
      q: "A%_",
    });
    for (const invalid of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { cursor: "x".repeat(501) },
      { q: "x".repeat(201) },
    ]) {
      assert.equal(peopleQuerySchema.safeParse(invalid).success, false);
    }
  });
});
