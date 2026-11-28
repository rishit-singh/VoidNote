import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";

import { summaryAnalysisSchema } from "../../src/contracts/analysis";
import {
  interpretSummaryOutput,
  summaryModelOutputSchema,
  SummaryOutputValidationError,
} from "../../src/ai/summary/output";
import { summaryQualityFixtures } from "./fixtures/summary-quality";

void test("historical prompt pins retain their original model and publication contract", () => {
  const fixture = summaryQualityFixtures[0]!;
  const output = fixture.controls.find((control) => control.kind === "authored-positive")!.output;
  for (const version of ["summary-v1", "summary-v2", "summary-v3", "summary-v4"]) {
    assert.deepEqual(summaryModelOutputSchema(version).parse(output), output);
    assert.deepEqual(interpretSummaryOutput(version, output, fixture.context), output);
    assert.equal(
      summaryModelOutputSchema(version).safeParse({ ...output, detailedSummary: [] }).success,
      false,
    );
    assert.throws(
      () => interpretSummaryOutput(version, { ...output, detailedSummary: [] }, fixture.context),
      SummaryOutputValidationError,
    );
  }
  assert.throws(
    () => interpretSummaryOutput("summary-v5", output, fixture.context),
    SummaryOutputValidationError,
  );
});

void test("the public DTO accepts empty detail while still requiring quick-summary evidence", () => {
  const fixture = summaryQualityFixtures[0]!;
  const output = fixture.controls.find((control) => control.kind === "authored-positive")!.output;
  const concise = { ...output, detailedSummary: [] };
  assert.deepEqual(summaryAnalysisSchema.parse(concise), concise);
  assert.equal(summaryAnalysisSchema.safeParse({ ...concise, quickSummary: [] }).success, false);
  assert.equal(
    summaryAnalysisSchema.safeParse({
      ...concise,
      quickSummary: [{ ...concise.quickSummary[0]!, citations: [] }],
    }).success,
    false,
  );
});
void test("model schema selection rejects unknown pins and exports the private v5 contract", () => {
  assert.throws(() => summaryModelOutputSchema("__proto__"), /Unsupported/);
  const schema = z.toJSONSchema(summaryModelOutputSchema("summary-v5"));
  assert.ok(schema.required?.includes("claims"));
  assert.ok(schema.required?.includes("actionCandidates"));
  assert.ok(!schema.required?.includes("memoryCandidates"));
  assert.equal(
    createHash("sha256").update(JSON.stringify(schema)).digest("hex"),
    "d09e80b6dd1f8ddbfc6bf5973df149fbec7cd23f87870fade9070fab215840e9",
    "Accepted v5 jobs retain the same model-output contract",
  );
});

void test("v6 adds reference guidance without changing the v5 schema or accepted output shape", () => {
  const historical = z.toJSONSchema(summaryModelOutputSchema("summary-v5"));
  const current = z.toJSONSchema(summaryModelOutputSchema("summary-v6"));
  assert.equal(
    createHash("sha256").update(JSON.stringify(current)).digest("hex"),
    "9d1af0f5a99620008e71b23c15aceb4558a5677e8b9e721dc5c8503889c51955",
  );
  assert.equal(current.additionalProperties, false);
  for (const section of ["quickSummary", "detailedSummary", "decisions"]) {
    const field = current.properties?.[section];
    const oldField = historical.properties?.[section];
    assert.ok(field && typeof field === "object");
    assert.ok(oldField && typeof oldField === "object");
    assert.match(field.description ?? "", /claims\[\]\.id/u);
    assert.match(field.description ?? "", /prose/u);
    assert.equal(oldField.description, undefined);
    const validation = { ...field };
    delete validation.description;
    assert.deepEqual(validation, oldField);
  }
  assert.match(JSON.stringify(current.properties?.decisions), /Put decision prose in claims/u);
});

void test("v7 pins the one-quick/optional-detail contract independently of v5 and v6", () => {
  const schema = z.toJSONSchema(summaryModelOutputSchema("summary-v7"));
  assert.equal(
    createHash("sha256").update(JSON.stringify(schema)).digest("hex"),
    "530bccc1c2aa8a0222e98694b2673711c31020b321fad48ffb07133db47ee279",
  );
});

