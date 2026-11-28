import { createHash } from "node:crypto";
import { z } from "zod";

import { validateSummaryAnalysis, validateSummaryContext } from "../../../src/ai/context";
import type { SummaryAnalysis } from "../../../src/contracts/analysis";
import {
  SUMMARY_PROMPT_VERSIONS,
  SUMMARY_SCHEMA_VERSION,
  summaryAnalysisSchema,
  summaryAnalysisV1Schema,
} from "../../../src/contracts/analysis";
import { renderSummaryPrompt, resolveSummaryPrompt } from "../../../src/ai/summary/instructions";
import type { SummaryQualityFixture } from "./summary-quality";
import {
  frozenSummaryPrompt,
  summaryQualityRubricVersion,
  summaryQualitySemanticChecklist,
} from "./summary-quality";

export const summaryQualityOutputSchema = {
  version: SUMMARY_SCHEMA_VERSION,
  definition: z.toJSONSchema(summaryAnalysisV1Schema),
};

const summaryQualityV7OutputSchema = {
  version: SUMMARY_SCHEMA_VERSION,
  definition: z.toJSONSchema(summaryAnalysisSchema),
};

// Provenance binds promptVersion + schemaDigest. Historical artifacts retain
// their exact public-schema digest; v7 alone admits the empty detail array.
export function summaryQualityOutputSchemaForPrompt(promptVersion: string) {
  resolveSummaryPrompt(promptVersion);

  return promptVersion === "summary-v7" ? summaryQualityV7OutputSchema : summaryQualityOutputSchema;
}

// Evaluation candidates only. These do not override the production schema/policy.
export const summaryQualityCriteria = {
  version: "summary-quality-concision-v1",
  quickSummary: { maxItems: 3, maxWords: 75 },
  detailedSummary: { maxItems: 4, maxWords: 160 },
  decisions: 4,
  nextSteps: 4,
  keyMoments: 2,
  contributionsPerParticipant: 2,
  engagementObservations: 2,
  memoryCandidates: 2,
  uncertainties: 3,
  maxQuickDetailedToTranscriptWordRatio: 0.75,
} as const;

/**
 * SHA-256 of UTF-8 JSON.stringify(value), including object key order.
 * Inputs must be JSON values. This is a parsed-output digest, not a raw-file hash.
 */
export function summaryQualityDigest(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error("Summary quality artifacts must be JSON-serializable.");
  }
  return createHash("sha256").update(json).digest("hex");
}

export function summaryQualityProvenance(
  fixture: SummaryQualityFixture,
  promptVersion: string = frozenSummaryPrompt.version,
) {
  const knownPromptVersion = SUMMARY_PROMPT_VERSIONS.some((version) => version === promptVersion);
  const resolvedVersion = knownPromptVersion ? promptVersion : frozenSummaryPrompt.version;
  const prompt = resolveSummaryPrompt(resolvedVersion);
  const promptArtifact =
    resolvedVersion === frozenSummaryPrompt.version
      ? frozenSummaryPrompt
      : resolvedVersion === "summary-v7"
        ? { version: resolvedVersion, ...renderSummaryPrompt(resolvedVersion, fixture.context) }
        : {
            version: resolvedVersion,
            instructions: prompt.system,
            userWrapper: prompt.user.split("\n").slice(0, -1),
          };
  const outputSchema = summaryQualityOutputSchemaForPrompt(resolvedVersion);

  return {
    fixtureId: fixture.id,
    fixtureVersion: fixture.version,
    fixtureDigest: summaryQualityDigest(fixture),
    contextDigest: summaryQualityDigest(fixture.context),
    rubricVersion: summaryQualityRubricVersion,
    rubricDigest: summaryQualityDigest({
      version: summaryQualityRubricVersion,
      checklist: summaryQualitySemanticChecklist,
      case: fixture.rubric,
    }),
    criteriaDigest: summaryQualityDigest(summaryQualityCriteria),
    promptVersion: resolvedVersion,
    promptDigest: summaryQualityDigest(promptArtifact),
    schemaVersion: outputSchema.version,
    schemaDigest: summaryQualityDigest(outputSchema),
  };
}

