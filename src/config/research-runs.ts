import { z } from "zod";

import { researchPolicySchema } from "./research";

export const DEFAULT_RESEARCH_RUN_MAX_QUESTIONS = 4;

export const researchRunPolicySchema = researchPolicySchema.extend({
  executionVersion: z.enum(["workflow-v1", "research-agent-v2"]).default("workflow-v1"),
  maxModelSteps: z.number().int().min(1).max(24).default(12),
  maxSearchCalls: z.number().int().min(0).max(8).default(4),
  maxToolCalls: z.number().int().min(1).max(48).default(24),
  reportVersion: z.literal("research-report-v1").default("research-report-v1"),
  maxQuestions: z.number().int().min(1).max(6).default(DEFAULT_RESEARCH_RUN_MAX_QUESTIONS),
  maxSources: z.number().int().min(1).max(6).default(6),
  maxEvidenceBytes: z.number().int().min(4000).max(64000).default(48000),
  maxSnapshotAgeDays: z.number().int().min(1).max(365).default(7),
});
export type ResearchRunPolicy = z.infer<typeof researchRunPolicySchema>;

export function pinResearchRunPolicy(
  policy: unknown,
  executionVersion?: ResearchRunPolicy["executionVersion"],
): ResearchRunPolicy {
  const parsed = researchRunPolicySchema.parse(policy);

  return executionVersion ? { ...parsed, executionVersion } : parsed;
}
