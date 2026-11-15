import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createWorkspaceRepository } from "../../src/db/repository";
import * as schema from "../../src/db/schema";
import type { Principal, SaveNote, SavePerson } from "../../src/contracts/workspace";

// Deliberately never read DATABASE_URL or load an application's .env file.
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error(
    "TEST_DATABASE_URL is required: these tests must run against real PostgreSQL, never skip.",
  );
}
const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
if (!/(^|[_-])test($|[_-])/.test(databaseName)) {
  throw new Error(
    "TEST_DATABASE_URL must name a dedicated test database (for example voidnote_test).",
  );
}

export const sql = postgres(url, { max: 12, prepare: false, connect_timeout: 5 });
export const db = drizzle(sql, { schema });
export const repository = createWorkspaceRepository(db);
const migrationsSchema = `test_migrations_${randomUUID().replaceAll("-", "")}`;
let ownsTables = false;
let lock: Awaited<ReturnType<typeof sql.reserve>> | undefined;

export async function setupDatabase() {
  lock = await sql.reserve();
  const [result] = await lock`select pg_try_advisory_lock(72002, 1) as acquired`;
  assert.equal(result?.acquired, true, "another integration suite already owns this database");
  const existing = await sql`
    select n.nspname, c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname not like 'pg_toast%'
      and c.relkind in ('r', 'p', 'v', 'm', 'S')`;
  assert.equal(
    existing.length,
    0,
    "refusing to migrate a nonempty database; provision a fresh dedicated test DB",
  );
  ownsTables = true;
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    migrationsSchema,
  });
}

export async function teardownDatabase() {
  try {
    if (ownsTables) {
      // Only objects created after the empty-database check are ours to remove.
      for (const table of [
        "transcript_correction_outbox",
        "transcript_sample_candidates",
        "transcript_corrections",
        "transcript_segments",
        "processing_outbox",
        "recording_events",
        "transcript_utterances",
        "processing_runs",
        "recordings",
        "outbox",
        "domain_events",
        "command_receipts",
        "people",
        "notes",
        "workspace_memberships",
        "workspaces",
        "user_profiles",
      ]) {
        await sql`drop table if exists ${sql(`public.${table}`)}`;
      }
      await sql`drop schema if exists ${sql(migrationsSchema)} cascade`;
    }
  } finally {
    if (lock) {
      await lock`select pg_advisory_unlock(72002, 1)`;
      lock.release();
    }
    await sql.end({ timeout: 5 });
  }
}

export async function workspace() {
  const principal: Principal = { id: randomUUID(), email: `test-${randomUUID()}@example.invalid` };
  const record = await repository.ensureWorkspace(principal);
  return { principal, workspaceId: record.id };
}

export function note(overrides: Partial<SaveNote> = {}): SaveNote {
  return {
    commandId: randomUUID(),
    id: randomUUID(),
    expectedRevision: 0,
    content: {
      title: "A note",
      transcript: "Original transcript",
    },
    ...overrides,
  };
}

export function person(overrides: Partial<SavePerson> = {}): SavePerson {
  return {
    commandId: randomUUID(),
    id: randomUUID(),
    expectedRevision: 0,
    content: { displayName: "Ada Lovelace", description: "A workspace-local person" },
    ...overrides,
  };
}

export async function counts(workspaceId: string) {
  const [result] = await sql`
    select
      (select count(*)::int from notes where workspace_id = ${workspaceId}) as notes,
      (select count(*)::int from people where workspace_id = ${workspaceId}) as people,
      (select count(*)::int from domain_events where workspace_id = ${workspaceId}) as events,
      (select count(*)::int from command_receipts where workspace_id = ${workspaceId}) as receipts,
      (select count(*)::int from outbox where workspace_id = ${workspaceId}) as outbox`;
  assert.ok(result);
  return { ...result };
}

/** A real late SQL failure, rather than a mock of the transaction machinery. */
export async function failInsert<T>(
  table: "outbox" | "command_receipts",
  workspaceId: string,
  run: () => Promise<T>,
) {
  const name = `test_fail_${randomUUID().replaceAll("-", "")}`;
  await sql.unsafe(`create function public.${name}() returns trigger language plpgsql as $$
    begin
      if NEW.workspace_id = '${workspaceId}'::uuid then
        raise exception 'injected late insert failure' using errcode = 'P0001';
      end if;
      return NEW;
    end $$`);
  try {
    await sql.unsafe(
      `create trigger ${name} before insert on public.${table} for each row execute function public.${name}()`,
    );
    return await run();
  } finally {
    await sql.unsafe(`drop trigger if exists ${name} on public.${table}`);
    await sql.unsafe(`drop function public.${name}()`);
  }
}
