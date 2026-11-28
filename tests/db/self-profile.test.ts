import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { PersonRecord } from "../../src/contracts/people";
import { WorkspaceError, type Principal } from "../../src/contracts/workspace";
import {
  failInsert,
  note,
  person,
  repository as repo,
  seedAuthIdentity,
  setupDatabase,
  sql,
  teardownDatabase,
  workspace,
} from "./fixture";

try {
  await setupDatabase();
} catch (error) {
  await teardownDatabase();
  throw error;
}

const conflict = (error: unknown) => error instanceof WorkspaceError && error.code === "conflict";
const principal = (): Principal => ({ id: randomUUID(), email: "not-a-name@example.invalid" });
const pgCode = (expected: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === expected;

async function existingWorkspace() {
  const owner = principal();
  const workspaceId = randomUUID();
  await seedAuthIdentity(owner.id);
  await sql`insert into user_profiles (id, email) values (${owner.id}, ${owner.email})`;
  await sql`insert into workspaces (id, owner_id) values (${workspaceId}, ${owner.id})`;
  await sql`insert into workspace_memberships (workspace_id, user_id, role)
    values (${workspaceId}, ${owner.id}, 'owner')`;
  return { principal: owner, workspaceId };
}

void describe("self profile / real PostgreSQL", { concurrency: false }, () => {
  after(teardownDatabase);

  void it("rejects orphan identities and restricts auth deletion without losing workspace data", async () => {
    await assert.rejects(
      sql`insert into user_profiles (id) values (${randomUUID()})`,
      pgCode("23503"),
    );
    const { principal: owner, workspaceId } = await workspace();
    const self = await repo.getSelfProfile(owner, workspaceId);
    const saved = await repo.saveNote(owner, workspaceId, note());
    await assert.rejects(sql`delete from auth.users where id = ${owner.id}`, pgCode("23503"));
    assert.deepEqual(await repo.getSelfProfile(owner, workspaceId), self);
    assert.deepEqual(await repo.getNote(owner, workspaceId, saved.id), saved);
    const [identity] = await sql`select id from auth.users where id = ${owner.id}`;
    assert.equal(identity?.id, owner.id);
    const [constraint] = await sql`select convalidated, confdeltype from pg_constraint
      where conname = 'user_profiles_id_users_id_fk'`;
    assert.equal(constraint?.convalidated, true);
    assert.equal(constraint?.confdeltype, "r");
  });

  void it("keeps one account's self profiles tenant-local and revocation cannot be bootstrapped away", async () => {
    const first = await workspace();
    const second = await workspace();
    await sql`insert into workspace_memberships (workspace_id, user_id)
      values (${second.workspaceId}, ${first.principal.id})`;
    const firstSelf = await repo.getSelfProfile(first.principal, first.workspaceId);
    const secondSelf = await repo.createSelfProfile(first.principal, {
      workspaceId: second.workspaceId,
      commandId: randomUUID(),
      displayName: "Me in another workspace",
    });
    assert.ok(firstSelf);
    assert.notEqual(firstSelf.id, secondSelf.id);
    assert.equal((await repo.getSelfProfile(first.principal, first.workspaceId))?.id, firstSelf.id);
    assert.equal(
      (await repo.getSelfProfile(first.principal, second.workspaceId))?.id,
      secondSelf.id,
    );
    await assert.rejects(
      repo.linkSelfProfile(first.principal, {
        workspaceId: first.workspaceId,
        commandId: randomUUID(),
        personId: secondSelf.id,
        expectedRevision: secondSelf.revision,
        expectedSelfId: firstSelf.id,
      }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "not_found",
    );
    await sql`update workspace_memberships set revoked_at = now()
      where workspace_id = ${second.workspaceId} and user_id = ${first.principal.id}`;
    await repo.ensureWorkspace(first.principal);
    await assert.rejects(
      repo.getSelfProfile(first.principal, second.workspaceId),
      (error: unknown) => error instanceof WorkspaceError && error.code === "forbidden",
    );
    await assert.rejects(
      repo.createSelfProfile(first.principal, {
        workspaceId: second.workspaceId,
        commandId: randomUUID(),
        displayName: "Forbidden",
      }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "forbidden",
    );
    assert.deepEqual(await repo.getSelfProfile(first.principal, first.workspaceId), firstSelf);
    const [retained] = await sql`select account_id from people
      where workspace_id = ${second.workspaceId} and id = ${secondSelf.id}`;
    assert.equal(retained?.account_id, first.principal.id);
  });

  void it("bootstraps one minimal Me across simultaneous sessions and protects its deletion", async () => {
    const owner = principal();
    await seedAuthIdentity(owner.id);
    const sessions = await Promise.all(
      Array.from({ length: 5 }, () => repo.ensureWorkspace(owner)),
    );
    const workspaceId = sessions[0]!.id;
    assert.ok(sessions.every((session) => session.id === workspaceId));
    const self = await repo.getSelfProfile(owner, workspaceId);
    assert.ok(self);
    assert.equal(self.displayName, "Me");
    assert.equal(self.description, "");
    assert.equal((await repo.listPeople(owner, workspaceId, { limit: 50 })).items.length, 1);
    await assert.rejects(
      repo.deletePerson(owner, workspaceId, {
        commandId: randomUUID(),
        id: self.id,
        expectedRevision: self.revision,
      }),
      conflict,
    );
  });

  void it("leaves existing profiles unlinked and supports exact create retry", async () => {
    const { principal: owner, workspaceId } = await existingWorkspace();
    await repo.savePerson(owner, workspaceId, person());
    await repo.ensureWorkspace(owner);
    assert.equal(await repo.getSelfProfile(owner, workspaceId), null);
    const input = { workspaceId, commandId: randomUUID(), displayName: "Chosen name" };
    const results = await Promise.all([
      repo.createSelfProfile(owner, input),
      repo.createSelfProfile(owner, input),
    ]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].displayName, "Chosen name");
    await assert.rejects(
      repo.createSelfProfile(owner, { ...input, displayName: "Different payload" }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "command_reused",
    );
    await assert.rejects(
      repo.createSelfProfile(owner, { ...input, commandId: randomUUID() }),
      conflict,
    );
  });

  void it("links without changing identity/content, rejects stale tokens and preserves old profile", async () => {
    const { principal: owner, workspaceId } = await workspace();
    const oldSelf = await repo.getSelfProfile(owner, workspaceId);
    assert.ok(oldSelf);
    const target = await repo.savePerson(owner, workspaceId, person());
    const input = {
      workspaceId,
      commandId: randomUUID(),
      personId: target.id,
      expectedRevision: target.revision,
      expectedSelfId: oldSelf.id,
    };
    const linked = await repo.linkSelfProfile(owner, input);
    assert.equal(linked.id, target.id);
    assert.equal(linked.description, target.description);
    assert.equal(linked.revision, target.revision + 1);
    assert.deepEqual(await repo.getPerson(owner, workspaceId, oldSelf.id), oldSelf);
    assert.deepEqual(await repo.linkSelfProfile(owner, input), linked);
    await assert.rejects(
      repo.linkSelfProfile(owner, { ...input, commandId: randomUUID() }),
      conflict,
    );
    await assert.rejects(
      repo.linkSelfProfile(owner, {
        ...input,
        commandId: randomUUID(),
        expectedSelfId: linked.id,
      }),
      conflict,
    );
    await repo.deletePerson(owner, workspaceId, {
      commandId: randomUUID(),
      id: oldSelf.id,
      expectedRevision: oldSelf.revision,
    });
  });

  void it("serializes competing links and never steals another account's identity", async () => {
    const { principal: owner, workspaceId } = await existingWorkspace();
    const other = principal();
    await seedAuthIdentity(other.id);
    await sql`insert into user_profiles (id) values (${other.id})`;
    await sql`insert into workspace_memberships (workspace_id, user_id)
      values (${workspaceId}, ${other.id})`;
    const target = await repo.savePerson(owner, workspaceId, person());
    const input = {
      workspaceId,
      personId: target.id,
      expectedRevision: 1,
      expectedSelfId: null,
    };
    const results = await Promise.allSettled([
      repo.linkSelfProfile(owner, { ...input, commandId: randomUUID() }),
      repo.linkSelfProfile(other, { ...input, commandId: randomUUID() }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      results.filter((result) => result.status === "rejected" && conflict(result.reason)).length,
      1,
    );
    const ownerSelf = await repo.getSelfProfile(owner, workspaceId);
    const loser = ownerSelf ? other : owner;
    await assert.rejects(
      repo.linkSelfProfile(loser, { ...input, commandId: randomUUID(), expectedRevision: 2 }),
      conflict,
    );
    const outsider = principal();
    await assert.rejects(
      repo.getSelfProfile(outsider, workspaceId),
      (error: unknown) => error instanceof WorkspaceError && error.code === "forbidden",
    );
    await assert.rejects(
      repo.linkSelfProfile(outsider, { ...input, commandId: randomUUID() }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "forbidden",
    );
  });

  void it("accepts only one concurrent relink from the same observed self and rejects deleted targets", async () => {
    const { principal: owner, workspaceId } = await workspace();
    const self = await repo.getSelfProfile(owner, workspaceId);
    assert.ok(self);
    const targets = await Promise.all([
      repo.savePerson(owner, workspaceId, person()),
      repo.savePerson(owner, workspaceId, person()),
    ]);
    const results = await Promise.allSettled(
      targets.map((target) =>
        repo.linkSelfProfile(owner, {
          workspaceId,
          commandId: randomUUID(),
          personId: target.id,
          expectedRevision: target.revision,
          expectedSelfId: self.id,
        }),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      results.filter((result) => result.status === "rejected" && conflict(result.reason)).length,
      1,
    );
    const linked = await repo.getSelfProfile(owner, workspaceId);
    assert.ok(linked);
    const unlinked = targets.find((target) => target.id !== linked.id)!;
    await repo.deletePerson(owner, workspaceId, {
      commandId: randomUUID(),
      id: unlinked.id,
      expectedRevision: unlinked.revision,
    });
    await assert.rejects(
      repo.linkSelfProfile(owner, {
        workspaceId,
        commandId: randomUUID(),
        personId: unlinked.id,
        expectedRevision: unlinked.revision,
        expectedSelfId: linked.id,
      }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "not_found",
    );
    assert.deepEqual(await repo.getSelfProfile(owner, workspaceId), linked);
  });

  void it("locks former and target profiles in ascending order alongside share-lock readers", async () => {
    const { principal: owner, workspaceId } = await existingWorkspace();
    const former = await repo.savePerson(
      owner,
      workspaceId,
      person({ id: "10000000-0000-4000-8000-000000000001" }),
    );
    const target = await repo.savePerson(
      owner,
      workspaceId,
      person({ id: "20000000-0000-4000-8000-000000000001" }),
    );
    await repo.linkSelfProfile(owner, {
      workspaceId,
      commandId: randomUUID(),
      personId: former.id,
      expectedRevision: former.revision,
      expectedSelfId: null,
    });
    let relink: Promise<PromiseSettledResult<PersonRecord>[]> = Promise.resolve([]);
    await sql
      .begin(async (reader) => {
        await reader`set local statement_timeout = '3s'`;
        const [holder] = await reader<{ pid: number }[]>`
          select pg_backend_pid() as pid from people
          where workspace_id = ${workspaceId} and id = ${former.id} for share`;
        assert.ok(holder);
        relink = Promise.allSettled([
          repo.linkSelfProfile(owner, {
            workspaceId,
            commandId: randomUUID(),
            personId: target.id,
            expectedRevision: target.revision,
            expectedSelfId: former.id,
          }),
        ]);
        const deadline = Date.now() + 2_000;
        let blocked = false;
        do {
          const [waiter] = await sql`
            select pid from pg_stat_activity where datname = current_database()
            and ${holder.pid}::int = any(pg_blocking_pids(pid))`;
          if (waiter) {
            blocked = true;
            break;
          }
          await delay(10);
        } while (Date.now() < deadline);
        assert.ok(blocked, "relink must be observed waiting on the former profile lock");
        // A target-first relink already holds this row and waits on former:
        // this second share lock deterministically closes that deadlock cycle.
        const rows = await reader`
          select id from people
          where workspace_id = ${workspaceId} and id = ${target.id} for share`;
        assert.equal(rows.length, 1);
      })
      .finally(() => relink);
    const [result] = await relink;
    assert.ok(result);
    if (result.status === "rejected") {
      throw result.reason;
    }
    assert.equal(result.value.id, target.id);
    assert.equal((await repo.getSelfProfile(owner, workspaceId))?.id, target.id);
  });

  void it("rolls back a link and old identity when event publication fails", async () => {
    const { principal: owner, workspaceId } = await workspace();
    const oldSelf = await repo.getSelfProfile(owner, workspaceId);
    assert.ok(oldSelf);
    const target = await repo.savePerson(owner, workspaceId, person());
    const input = {
      workspaceId,
      commandId: randomUUID(),
      personId: target.id,
      expectedRevision: 1,
      expectedSelfId: oldSelf.id,
    };
    await failInsert("outbox", workspaceId, () =>
      assert.rejects(repo.linkSelfProfile(owner, input)),
    );
    assert.deepEqual(await repo.getSelfProfile(owner, workspaceId), oldSelf);
    assert.deepEqual(await repo.getPerson(owner, workspaceId, target.id), target);
    assert.equal((await repo.linkSelfProfile(owner, input)).id, target.id);
  });

  void it("enforces uniqueness in SQL and arbitrary person saves cannot assign account links", async () => {
    const { principal: owner, workspaceId } = await workspace();
    const command = person();
    await repo.savePerson(owner, workspaceId, {
      ...command,
      content: { ...command.content, accountId: owner.id } as typeof command.content,
    });
    const [row] = await sql`select account_id from people
      where workspace_id = ${workspaceId} and id = ${command.id}`;
    assert.equal(row!.account_id, null);
    await assert.rejects(sql`update people set account_id = ${owner.id}
      where workspace_id = ${workspaceId} and id = ${command.id}`);
  });
});