void test("v8 keeps the v7 evidence contract and refuses invalid citations without repair", () => {
  assert.equal(summaryModelOutputSchema("summary-v8"), summaryModelOutputSchema("summary-v7"));
  const fixture = summaryQualityFixtures[0]!;
  const passage = fixture.context.passages[0]!;
  const draft = {
    claims: [
      {
        id: "c1",
        text: "Discussion continued.",
        support: [{ evidenceId: passage.evidenceId, quote: passage.text }],
      },
    ],
    quickSummary: ["c1"],
    detailedSummary: [],
    decisions: [],
    actionCandidates: [],
    keywords: [],
    keyMoments: [],
    uncertainties: [],
  };
  assert.deepEqual(
    interpretSummaryOutput("summary-v8", draft, fixture.context),
    interpretSummaryOutput("summary-v7", draft, fixture.context),
  );
  draft.claims[0]!.support[0]!.quote = "This quote is not in the source.";
  const original = structuredClone(draft);
  assert.throws(
    () => interpretSummaryOutput("summary-v8", draft, fixture.context),
    SummaryOutputValidationError,
  );
  assert.deepEqual(draft, original);
});

void test("v6 projects decision IDs and rejects prose references without rewriting the draft", () => {
  const fixture = summaryQualityFixtures.find((item) => item.id === "conditional-decision")!;
  const positive = fixture.controls.find((control) => control.kind === "authored-positive")!.output;
  const statements = [...positive.quickSummary, ...positive.detailedSummary];
  const draft = {
    claims: statements.map((statement, index) => ({
      id: `c${index + 1}`,
      text: statement.text,
      support: structuredClone(statement.citations),
    })),
    quickSummary: positive.quickSummary.map((_, index) => `c${index + 1}`),
    detailedSummary: positive.detailedSummary.map(
      (_, index) => `c${index + positive.quickSummary.length + 1}`,
    ),
    decisions: ["c1"],
    actionCandidates: [],
    keywords: [],
    keyMoments: [],
    uncertainties: [],
  };
  const original = structuredClone(draft);
  const projected = interpretSummaryOutput("summary-v6", draft, fixture.context);
  assert.deepEqual(projected.decisions, [
    { text: draft.claims[0]!.text, citations: draft.claims[0]!.support },
  ]);
  assert.deepEqual(projected, interpretSummaryOutput("summary-v5", draft, fixture.context));
  assert.deepEqual(draft, original);

  const shortProse = { ...draft, decisions: ["The team agreed to a pilot."] };
  // Under 80 characters still isn't a claim reference. The application rejects
  // it rather than guessing which claim the model intended.
  assert.equal(summaryModelOutputSchema("summary-v6").safeParse(shortProse).success, true);
  for (const version of ["summary-v5", "summary-v6"]) {
    assert.throws(
      () => interpretSummaryOutput(version, shortProse, fixture.context),
      SummaryOutputValidationError,
    );
    const longProse = { ...draft, decisions: ["A decision stated as prose. ".padEnd(85, "x")] };
    const parsed = summaryModelOutputSchema(version).safeParse(longProse);
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.deepEqual(
        parsed.error.issues.map(({ code, path }) => ({ code, path })),
        [{ code: "too_big", path: ["decisions", 0] }],
      );
    }
  }
  assert.deepEqual(shortProse.decisions, ["The team agreed to a pilot."]);
  assert.deepEqual(
    interpretSummaryOutput("summary-v6", { ...draft, decisions: [] }, fixture.context).decisions,
    [],
  );
});

void test("publication errors do not expose source or model content", () => {
  const fixture = summaryQualityFixtures[0]!;
  for (const version of ["summary-v5", "summary-v6"]) {
    assert.throws(
      () => interpretSummaryOutput(version, { claims: "private-content-marker" }, fixture.context),
      (error: unknown) =>
        error instanceof SummaryOutputValidationError &&
        !error.message.includes("private-content-marker"),
    );
  }
});
