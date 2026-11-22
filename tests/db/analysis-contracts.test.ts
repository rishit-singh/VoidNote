import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
  readSummarySnapshot,
  validateSummaryAnalysis,
  validateSummaryContext,
} from "../../src/ai/context";
import type { SummaryContext } from "../../src/ai/context";
import { summaryPolicy } from "../../src/ai/runtime";
import { requestSummarySchema, summaryAnalysisSchema } from "../../src/contracts/analysis";
import type { SummaryAnalysis } from "../../src/contracts/analysis";
import { z } from "zod";

function fixture() {
  const evidenceId = randomUUID();
  const personId = randomUUID();
  const context: SummaryContext = {
    schemaVersion: 1,
    snapshotId: randomUUID(),
    workspaceId: randomUUID(),
    source: {
      noteId: randomUUID(),
      recordingId: randomUUID(),
      runId: randomUUID(),
      generation: 3,
    },
    noteRevision: 1,
    title: "Planning",
    passages: [
      {
        evidenceId,
        segmentId: evidenceId,
        segmentRevision: 2,
        attributionRevision: 1,
        sourceUtteranceId: randomUUID(),
        sequence: 0,
        orderKey: "",
        providerTrackId: "SPEAKER_00",
        assignment: { kind: "person", personId },
        text: "We agreed to send the proposal tomorrow.",
        startSeconds: 0,
        endSeconds: 5,
      },
    ],
    people: [{ personId, revision: 2, displayName: "Ada", authoredDescription: "Project owner" }],
    agenda: null,
    relatedConversations: [],
    coverage: { complete: true, passageCount: 1 },
  };
  const statement = {
    text: "The proposal will be sent tomorrow.",
    citations: [{ evidenceId, quote: "send the proposal tomorrow" }],
  };
  const analysis: SummaryAnalysis = {
    quickSummary: [statement],
    detailedSummary: [statement],
    keywords: ["proposal"],
    decisions: [statement],
    nextSteps: [{ action: statement, ownerPersonId: null, dueDate: null }],
    keyMoments: [{ title: "Proposal decision", significance: statement }],
    participants: [{ personId, providerTrackId: "SPEAKER_00", contributions: [statement] }],
    engagement: { observations: [], limitations: ["One short passage."] },
    agendaAssessment: [],
    memoryCandidates: [],
    overlapFindings: [],
    uncertainties: [],
  };

  return { context, analysis };
}

void describe("analysis evidence and model-output boundary", () => {
  void it("retains exact source revisions and validates grounded output", () => {
    const { context, analysis } = fixture();
    assert.deepEqual(validateSummaryAnalysis(analysis, context), analysis);
    assert.equal(validateSummaryContext(context).source.generation, 3);
    const jsonSchema = z.toJSONSchema(summaryAnalysisSchema);
    assert.equal(jsonSchema.type, "object");
  });

  void it("rejects invented handles and quotations including whitespace-only citations", () => {
    for (const citation of [
      { evidenceId: randomUUID(), quote: "send the proposal tomorrow" },
      { evidenceId: null, quote: "An invented conclusion." },
      { evidenceId: null, quote: " " },
    ]) {
      const { context, analysis } = fixture();
      analysis.quickSummary[0]!.citations = [
        { ...citation, evidenceId: citation.evidenceId ?? context.passages[0]!.evidenceId },
      ];
      assert.throws(() => validateSummaryAnalysis(analysis, context), /quotation/);
    }
  });

  void it("rejects out-of-snapshot people, speakers, agendas and overlap references", () => {
    const mutations: ((analysis: SummaryAnalysis) => void)[] = [
      (analysis) => {
        analysis.nextSteps[0]!.ownerPersonId = randomUUID();
      },
      (analysis) => {
        analysis.participants[0]!.providerTrackId = "SPEAKER_OTHER";
      },
      (analysis) => {
        analysis.agendaAssessment = [
          {
            itemId: randomUUID(),
            status: "not-discussed",
            explanation: { text: "No discussion", citations: [] },
          },
        ];
      },
      (analysis) => {
        analysis.overlapFindings = [
          {
            evidenceIds: [randomUUID()],
            concern: "Overlapping speech.",
            requiresAudioReview: true,
          },
        ];
      },
    ];

    for (const mutate of mutations) {
      const { context, analysis } = fixture();
      mutate(analysis);
      assert.throws(() => validateSummaryAnalysis(analysis, context));
    }
  });

  void it("rejects incomplete, duplicated or profile-inconsistent snapshots", () => {
    const { context } = fixture();
    assert.throws(() =>
      validateSummaryContext({
        ...context,
        coverage: { complete: false, passageCount: 1 },
      }),
    );
    assert.throws(() =>
      validateSummaryContext({
        ...context,
        coverage: { complete: true, passageCount: 2 },
      }),
    );
    assert.throws(
      () =>
        validateSummaryContext({
          ...context,
          passages: [...context.passages, ...context.passages],
          coverage: { complete: true, passageCount: 2 },
        }),
      /duplicate/,
    );
    assert.throws(() => validateSummaryContext({ ...context, people: [] }), /profile/);
  });

  void it("rejects client-supplied authority/model policy and unsupported models", () => {
    const command = { commandId: randomUUID(), noteId: randomUUID() };
    assert.deepEqual(requestSummarySchema.parse(command), command);
    assert.equal(
      requestSummarySchema.safeParse({ ...command, actorId: randomUUID() }).success,
      false,
    );
    assert.equal(requestSummarySchema.safeParse({ ...command, model: "external" }).success, false);
    assert.throws(() => summaryPolicy("external/model"));
    assert.equal(summaryPolicy("@cf/test/model").maxSteps, 1);
  });

  void it("preserves historical snapshot evidence and rejects tampering or cross-job reads", async () => {
    const { context } = fixture();
    const body = JSON.stringify(context);
    const checksum = createHash("sha256").update(body).digest("hex");
    const reference = {
      snapshotId: context.snapshotId,
      objectKey: `analysis/${context.workspaceId}/${context.snapshotId}/context-${checksum}.json`,
      checksum,
      source: context.source,
      noteRevision: context.noteRevision,
      profiles: context.people.map(({ personId, revision }) => ({ personId, revision })),
    };
    let storedBody = body;
    let reads = 0;
    let contentReads = 0;
    const bucket = {
      get: () => {
        reads++;
        return Promise.resolve({
          size: new TextEncoder().encode(storedBody).byteLength,
          text: () => {
            contentReads++;
            return Promise.resolve(storedBody);
          },
        });
      },
    };
    const load = (budget = 64_000) =>
      readSummarySnapshot(bucket, context.workspaceId, context.snapshotId, reference, budget);

    assert.deepEqual(await load(), context);
    const successfulReads = reads;
    await assert.rejects(
      readSummarySnapshot(bucket, randomUUID(), context.snapshotId, reference, 64_000),
      /belong/,
    );
    assert.equal(reads, successfulReads);
    const successfulContentReads = contentReads;
    await assert.rejects(load(1), /budget/);
    assert.equal(contentReads, successfulContentReads);
    storedBody = body.replace("Planning", "Tampered");
    await assert.rejects(load(), /integrity/);
  });
});
