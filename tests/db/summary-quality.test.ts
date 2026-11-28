import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateSummaryAnalysis, validateSummaryContext } from "../../src/ai/context";
import { renderSummaryPrompt, resolveSummaryPrompt } from "../../src/ai/summary/instructions";
import type { SummaryAnalysis } from "../../src/contracts/analysis";
import {
  frozenSummaryPrompt,
  summaryQualityFixtures,
  summaryQualityRubricVersion,
  summaryQualitySemanticChecklist,
} from "./fixtures/summary-quality";
import type { SummaryQualityFixture } from "./fixtures/summary-quality";
import {
  evaluateSummaryQuality,
  summaryQualityCriteria,
  summaryQualityDigest,
  summaryQualityOutputSchema,
  summaryQualityOutputSchemaForPrompt,
  summaryQualityProvenance,
} from "./fixtures/summary-quality-evaluation";
import type { SummaryQualitySubmission } from "./fixtures/summary-quality-evaluation";

function fixture(id = "conditional-decision"): SummaryQualityFixture {
  const found = summaryQualityFixtures.find((item) => item.id === id);
  assert.ok(found, `Missing frozen fixture ${id}`);
  return structuredClone(found);
}

function submission(
  source: SummaryQualityFixture,
  output: unknown = source.controls[0]!.output,
): SummaryQualitySubmission {
  return {
    submissionId: `${source.id}/authored-control`,
    provenance: summaryQualityProvenance(source),
    producer: {
      kind: "authored-control",
      label: "Offline authored test control; not a model result",
      model: null,
      runId: null,
    },
    output,
  };
}

