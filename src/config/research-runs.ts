import { z } from "zod";

import { researchPolicySchema } from "./research";

export const researchRunPolicySchema = researchPolicySchema.extend({
  reportVersion: z.literal("research-report-v1").default("research-report-v1"),
  maxQuestions: z.number().int().min(1).max(6).default(4),
  maxSources: z.number().int().min(1).max(6).default(6),
  maxEvidenceBytes: z.number().int().min(4000).max(64000).default(48000),
  maxSnapshotAgeDays: z.number().int().min(1).max(365).default(7),
});
export type ResearchRunPolicy = z.infer<typeof researchRunPolicySchema>;

export function pinResearchRunPolicy(policy: unknown): ResearchRunPolicy {
  return researchRunPolicySchema.parse(policy);
}
