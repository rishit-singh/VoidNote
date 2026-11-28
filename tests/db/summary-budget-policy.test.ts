import assert from "node:assert/strict";
import { test } from "node:test";

import {
  summaryBudgetPricing,
  summaryInputTokenBound,
  summaryPolicy,
  summaryPolicySchema,
  summaryReservationMicroUsd,
  summaryUsageMicroUsd,
  validSummaryUsage,
} from "../../src/ai/runtime";
import { readSummaryPolicy } from "../../src/config/summary";

const budgetId = "c43b4ace-9380-44ef-a5a9-3351adc67c3d";

void test("Summary acceptance defaults to none and only overrides reasoning when selected", () => {
  const env = {
    SUMMARY_ENABLED: "true",
    SUMMARY_MODEL: summaryBudgetPricing.model,
    SUMMARY_BUDGET_ID: budgetId,
  };
  const defaults = summaryPolicy(summaryBudgetPricing.model, budgetId);
  assert.deepEqual(readSummaryPolicy(env), defaults);
  assert.deepEqual(readSummaryPolicy({ ...env, SUMMARY_REASONING_EFFORT: "none" }), defaults);
  assert.deepEqual(readSummaryPolicy({ ...env, SUMMARY_REASONING_EFFORT: "low" }), {
    ...defaults,
    reasoningEffort: "low",
  });
});

void test("Summary acceptance fails closed for invalid or incomplete configuration", () => {
  const env = {
    SUMMARY_ENABLED: "true",
    SUMMARY_MODEL: summaryBudgetPricing.model,
    SUMMARY_BUDGET_ID: budgetId,
  };
  for (const value of ["", "LOW", "high", " low ", "invalid"]) {
    assert.equal(readSummaryPolicy({ ...env, SUMMARY_REASONING_EFFORT: value }), null);
  }
  for (const overrides of [
    { SUMMARY_ENABLED: "false" },
    { SUMMARY_MODEL: "" },
    { SUMMARY_MODEL: "invalid-model" },
    { SUMMARY_BUDGET_ID: "" },
    { SUMMARY_BUDGET_ID: "invalid-budget" },
  ]) {
    assert.equal(readSummaryPolicy({ ...env, ...overrides }), null);
  }
  assert.equal(readSummaryPolicy({}), null);
  assert.equal(readSummaryPolicy({ SUMMARY_ENABLED: "true" }), null);
});

void test("new Summary reasoning selection leaves persisted and historical policy pins intact", () => {
  const pinned = summaryPolicy(summaryBudgetPricing.model, budgetId);
  const stored = JSON.stringify(pinned);
  const historical = { ...pinned };
  delete historical.reasoningEffort;

  const selected = readSummaryPolicy({
    SUMMARY_ENABLED: "true",
    SUMMARY_MODEL: summaryBudgetPricing.model,
    SUMMARY_BUDGET_ID: budgetId,
    SUMMARY_REASONING_EFFORT: "low",
  });
  assert.equal(selected?.reasoningEffort, "low");
  assert.equal(JSON.stringify(pinned), stored);
  assert.equal(summaryPolicySchema.parse(JSON.parse(stored)).reasoningEffort, "none");
  assert.equal(summaryPolicySchema.parse(historical).reasoningEffort, undefined);
  assert.equal(summaryPolicy(summaryBudgetPricing.model, budgetId).reasoningEffort, "none");
});

void test("historical admission ceiling stays stable while new jobs pin usage accounting", () => {
  const policy = summaryPolicy(summaryBudgetPricing.model, budgetId);
  assert.equal(summaryPolicySchema.parse(JSON.parse(JSON.stringify(policy))).budgetId, budgetId);
  assert.equal(policy.budgetAccounting, "request-usage-v1");
  const reservation = summaryReservationMicroUsd(policy);
  assert.equal(reservation, 324_404);
  assert.ok(reservation * 9 <= 3_000_000);
  assert.ok(reservation * 10 > 3_000_000);
  const low = summaryPolicySchema.parse({ ...policy, reasoningEffort: "low" });
  assert.equal(policy.reasoningEffort, "none");
  assert.equal(summaryReservationMicroUsd(low), reservation);
  assert.equal(low.maxSteps, 1);
});

void test("request-sized admission includes system, messages, UTF-8 and final-answer tools", () => {
  const policy = summaryPolicy(summaryBudgetPricing.model, budgetId);
  const request = {
    prompt: [
      { role: "system", content: "Summarize faithfully." },
      { role: "user", content: "你好" },
    ],
    tools: [{ name: "think_final_answer", inputSchema: { type: "object" } }],
  };
  const bound = summaryInputTokenBound(request);
  assert.ok(bound > new TextEncoder().encode(JSON.stringify(request)).byteLength);
  assert.ok(bound > summaryInputTokenBound({ prompt: request.prompt }));
  assert.ok(summaryReservationMicroUsd(policy, bound) < 11_000);
  assert.ok(summaryReservationMicroUsd(policy, bound) > 9830);
  assert.throws(() => summaryInputTokenBound({ prompt: "x".repeat(1_048_576) }), /exceeds/);
  for (const invalid of [0, -1, NaN, Infinity, 1.5, 1_048_577]) {
    assert.throws(() => summaryReservationMicroUsd(policy, invalid), /not covered/);
  }
});

void test("settlement uses complete nonnegative provider totals and rounds only the combined cost", () => {
  assert.equal(
    summaryUsageMicroUsd(summaryBudgetPricing.model, { inputTokens: 6878, outputTokens: 1683 }),
    4083,
  );
  assert.equal(
    summaryUsageMicroUsd(summaryBudgetPricing.model, { inputTokens: 0, outputTokens: 0 }),
    0,
  );
  assert.equal(validSummaryUsage({ inputTokens: 1 }), false);
  for (const count of [-1, NaN, Infinity, 0.5, 2_147_483_648]) {
    assert.equal(validSummaryUsage({ inputTokens: count, outputTokens: 1 }), false);
  }
});

void test("unsupported models or expanded calls cannot use this pricing bound", () => {
  const policy = summaryPolicy(summaryBudgetPricing.model, budgetId);
  for (const changed of [
    { ...policy, model: "@cf/another/model" },
    { ...policy, maxSteps: 2 },
    { ...policy, maxOutputTokens: 8193 },
  ]) {
    assert.throws(() => summaryReservationMicroUsd(changed), /not covered/);
  }
  assert.equal(
    summaryPolicySchema.parse(summaryPolicy(summaryBudgetPricing.model)).budgetId,
    undefined,
  );
  assert.throws(() => summaryPolicy(summaryBudgetPricing.model, "invalid-budget"));
});