void describe("frozen offline summary-quality baseline", () => {
  void it("pins the complete synthetic sources, rubrics and authored controls", () => {
    assert.equal(summaryQualityRubricVersion, "summary-quality-rubric-v1");
    assert.deepEqual(
      Object.fromEntries(
        summaryQualityFixtures.map((item) => [item.id, summaryQualityDigest(item)]),
      ),
      {
        "conditional-decision": "d4f8f6b769d6a5868e8835854543e00550d266dfcf8c2e2fd5ae5559b35fe112",
        "commitments-and-questions":
          "1d87091a1e0405d6aae082418e77aa6361a50d8928a92affad189f6dc2a33d41",
        "unknown-speakers-and-profiles":
          "ca47832a4948e28b9d201f86d871bb1e6b50870ce75297534b8fc3d2159b7835",
        "negation-silence-and-partial-claims":
          "deadf70304cdcc7d1bd323a12566bfe2dc83fab9e5de3e9b14325eec22d57e44",
      },
      "Frozen evaluation artifacts changed. Review and version the baseline; do not silently bless drift.",
    );
    const evidenceIds = summaryQualityFixtures.flatMap((item) =>
      item.context.passages.map((passage) => passage.evidenceId),
    );
    assert.equal(new Set(evidenceIds).size, evidenceIds.length);
    assert.equal(new Set(summaryQualityFixtures.map((item) => item.context.source.runId)).size, 4);
  });

  void it("freezes v1 instruction content and its resolved user wrapper", () => {
    assert.equal(
      summaryQualityDigest(frozenSummaryPrompt),
      "4d47074813d210e77dfc81ad3b7075efbea7e2deff03e06b540873b145d75886",
    );
    const resolved = resolveSummaryPrompt(frozenSummaryPrompt.version);
    assert.equal(resolved.system, frozenSummaryPrompt.instructions);
    assert.equal(
      resolved.user,
      [...frozenSummaryPrompt.userWrapper, "{{snapshot}}"].join("\n"),
      "Historical user-wrapper content must remain immutable.",
    );
  });

  void it("pins evaluation-only criteria independently of production limits", () => {
    assert.equal(
      summaryQualityDigest(summaryQualityOutputSchema),
      "159196b5ba3b6364afe2b869bddf8c3d712ec9ebbe95c0920006623d143671eb",
      "The exported output schema changed; review and version its evaluation baseline.",
    );
    assert.equal(
      summaryQualityDigest(summaryQualityCriteria),
      "7784a21d0a5d7986000c46505a49d8a2989d50991c78312345f0368faf863756",
    );
    assert.equal(
      summaryQualityDigest(summaryQualitySemanticChecklist),
      "e6fa2eeb67a6566a5c5abc7f0629bf2f87ff17debdbefa9b14d2db5448f4f885",
    );
  });

  void it("records v6 provenance without relabeling the frozen v1 or historical v5 baseline", () => {
    const source = fixture();
    const historical = summaryQualityProvenance(source, "summary-v5");
    const current = summaryQualityProvenance(source, "summary-v6");
    assert.equal(current.promptVersion, "summary-v6");
    assert.notEqual(current.promptDigest, historical.promptDigest);
    assert.equal(current.fixtureDigest, historical.fixtureDigest);
    assert.equal(current.schemaDigest, historical.schemaDigest);
    assert.equal(summaryQualityProvenance(source).promptVersion, "summary-v1");
    assert.equal(summaryQualityProvenance(source, "summary-v5").promptVersion, "summary-v5");
  });

  void it("uses a v7-specific public schema digest and the actual rendered prompt", () => {
    const source = fixture();
    const current = summaryQualityProvenance(source, "summary-v7");
    const historical = summaryQualityProvenance(source, "summary-v6");
    assert.equal(current.promptVersion, "summary-v7");
    assert.notEqual(current.schemaDigest, historical.schemaDigest);
    assert.equal(historical.schemaDigest, summaryQualityDigest(summaryQualityOutputSchema));
    assert.equal(
      current.schemaDigest,
      summaryQualityDigest(summaryQualityOutputSchemaForPrompt("summary-v7")),
    );
    assert.equal(
      current.promptDigest,
      summaryQualityDigest({
        version: "summary-v7",
        ...renderSummaryPrompt("summary-v7", source.context),
      }),
    );
    assert.equal(current.fixtureDigest, historical.fixtureDigest);
    for (const version of [
      "summary-v1",
      "summary-v2",
      "summary-v3",
      "summary-v4",
      "summary-v5",
      "summary-v6",
    ]) {
      assert.deepEqual(summaryQualityOutputSchemaForPrompt(version), summaryQualityOutputSchema);
    }
  });

  void it("evaluates empty detail only under v7 while preserving historical interpretation", () => {
    const source = fixture();
    const output = { ...source.controls[0]!.output, detailedSummary: [] };
    for (const version of ["summary-v1", "summary-v5", "summary-v6", "summary-v7"]) {
      const candidate = {
        ...submission(source, output),
        provenance: summaryQualityProvenance(source, version),
      };
      const result = evaluateSummaryQuality(source, candidate);
      assert.equal(result.mechanical.provenance.status, "passed");
      assert.equal(result.mechanical.schema.status, version === "summary-v7" ? "passed" : "failed");
      if (version === "summary-v7") {
        assert.equal(result.mechanical.citations.status, "passed");
        assert.equal(result.semanticReview.status, "review-required");
        assert.equal(result.measurements?.counts.detailedSummary, 0);
        const mislabeled = evaluateSummaryQuality(source, {
          ...candidate,
          provenance: {
            ...candidate.provenance,
            schemaDigest: summaryQualityDigest(summaryQualityOutputSchema),
          },
        });
        assert.deepEqual(mislabeled.mechanical.provenance.mismatches, ["schemaDigest"]);
      }
    }
  });

  void it("uses valid complete contexts and evidence-backed rubric items for all cases", () => {
    for (const item of summaryQualityFixtures) {
      assert.deepEqual(validateSummaryContext(item.context), item.context);
      assert.ok(item.rubric.requiredFacts.length >= 3);
      assert.ok(item.rubric.prohibitedInferences.length >= 3);
      const rules = [...item.rubric.requiredFacts, ...item.rubric.prohibitedInferences];
      assert.equal(new Set(rules.map((rule) => rule.id)).size, rules.length);
      for (const rule of rules) {
        assert.ok(rule.evidence.length > 0);
        for (const citation of rule.evidence) {
          const passage = item.context.passages.find(
            (entry) => entry.evidenceId === citation.evidenceId,
          );
          assert.ok(passage?.text.includes(citation.quote), rule.id);
          assert.ok(citation.quote.trim(), rule.id);
        }
      }
      assert.deepEqual(
        item.controls.map((control) => control.kind),
        ["authored-positive", "authored-adversarial"],
      );
      for (const control of item.controls) {
        assert.deepEqual(validateSummaryAnalysis(control.output, item.context), control.output);
        for (const finding of control.expectedSemanticFindings) {
          assert.ok(rules.some((rule) => rule.id === finding));
        }
      }
    }
  });

  void it("keeps every authored control review-required even when all mechanical checks pass", () => {
    for (const item of summaryQualityFixtures) {
      for (const control of item.controls) {
        const result = evaluateSummaryQuality(item, submission(item, control.output));
        assert.equal(result.mechanical.context.status, "passed");
        assert.equal(result.mechanical.schema.status, "passed");
        assert.equal(result.mechanical.citations.status, "passed");
        assert.equal(result.mechanical.provenance.status, "passed");
        assert.equal(result.mechanical.coverage.valid, true);
        assert.equal(result.semanticReview.status, "review-required");
        assert.deepEqual(result.semanticReview.requiredFacts, item.rubric.requiredFacts);
        assert.deepEqual(
          result.semanticReview.prohibitedInferences,
          item.rubric.prohibitedInferences,
        );
        assert.ok(result.measurements);
        assert.equal(result.measurements.compressionCheck.passed, true);
        assert.ok(result.measurements.sectionChecks.every((entry) => entry.passed));
      }
    }
  });

  void it("demonstrates exact but insufficient quotations and silence inference are not validator failures", () => {
    const source = fixture("negation-silence-and-partial-claims");
    const adversarial = source.controls.find((control) => control.kind === "authored-adversarial")!;
    const partial = adversarial.output.detailedSummary[0]!;
    assert.equal(partial.citations[0]!.quote, "I will draft the invitation");
    assert.match(partial.text, /customers Wednesday morning/u);
    const result = evaluateSummaryQuality(source, submission(source, adversarial.output));
    assert.equal(result.mechanical.citations.status, "passed");
    assert.equal(result.semanticReview.status, "review-required");
    assert.ok(adversarial.expectedSemanticFindings.includes("scope.partial-citation"));
    assert.ok(adversarial.expectedSemanticFindings.includes("scope.sentiment"));
    // This is a manually annotated adversarial fixture, not an automatically
    // detected semantic violation or an assertion that the model made this error.
    assert.equal("semanticScore" in result, false);
  });

  void it("separates malformed output, nonresolving citations and out-of-source references", () => {
    const source = fixture();
    const malformed = evaluateSummaryQuality(source, submission(source, { quickSummary: [] }));
    assert.equal(malformed.mechanical.schema.status, "failed");
    assert.equal(malformed.mechanical.citations.status, "not-run");
    assert.equal(malformed.measurements, null);

    for (const mutate of [
      (output: SummaryAnalysis) => {
        output.quickSummary[0]!.citations[0]!.evidenceId = "00000000-0000-4000-8000-000000000001";
      },
      (output: SummaryAnalysis) => {
        output.quickSummary[0]!.citations[0]!.quote = "A quotation absent from this source.";
      },
      (output: SummaryAnalysis) => {
        output.nextSteps[0]!.ownerPersonId = "00000000-0000-4000-8000-000000000001";
      },
    ]) {
      const output = structuredClone(source.controls[0]!.output);
      mutate(output);
      const result = evaluateSummaryQuality(source, submission(source, output));
      assert.equal(result.mechanical.schema.status, "passed");
      assert.equal(result.mechanical.citations.status, "failed");
      assert.equal(result.semanticReview.status, "review-required");
    }
  });

  void it("does not confuse complete input coverage with summary fact coverage", () => {
    const source = fixture();
    const output = structuredClone(source.controls[0]!.output);
    output.quickSummary = [output.detailedSummary[0]!];
    output.detailedSummary = [output.detailedSummary[0]!];
    output.decisions = [];
    output.nextSteps = [];
    const result = evaluateSummaryQuality(source, submission(source, output));
    assert.equal(result.mechanical.coverage.valid, true);
    assert.equal(result.measurements!.citedPassageFraction, 0.25);
    assert.equal(result.semanticReview.status, "review-required");
    assert.ok(result.semanticReview.requiredFacts.some((rule) => rule.id === "decision.gate"));

    source.context.coverage.passageCount++;
    const incomplete = evaluateSummaryQuality(source, submission(source, output));
    assert.equal(incomplete.mechanical.context.status, "failed");
    assert.equal(incomplete.mechanical.coverage.valid, false);
    assert.equal(incomplete.mechanical.citations.status, "not-run");
    assert.equal(incomplete.measurements, null);
  });

  void it("flags stale source, rubric, criteria and prompt provenance without silently rebasing", () => {
    const source = fixture();
    for (const key of Object.keys(summaryQualityProvenance(source)) as (keyof ReturnType<
      typeof summaryQualityProvenance
    >)[]) {
      const input = submission(source);
      // Simulates an artifact for a different frozen baseline, not a new model run.
      input.provenance = { ...input.provenance, [key]: "stale" };
      const result = evaluateSummaryQuality(source, input);
      assert.equal(result.mechanical.provenance.status, "failed");
      assert.deepEqual(result.mechanical.provenance.mismatches, [key]);
      assert.equal(result.semanticReview.status, "review-required");
    }
    const input = submission(source);
    source.context.source.generation++;
    source.context.people[0]!.revision++;
    const changed = evaluateSummaryQuality(source, input);
    assert.deepEqual(changed.mechanical.provenance.mismatches, ["fixtureDigest", "contextDigest"]);
    assert.equal(changed.source.transcript.generation, source.context.source.generation);
    assert.equal(changed.source.profiles[0]!.revision, source.context.people[0]!.revision);
  });

  void it("measures section excess and compression without changing the production schema", () => {
    const source = fixture();
    const output = structuredClone(source.controls[0]!.output);
    const longClaim = {
      ...output.quickSummary[0]!,
      text: Array.from({ length: 80 }, () => "repetition").join(" "),
    };
    output.quickSummary = Array.from({ length: 4 }, () => structuredClone(longClaim));
    output.uncertainties = ["One", "Two", "Three", "Four"];
    const result = evaluateSummaryQuality(source, submission(source, output));
    assert.equal(result.mechanical.schema.status, "passed");
    assert.equal(result.mechanical.citations.status, "passed");
    const metrics = result.measurements!;
    assert.equal(metrics.quickWords, 320);
    assert.equal(metrics.compressionCheck.passed, false);
    assert.deepEqual(
      metrics.sectionChecks.filter((item) => !item.passed).map((item) => item.criterion),
      ["quickSummary.items", "quickSummary.words", "uncertainties"],
    );
    assert.equal(result.semanticReview.status, "review-required");
  });

  void it("counts citation verbosity separately and records output identity for repeatable review", () => {
    const source = fixture();
    const input = submission(source);
    const before = JSON.stringify({ source, input });
    const first = evaluateSummaryQuality(source, input);
    assert.deepEqual(evaluateSummaryQuality(source, input), first);
    assert.equal(JSON.stringify({ source, input }), before);
    assert.equal(first.outputDigest, summaryQualityDigest(input.output));
    const output = structuredClone(source.controls[0]!.output);
    output.quickSummary[0]!.citations.push(structuredClone(output.quickSummary[0]!.citations[0]!));
    const changed = evaluateSummaryQuality(source, submission(source, output));
    assert.notEqual(changed.outputDigest, first.outputDigest);
    assert.equal(changed.measurements!.quickWords, first.measurements!.quickWords);
    assert.ok(changed.measurements!.quotedWords > first.measurements!.quotedWords);
  });

  void it("evaluates supplied output without representing its producer claims as model acceptance", () => {
    const source = fixture();
    const input = submission(source);
    input.producer = {
      kind: "submitted-output",
      label: "Externally supplied artifact; execution not attested",
      model: "claimed-model-name",
      runId: "claimed-run-42",
    };
    const result = evaluateSummaryQuality(source, input);
    assert.deepEqual(result.producer, input.producer);
    assert.equal(result.mechanical.provenance.status, "passed");
    assert.equal(result.semanticReview.status, "review-required");
  });
});
