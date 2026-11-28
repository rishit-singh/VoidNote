import assert from "node:assert/strict";
import { test } from "node:test";

import {
  projectSummaryDraft,
  projectSummaryDraftV7,
  summaryDraftV7Schema,
} from "../../src/ai/summary/draft";
import { renderSummaryPrompt, resolveSummaryPrompt } from "../../src/ai/summary/instructions";
import { summaryWordBudget, summaryWordCount } from "../../src/ai/summary/limits";
import { summaryQualityFixtures } from "./fixtures/summary-quality";

function boundedFixture() {
  const context = structuredClone(summaryQualityFixtures[0]!.context);
  const words = Array.from({ length: 54 }, (_, index) => `word${index}`);
  const passage = { ...context.passages[0]!, text: words.join(" ") };
  context.passages = [passage];
  context.coverage.passageCount = 1;
  const support = [{ evidenceId: passage.evidenceId, quote: passage.text }];
  const draft = {
    claims: [
      { id: "c1", text: words.slice(0, 20).join(" "), support },
      { id: "c2", text: words.slice(20, 40).join(" "), support },
      { id: "c3", text: words.slice(40).join(" "), support },
    ],
    quickSummary: ["c1"],
    detailedSummary: ["c2"],
    decisions: ["c3"],
    actionCandidates: [],
    keywords: [],
    keyMoments: [],
    uncertainties: [],
  };

  return { context, draft, words };
}

void test("v7 renders the exact 54-source-word / 40-summary-word publication bound", () => {
  const { context, draft } = boundedFixture();
  const original = structuredClone({ context, draft });
  const rendered = renderSummaryPrompt("summary-v7", context);
  assert.match(rendered.user, /Source passage word count: 54\./u);
  assert.match(
    rendered.user,
    /Maximum combined quickSummary \+ detailedSummary prose: 40 words total/u,
  );
  assert.match(rendered.user, /floor\(0\.75 × 54\)/u);
  assert.match(
    rendered.system,
    /Count whitespace-delimited words in every selected claim occurrence/u,
  );
  assert.match(rendered.system, /repeated selections would count again/u);
  assert.match(rendered.system, /Decisions and actions may refer to separate supported claims/u);
  assert.ok(rendered.user.endsWith(JSON.stringify(context)));
  const projected = projectSummaryDraftV7(draft, context);
  assert.equal(projected.decisions[0]!.text, draft.claims[2]!.text);
  assert.deepEqual(projected, projectSummaryDraft(draft, context));
  assert.deepEqual({ context, draft }, original);
});

void test("v7 and historical projection reject the same over-budget selected prose without repair", () => {
  const { context, draft, words } = boundedFixture();
  draft.claims[1]!.text = words.slice(20, 41).join(" ");
  const original = structuredClone(draft);
  for (const project of [projectSummaryDraft, projectSummaryDraftV7]) {
    assert.throws(
      () => project(draft, context),
      /41 summary words; maximum 40 for 54 source words/u,
    );
  }
  assert.deepEqual(draft, original);

  draft.claims[0]!.text = [...words, ...words.slice(0, 19)].join(" ");
  draft.detailedSummary = [];
  assert.equal(summaryDraftV7Schema.safeParse(draft).success, true);
  assert.throws(
    () => projectSummaryDraftV7(draft, context),
    /73 summary words; maximum 40 for 54 source words/u,
  );
});

