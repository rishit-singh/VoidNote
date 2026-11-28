import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { createContactRepository } from "../../src/db/contacts";
import { db, person, repository, setupDatabase, teardownDatabase, workspace } from "./fixture";

await setupDatabase();
after(teardownDatabase);

void test("contact fields are scoped, revisioned and exact-replay safe", async () => {
  const owner = await workspace();
  const other = await workspace();
  const saved = await repository.savePerson(owner.principal, owner.workspaceId, person());
  const contacts = createContactRepository(db);
  const command = {
    workspaceId: owner.workspaceId,
    personId: saved.id,
    operationId: randomUUID(),
    expectedRevision: 0,
    fields: {
      organization: "Analytical Engines",
      role: "Engineer",
      links: [{ label: "Website", url: "https://example.com/ada" }],
    },
  };
  const first = await contacts.save(owner.principal, command);

  assert.equal(first.revision, 1);
  assert.deepEqual(await contacts.save(owner.principal, command), first);
  await assert.rejects(
    contacts.save(owner.principal, {
      ...command,
      fields: { ...command.fields, role: "Invented" },
    }),
    /identity was reused/,
  );
  await assert.rejects(
    contacts.save(owner.principal, {
      ...command,
      operationId: randomUUID(),
    }),
    /changed/,
  );
  await assert.rejects(
    contacts.getMany(other.principal, owner.workspaceId, [saved.id]),
    /unavailable/,
  );

  const [current] = await contacts.getMany(owner.principal, owner.workspaceId, [saved.id]);

  assert.equal(current?.role, "Engineer");
  assert.equal(current?.personRevision, saved.revision);

  const newer = await contacts.save(owner.principal, {
    ...command,
    operationId: randomUUID(),
    expectedRevision: first.revision,
    fields: { ...command.fields, role: "Lead engineer" },
  });
  const replay = await contacts.save(owner.principal, command);

  assert.deepEqual(replay, newer, "lost old acknowledgement must recover the current projection");
});

void test("concurrent detail writes cannot both claim the same revision", async () => {
  const owner = await workspace();
  const saved = await repository.savePerson(owner.principal, owner.workspaceId, person());
  const contacts = createContactRepository(db);
  const outcomes = await Promise.allSettled(
    ["First", "Second"].map((role) =>
      contacts.save(owner.principal, {
        workspaceId: owner.workspaceId,
        personId: saved.id,
        operationId: randomUUID(),
        expectedRevision: 0,
        fields: { organization: "", role, links: [] },
      }),
    ),
  );

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
});
