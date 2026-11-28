import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";

import { observeInferenceUsage } from "../../src/ai/inference";
import { WorkspaceError } from "../../src/contracts/workspace";
import { createInferenceRepository } from "../../src/db/inference";
import { inferenceBudgets, inferenceRates, inferenceReceipts } from "../../src/db/inference-schema";
import { db, setupDatabase, sql, teardownDatabase, workspace } from "./fixture";

await setupDatabase();
after(teardownDatabase);

const repository = createInferenceRepository(db);
const MODEL = "test/inference-model";
const code = (expected: WorkspaceError["code"]) => (error: unknown) =>
  error instanceof WorkspaceError && error.code === expected;

async function fixture(
  options: {
    limitMicroUsd?: number;
    inputRate?: number;
    outputRate?: number;
    revokedAt?: Date;
  } = {},
) {
  const { workspaceId } = await workspace();
  const rateVersionId = randomUUID();
  const budgetId = randomUUID();
  await db.insert(inferenceRates).values({
    id: rateVersionId,
    provider: "test-provider",
    model: MODEL,
    currency: "USD",
    inputMicroUsdPerMillionTokens: options.inputRate ?? 1_000_000,
    outputMicroUsdPerMillionTokens: options.outputRate ?? 1_000_000,
  });
  await db.insert(inferenceBudgets).values({
    workspaceId,
    id: budgetId,
    rateVersionId,
    limitMicroUsd: options.limitMicroUsd ?? 1000,
    approvedAt: new Date(),
    revokedAt: options.revokedAt ?? null,
  });

  return {
    workspaceId,
    budgetId,
    rateVersionId,
    requestId: randomUUID(),
    model: MODEL,
    inputTokenBound: 60,
    maxOutputTokens: 40,
  };
}

