import { z } from "zod";

export const researchStatusSchema = z.enum([
  "queued",
  "running",
  "needs-input",
  "partial",
  "completed",
  "failed",
  "cancelled",
]);
export type ResearchStatus = z.infer<typeof researchStatusSchema>;

export const researchFactRequestSchema = z
  .object({
    key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    question: z.string().trim().min(3).max(500),
    maxAgeDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict();
export type ResearchFactRequest = z.infer<typeof researchFactRequestSchema>;

export const researchPersonRequestSchema = z
  .object({
    personId: z.uuid(),
    expectedProfileRevision: z.number().int().positive(),
    expectedContactRevision: z.number().int().nonnegative().optional(),
    verifiedAliases: z.array(z.string().trim().min(1).max(100)).max(8).optional(),
    discoverSources: z.boolean().optional(),
    requestedFacts: z.array(researchFactRequestSchema).min(1).max(8),
    sourceUrls: z.array(z.url().max(2048)).max(4),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.requestedFacts.map((fact) => fact.key)).size === value.requestedFacts.length,
    {
      message: "Fact keys must be unique for each person.",
    },
  )
  .refine((value) => new Set(value.sourceUrls).size === value.sourceUrls.length, {
    message: "Source URLs must be unique.",
  });
export type ResearchPersonRequest = z.infer<typeof researchPersonRequestSchema>;

export const requestResearchSchema = z
  .object({
    workspaceId: z.uuid(),
    requestId: z.uuid(),
    people: z.array(researchPersonRequestSchema).min(1).max(10),
  })
  .strict()
  .refine(
    (value) => new Set(value.people.map((person) => person.personId)).size === value.people.length,
    {
      message: "Select each person only once.",
    },
  );
export type RequestResearch = z.infer<typeof requestResearchSchema>;

export const researchScopeSchema = z
  .object({
    workspaceId: z.uuid(),
    batchId: z.uuid(),
  })
  .strict();
export const retryResearchSchema = researchScopeSchema.extend({
  requestId: z.uuid(),
  personId: z.uuid(),
  expectedGeneration: z.number().int().positive(),
});

export const researchCitationSchema = z.object({
  sourceId: z.string().min(1).max(100),
  url: z.url().max(2048),
  excerpt: z.string().min(1).max(2000),
  retrievedAt: z.iso.datetime(),
  asOf: z.iso.datetime().nullable(),
});
export const researchFindingSchema = z.object({
  key: z.string(),
  question: z.string(),
  status: z.enum(["supported", "not-found", "ambiguous", "conflicting"]),
  answer: z.string().max(4000).nullable(),
  explanation: z.string().max(2000),
  citations: z.array(researchCitationSchema).max(8),
});
export type ResearchFinding = z.infer<typeof researchFindingSchema>;

export const researchItemSchema = z.object({
  personId: z.uuid(),
  profileRevision: z.number().int().positive(),
  contactRevision: z.number().int().nonnegative(),
  displayName: z.string(),
  generation: z.number().int().positive(),
  status: researchStatusSchema,
  requestedFacts: z.array(researchFactRequestSchema),
  sourceUrls: z.array(z.string()),
  findings: z.array(researchFindingSchema),
  discoveryCreditsUsed: z.number().int().nonnegative().nullable().optional(),
  error: z.string().nullable(),
  retryable: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type ResearchItem = z.infer<typeof researchItemSchema>;
export const researchBatchSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  status: researchStatusSchema,
  items: z.array(researchItemSchema),
  createdAt: z.iso.datetime(),
});
export type ResearchBatch = z.infer<typeof researchBatchSchema>;

export function aggregateResearchStatus(statuses: ResearchStatus[]): ResearchStatus {
  if (statuses.length === 0) {
    return "queued";
  }

  if (statuses.every((status) => status === "cancelled")) {
    return "cancelled";
  }

  if (statuses.some((status) => status === "running")) {
    return "running";
  }

  if (statuses.some((status) => status === "queued")) {
    return "queued";
  }

  if (statuses.every((status) => status === "completed")) {
    return "completed";
  }

  if (statuses.some((status) => status === "completed" || status === "partial")) {
    return "partial";
  }

  if (statuses.some((status) => status === "needs-input")) {
    return "needs-input";
  }

  return "failed";
}