// Submitted pins may belong to an older baseline; compare rather than coerce them
// into the current literals so the report can explain a provenance mismatch.
export type SummaryQualityProvenance = {
  [Key in keyof ReturnType<typeof summaryQualityProvenance>]: string;
};

export type SummaryQualitySubmission = {
  submissionId: string;
  provenance: SummaryQualityProvenance;
  producer: {
    kind: "authored-control" | "submitted-output";
    label: string;
    model: string | null;
    runId: string | null;
  };
  output: unknown;
};

type Check = {
  status: "passed" | "failed" | "not-run";
  errors: string[];
};

function check(operation: () => unknown): Check {
  try {
    operation();
    return { status: "passed", errors: [] };
  } catch (error) {
    return {
      status: "failed",
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function words(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

function statements(analysis: SummaryAnalysis) {
  return [
    ...analysis.quickSummary,
    ...analysis.detailedSummary,
    ...analysis.decisions,
    ...analysis.nextSteps.map((item) => item.action),
    ...analysis.keyMoments.map((item) => item.significance),
    ...analysis.participants.flatMap((item) => item.contributions),
    ...analysis.engagement.observations,
    ...analysis.agendaAssessment.map((item) => item.explanation),
    ...analysis.memoryCandidates.map((item) => item.observation),
  ];
}

function measure(analysis: SummaryAnalysis, fixture: SummaryQualityFixture) {
  const sourceWords = fixture.context.passages.reduce((sum, item) => sum + words(item.text), 0);
  const quickWords = analysis.quickSummary.reduce((sum, item) => sum + words(item.text), 0);
  const detailedWords = analysis.detailedSummary.reduce((sum, item) => sum + words(item.text), 0);
  const claims = statements(analysis);
  const citations = claims.flatMap((item) => item.citations);
  const prose = [
    ...claims.map((item) => item.text),
    ...analysis.keywords,
    ...analysis.keyMoments.map((item) => item.title),
    ...analysis.engagement.limitations,
    ...analysis.overlapFindings.map((item) => item.concern),
    ...analysis.uncertainties,
    ...analysis.nextSteps.flatMap((item) => (item.dueDate === null ? [] : [item.dueDate])),
  ];
  const proseWords = prose.reduce((sum, text) => sum + words(text), 0);
  const ratio = sourceWords === 0 ? null : (quickWords + detailedWords) / sourceWords;
  const counts = {
    quickSummary: analysis.quickSummary.length,
    detailedSummary: analysis.detailedSummary.length,
    decisions: analysis.decisions.length,
    nextSteps: analysis.nextSteps.length,
    keyMoments: analysis.keyMoments.length,
    contributionsPerParticipant: analysis.participants.map((item) => item.contributions.length),
    engagementObservations: analysis.engagement.observations.length,
    memoryCandidates: analysis.memoryCandidates.length,
    uncertainties: analysis.uncertainties.length,
  };
  const limits = [
    ["quickSummary.items", counts.quickSummary, summaryQualityCriteria.quickSummary.maxItems],
    ["quickSummary.words", quickWords, summaryQualityCriteria.quickSummary.maxWords],
    [
      "detailedSummary.items",
      counts.detailedSummary,
      summaryQualityCriteria.detailedSummary.maxItems,
    ],
    ["detailedSummary.words", detailedWords, summaryQualityCriteria.detailedSummary.maxWords],
    ["decisions", counts.decisions, summaryQualityCriteria.decisions],
    ["nextSteps", counts.nextSteps, summaryQualityCriteria.nextSteps],
    ["keyMoments", counts.keyMoments, summaryQualityCriteria.keyMoments],
    [
      "engagement.observations",
      counts.engagementObservations,
      summaryQualityCriteria.engagementObservations,
    ],
    ["memoryCandidates", counts.memoryCandidates, summaryQualityCriteria.memoryCandidates],
    ["uncertainties", counts.uncertainties, summaryQualityCriteria.uncertainties],
    ...counts.contributionsPerParticipant.map(
      (count, index) =>
        [
          `participants[${index}].contributions`,
          count,
          summaryQualityCriteria.contributionsPerParticipant,
        ] as const,
    ),
  ] satisfies (readonly [string, number, number])[];
  const sectionChecks = limits.map(([criterion, actual, maximum]) => ({
    criterion,
    actual,
    maximum,
    passed: actual <= maximum,
  }));
  const citedEvidenceIds = [...new Set(citations.map((item) => item.evidenceId))].sort();
  return {
    wordCounting: "Whitespace-delimited words; repeated text is counted repeatedly.",
    sourceWords,
    quickWords,
    detailedWords,
    proseWords,
    quotedWords: citations.reduce((sum, item) => sum + words(item.quote), 0),
    outputBytes: new TextEncoder().encode(JSON.stringify(analysis)).byteLength,
    proseToTranscriptWordRatio: sourceWords === 0 ? null : proseWords / sourceWords,
    quickDetailedToTranscriptWordRatio: ratio,
    compressionCheck: {
      maximum: summaryQualityCriteria.maxQuickDetailedToTranscriptWordRatio,
      passed:
        ratio === null
          ? null
          : ratio <= summaryQualityCriteria.maxQuickDetailedToTranscriptWordRatio,
    },
    counts,
    sectionChecks,
    citationOccurrences: citations.length,
    citedEvidenceIds,
    citedPassageFraction:
      citedEvidenceIds.filter((id) =>
        fixture.context.passages.some((item) => item.evidenceId === id),
      ).length / fixture.context.passages.length,
  };
}

/**
 * Pure, offline and deterministic. Production validators establish structural
 * validity only. No output, including an authored positive control, is awarded a
 * semantic score or accepted automatically. Provenance checks compare declarations;
 * they do not authenticate who generated an output or which prompt was executed.
 */
export function evaluateSummaryQuality(
  fixture: SummaryQualityFixture,
  submission: SummaryQualitySubmission,
) {
  const expected = summaryQualityProvenance(fixture, submission.provenance.promptVersion);
  const mismatches = (Object.keys(expected) as (keyof SummaryQualityProvenance)[]).filter(
    (key) => submission.provenance[key] !== expected[key],
  );
  const context = check(() => validateSummaryContext(fixture.context));
  const selectedSchema =
    expected.promptVersion === "summary-v7" ? summaryAnalysisSchema : summaryAnalysisV1Schema;
  const parsed = selectedSchema.safeParse(submission.output);
  const schema: Check = parsed.success
    ? { status: "passed", errors: [] }
    : { status: "failed", errors: [parsed.error.message] };
  const citations: Check =
    context.status === "passed" && parsed.success
      ? check(() => validateSummaryAnalysis(parsed.data, fixture.context))
      : { status: "not-run", errors: ["Context and output schema must pass first."] };
  return {
    evaluationVersion: "summary-quality-offline-v1",
    submissionId: submission.submissionId,
    producer: submission.producer,
    outputDigest: summaryQualityDigest(submission.output),
    expectedProvenance: expected,
    submittedProvenance: submission.provenance,
    source: {
      snapshotId: fixture.context.snapshotId,
      transcript: fixture.context.source,
      noteRevision: fixture.context.noteRevision,
      profiles: fixture.context.people.map(({ personId, revision }) => ({ personId, revision })),
    },
    mechanical: {
      context,
      schema,
      citations,
      provenance: {
        status: mismatches.length === 0 ? ("passed" as const) : ("failed" as const),
        mismatches,
      },
      coverage: {
        declaredComplete: fixture.context.coverage.complete,
        declaredPassages: fixture.context.coverage.passageCount,
        actualPassages: fixture.context.passages.length,
        valid: context.status === "passed",
        meaning: "Snapshot completeness and reference reach only; not semantic fact coverage.",
      },
    },
    measurements:
      context.status === "passed" && parsed.success ? measure(parsed.data, fixture) : null,
    semanticReview: {
      status: "review-required" as const,
      rubricVersion: summaryQualityRubricVersion,
      requiredFacts: fixture.rubric.requiredFacts,
      prohibitedInferences: fixture.rubric.prohibitedInferences,
      checklist: summaryQualitySemanticChecklist,
    },
  };
}

export type SummaryQualityEvaluation = ReturnType<typeof evaluateSummaryQuality>;
