import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { WorkspaceError } from "../../src/contracts/workspace";
import { createServiceBudgetRepository } from "../../src/db/service-budgets";
import { serviceBudgetOperations, serviceBudgets } from "../../src/db/service-budget-schema";
import * as schema from "../../src/db/schema";
import { platformTables } from "./platform-tables";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/(^|[_-])test($|[_-])/.test(decodeURIComponent(new URL(url).pathname.slice(1)))) {
  throw new Error("A dedicated empty TEST_DATABASE_URL is required.");
}

const sql = postgres(url, { max: 8, prepare: false, connect_timeout: 5, onnotice: () => {} });
const db = drizzle(sql, { schema });
const repository = createServiceBudgetRepository(db);
const migrationsSchema = `service_budget_test_migrations_${randomUUID().replaceAll("-", "")}`;
const lock = await sql.reserve();
let ownsTables = false;

async function teardown() {
  try {
    if (ownsTables) {
      for (const table of [
        "service_budget_operations",
        "service_budgets",
        ...platformTables,
        "summary_inference_reservations",
        "summary_inference_budgets",
        "note_summaries",
        "analysis_jobs",
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
      await sql`drop table if exists auth.users`;
      await sql`drop schema if exists auth`;
    }
  } finally {
    await lock`select pg_advisory_unlock(72002, 1)`;
    lock.release();
    await sql.end({ timeout: 5 });
  }
}

try {
  const [result] = await lock`select pg_try_advisory_lock(72002, 1) as acquired`;
  assert.equal(result?.acquired, true, "another DB suite owns this database");
  const existing = await sql`
    select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname not in ('pg_catalog','information_schema')
      and n.nspname not like 'pg_toast%' and c.relkind in ('r','p','v','m','S')`;
  assert.equal(existing.length, 0, "refusing to migrate a nonempty database");
  const [authSchema] = await sql`select 1 from pg_namespace where nspname = 'auth'`;
  assert.equal(authSchema, undefined, "refusing to own an existing auth schema");
  ownsTables = true;
  await sql`create schema auth`;
  await sql`create table auth.users (id uuid primary key)`;
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    migrationsSchema,
  });
} catch (error) {
  await teardown();
  throw error;
}
after(teardown);

async function budget(limitUnits = 20) {
  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  const budgetId = randomUUID();
  await sql`insert into auth.users (id) values (${ownerId})`;
  await db.insert(schema.userProfiles).values({ id: ownerId });
  await db.insert(schema.workspaces).values({ id: workspaceId, ownerId });
  await db.insert(schema.workspaceMemberships).values({ workspaceId, userId: ownerId });
  // Explicit fixture seeding models authorized administrative provisioning.
  await db.insert(serviceBudgets).values({
    workspaceId,
    provider: "firecrawl",
    id: budgetId,
    limitUnits,
    approvedAt: new Date(Date.now() - 1000),
  });
  return { workspaceId, budgetId };
}

const isConflict = (error: unknown) => error instanceof WorkspaceError && error.code === "conflict";
const isUnavailable = (error: unknown) =>
  error instanceof WorkspaceError && error.code === "service_unavailable";
function databaseErrorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof error !== "object" || error === null) {
    return undefined;
  }

  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }

  if ("cause" in error) {
    return databaseErrorCode(error.cause, depth + 1);
  }

  return undefined;
}

const isConstraintViolation = (error: unknown) => databaseErrorCode(error) === "23514";

