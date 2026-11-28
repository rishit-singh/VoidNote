import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { and, eq } from "drizzle-orm";

import { WorkspaceError } from "../../src/contracts/workspace";
import { createAssistantRepository } from "../../src/db/assistant";
import { assistantProfileChanges } from "../../src/db/assistant-profiles-schema";
import { applicationEvents } from "../../src/db/activity-schema";
import { createContactRepository } from "../../src/db/contacts";
import { contactDetails } from "../../src/db/contact-schema";
import { fingerprint } from "../../src/db/assistant/shared";
import * as schema from "../../src/db/schema";
import { db, repository, setupDatabase, sql, teardownDatabase, workspace } from "./fixture";

before(setupDatabase);
after(teardownDatabase);

const assistant = createAssistantRepository(db);
const policy = { version: 1, model: "test-only", maxSteps: 1 };
const code = (expected: WorkspaceError["code"]) => (error: unknown) =>
  error instanceof WorkspaceError && error.code === expected;

async function runningTurn() {
  const owner = await workspace();
  const thread = await assistant.openThread(owner.principal, owner.workspaceId, randomUUID(), null);
  const turnId = randomUUID();
  await assistant.requestTurn(
    owner.principal,
    owner.workspaceId,
    thread.id,
    turnId,
    "Update the sourced profile",
    policy,
  );
  assert.equal(await assistant.beginTurn(owner.workspaceId, turnId), true);
  return { ...owner, thread, turnId, context: { turnId, executor: "agent" as const } };
}

const personSource = (personId: string, contactRevision: number) => ({
  kind: "person" as const,
  id: personId,
  label: "Verified profile context",
  contactRevision,
});

