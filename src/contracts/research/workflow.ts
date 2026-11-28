import { z } from "zod";

import type { ResearchAgentScope } from "./agent";
import { evidenceLookupInputSchema } from "./agent";
import { researchRunFindingSchema } from "./runs";

const researchWorkflowFindingSchema = researchRunFindingSchema
  .omit({ id: true, question: true })
  .extend({
    outcome: z.enum(["supported", "conflicting", "insufficient-evidence"]),
  });

export const researchWorkflowCandidateSchema = z
  .object({
    answer: z.string().trim().min(1).max(12_000),
    quality: z.enum(["answered", "partial", "conflicting", "insufficient-evidence"]),
    findings: z.array(researchWorkflowFindingSchema).max(12),
    gaps: z.array(z.string().trim().min(1).max(500)).max(12),
    stopReason: z.enum(["evidence-sufficient", "insufficient-evidence", "limit-reached"]),
  })
  .strict();

export const researchWorkflowPublicationResultSchema = z.discriminatedUnion("published", [
  z.object({ published: z.literal(true) }).strict(),
  z
    .object({
      published: z.literal(false),
      feedback: z.string().max(1000).optional(),
    })
    .strict(),
]);

export type ResearchWorkflowCandidate = z.infer<typeof researchWorkflowCandidateSchema>;

export const researchWorkflowReadInputSchema = z
  .object({
    reads: z
      .array(
        z
          .object({
            sourceId: z.uuid(),
            startOffset: z.number().int().nonnegative(),
            limit: z.number().int().min(1).max(4000),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();

export const researchWorkflowLookupInputSchema = evidenceLookupInputSchema;

export const researchWorkflowSearchInputSchema = z
  .object({
    queries: z.array(z.string().trim().min(3).max(500)).min(1).max(4),
  })
  .strict();

export const researchWorkflowRetrieveInputSchema = z
  .object({
    urls: z.array(z.url().max(2048)).min(1).max(6),
  })
  .strict();

export const researchWorkflowFindingBatchInputSchema = z
  .object({
    findings: z.array(researchWorkflowFindingSchema).max(12),
    gaps: z.array(z.string().trim().min(1).max(500)).max(12),
  })
  .strict();

export type ResearchWorkflowReadInput = z.infer<typeof researchWorkflowReadInputSchema>;
export type ResearchWorkflowSearchInput = z.infer<typeof researchWorkflowSearchInputSchema>;
export type ResearchWorkflowRetrieveInput = z.infer<typeof researchWorkflowRetrieveInputSchema>;
export type ResearchWorkflowFindingBatchInput = z.infer<
  typeof researchWorkflowFindingBatchInputSchema
>;

export function researchWorkflowCandidateFeedback(
  scope: Pick<ResearchAgentScope, "questions">,
  candidate: ResearchWorkflowCandidate,
): string[] {
  const required = new Set(scope.questions.map(({ id }) => id));

  const seen = new Set<string>();

  const feedback: string[] = [];

  for (const finding of candidate.findings) {
    if (!required.has(finding.questionId)) {
      feedback.push(`Finding questionId ${finding.questionId} is not an admitted question.`);
    } else if (seen.has(finding.questionId)) {
      feedback.push(`Question ${finding.questionId} has more than one finding.`);
    }

    seen.add(finding.questionId);
  }

  for (const question of scope.questions) {
    if (!seen.has(question.id)) {
      feedback.push(`Missing a finding for admitted question ${question.id}: ${question.question}`);
    }
  }

  return feedback;
}