void describe("shared service-unit allowance", () => {
  void it("reserves atomically and rejects concurrent reservations beyond the allowance", async () => {
    const allowance = await budget(10);
    const requests = [randomUUID(), randomUUID()];
    const attempts = await Promise.allSettled(
      requests.map((operationId) =>
        repository.reserve({
          ...allowance,
          provider: "firecrawl",
          operationId,
          maximumUnits: 7,
        }),
      ),
    );
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
    assert.ok(
      attempts.some((result) => result.status === "rejected" && isUnavailable(result.reason)),
    );
  });

  void it("retains unknown holds and distinguishes reservation recovery from new admission", async () => {
    const allowance = await budget();
    const operationId = randomUUID();
    const reservation = {
      ...allowance,
      provider: "firecrawl" as const,
      operationId,
      maximumUnits: 7,
    };
    assert.equal((await repository.reserve(reservation)).status, "created");
    assert.equal((await repository.reserve(reservation)).status, "existing-held");
    await assert.rejects(repository.reserve({ ...reservation, maximumUnits: 8 }), isConflict);

    const [row] = await db
      .select()
      .from(serviceBudgets)
      .where(
        and(
          eq(serviceBudgets.workspaceId, allowance.workspaceId),
          eq(serviceBudgets.id, allowance.budgetId),
        ),
      );
    assert.equal(row?.reservedUnits, 7);
    assert.equal(row?.settledUnits, 0);
  });

  void it("settles known usage idempotently and rejects amounts above the reserved bound", async () => {
    const allowance = await budget();
    const operationId = randomUUID();
    await repository.reserve({
      ...allowance,
      provider: "firecrawl",
      operationId,
      maximumUnits: 7,
    });
    await assert.rejects(
      repository.settle({
        workspaceId: allowance.workspaceId,
        provider: "firecrawl",
        operationId,
        actualUnits: 8,
      }),
      isConflict,
    );

    const usage = {
      workspaceId: allowance.workspaceId,
      provider: "firecrawl" as const,
      operationId,
      actualUnits: 5,
    };
    await repository.settle(usage);
    await repository.settle(usage);
    await assert.rejects(repository.settle({ ...usage, actualUnits: 4 }), isConflict);

    const [row] = await db
      .select()
      .from(serviceBudgets)
      .where(
        and(
          eq(serviceBudgets.workspaceId, allowance.workspaceId),
          eq(serviceBudgets.id, allowance.budgetId),
        ),
      );
    assert.equal(row?.reservedUnits, 0);
    assert.equal(row?.settledUnits, 5);
  });

  void it("scopes budget and operation identities by provider", async () => {
    const allowance = await budget();
    const operationId = randomUUID();
    await assert.rejects(
      repository.reserve({
        ...allowance,
        provider: "composio",
        operationId,
        maximumUnits: 1,
      }),
      isUnavailable,
    );
    await repository.reserve({
      ...allowance,
      provider: "firecrawl",
      operationId,
      maximumUnits: 1,
    });
    await assert.rejects(
      repository.settle({
        workspaceId: allowance.workspaceId,
        provider: "composio",
        operationId,
        actualUnits: 1,
      }),
      isConflict,
    );
  });

  void it("protects approved budget identity and forbids deleting or truncating allowance history", async () => {
    const allowance = await budget();
    const operationId = randomUUID();
    await repository.reserve({
      ...allowance,
      provider: "firecrawl",
      operationId,
      maximumUnits: 7,
    });

    await assert.rejects(
      sql`update public.service_budgets
        set limit_units = limit_units + 1
        where workspace_id = ${allowance.workspaceId} and provider = 'firecrawl' and id = ${allowance.budgetId}`,
      isConstraintViolation,
    );
    await assert.rejects(
      sql`update public.service_budgets
        set approved_at = approved_at + interval '1 second'
        where workspace_id = ${allowance.workspaceId} and provider = 'firecrawl' and id = ${allowance.budgetId}`,
      isConstraintViolation,
    );

    await sql`update public.service_budgets
      set revoked_at = now()
      where workspace_id = ${allowance.workspaceId} and provider = 'firecrawl' and id = ${allowance.budgetId}`;
    await assert.rejects(
      sql`update public.service_budgets
        set revoked_at = null
        where workspace_id = ${allowance.workspaceId} and provider = 'firecrawl' and id = ${allowance.budgetId}`,
      isConstraintViolation,
    );

    await assert.rejects(
      sql`delete from public.service_budgets
        where workspace_id = ${allowance.workspaceId} and provider = 'firecrawl' and id = ${allowance.budgetId}`,
      isConstraintViolation,
    );
    await assert.rejects(
      sql`delete from public.service_budget_operations
        where workspace_id = ${allowance.workspaceId} and provider = 'firecrawl' and operation_id = ${operationId}`,
      isConstraintViolation,
    );
    await assert.rejects(sql`truncate public.service_budget_operations`, isConstraintViolation);
    await assert.rejects(
      sql`truncate public.service_budget_operations, public.service_budgets`,
      isConstraintViolation,
    );
  });

  void it("allows only one complete held-to-settled receipt update and then freezes it", async () => {
    const allowance = await budget();
    const operationId = randomUUID();
    await repository.reserve({
      ...allowance,
      provider: "firecrawl",
      operationId,
      maximumUnits: 7,
    });

    await assert.rejects(
      sql`update public.service_budget_operations
        set maximum_units = 6
        where workspace_id = ${allowance.workspaceId} and provider = 'firecrawl' and operation_id = ${operationId}`,
      isConstraintViolation,
    );

    await repository.settle({
      workspaceId: allowance.workspaceId,
      provider: "firecrawl",
      operationId,
      actualUnits: 5,
    });

    await assert.rejects(
      sql`update public.service_budget_operations
        set actual_units = 4
        where workspace_id = ${allowance.workspaceId} and provider = 'firecrawl' and operation_id = ${operationId}`,
      isConstraintViolation,
    );
    await assert.rejects(
      db
        .update(serviceBudgetOperations)
        .set({ settledAt: new Date() })
        .where(
          and(
            eq(serviceBudgetOperations.workspaceId, allowance.workspaceId),
            eq(serviceBudgetOperations.provider, "firecrawl"),
            eq(serviceBudgetOperations.operationId, operationId),
          ),
        ),
      isConstraintViolation,
    );
  });
});
