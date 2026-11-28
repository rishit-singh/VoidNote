import assert from "node:assert/strict";
import { test } from "node:test";

import {
  inferenceInputTokenBound,
  inferenceUsageMicroUsd,
  observeInferenceUsage,
  validInferenceUsage,
} from "../../src/ai/inference";
import type { InferenceRate, InferenceUsage } from "../../src/ai/inference";

const rate: InferenceRate = {
  id: "test-version",
  provider: "test-provider",
  model: "test-model",
  currency: "USD",
  inputMicroUsdPerMillionTokens: 300_000,
  outputMicroUsdPerMillionTokens: 1_200_000,
};
const policy = {
  maxInputTokens: 16_000,
  maxOutputTokens: 1000,
  contextWindowTokens: 17_000,
};

void test("integer pricing rounds the combined cost once and preserves large products exactly", () => {
  assert.equal(inferenceUsageMicroUsd(rate, { inputTokens: 0, outputTokens: 0 }), 0);
  assert.equal(inferenceUsageMicroUsd(rate, { inputTokens: 1, outputTokens: 1 }), 2);
  const large = {
    ...rate,
    inputMicroUsdPerMillionTokens: Number.MAX_SAFE_INTEGER,
    outputMicroUsdPerMillionTokens: 1,
  };
  assert.equal(
    inferenceUsageMicroUsd(large, { inputTokens: 999_999, outputTokens: 1 }),
    9_007_190_247_541_737,
  );
  assert.throws(
    () => inferenceUsageMicroUsd(large, { inputTokens: 1_000_001, outputTokens: 0 }),
    /accounting range/,
  );
});

void test("invalid, missing and overflowing usage and prices never become zero-cost evidence", () => {
  for (const value of [-1, 0.1, NaN, Infinity, 2_147_483_648]) {
    assert.equal(validInferenceUsage({ inputTokens: value, outputTokens: 0 }), false);
    assert.throws(() => inferenceUsageMicroUsd(rate, { inputTokens: 0, outputTokens: value }));
  }
  assert.equal(validInferenceUsage({ inputTokens: 0 }), false);
  assert.equal(validInferenceUsage({ outputTokens: 0 }), false);
  assert.equal(validInferenceUsage({ inputTokens: 0, outputTokens: 0 }), true);
  for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() =>
      inferenceUsageMicroUsd(
        { ...rate, inputMicroUsdPerMillionTokens: value },
        { inputTokens: 0, outputTokens: 0 },
      ),
    );
  }
});

void test("final-request estimate includes UTF-8 history and tool schemas, rejecting policy excess", () => {
  const request = {
    prompt: [
      { role: "system", content: "instructions" },
      { role: "user", content: "私人" },
      { role: "tool", content: "complete retrieved result" },
    ],
    tools: [{ name: "search", inputSchema: { type: "object" } }],
  };
  const bound = inferenceInputTokenBound(request, policy);
  assert.equal(bound, new TextEncoder().encode(JSON.stringify(request)).byteLength + 2048);
  assert.ok(bound > inferenceInputTokenBound({ prompt: request.prompt }, policy));
  assert.equal(inferenceInputTokenBound(request, { ...policy, maxInputTokens: bound }), bound);
  assert.throws(() => inferenceInputTokenBound(request, { ...policy, maxInputTokens: bound - 1 }));
  assert.throws(() =>
    inferenceInputTokenBound(request, {
      ...policy,
      contextWindowTokens: bound + policy.maxOutputTokens - 1,
    }),
  );
  assert.throws(() => inferenceInputTokenBound(request, { ...policy, maxOutputTokens: -1 }));
  assert.throws(() =>
    inferenceInputTokenBound(
      { prompt: [{ type: "image", image: "https://example.invalid" }] },
      policy,
    ),
  );
  assert.throws(() => inferenceInputTokenBound({ prompt: new Uint8Array(4) }, policy));
});

void test("application usage adapter ignores incomplete raw usage and accepts explicit zero", async () => {
  const receipts: InferenceUsage[] = [];
  for (const usage of [
    undefined,
    {},
    { prompt_tokens: 10 },
    { completion_tokens: 10 },
    { prompt_tokens: 0, completion_tokens: null },
    { prompt_tokens: 0, completion_tokens: 0 },
  ]) {
    const binding = observeInferenceUsage(
      { run: () => Promise.resolve({ response: "fixture", usage }) } as unknown as Ai,
      (value) => {
        receipts.push(value);
      },
    );
    await binding.run("@cf/test/inference", { prompt: "fixture" });
  }
  assert.deepEqual(receipts, [{ inputTokens: 0, outputTokens: 0 }]);
});
