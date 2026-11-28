import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import type { SummaryContext } from "../../src/ai/context";
import { validateSummaryAnalysis, validateSummaryContext } from "../../src/ai/context";
import { projectSummaryDraft, summaryDraftSchema } from "../../src/ai/summary/draft";
import type { Citation } from "../../src/contracts/analysis";
import { summaryQualityFixtures } from "./fixtures/summary-quality";

type Draft = z.infer<typeof summaryDraftSchema>;

function fixture() {
  const source = summaryQualityFixtures.find((item) => item.id === "conditional-decision")!;
  const context = structuredClone(source.context);
  const positive = source.controls[0]!.output;
  const statements = [...positive.quickSummary, ...positive.detailedSummary];
  const draft: Draft = {
    claims: statements.map((statement, index) => ({
      id: `claim-${index}`,
      text: statement.text,
      support: structuredClone(statement.citations),
    })),
    quickSummary: ["claim-0"],
    detailedSummary: ["claim-1", "claim-2"],
    decisions: ["claim-0"],
    actionCandidates: [
      {
        claimId: "claim-1",
        disposition: "commitment",
        commitmentEvidence: structuredClone(statements[1]!.citations),
        ownerPersonId: context.people[1]!.personId,
        ownerEvidence: structuredClone(statements[1]!.citations),
        dueDate: "Thursday afternoon",
        dueDateEvidence: [
          { evidenceId: context.passages[1]!.evidenceId, quote: "Thursday afternoon" },
        ],
      },
    ],
    keywords: ["Cedar", "access check"],
    keyMoments: [{ title: "Conditional pilot", claimId: "claim-0" }],
    uncertainties: [],
  };

  return { context, draft };
}

function citation(context: SummaryContext, index: number, quote?: string): Citation {
  const passage = context.passages[index]!;

  return { evidenceId: passage.evidenceId, quote: quote ?? passage.text };
}

