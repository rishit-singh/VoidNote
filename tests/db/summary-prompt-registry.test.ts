import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { SUMMARY_PROMPT_VERSION } from "../../src/contracts/analysis";
import { summaryPolicy, summaryPolicySchema } from "../../src/ai/runtime";
import {
  resolveSummaryPrompt,
  summaryInstructions,
  summaryPromptRegistry,
} from "../../src/ai/summary/instructions";

void test("resolves frozen historical and current prompts", () => {
  for (const version of ["summary-unknown", "__proto__", "constructor", "toString"]) {
    assert.throws(() => resolveSummaryPrompt(version), /Unsupported summary prompt version/);
  }
  assert.equal(resolveSummaryPrompt("summary-v1"), summaryPromptRegistry["summary-v1"]);
  assert.equal(
    createHash("sha256").update(resolveSummaryPrompt("summary-v1").system).digest("hex"),
    "5462a1338b589ae7ff8342b5caa1ee90c3fdac392f135346cb08557e12050edf",
  );
  assert.equal(
    createHash("sha256").update(resolveSummaryPrompt("summary-v1").user).digest("hex"),
    "a7ecda87ba2cd64e751cf760a52816d350d9b65471cdec83b02fcb5911cebee4",
  );
  assert.equal(summaryInstructions, resolveSummaryPrompt("summary-v1").system);
  for (const version of ["summary-v1", "summary-v2"] as const) {
    assert.equal(resolveSummaryPrompt(version), summaryPromptRegistry[version]);
  }
  assert.match(
    resolveSummaryPrompt("summary-v1").system,
    /VoidNote summary instructions summary-v1\./,
  );
  assert.match(resolveSummaryPrompt("summary-v1").user, /Analyze every passage/);
  assert.match(resolveSummaryPrompt("summary-v2").user, /\{\{snapshot\}\}/);
  assert.equal(
    createHash("sha256").update(resolveSummaryPrompt("summary-v2").system).digest("hex"),
    "ce81c43c68626027e5f19a33760576742b8589264f7cb43076e46e4f1fa780e3",
  );
  assert.equal(
    createHash("sha256").update(resolveSummaryPrompt("summary-v2").user).digest("hex"),
    "c885f818ef0e816a59799f6c3f61a888d141bec5244100000c546653f9119abb",
  );
  assert.equal(SUMMARY_PROMPT_VERSION, "summary-v8");
  assert.equal(resolveSummaryPrompt("summary-v3"), summaryPromptRegistry["summary-v3"]);
  assert.equal(
    createHash("sha256").update(resolveSummaryPrompt("summary-v3").system).digest("hex"),
    "fe906012d5fccf595da60812d92824d99081154c92298c1fce5e8671c28d5aca",
  );
  assert.equal(
    createHash("sha256").update(resolveSummaryPrompt("summary-v3").user).digest("hex"),
    "f6b2233c37f9d15c663cba5d7a8b5e927521e66a6b7d9cc1120c0b785a9fdadd",
  );
  assert.match(resolveSummaryPrompt("summary-v3").system, /substantive ambiguity/);
  assert.match(resolveSummaryPrompt("summary-v3").system, /preserve rejected proposals/);
  assert.equal(resolveSummaryPrompt("summary-v4"), summaryPromptRegistry["summary-v4"]);
  assert.equal(
    createHash("sha256").update(resolveSummaryPrompt("summary-v4").system).digest("hex"),
    "be7344d94e3b38feb2b32017380a7f96723eb1cd63811c0c795a944bdd57ec32",
  );
  assert.equal(
    createHash("sha256").update(resolveSummaryPrompt("summary-v4").user).digest("hex"),
    "f6b2233c37f9d15c663cba5d7a8b5e927521e66a6b7d9cc1120c0b785a9fdadd",
  );
  const concise = resolveSummaryPrompt("summary-v4").system;
  assert.match(concise, /150 words or fewer/u);
  assert.match(concise, /Never expose person IDs, provider track IDs/u);
  assert.match(concise, /Never infer or state gender/u);
  assert.match(concise, /never say that there was no agenda/u);
  assert.match(concise, /Preserve material conditions, negation/u);
  assert.match(concise, /75% of the source/u);
  assert.match(concise, /smallest complete supporting quotation/u);
  assert.match(concise, /“I have not investigated”/u);
  assert.match(concise, /Keep memoryCandidates empty/u);
  assert.match(concise, /no more than two keyMoments/u);
  assert.equal(
    createHash("sha256").update(resolveSummaryPrompt("summary-v5").system).digest("hex"),
    "7d472eb3e0096cf8c002306c03c45617299514dfe7fbe7c9886731ab20187dc4",
  );
  assert.equal(
    createHash("sha256").update(resolveSummaryPrompt("summary-v5").user).digest("hex"),
    "00509d9364a0885582eabc624abaf1db01414fa800764d5d87a53768bd7c4b89",
  );
});

void test("v6 remains frozen and new v8 jobs retain the bounded one-step policy", () => {
  const prompt = resolveSummaryPrompt("summary-v6");
  assert.match(prompt.system, /summary-v6/u);
  assert.match(
    prompt.system,
    /quickSummary, detailedSummary, and decisions are arrays of claim IDs/u,
  );
  assert.match(prompt.system, /decisions \["c3"\]/u);
  assert.match(prompt.system, /Use decisions: \[\]/u);
  assert.match(prompt.user, /existing claims\[\]\.id/u);
  assert.match(prompt.user, /never prose/u);
  assert.equal(
    createHash("sha256").update(prompt.system).digest("hex"),
    "c0142a9960dcb77b9419189948df3c258366caf5f7decc79b40866ade3982715",
  );
  assert.equal(
    createHash("sha256").update(prompt.user).digest("hex"),
    "76066bfb5c4e5426df110bfa28bbbc5535b771b564ee076f19080bdcabbced7c",
  );

  const policy = summaryPolicy("@cf/fixture/summary", "10000000-0000-4000-8000-000000000001");
  assert.equal(policy.promptVersion, "summary-v8");
  assert.equal(policy.maxSteps, 1);
  assert.equal(policy.reasoningEffort, "none");
  assert.equal(policy.maxOutputTokens, 8192);
  assert.equal(policy.maxContextBytes, 64_000);
  assert.equal(policy.budgetAccounting, "request-usage-v1");
  assert.equal(summaryPolicy("@cf/fixture/summary").reasoningEffort, "none");
  const historical = { ...policy, promptVersion: "summary-v5" };
  delete historical.reasoningEffort;
  assert.deepEqual(summaryPolicySchema.parse(historical), historical);
});

void test("v7 prompt templates are immutable", () => {
  const prompt = resolveSummaryPrompt("summary-v7");
  assert.equal(
    createHash("sha256").update(prompt.system).digest("hex"),
    "1210237db0bc2979fad98f6300f2f776e264c0c9d22105a16c3fd1b6586cff8d",
  );
  assert.equal(
    createHash("sha256").update(prompt.user).digest("hex"),
    "007c1b91bc10100e3d8d3620213b2de39f574da80355a6e0a59f48d8743c6533",
  );
});
