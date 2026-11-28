import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import { researchRunPolicySchema } from "../../src/config/research-runs";

const execution = z.object({
  executionVersion: researchRunPolicySchema.shape.executionVersion,
  maxModelSteps: researchRunPolicySchema.shape.maxModelSteps,
  maxSearchCalls: researchRunPolicySchema.shape.maxSearchCalls,
  maxToolCalls: researchRunPolicySchema.shape.maxToolCalls,
});

void test("legacy pinned work keeps its original execution owner", () => {
  assert.equal(execution.parse({}).executionVersion, "workflow-v1");
  assert.equal(
    execution.parse({ executionVersion: "research-agent-v2" }).executionVersion,
    "research-agent-v2",
  );
  assert.equal(execution.safeParse({ executionVersion: "unknown" }).success, false);
});

void test("agent limits reject unbounded execution and permit search-disabled work", () => {
  assert.equal(execution.parse({ maxSearchCalls: 0 }).maxSearchCalls, 0);

  for (const invalid of [
    { maxModelSteps: 0 },
    { maxModelSteps: 25 },
    { maxToolCalls: 49 },
    { maxSearchCalls: 9 },
    { maxSearchCalls: -1 },
  ]) {
    assert.equal(execution.safeParse(invalid).success, false);
  }
});
