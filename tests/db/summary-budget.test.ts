import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { platformTables } from "./platform-tables";

import { summaryPolicy, type SummaryPolicy } from "../../src/ai/runtime";
import { summaryBudgetPricing } from "../../src/ai/runtime/budget";
import type { AnalysisJobStatus } from "../../src/contracts/analysis";
import { WorkspaceError } from "../../src/contracts/workspace";
import * as schema from "../../src/db/schema";
import { createSummaryBudgetRepository } from "../../src/db/summary-budget";

// Never load application environment files or fall back to DATABASE_URL.
const url = process.env.TEST_DATABASE_URL;
if (!url || !/(^|[_-])test($|[_-])/.test(decodeURIComponent(new URL(url).pathname.slice(1)))) {
  throw new Error("A dedicated empty TEST_DATABASE_URL is required.");
}
const sql = postgres(url, { max: 12, prepare: false, connect_timeout: 5, onnotice: () => {} });
const db = drizzle(sql, { schema });
const repo = createSummaryBudgetRepository(db);
const migrationsSchema = `summary_budget_test_migrations_${randomUUID().replaceAll("-", "")}`;
const lock = await sql.reserve();
let ownsTables = false;

async function teardown() {
  try {
    if (ownsTables) {
      for (const table of [
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

const MODEL = summaryBudgetPricing.model;
const RESERVATION_MICRO_USD = 324_404;
const LIMIT_MICRO_USD = 3_000_000;
const code = (expected: WorkspaceError["code"]) => (error: unknown) =>
  error instanceof WorkspaceError && error.code === expected;

async function budget(limitMicroUsd = LIMIT_MICRO_USD) {
  const id = randomUUID();
  await db.insert(schema.summaryInferenceBudgets).values({
    id,
    model: MODEL,
    limitMicroUsd,
    reservationMicroUsd: RESERVATION_MICRO_USD,
  });
  return id;
}

async function fixture(budgetId: string) {
  const workspaceId = randomUUID();
  const actorId = randomUUID();
  const noteId = randomUUID();
  const recordingId = randomUUID();
  const runId = randomUUID();
  await sql`insert into auth.users (id) values (${actorId})`;
  await db.insert(schema.userProfiles).values({ id: actorId });
  await db.insert(schema.workspaces).values({ id: workspaceId, ownerId: actorId });
  await db.insert(schema.workspaceMemberships).values({ workspaceId, userId: actorId });
  await db.insert(schema.notes).values({
    workspaceId,
    id: noteId,
    title: "Budget test",
    transcript: "",
    revision: 1,
  });
  await db.insert(schema.recordings).values({
    workspaceId,
    id: recordingId,
    noteId,
    actorId,
    sha256: "a".repeat(64),
    bytes: 20,
    mimeType: "audio/webm",
    durationSeconds: 20,
    objectKey: `${workspaceId}/recording`,
    status: "ready",
  });
  await db.insert(schema.processingRuns).values({
    workspaceId,
    id: runId,
    noteId,
    recordingId,
    actorId,
    config: { model: "test", transcriptionModel: "test" },
    status: "succeeded",
    transcriptGeneration: 1,
  });

  return {
    workspaceId,
    async job(
      status: AnalysisJobStatus = "queued",
      policy: SummaryPolicy = { ...summaryPolicy(MODEL), budgetId },
    ) {
      const jobId = randomUUID();
      await db.insert(schema.analysisJobs).values({
        workspaceId,
        id: jobId,
        commandId: jobId,
        noteId,
        runId,
        actorId,
        status,
        source: { noteId, recordingId, runId, generation: 1 },
        policy,
      });
      return {
        budgetId,
        workspaceId,
        jobId,
        model: MODEL,
        reservationMicroUsd: RESERVATION_MICRO_USD,
      };
    },
  };
}

async function totals(budgetId: string) {
  const [row] = await sql<{ reserved: number; count: number; amount: number }[]>`
    select reserved_micro_usd as reserved,
      (select count(*)::int from summary_inference_reservations where budget_id=${budgetId}) as count,
      (select coalesce(sum(amount_micro_usd), 0)::int
        from summary_inference_reservations where budget_id=${budgetId}) as amount
    from summary_inference_budgets where id=${budgetId}`;
  assert.ok(row);
  return { reserved: row.reserved, count: row.count, amount: row.amount };
}

async function requestSizedJob(
  f: Awaited<ReturnType<typeof fixture>>,
  budgetId: string,
  amount = 1000,
) {
  return {
    ...(await f.job("running", {
      ...summaryPolicy(MODEL),
      budgetId,
      budgetAccounting: "request-usage-v1",
    })),
    accountingVersion: "request-usage-v1" as const,
    inputTokenBound: 1000,
    reservationMicroUsd: amount,
  };
}

async function settlementReceipt(input: { workspaceId: string; jobId: string; budgetId: string }) {
  const [reservation] = await db
    .select()
    .from(schema.summaryInferenceReservations)
    .where(
      and(
        eq(schema.summaryInferenceReservations.workspaceId, input.workspaceId),
        eq(schema.summaryInferenceReservations.jobId, input.jobId),
      ),
    );
  const [allowance] = await db
    .select()
    .from(schema.summaryInferenceBudgets)
    .where(eq(schema.summaryInferenceBudgets.id, input.budgetId));
  assert.ok(reservation);
  assert.ok(allowance);
  return { reservation, allowance };
}

void describe("summary inference allowance", () => {
  void it("serializes request-sized admission across workspaces against remaining funds", async () => {
    const budgetId = await budget(2500);
    const fixtures = await Promise.all([fixture(budgetId), fixture(budgetId)]);
    const requests = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        requestSizedJob(fixtures[index % fixtures.length]!, budgetId, 500),
      ),
    );
    const results = await Promise.allSettled(requests.map((input) => repo.reserve(input)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 5);
    for (const result of results) {
      if (result.status === "rejected") assert.ok(code("service_unavailable")(result.reason));
    }
    assert.deepEqual(await totals(budgetId), { reserved: 2500, count: 5, amount: 2500 });
  });

  void it("requires matching accounting versions and bounded request-sized holds", async () => {
    const budgetId = await budget();
    const f = await fixture(budgetId);
    const input = await requestSizedJob(f, budgetId);
    await assert.rejects(
      repo.reserve({ ...input, accountingVersion: undefined }),
      code("conflict"),
    );
    const legacy = await f.job();
    await assert.rejects(
      repo.reserve({ ...legacy, accountingVersion: "request-usage-v1", inputTokenBound: 1000 }),
      code("conflict"),
    );
    for (const inputTokenBound of [undefined, 0, -1, 1.5, NaN, Infinity, 1_048_577]) {
      await assert.rejects(
        repo.reserve({ ...input, inputTokenBound }),
        code("service_unavailable"),
      );
    }
    await assert.rejects(
      repo.reserve({ ...input, reservationMicroUsd: RESERVATION_MICRO_USD + 1 }),
      code("service_unavailable"),
    );
    assert.deepEqual(await totals(budgetId), { reserved: 0, count: 0, amount: 0 });
    await repo.reserve(input);
    assert.equal((await settlementReceipt(input)).reservation.inputTokenBound, 1000);
  });

  void it("settles concurrent duplicate usage once, frees the full hold, and prevents reserve replay", async () => {
    const budgetId = await budget(1000);
    const f = await fixture(budgetId);
    const input = await requestSizedJob(f, budgetId);
    await repo.reserve(input);
    const usage = { ...input, inputTokens: 100, outputTokens: 10 };
    await Promise.all(Array.from({ length: 8 }, () => repo.settle(usage)));
    const receipt = await settlementReceipt(input);
    assert.equal(receipt.allowance.reservedMicroUsd, 0);
    assert.equal(receipt.allowance.settledMicroUsd, 42);
    assert.equal(receipt.reservation.amountMicroUsd, 1000);
    assert.equal(receipt.reservation.actualMicroUsd, 42);
    assert.equal(receipt.reservation.inputTokens, 100);
    assert.equal(receipt.reservation.outputTokens, 10);
    assert.ok(receipt.reservation.settledAt);
    await assert.rejects(repo.reserve(input), code("conflict"));
    await assert.rejects(repo.settle({ ...usage, inputTokens: 101 }), code("conflict"));
    await assert.rejects(repo.settle({ ...usage, outputTokens: 11 }), code("conflict"));
    assert.deepEqual(await settlementReceipt(input), receipt);
    await repo.reserve(await requestSizedJob(f, budgetId, 958));
    await assert.rejects(
      repo.reserve(await requestSizedJob(f, budgetId, 1)),
      code("service_unavailable"),
    );
  });

  void it("records overage truth beyond the allowance and integer range, blocking future admission", async () => {
    const budgetId = await budget(1000);
    const f = await fixture(budgetId);
    const input = await requestSizedJob(f, budgetId);
    await repo.reserve(input);
    await repo.settle({ ...input, inputTokens: 2_147_483_647, outputTokens: 2_147_483_647 });
    const receipt = await settlementReceipt(input);
    assert.equal(receipt.allowance.reservedMicroUsd, 0);
    assert.equal(receipt.allowance.settledMicroUsd, 3_221_225_471);
    assert.equal(receipt.reservation.actualMicroUsd, 3_221_225_471);
    assert.equal(receipt.reservation.amountMicroUsd, 1000);
    await assert.rejects(
      repo.reserve(await requestSizedJob(f, budgetId, 1)),
      code("service_unavailable"),
    );
  });

  void it("retains holds for malformed or missing usage and accepts explicit zero usage", async () => {
    const budgetId = await budget(1000);
    const f = await fixture(budgetId);
    const input = await requestSizedJob(f, budgetId);
    await repo.reserve(input);
    const before = await settlementReceipt(input);
    for (const value of [undefined, null, "1", -1, 0.5, NaN, Infinity, 2_147_483_648]) {
      for (const field of ["inputTokens", "outputTokens"]) {
        await assert.rejects(
          repo.settle({
            ...input,
            inputTokens: 1,
            outputTokens: 1,
            [field]: value,
          }),
          code("conflict"),
        );
      }
    }
    assert.deepEqual(await settlementReceipt(input), before);
    await assert.rejects(
      repo.reserve(await requestSizedJob(f, budgetId, 1)),
      code("service_unavailable"),
    );
    await repo.settle({ ...input, inputTokens: 0, outputTokens: 0 });
    const after = await settlementReceipt(input);
    assert.equal(after.allowance.reservedMicroUsd, 0);
    assert.equal(after.allowance.settledMicroUsd, 0);
    assert.equal(after.reservation.actualMicroUsd, 0);
    assert.ok(after.reservation.settledAt);
  });

  void it("rejects missing and cross-scope reservations without releasing a hold", async () => {
    const budgetId = await budget();
    const f = await fixture(budgetId);
    const other = await fixture(budgetId);
    const input = await requestSizedJob(f, budgetId);
    await repo.reserve(input);
    const before = await settlementReceipt(input);
    const missing = await f.job();
    for (const identity of [
      { ...input, workspaceId: other.workspaceId },
      { ...input, jobId: randomUUID() },
      missing,
    ]) {
      await assert.rejects(
        repo.settle({ ...identity, inputTokens: 1, outputTokens: 1 }),
        code("conflict"),
      );
    }
    assert.deepEqual(await settlementReceipt(input), before);
  });

  void it("settles historical holds once after cancellation without changing their original amount", async () => {
    const budgetId = await budget();
    const f = await fixture(budgetId);
    const input = await f.job();
    await repo.reserve(input);
    const before = await settlementReceipt(input);
    assert.equal(before.reservation.inputTokenBound, null);
    assert.equal(before.reservation.inputTokens, null);
    assert.equal(before.reservation.outputTokens, null);
    assert.equal(before.reservation.actualMicroUsd, null);
    assert.equal(before.reservation.settledAt, null);
    await db
      .update(schema.analysisJobs)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(schema.analysisJobs.workspaceId, input.workspaceId),
          eq(schema.analysisJobs.id, input.jobId),
        ),
      );
    const usage = { ...input, inputTokens: 1, outputTokens: 1 };
    await repo.settle(usage);
    await createSummaryBudgetRepository(db).settle(usage);
    const after = await settlementReceipt(input);
    assert.equal(after.allowance.reservedMicroUsd, 0);
    assert.equal(after.allowance.settledMicroUsd, 2);
    assert.equal(after.reservation.amountMicroUsd, RESERVATION_MICRO_USD);
    assert.equal(after.reservation.inputTokenBound, null);
    await assert.rejects(repo.reserve(input), code("conflict"));
  });

  void it("rolls back both totals when persisting the settlement receipt fails", async () => {
    const budgetId = await budget();
    const f = await fixture(budgetId);
    const input = await requestSizedJob(f, budgetId);
    await repo.reserve(input);
    const before = await settlementReceipt(input);
    const trigger = `test_settle_fail_${randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(`create function public.${trigger}() returns trigger language plpgsql as $$
      begin
        if NEW.job_id = '${input.jobId}'::uuid then
          raise exception 'injected settlement update failure' using errcode = 'P0001';
        end if;
        return NEW;
      end $$`);
    try {
      await sql.unsafe(
        `create trigger ${trigger} before update on public.summary_inference_reservations
          for each row execute function public.${trigger}()`,
      );
      await assert.rejects(repo.settle({ ...input, inputTokens: 100, outputTokens: 10 }));
      assert.deepEqual(await settlementReceipt(input), before);
    } finally {
      await sql.unsafe(
        `drop trigger if exists ${trigger} on public.summary_inference_reservations`,
      );
      await sql.unsafe(`drop function public.${trigger}()`);
    }
    await repo.settle({ ...input, inputTokens: 100, outputTokens: 10 });
    const after = await settlementReceipt(input);
    assert.equal(after.allowance.reservedMicroUsd, 0);
    assert.equal(after.allowance.settledMicroUsd, 42);
    assert.equal(after.reservation.actualMicroUsd, 42);
  });

  void it("checks pinned budget and model before settling any hold", async () => {
    const budgetId = await budget();
    const f = await fixture(budgetId);
    const input = await f.job();
    await repo.reserve(input);
    const before = await settlementReceipt(input);
    for (const policy of [
      { ...summaryPolicy(MODEL), budgetId: randomUUID() },
      { ...summaryPolicy("@cf/test/other"), budgetId },
    ]) {
      await db
        .update(schema.analysisJobs)
        .set({ policy })
        .where(
          and(
            eq(schema.analysisJobs.workspaceId, input.workspaceId),
            eq(schema.analysisJobs.id, input.jobId),
          ),
        );
      await assert.rejects(
        repo.settle({ ...input, inputTokens: 100, outputTokens: 10 }),
        code("conflict"),
      );
      assert.deepEqual(await settlementReceipt(input), before);
    }
  });

  void it("admits only nine concurrent distinct jobs across workspaces under the $3 ceiling", async () => {
    const budgetId = await budget();
    const fixtures = await Promise.all([fixture(budgetId), fixture(budgetId)]);
    const requests = await Promise.all(
      Array.from({ length: 15 }, (_, index) =>
        fixtures[index % fixtures.length]!.job(index % 2 === 0 ? "queued" : "running"),
      ),
    );
    const results = await Promise.allSettled(requests.map((input) => repo.reserve(input)));
    const capacity = Math.floor(LIMIT_MICRO_USD / RESERVATION_MICRO_USD);
    assert.equal(capacity, 9);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, capacity);
    for (const result of results) {
      if (result.status === "rejected") {
        assert.ok(code("service_unavailable")(result.reason));
      }
    }
    assert.deepEqual(await totals(budgetId), {
      reserved: capacity * RESERVATION_MICRO_USD,
      count: capacity,
      amount: capacity * RESERVATION_MICRO_USD,
    });
  });

  void it("rejects concurrent duplicates and exact replay rather than authorizing another call", async () => {
    const budgetId = await budget();
    const f = await fixture(budgetId);
    const input = await f.job();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => repo.reserve(input)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    for (const result of results) {
      if (result.status === "rejected") {
        assert.ok(code("conflict")(result.reason));
      }
    }
    await assert.rejects(repo.reserve(input), code("conflict"));
    assert.deepEqual(await totals(budgetId), {
      reserved: RESERVATION_MICRO_USD,
      count: 1,
      amount: RESERVATION_MICRO_USD,
    });
  });

  void it("cannot reserve the same job under another budget even if its policy is changed", async () => {
    const originalBudgetId = await budget();
    const replacementBudgetId = await budget();
    const f = await fixture(originalBudgetId);
    const input = await f.job();
    await repo.reserve(input);
    await db
      .update(schema.analysisJobs)
      .set({ policy: { ...summaryPolicy(MODEL), budgetId: replacementBudgetId } })
      .where(
        and(
          eq(schema.analysisJobs.workspaceId, input.workspaceId),
          eq(schema.analysisJobs.id, input.jobId),
        ),
      );
    await assert.rejects(
      repo.reserve({ ...input, budgetId: replacementBudgetId }),
      code("conflict"),
    );
    assert.equal((await totals(originalBudgetId)).reserved, RESERVATION_MICRO_USD);
    assert.deepEqual(await totals(replacementBudgetId), { reserved: 0, count: 0, amount: 0 });
  });

  void it("retains an unknown provider outcome through failure and repository restart", async () => {
    const budgetId = await budget(RESERVATION_MICRO_USD);
    const f = await fixture(budgetId);
    const input = await f.job("running");
    await repo.reserve(input);
    // No provider acknowledgement arrives. Terminal failure does not release the
    // reservation, and a reconstructed repository cannot authorize a retry.
    await db
      .update(schema.analysisJobs)
      .set({ status: "failed" })
      .where(
        and(
          eq(schema.analysisJobs.workspaceId, input.workspaceId),
          eq(schema.analysisJobs.id, input.jobId),
        ),
      );
    const restarted = createSummaryBudgetRepository(db);
    await assert.rejects(restarted.reserve(input), code("conflict"));
    await assert.rejects(restarted.reserve(await f.job()), code("service_unavailable"));
    assert.deepEqual(await totals(budgetId), {
      reserved: RESERVATION_MICRO_USD,
      count: 1,
      amount: RESERVATION_MICRO_USD,
    });
  });

  void it("rejects missing budgets and mismatched pinned policies, models, and rates", async () => {
    const budgetId = await budget();
    const f = await fixture(budgetId);
    await assert.rejects(
      repo.reserve(await f.job("queued", summaryPolicy(MODEL))),
      code("conflict"),
    );
    await assert.rejects(
      repo.reserve(await f.job("queued", { ...summaryPolicy(MODEL), budgetId: randomUUID() })),
      code("conflict"),
    );
    await assert.rejects(
      repo.reserve(await f.job("queued", { ...summaryPolicy("@cf/test/other"), budgetId })),
      code("conflict"),
    );
    const input = await f.job();
    await assert.rejects(
      repo.reserve({ ...input, reservationMicroUsd: RESERVATION_MICRO_USD - 1 }),
      code("service_unavailable"),
    );
    for (const reservationMicroUsd of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
      await assert.rejects(
        repo.reserve({ ...input, reservationMicroUsd }),
        code("service_unavailable"),
      );
    }
    await assert.rejects(
      repo.reserve({ ...input, budgetId: "invalid" }),
      code("service_unavailable"),
    );
    await db
      .update(schema.summaryInferenceBudgets)
      .set({ model: "@cf/test/other" })
      .where(eq(schema.summaryInferenceBudgets.id, budgetId));
    await assert.rejects(repo.reserve(input), code("service_unavailable"));

    const missing = await fixture(randomUUID());
    await assert.rejects(repo.reserve(await missing.job()), code("service_unavailable"));
    assert.deepEqual(await totals(budgetId), { reserved: 0, count: 0, amount: 0 });
  });

  void it("rejects inactive, missing, and wrong-workspace jobs without charging the allowance", async () => {
    const budgetId = await budget();
    const f = await fixture(budgetId);
    const statuses: AnalysisJobStatus[] = [
      "succeeded",
      "failed",
      "cancelled",
      "superseded",
      "blocked",
    ];
    for (const status of statuses) {
      await assert.rejects(repo.reserve(await f.job(status)), code("conflict"));
    }
    const input = await f.job();
    await assert.rejects(repo.reserve({ ...input, jobId: randomUUID() }), code("conflict"));
    await assert.rejects(repo.reserve({ ...input, workspaceId: randomUUID() }), code("conflict"));
    assert.deepEqual(await totals(budgetId), { reserved: 0, count: 0, amount: 0 });
  });

  void it("rolls back the increment when the reservation insert fails and permits a fresh attempt", async () => {
    const budgetId = await budget();
    const f = await fixture(budgetId);
    const input = await f.job();
    const trigger = `test_budget_fail_${randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(`create function public.${trigger}() returns trigger language plpgsql as $$
      begin
        if NEW.job_id = '${input.jobId}'::uuid then
          raise exception 'injected reservation insert failure' using errcode = 'P0001';
        end if;
        return NEW;
      end $$`);
    try {
      await sql.unsafe(
        `create trigger ${trigger} before insert on public.summary_inference_reservations
          for each row execute function public.${trigger}()`,
      );
      await assert.rejects(repo.reserve(input));
      assert.deepEqual(await totals(budgetId), { reserved: 0, count: 0, amount: 0 });
    } finally {
      await sql.unsafe(
        `drop trigger if exists ${trigger} on public.summary_inference_reservations`,
      );
      await sql.unsafe(`drop function public.${trigger}()`);
    }
    await repo.reserve(input);
    assert.deepEqual(await totals(budgetId), {
      reserved: RESERVATION_MICRO_USD,
      count: 1,
      amount: RESERVATION_MICRO_USD,
    });
  });

  void it("enforces database amount bounds and reservation job identity", async () => {
    const budgetId = await budget();
    const f = await fixture(budgetId);
    const input = await f.job();
    for (const change of [
      { limitMicroUsd: 0 },
      { reservationMicroUsd: 0 },
      { reservedMicroUsd: -1 },
      { settledMicroUsd: -1 },
      { reservedMicroUsd: LIMIT_MICRO_USD + 1 },
    ]) {
      await assert.rejects(
        db
          .update(schema.summaryInferenceBudgets)
          .set(change)
          .where(eq(schema.summaryInferenceBudgets.id, budgetId)),
      );
    }
    await assert.rejects(
      db.insert(schema.summaryInferenceReservations).values({
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        budgetId,
        amountMicroUsd: 0,
      }),
    );
    await assert.rejects(
      db.insert(schema.summaryInferenceReservations).values({
        workspaceId: randomUUID(),
        jobId: input.jobId,
        budgetId,
        amountMicroUsd: RESERVATION_MICRO_USD,
      }),
    );
    assert.deepEqual(await totals(budgetId), { reserved: 0, count: 0, amount: 0 });
  });
});