void test("v7 cardinalities admit an optional detail but never duplicate a selected claim", () => {
  const { context, draft } = boundedFixture();
  assert.equal(summaryDraftV7Schema.safeParse({ ...draft, detailedSummary: [] }).success, true);
  const concise = projectSummaryDraftV7({ ...draft, detailedSummary: [] }, context);
  assert.deepEqual(concise.detailedSummary, []);
  assert.equal(concise.quickSummary.length, 1);
  assert.equal(concise.decisions[0]!.text, draft.claims[2]!.text);
  assert.throws(() => projectSummaryDraft({ ...draft, detailedSummary: [] }, context));
  assert.equal(
    summaryDraftV7Schema.safeParse({ ...draft, quickSummary: ["c1", "c3"] }).success,
    false,
  );
  assert.equal(
    summaryDraftV7Schema.safeParse({ ...draft, detailedSummary: ["c2", "c3"] }).success,
    false,
  );
  assert.throws(
    () => projectSummaryDraftV7({ ...draft, detailedSummary: ["c1"] }, context),
    /reuses a claim/u,
  );
  assert.throws(
    () => projectSummaryDraftV7({ ...draft, decisions: ["missing-claim"] }, context),
    /dangling claim ID/u,
  );
  draft.claims[0]!.support = [
    {
      evidenceId: context.passages[0]!.evidenceId,
      quote: "This quotation is absent from the source.",
    },
  ];
  assert.throws(
    () => projectSummaryDraftV7(draft, context),
    /does not resolve to an exact snapshot quotation/u,
  );
});

void test("word budgets floor exactly, count only passage text, and retain Unicode whitespace semantics", () => {
  assert.equal(summaryWordCount("one\ttwo\nthree\u00a0four\u2003five"), 5);
  for (const [text, sourceWords, maxSummaryWords] of [
    ["", 0, 0],
    [" \n\t", 0, 0],
    ["one", 1, 0],
    ["one two", 2, 1],
    ["one two three", 3, 2],
    ["one two three four", 4, 3],
  ] as const) {
    const context = structuredClone(summaryQualityFixtures[0]!.context);
    context.passages = [{ ...context.passages[0]!, text }];
    context.coverage.passageCount = 1;
    assert.deepEqual(summaryWordBudget(context), { sourceWords, maxSummaryWords });
    assert.ok(
      renderSummaryPrompt("summary-v7", context).user.includes(
        `prose: ${maxSummaryWords} words total`,
      ),
    );
  }
});

void test("rendering preserves historical wrappers and never expands markers inside snapshot text", () => {
  const { context } = boundedFixture();
  context.passages[0]!.text = "Source {{wordBudget}} {{snapshot}} $& $` $' text.";
  for (const version of [
    "summary-v1",
    "summary-v2",
    "summary-v3",
    "summary-v4",
    "summary-v5",
    "summary-v6",
  ]) {
    const historical = resolveSummaryPrompt(version);
    assert.deepEqual(renderSummaryPrompt(version, context), {
      system: historical.system,
      user: historical.user.replace("{{snapshot}}", () => JSON.stringify(context)),
    });
  }
  const rendered = renderSummaryPrompt("summary-v7", context);
  assert.ok(rendered.user.endsWith(JSON.stringify(context)));
  assert.equal(rendered.user.match(/Source passage word count:/gu)?.length, 1);
  assert.throws(() => renderSummaryPrompt("unknown", context), /Unsupported summary prompt/);
});

void test("v8 renders the same exact budget while requesting a selective compact draft", () => {
  const { context } = boundedFixture();
  context.passages[0]!.text += " {{wordBudget}} {{snapshot}}";
  const rendered = renderSummaryPrompt("summary-v8", context);
  const budget = summaryWordBudget(context);
  assert.ok(rendered.user.includes(`prose: ${budget.maxSummaryWords} words total`));
  assert.ok(rendered.user.endsWith(JSON.stringify(context)));
  assert.equal(rendered.user.match(/Source passage word count:/gu)?.length, 1);
  assert.match(rendered.system, /at most six high-value atomic claims/u);
  assert.match(rendered.system, /at most 35 words/u);
  assert.match(rendered.system, /smallest complete exact quotation/u);
  assert.match(rendered.system, /explicit commitments or assignments only/u);
  assert.match(rendered.system, /Do not build an exhaustive inventory/u);
});