void describe("assistant profile persistence", () => {
  void it("replays the exact create receipt under concurrent retries without duplicate events", async () => {
    const f = await runningTurn();
    const input = {
      operationId: randomUUID(),
      displayName: "Grace Hopper",
      fields: { role: "Compiler designer" },
      sources: [{ kind: "url" as const, id: "https://example.com/grace", label: "Source" }],
    };
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        assistant.createProfile(f.principal, f.workspaceId, input, f.context),
      ),
    );

    assert.ok(outcomes.every((outcome) => outcome.person.id === outcomes[0]?.person.id));
    assert.deepEqual(
      outcomes.slice(1),
      Array.from({ length: 3 }, () => outcomes[0]),
    );
    assert.ok(outcomes.every((outcome) => outcome.contact.revision === 1));
    assert.ok(outcomes.every((outcome) => outcome.provenance.operationId === input.operationId));
    const events = await db
      .select()
      .from(applicationEvents)
      .where(
        and(
          eq(applicationEvents.workspaceId, f.workspaceId),
          eq(applicationEvents.type, "profile.changed"),
        ),
      );
    assert.equal(events.length, 1);
    assert.equal(
      (
        await db
          .select()
          .from(assistantProfileChanges)
          .where(eq(assistantProfileChanges.operationId, input.operationId))
      ).length,
      1,
    );
    await assert.rejects(
      assistant.createProfile(
        f.principal,
        f.workspaceId,
        { ...input, displayName: "Different name" },
        f.context,
      ),
      code("command_reused"),
    );
  });

  void it("refuses to overwrite a manually authored field and detects stale revisions and sources", async () => {
    const f = await runningTurn();
    const manual = await repository.savePerson(f.principal, f.workspaceId, {
      commandId: randomUUID(),
      id: randomUUID(),
      expectedRevision: 0,
      content: { displayName: "Katherine Johnson", description: "Human-authored description" },
    });
    const contacts = (await import("../../src/db/contacts")).createContactRepository(db);
    await contacts.save(f.principal, {
      workspaceId: f.workspaceId,
      personId: manual.id,
      operationId: randomUUID(),
      expectedRevision: 0,
      fields: { organization: "NASA", role: "Mathematician", links: [] },
    });
    const source = [personSource(manual.id, 1)];
    const args = {
      operationId: randomUUID(),
      personId: manual.id,
      expectedPersonRevision: manual.revision,
      expectedContactRevision: 1,
      sources: source,
      fields: { role: "Lead mathematician" },
    };

    await assert.rejects(
      assistant.updateProfile(f.principal, f.workspaceId, args, f.context),
      code("conflict"),
    );
    const [manualAfterAttempt] = await db
      .select()
      .from(schema.people)
      .where(eq(schema.people.id, manual.id));
    assert.equal(manualAfterAttempt?.description, "Human-authored description");

    const sourced = await assistant.createProfile(
      f.principal,
      f.workspaceId,
      {
        operationId: randomUUID(),
        displayName: "Dorothy Vaughan",
        fields: { organization: "NACA" },
        sources: [personSource(manual.id, 1)],
      },
      f.context,
    );
    const update = {
      operationId: randomUUID(),
      personId: sourced.person.id,
      expectedPersonRevision: sourced.person.revision,
      expectedContactRevision: sourced.contact.revision,
      sources: [personSource(manual.id, 1)],
      fields: { organization: "NASA" },
    };
    await contacts.save(f.principal, {
      workspaceId: f.workspaceId,
      personId: manual.id,
      operationId: randomUUID(),
      expectedRevision: 1,
      fields: { organization: "NASA", role: "Director", links: [] },
    });
    await assert.rejects(
      assistant.updateProfile(f.principal, f.workspaceId, update, f.context),
      code("conflict"),
    );
    await assert.rejects(
      assistant.updateProfile(
        f.principal,
        f.workspaceId,
        {
          ...update,
          operationId: randomUUID(),
          expectedContactRevision: update.expectedContactRevision + 1,
          sources: [{ kind: "url", id: "https://example.com/source", label: "Source" }],
        },
        f.context,
      ),
      code("conflict"),
    );
    await assert.rejects(
      assistant.updateProfile(
        f.principal,
        f.workspaceId,
        { ...update, operationId: randomUUID(), sources: [personSource(manual.id, 0)] },
        f.context,
      ),
      code("conflict"),
    );
  });

  void it("rejects writes from revoked memberships and canceled origin turns", async () => {
    const f = await runningTurn();
    const profile = await assistant.createProfile(
      f.principal,
      f.workspaceId,
      {
        operationId: randomUUID(),
        displayName: "Mary Jackson",
        fields: { role: "Engineer" },
        sources: [{ kind: "url", id: "https://example.com/source", label: "Source" }],
      },
      f.context,
    );
    const patch = {
      operationId: randomUUID(),
      personId: profile.person.id,
      expectedPersonRevision: profile.person.revision,
      expectedContactRevision: profile.contact.revision,
      fields: { role: "Senior engineer" },
      sources: [{ kind: "url" as const, id: "https://example.com/source", label: "Source" }],
    };
    await assistant.cancelTurn(f.principal, f.workspaceId, f.turnId);
    await assert.rejects(
      assistant.updateProfile(f.principal, f.workspaceId, patch, f.context),
      code("conflict"),
    );

    const revoked = await runningTurn();
    await db
      .update(schema.workspaceMemberships)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.workspaceMemberships.workspaceId, revoked.workspaceId),
          eq(schema.workspaceMemberships.userId, revoked.principal.id),
        ),
      );
    await assert.rejects(
      assistant.createProfile(
        revoked.principal,
        revoked.workspaceId,
        {
          operationId: randomUUID(),
          displayName: "Annie Easley",
          fields: {},
          sources: [{ kind: "url", id: "https://example.com/source", label: "Source" }],
        },
        revoked.context,
      ),
      code("forbidden"),
    );
  });

  void it("commits a profile patch and its event together, and preserves the human-authored name", async () => {
    const f = await runningTurn();
    const profile = await assistant.createProfile(
      f.principal,
      f.workspaceId,
      {
        operationId: randomUUID(),
        displayName: "Ellen Ochoa",
        fields: {},
        sources: [{ kind: "url", id: "https://example.com/source", label: "Source" }],
      },
      f.context,
    );
    const updated = await assistant.updateProfile(
      f.principal,
      f.workspaceId,
      {
        operationId: randomUUID(),
        personId: profile.person.id,
        expectedPersonRevision: profile.person.revision,
        expectedContactRevision: profile.contact.revision,
        fields: { role: "Astronaut" },
        sources: [{ kind: "url", id: "https://example.com/source", label: "Source" }],
      },
      f.context,
    );
    assert.equal(updated.person.displayName, "Ellen Ochoa");
    assert.equal(updated.contact.role, "Astronaut");
    assert.equal(updated.contact.revision, 1);

    const rows = await db
      .select()
      .from(applicationEvents)
      .where(
        and(
          eq(applicationEvents.workspaceId, f.workspaceId),
          eq(applicationEvents.type, "profile.changed"),
        ),
      );
    assert.equal(rows.length, 2, "profile creation and patch each append one application event");
    assert.ok(
      (
        await db.select().from(contactDetails).where(eq(contactDetails.personId, profile.person.id))
      )[0],
    );
  });

  void it("treats JSONB-reordered links as unchanged for assistant and human ownership", async () => {
    const f = await runningTurn();
    const links = [{ label: "Portfolio", url: "https://example.com/portfolio" }];
    const profile = await assistant.createProfile(
      f.principal,
      f.workspaceId,
      {
        operationId: randomUUID(),
        displayName: "Profile with links",
        fields: { links },
        sources: [{ kind: "url", id: "https://example.com/source", label: "Source" }],
      },
      f.context,
    );
    const [storedAssistantContact] = await db
      .select()
      .from(contactDetails)
      .where(eq(contactDetails.personId, profile.person.id));
    assert.deepEqual(Object.keys(storedAssistantContact!.links[0]!), ["url", "label"]);
    assert.equal(fingerprint(storedAssistantContact!.links), fingerprint(links));

    const assistantNoop = await assistant.updateProfile(
      f.principal,
      f.workspaceId,
      {
        operationId: randomUUID(),
        personId: profile.person.id,
        expectedPersonRevision: profile.person.revision,
        expectedContactRevision: profile.contact.revision,
        fields: { links },
        sources: [{ kind: "url", id: "https://example.com/source", label: "Source" }],
      },
      f.context,
    );
    assert.equal(assistantNoop.contact.revision, profile.contact.revision);
    const assistantChanges = await db
      .select()
      .from(assistantProfileChanges)
      .where(eq(assistantProfileChanges.personId, profile.person.id));
    assert.equal(
      assistantChanges.filter((change) => Object.keys(change.fields).length > 0).length,
      1,
      "a semantic no-op must not append another field-ownership revision",
    );

    const human = await repository.savePerson(f.principal, f.workspaceId, {
      commandId: randomUUID(),
      id: randomUUID(),
      expectedRevision: 0,
      content: { displayName: "Human-owned link profile", description: "" },
    });
    const contacts = createContactRepository(db);
    const firstContact = await contacts.save(f.principal, {
      workspaceId: f.workspaceId,
      personId: human.id,
      operationId: randomUUID(),
      expectedRevision: 0,
      fields: { organization: "", role: "", links },
    });
    const eventsBeforeNoop = await db
      .select()
      .from(applicationEvents)
      .where(
        and(
          eq(applicationEvents.workspaceId, f.workspaceId),
          eq(applicationEvents.type, "profile.changed"),
        ),
      );
    const [storedHumanContact] = await db
      .select()
      .from(contactDetails)
      .where(eq(contactDetails.personId, human.id));
    assert.deepEqual(Object.keys(storedHumanContact!.links[0]!), ["url", "label"]);

    await contacts.save(f.principal, {
      workspaceId: f.workspaceId,
      personId: human.id,
      operationId: randomUUID(),
      expectedRevision: firstContact.revision,
      fields: { organization: "", role: "", links },
    });
    assert.equal(
      (
        await db
          .select()
          .from(assistantProfileChanges)
          .where(eq(assistantProfileChanges.personId, human.id))
      ).length,
      1,
      "a semantic no-op must not claim a new human field-ownership revision",
    );
    const eventsAfterNoop = await db
      .select()
      .from(applicationEvents)
      .where(
        and(
          eq(applicationEvents.workspaceId, f.workspaceId),
          eq(applicationEvents.type, "profile.changed"),
        ),
      );
    assert.equal(eventsAfterNoop.length, eventsBeforeNoop.length);
  });

  void it("rolls profile/contact mutations back when their same-transaction event insert fails", async () => {
    const f = await runningTurn();
    const functionName = `test_fail_profile_event_${randomUUID().replaceAll("-", "")}`;
    const triggerName = `${functionName}_trigger`;
    const contacts = (await import("../../src/db/contacts")).createContactRepository(db);
    const manual = await repository.savePerson(f.principal, f.workspaceId, {
      commandId: randomUUID(),
      id: randomUUID(),
      expectedRevision: 0,
      content: { displayName: "Human profile", description: "" },
    });
    const peopleBefore = await db
      .select()
      .from(schema.people)
      .where(eq(schema.people.workspaceId, f.workspaceId));
    await sql.unsafe(`create function public.${functionName}() returns trigger language plpgsql as $$
      begin
        if NEW.workspace_id = '${f.workspaceId}'::uuid and NEW.type = 'profile.changed' then
          raise exception 'injected profile event failure' using errcode = 'P0001';
        end if;
        return NEW;
      end $$`);
    try {
      await sql.unsafe(
        `create trigger ${triggerName} before insert on public.application_events
         for each row execute function public.${functionName}()`,
      );

      await assert.rejects(
        assistant.createProfile(
          f.principal,
          f.workspaceId,
          {
            operationId: randomUUID(),
            displayName: "Test create",
            fields: { role: "Test role" },
            sources: [{ kind: "url", id: "https://example.com/source", label: "Source" }],
          },
          f.context,
        ),
      );
      assert.equal(
        (await db.select().from(schema.people).where(eq(schema.people.workspaceId, f.workspaceId)))
          .length,
        peopleBefore.length,
      );

      await assert.rejects(
        contacts.save(f.principal, {
          workspaceId: f.workspaceId,
          personId: manual.id,
          operationId: randomUUID(),
          expectedRevision: 0,
          fields: { organization: "Example", role: "Engineer", links: [] },
        }),
      );
      assert.equal(
        (await db.select().from(contactDetails).where(eq(contactDetails.personId, manual.id)))
          .length,
        0,
      );
      assert.equal(
        (
          await db
            .select()
            .from(assistantProfileChanges)
            .where(eq(assistantProfileChanges.personId, manual.id))
        ).length,
        0,
      );
    } finally {
      await sql.unsafe(`drop trigger if exists ${triggerName} on public.application_events`);
      await sql.unsafe(`drop function if exists public.${functionName}()`);
    }
  });
});
