import { z } from "zod";

import { researchFindingSchema } from "./index";

export const researchLookupInputSchema = z
  .object({
    query: z.string().trim().max(300).default(""),
    personIds: z.array(z.uuid()).max(10).default([]),
    maxAgeDays: z.number().int().min(1).max(3650).optional(),
    includeActive: z.boolean().default(true),
    limit: z.number().int().min(1).max(20).default(6),
    cursor: z.string().max(2000).optional(),
  })
  .strict();

export const savedResearchMatchSchema = z.object({
  batchId: z.uuid(),
  personId: z.uuid(),
  displayName: z.string(),
  generation: z.number().int().positive(),
  status: z.string(),
  updatedAt: z.iso.datetime(),
  identityCurrent: z.boolean(),
  freshness: z.enum(["within-requested-age", "stale", "unknown"]),
  findings: z.array(researchFindingSchema),
});

export type ResearchLookupInput = z.infer<typeof researchLookupInputSchema>;
export type SavedResearchMatch = z.infer<typeof savedResearchMatchSchema>;
