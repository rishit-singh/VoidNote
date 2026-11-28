import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySummaryFailure,
  classifyThinkSubmissionError,
  summaryFailureMessage,
  summaryPublicationFailureMessage,
} from "../../src/ai/summary/failure.ts";
import { SummaryOutputValidationError } from "../../src/ai/summary/output.ts";

void test("publication validation is recognized through the observed Workflow wrappers", () => {
  const rejection = new SummaryOutputValidationError();
  for (const error of [
    rejection,
    new Error(rejection.message),
    new Error(`NonRetryableError: ${rejection.message}`),
    new Error(
      `Step threw a NonRetryableError with message "NonRetryableError: ${rejection.message}"`,
    ),
  ]) {
    assert.equal(
      summaryPublicationFailureMessage(error),
      "The generated Summary did not pass source-evidence validation. No automatic model retry was issued.",
    );
  }
});

void test("publication diagnosis does not reinterpret or return arbitrary private error text", () => {
  for (const error of [
    new Error("Provider request failed with private payload."),
    new Error(`Private payload: ${new SummaryOutputValidationError().message}`),
    new Error("Private quote does not resolve to source."),
    new Error("x".repeat(1024)),
    { message: "Untrusted non-error object" },
    null,
  ]) {
    assert.equal(summaryPublicationFailureMessage(error), undefined);
  }
});

void test("output cap without finish reason is inferred only from complete cap usage and no final answer", () => {
  const evidence = classifySummaryFailure({
    finalAnswerPresent: false,
    outputTokenLimit: 8192,
    usage: {
      inputTokens: 19797,
      outputTokens: 8192,
      cachedInputTokens: 120,
      reasoningTokens: 40,
    },
  });
  assert.deepEqual(evidence, {
    kind: "output_limit",
    confidence: "inferred",
    usage: {
      inputTokens: 19797,
      outputTokens: 8192,
      cachedInputTokens: 120,
      reasoningTokens: 40,
    },
  });
  assert.match(summaryFailureMessage(evidence), /likely reached/);
});

void test("finish reason and usage fields are allowlisted, absent fields stay absent", () => {
  assert.deepEqual(
    classifySummaryFailure({
      finishReason: "length",
      finalAnswerPresent: false,
      usage: { outputTokens: 8192, cachedInputTokens: 0 },
    }),
    {
      kind: "output_limit",
      confidence: "provider",
      finishReason: "length",
      usage: { outputTokens: 8192, cachedInputTokens: 0 },
    },
  );
  assert.deepEqual(classifySummaryFailure({ usage: { outputTokens: -1, reasoningTokens: 1.5 } }), {
    kind: "provider",
    confidence: "provider",
  });
});

void test("uncertain usage or absent final answer evidence is not upgraded to output limit", () => {
  assert.equal(
    classifySummaryFailure({
      finalAnswerPresent: false,
      outputTokenLimit: 8192,
      usage: { inputTokens: 10 },
    }).kind,
    "missing_final_answer",
  );
  assert.equal(
    classifySummaryFailure({
      finalAnswerPresent: false,
      outputTokenLimit: 8192,
      usage: { outputTokens: 8191 },
    }).confidence,
    "provider",
  );
});

void test("Think errors map only by bounded signatures and arbitrary payloads are not returned", () => {
  assert.equal(
    classifyThinkSubmissionError("think_final_answer was not found in the response"),
    "missing_final_answer",
  );
  assert.equal(
    classifyThinkSubmissionError(
      "Model response did not contain a call to the required tool 'think_final_answer'.",
    ),
    "missing_final_answer",
  );
  assert.equal(classifyThinkSubmissionError("output does not match schema"), "schema");
  assert.equal(classifyThinkSubmissionError("upstream provider request failed"), "provider");
  assert.equal(classifyThinkSubmissionError("secret transcript: ..."), undefined);
  assert.equal(classifyThinkSubmissionError("x".repeat(513)), undefined);
});