void describe("reusable inference admission", () => {
  void it("serializes concurrent requests against the remaining approved budget", async () => {
    const input = await fixture({ limitMicroUsd: 500 });
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => repository.reserve({ ...input, requestId: randomUUID() })),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 5);
    for (const result of results) {
      if (result.status === "rejected") {
        assert.ok(code("service_unavailable")(result.reason));
      }
    }
    const availability = await repository.getBudgetAvailability(input);
    assert.equal(availability?.reservedMicroUsd, 500);
    assert.equal(availability?.availableMicroUsd, 0);
  });

  void it("admits a request once even when concurrent replays name different budgets", async () => {
    const input = await fixture();
    const otherBudgetId = randomUUID();
    await db.insert(inferenceBudgets).values({
      workspaceId: input.workspaceId,
      id: otherBudgetId,
      rateVersionId: input.rateVersionId,
      limitMicroUsd: 1000,
      approvedAt: new Date(),
    });
    const results = await Promise.allSettled([
      repository.reserve(input),
      repository.reserve({ ...input, budgetId: otherBudgetId }),
      repository.reserve(input),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    for (const result of results) {
      if (result.status === "rejected") {
        assert.ok(code("conflict")(result.reason));
      }
    }
    const totals = await Promise.all([
      repository.getBudgetAvailability(input),
      repository.getBudgetAvailability({ ...input, budgetId: otherBudgetId }),
    ]);
    assert.equal(
      totals.reduce((sum, value) => sum + (value?.reservedMicroUsd ?? 0), 0),
      100,
    );
  });

  void it("rolls back the hold when receipt persistence fails, allowing safe first admission", async () => {
    const input = await fixture();
    const trigger = `inference_fail_${randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(`create function public.${trigger}() returns trigger language plpgsql as $$
      begin
        if NEW.request_id = '${input.requestId}'::uuid then
          raise exception 'injected receipt failure';
        end if;
        return NEW;
      end $$`);
    try {
      await sql.unsafe(
        `create trigger ${trigger} before insert on inference_receipts for each row execute function public.${trigger}()`,
      );
      await assert.rejects(repository.reserve(input));
      assert.equal((await repository.getBudgetAvailability(input))?.reservedMicroUsd, 0);
    } finally {
      await sql.unsafe(`drop trigger if exists ${trigger} on inference_receipts`);
      await sql.unsafe(`drop function public.${trigger}()`);
    }
    const receipt = await repository.reserve(input);
    assert.equal(receipt.reservedMicroUsd, 100);
  });

  void it("pins settlement to the accepted rate despite a newer price for the same model", async () => {
    const input = await fixture();
    const receipt = await repository.reserve(input);
    await db.insert(inferenceRates).values({
      id: randomUUID(),
      provider: "test-provider",
      model: MODEL,
      currency: "USD",
      inputMicroUsdPerMillionTokens: 20_000_000,
      outputMicroUsdPerMillionTokens: 20_000_000,
    });
    const settled = await repository.settle({ ...input, inputTokens: 10, outputTokens: 20 });
    assert.equal(settled.actualMicroUsd, 30);
    assert.equal(settled.rateVersionId, receipt.rateVersionId);
    assert.equal(
      (await repository.getRate(input.rateVersionId))?.inputMicroUsdPerMillionTokens,
      1_000_000,
    );
    assert.equal(await repository.getRate(randomUUID()), null);
    await assert.rejects(repository.reserve(input), code("conflict"));
  });

  void it("settles explicit zero exactly once while preserving a permanent non-replayable receipt", async () => {
    const input = await fixture();
    await repository.reserve(input);
    const settlements = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.settle({ ...input, inputTokens: 0, outputTokens: 0 }),
      ),
    );
    for (const receipt of settlements) {
      assert.equal(receipt.actualMicroUsd, 0);
      assert.ok(receipt.settledAt);
    }
    const totals = await repository.getBudgetAvailability(input);
    assert.equal(totals?.settledMicroUsd, 0);
    assert.equal(totals?.reservedMicroUsd, 0);
    assert.equal(totals?.availableMicroUsd, 1000);
    await assert.rejects(repository.reserve(input), code("conflict"));
    await assert.rejects(
      repository.settle({ ...input, inputTokens: 1, outputTokens: 0 }),
      code("conflict"),
    );
  });

  void it("accounts for overages as debt and blocks even zero-cost admission after exhaustion", async () => {
    const input = await fixture({ limitMicroUsd: 100 });
    await repository.reserve(input);
    const settled = await repository.settle({ ...input, inputTokens: 100, outputTokens: 100 });
    assert.equal(settled.actualMicroUsd, 200);
    const totals = await repository.getBudgetAvailability(input);
    assert.equal(totals?.settledMicroUsd, 200);
    assert.equal(totals?.reservedMicroUsd, 0);
    assert.equal(totals?.availableMicroUsd, 0);
    await assert.rejects(
      repository.reserve({
        ...input,
        requestId: randomUUID(),
        inputTokenBound: 0,
        maxOutputTokens: 0,
      }),
      code("service_unavailable"),
    );
  });

  void it("rejects missing, revoked, wrong-scope and mismatched price/model approvals", async () => {
    const input = await fixture();
    const other = await fixture({ revokedAt: new Date() });
    for (const invalid of [
      { ...input, budgetId: randomUUID() },
      { ...input, rateVersionId: other.rateVersionId },
      { ...input, model: "another-model" },
      { ...input, workspaceId: other.workspaceId },
      other,
    ]) {
      await assert.rejects(repository.reserve(invalid), code("service_unavailable"));
    }
    assert.equal(
      await repository.getBudgetAvailability({ ...input, workspaceId: other.workspaceId }),
      null,
    );
    assert.equal((await repository.getBudgetAvailability(other))?.approved, false);
    await repository.reserve(input);
    await assert.rejects(
      repository.settle({
        ...input,
        workspaceId: other.workspaceId,
        inputTokens: 0,
        outputTokens: 0,
      }),
      code("conflict"),
    );
  });

  void it("keeps uncertain holds for incomplete raw usage, failures and invalid counts", async () => {
    const input = await fixture();
    await repository.reserve(input);
    const binding = observeInferenceUsage(
      { run: () => Promise.resolve({ usage: { prompt_tokens: 0 } }) } as unknown as Ai,
      async (usage) => {
        await repository.settle({ ...input, ...usage });
      },
    );
    await binding.run("@cf/test/inference", { prompt: "fixture" });
    for (const inputTokens of [NaN, -1, 0.5, 2_147_483_648]) {
      await assert.rejects(
        repository.settle({ ...input, inputTokens, outputTokens: 0 }),
        code("conflict"),
      );
    }
    assert.equal((await repository.getBudgetAvailability(input))?.reservedMicroUsd, 100);
    await assert.rejects(repository.reserve(input), code("conflict"));
  });

  void it("settles admitted usage after approval revocation without authorizing more work", async () => {
    const input = await fixture();
    await repository.reserve(input);
    await db
      .update(inferenceBudgets)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(inferenceBudgets.workspaceId, input.workspaceId),
          eq(inferenceBudgets.id, input.budgetId),
        ),
      );
    await repository.settle({ ...input, inputTokens: 20, outputTokens: 20 });
    const availability = await repository.getBudgetAvailability(input);
    assert.equal(availability?.settledMicroUsd, 40);
    assert.equal(availability?.availableMicroUsd, 0);
    await assert.rejects(
      repository.reserve({ ...input, requestId: randomUUID() }),
      code("service_unavailable"),
    );
  });

  void it("rejects unsafe costs atomically and retains holds when settlement totals overflow", async () => {
    const input = await fixture({
      limitMicroUsd: Number.MAX_SAFE_INTEGER,
      inputRate: Number.MAX_SAFE_INTEGER,
      outputRate: 0,
    });
    await assert.rejects(
      repository.reserve({ ...input, inputTokenBound: 1_000_001, maxOutputTokens: 0 }),
      /accounting range/,
    );
    assert.equal((await repository.getBudgetAvailability(input))?.reservedMicroUsd, 0);
    await repository.reserve({ ...input, inputTokenBound: 1, maxOutputTokens: 0 });
    await repository.settle({ ...input, inputTokens: 999_999, outputTokens: 0 });
    const next = { ...input, requestId: randomUUID(), inputTokenBound: 0, maxOutputTokens: 0 };
    await repository.reserve(next);
    await assert.rejects(
      repository.settle({ ...next, inputTokens: 2, outputTokens: 0 }),
      code("conflict"),
    );
    const [receipt] = await db
      .select()
      .from(inferenceReceipts)
      .where(
        and(
          eq(inferenceReceipts.workspaceId, next.workspaceId),
          eq(inferenceReceipts.requestId, next.requestId),
        ),
      );
    assert.equal(receipt?.settledAt, null);
  });

  void it("database rejects rate mutation, receipt deletion and settled receipt rewrites", async () => {
    const input = await fixture();
    await repository.reserve(input);
    await assert.rejects(
      sql`update inference_rates set input_micro_usd_per_million_tokens = 1 where id = ${input.rateVersionId}`,
    );
    await assert.rejects(sql`delete from inference_rates where id = ${input.rateVersionId}`);
    await assert.rejects(
      sql`delete from inference_receipts where workspace_id = ${input.workspaceId} and request_id = ${input.requestId}`,
    );
    await assert.rejects(
      sql`update inference_receipts set input_token_bound = 1 where workspace_id = ${input.workspaceId} and request_id = ${input.requestId}`,
    );
    await repository.settle({ ...input, inputTokens: 10, outputTokens: 10 });
    await assert.rejects(
      sql`update inference_receipts set input_tokens = 11 where workspace_id = ${input.workspaceId} and request_id = ${input.requestId}`,
    );
    const unusedRateId = randomUUID();
    await db.insert(inferenceRates).values({
      id: unusedRateId,
      provider: "test-provider",
      model: MODEL,
      currency: "USD",
      inputMicroUsdPerMillionTokens: 0,
      outputMicroUsdPerMillionTokens: 0,
    });
    await assert.rejects(sql`delete from inference_rates where id = ${unusedRateId}`);
    await assert.rejects(
      sql`insert into inference_rates
        (id, provider, model, currency, input_micro_usd_per_million_tokens, output_micro_usd_per_million_tokens)
        values (${randomUUID()}, 'test-provider', ${MODEL}, 'USD', 9007199254740992, 0)`,
    );
  });
});