void describe("evidence-first summary draft projection", () => {
  void it("projects valid claims and deduplicated action witnesses into the public contract", () => {
    const { context, draft } = fixture();
    const original = structuredClone({ context, draft });
    const analysis = projectSummaryDraft(draft, context);

    assert.deepEqual(validateSummaryContext(context), context);
    assert.deepEqual(validateSummaryAnalysis(analysis, context), analysis);
    assert.deepEqual(analysis.quickSummary, [
      { text: draft.claims[0]!.text, citations: draft.claims[0]!.support },
    ]);
    assert.deepEqual(
      analysis.detailedSummary.map((item) => item.text),
      [draft.claims[1]!.text, draft.claims[2]!.text],
    );
    assert.deepEqual(analysis.nextSteps, [
      {
        action: {
          text: draft.claims[1]!.text,
          citations: [...draft.claims[1]!.support, ...draft.actionCandidates[0]!.dueDateEvidence],
        },
        ownerPersonId: context.people[1]!.personId,
        dueDate: "Thursday afternoon",
      },
    ]);
    assert.deepEqual(analysis.decisions, analysis.quickSummary);
    assert.deepEqual(analysis.keyMoments[0]!.significance, analysis.quickSummary[0]);
    assert.deepEqual(analysis.keywords, draft.keywords);
    assert.deepEqual(analysis.participants, []);
    assert.deepEqual(analysis.engagement, { observations: [], limitations: [] });
    assert.deepEqual(analysis.agendaAssessment, []);
    assert.deepEqual(analysis.memoryCandidates, []);
    assert.deepEqual(analysis.overlapFindings, []);
    assert.deepEqual({ context, draft }, original, "Projection must not rewrite source or draft.");
  });

  void it("has a strict, bounded JSON-schema model contract with every field required", () => {
    const schema = z.toJSONSchema(summaryDraftSchema);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties!)));
    const serialized = JSON.stringify(schema);
    assert.match(serialized, /"maxItems":40/u);
    assert.match(serialized, /"maxItems":12/u);

    const { draft } = fixture();
    assert.equal(summaryDraftSchema.safeParse(draft).success, true);
    assert.equal(summaryDraftSchema.safeParse({ ...draft, nextSteps: [] }).success, false);
    const incomplete: Partial<Draft> = { ...draft };
    delete incomplete.uncertainties;
    assert.equal(summaryDraftSchema.safeParse(incomplete).success, false);
    assert.equal(
      summaryDraftSchema.safeParse({
        ...draft,
        claims: [{ ...draft.claims[0], unexpected: true }],
      }).success,
      false,
    );
  });

  for (const section of [
    "quickSummary",
    "detailedSummary",
    "decisions",
    "actionCandidates",
    "keyMoments",
  ] as const) {
    void it(`rejects dangling claim references in ${section}`, () => {
      const { context, draft } = fixture();

      if (section === "actionCandidates" || section === "keyMoments") {
        draft[section][0]!.claimId = "missing";
      } else {
        draft[section][0] = "missing";
      }

      assert.throws(() => projectSummaryDraft(draft, context), /dangling claim ID/u);
    });

    void it(`rejects duplicate selected IDs in ${section}`, () => {
      const { context, draft } = fixture();

      if (section === "actionCandidates") {
        draft.actionCandidates.push(structuredClone(draft.actionCandidates[0]!));
      } else if (section === "keyMoments") {
        draft.keyMoments.push({ title: "Repeated reference", claimId: "claim-0" });
      } else {
        draft[section].push(draft[section][0]!);
      }

      assert.throws(() => projectSummaryDraft(draft, context), /duplicate selected IDs/u);
    });
  }

  void it("rejects duplicate claim identities and text even when unselected", () => {
    for (const duplicate of ["id", "text"] as const) {
      const { context, draft } = fixture();
      const extra = structuredClone(draft.claims[0]!);
      extra.id = duplicate === "id" ? extra.id : "unused";
      extra.text = duplicate === "text" ? extra.text : "Different text.";
      draft.claims.push(extra);

      assert.throws(() => projectSummaryDraft(draft, context), /duplicate claim/u);
    }
  });

  void it("rejects reuse between quick and detailed while allowing other section reuse", () => {
    const { context, draft } = fixture();
    draft.detailedSummary = ["claim-0"];
    assert.throws(() => projectSummaryDraft(draft, context), /reuses a claim/u);
  });

  void it("validates exact quotes for all claims, including unselected claims", () => {
    for (const invalid of [
      { evidenceId: "00000000-0000-4000-8000-000000000001", quote: "Thursday afternoon" },
      { evidenceId: fixture().context.passages[1]!.evidenceId, quote: "An invented quote." },
      { evidenceId: fixture().context.passages[1]!.evidenceId, quote: " " },
    ]) {
      const { context, draft } = fixture();
      draft.claims.push({ id: "unused", text: "Not displayed.", support: [invalid] });
      assert.throws(() => projectSummaryDraft(draft, context), /exact snapshot quotation/u);
    }
  });

  for (const field of ["commitmentEvidence", "ownerEvidence", "dueDateEvidence"] as const) {
    void it(`validates ${field} even for unpublished candidates`, () => {
      const { context, draft } = fixture();
      const candidate = draft.actionCandidates[0]!;
      candidate.disposition = "question";
      candidate[field] = [citation(context, 1, "Absent quotation.")];
      assert.throws(() => projectSummaryDraft(draft, context), /exact snapshot quotation/u);
    });
  }

  void it("publishes commitments and assignments but excludes proposals, questions, status and rejections", () => {
    for (const disposition of [
      "commitment",
      "assignment",
      "proposal",
      "question",
      "status",
      "rejected",
    ] as const) {
      const { context, draft } = fixture();
      draft.actionCandidates[0]!.disposition = disposition;
      const analysis = projectSummaryDraft(draft, context);
      assert.equal(
        analysis.nextSteps.length,
        disposition === "commitment" || disposition === "assignment" ? 1 : 0,
      );
    }
  });

  void it("requires commitment witnesses only for commitment and assignment candidates", () => {
    for (const disposition of ["commitment", "assignment", "question"] as const) {
      const { context, draft } = fixture();
      const candidate = draft.actionCandidates[0]!;
      candidate.disposition = disposition;
      candidate.commitmentEvidence = [];

      if (disposition === "question") {
        assert.equal(projectSummaryDraft(draft, context).nextSteps.length, 0);
      } else {
        assert.throws(() => projectSummaryDraft(draft, context), /requires commitment evidence/u);
      }
    }
  });

  void it("requires known people and witnesses even for excluded candidates", () => {
    for (const disposition of ["commitment", "status"] as const) {
      const { context, draft } = fixture();
      const candidate = draft.actionCandidates[0]!;
      candidate.disposition = disposition;
      candidate.ownerPersonId = "00000000-0000-4000-8000-000000000001";
      assert.throws(() => projectSummaryDraft(draft, context), /person outside the snapshot/u);
      candidate.ownerPersonId = context.people[1]!.personId;
      candidate.ownerEvidence = [];
      assert.throws(() => projectSummaryDraft(draft, context), /owner requires owner evidence/u);
    }
  });

  void it("requires a direct speaker assignment or literal display-name anchor for an owner", () => {
    const { context, draft } = fixture();
    const candidate = draft.actionCandidates[0]!;
    context.passages[1]!.assignment = { kind: "unknown" };
    assert.throws(() => projectSummaryDraft(draft, context), /owner evidence lacks/u);

    candidate.ownerEvidence = [citation(context, 2, "Bryn owns the check.")];
    const analysis = projectSummaryDraft(draft, context);
    assert.equal(analysis.nextSteps[0]!.ownerPersonId, context.people[1]!.personId);
    assert.ok(
      analysis.nextSteps[0]!.action.citations.some((item) => item.quote === "Bryn owns the check."),
    );

    context.people[1]!.displayName = "bryn";
    assert.throws(() => projectSummaryDraft(draft, context), /owner evidence lacks/u);
    context.people[1]!.displayName = "Bry";
    assert.throws(() => projectSummaryDraft(draft, context), /owner evidence lacks/u);
    context.people[1]!.displayName = "";
    assert.throws(() => projectSummaryDraft(draft, context), /owner evidence lacks/u);
  });

  void it("requires due-date witnesses and rejects evidence attached to null owner/date fields", () => {
    const { context, draft } = fixture();
    const candidate = draft.actionCandidates[0]!;
    candidate.dueDateEvidence = [];
    assert.throws(() => projectSummaryDraft(draft, context), /due date requires/u);
    candidate.dueDate = null;
    candidate.ownerPersonId = null;
    assert.throws(() => projectSummaryDraft(draft, context), /null owner/u);
    candidate.ownerEvidence = [];
    candidate.dueDateEvidence = [citation(context, 1)];
    assert.throws(() => projectSummaryDraft(draft, context), /null due date/u);
    candidate.dueDateEvidence = [];
    const action = projectSummaryDraft(draft, context).nextSteps[0]!;
    assert.equal(action.ownerPersonId, null);
    assert.equal(action.dueDate, null);
  });

  void it("enforces the floored 75% whitespace-word budget without truncating short sources", () => {
    const { context, draft } = fixture();
    context.passages = [context.passages[0]!];
    context.passages[0]!.text = "one two three four five six seven";
    context.coverage.passageCount = 1;
    draft.claims = [
      { id: "a", text: "one two", support: [citation(context, 0)] },
      { id: "b", text: "three\tfour\nfive", support: [citation(context, 0)] },
    ];
    draft.quickSummary = ["a"];
    draft.detailedSummary = ["b"];
    draft.decisions = [];
    draft.actionCandidates = [];
    draft.keyMoments = [];
    assert.equal(projectSummaryDraft(draft, context).detailedSummary[0]!.text, "three\tfour\nfive");
    draft.claims[1]!.text += " six";
    const original = structuredClone(draft);
    assert.throws(
      () => projectSummaryDraft(draft, context),
      /compression limit: 6 summary words; maximum 5 for 7 source words/u,
    );
    assert.deepEqual(draft, original);
  });

  void it("does not impose a one-topic heuristic on short sources", () => {
    const { context, draft } = fixture();
    context.passages = [context.passages[0]!];
    context.passages[0]!.text =
      "Access failed. Pricing changed. Further investigation is needed for both.";
    context.coverage.passageCount = 1;
    draft.claims = [
      { id: "a", text: "Access failed.", support: [citation(context, 0, "Access failed.")] },
      { id: "b", text: "Pricing changed.", support: [citation(context, 0, "Pricing changed.")] },
      {
        id: "c",
        text: "Investigation needed.",
        support: [citation(context, 0, "Further investigation is needed for both.")],
      },
    ];
    draft.quickSummary = ["a", "b"];
    draft.detailedSummary = ["c"];
    draft.decisions = [];
    draft.actionCandidates = [];
    draft.keyMoments = [];
    assert.equal(projectSummaryDraft(draft, context).quickSummary.length, 2);
  });

  void it("runs final public-contract validation rather than silently dropping excess citations", () => {
    const { context, draft } = fixture();
    const words = context.passages[1]!.text.split(/\s+/u);
    const unique = [...new Set(words)].map((word) => citation(context, 1, word));
    assert.ok(unique.length >= 21);
    draft.claims[1]!.support = unique.slice(0, 10);
    const candidate = draft.actionCandidates[0]!;
    candidate.commitmentEvidence = unique.slice(10, 20);
    candidate.ownerEvidence = unique.slice(20, 21);
    candidate.dueDate = null;
    candidate.dueDateEvidence = [];
    assert.throws(() => projectSummaryDraft(draft, context), /Too big|<=20/u);
  });

  void it("rejects historical public outputs as drafts without changing their historical validity", () => {
    for (const source of summaryQualityFixtures) {
      for (const control of source.controls) {
        assert.deepEqual(validateSummaryAnalysis(control.output, source.context), control.output);
        assert.equal(summaryDraftSchema.safeParse(control.output).success, false);
        assert.throws(() => projectSummaryDraft(control.output, source.context));
      }
    }
  });

  void it("does not misrepresent exact evidence or identity anchors as semantic entailment", () => {
    const { context, draft } = fixture();
    draft.claims[0]!.text = "The private pilot is approved unconditionally.";
    const candidate = draft.actionCandidates[0]!;
    candidate.ownerPersonId = context.people[0]!.personId;
    candidate.ownerEvidence = [citation(context, 2, "Bryn owns the check.")];
    candidate.dueDate = "Friday";
    // These deliberately wrong statements still have exact quotes and a speaker
    // identity anchor. Passing mechanical checks must never be a semantic score.
    const analysis = projectSummaryDraft(draft, context);
    assert.equal(analysis.quickSummary[0]!.text, draft.claims[0]!.text);
    assert.equal(analysis.nextSteps[0]!.ownerPersonId, context.people[0]!.personId);
    assert.equal(analysis.nextSteps[0]!.dueDate, "Friday");
  });
});
