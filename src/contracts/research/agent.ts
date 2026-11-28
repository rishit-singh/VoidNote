import { z } from "zod";

import { type ResearchRunFinding, researchRunFindingSchema } from "./runs";

export const researchAgentScopeSchema = z
  .object({
    runId: z.uuid(),
    workspaceId: z.uuid(),
    actorId: z.uuid(),
    operationId: z.string().min(1).max(200),
    question: z.string().min(1).max(2000),
    questions: z
      .array(
        z
          .object({
            id: z.uuid(),
            question: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(12),
    noteId: z.uuid().nullable(),
    personId: z.uuid().nullable(),
    sourceUrls: z.array(z.url().max(2048)).max(6),
    discoverSources: z.boolean(),
    timeframe: z
      .object({
        mode: z.enum(["current", "historical", "unspecified"]),
        asOf: z.iso.datetime().optional(),
      })
      .strict(),
    maxAgeDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict();
export type ResearchAgentScope = z.infer<typeof researchAgentScopeSchema>;

export const evidenceLookupInputSchema = z
  .object({
    query: z.string().trim().max(300).default(""),
    limit: z.number().int().min(1).max(6).default(4),
  })
  .strict();
export const evidenceReadInputSchema = z
  .object({
    sourceId: z.uuid(),
    startOffset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(4000).default(2000),
  })
  .strict();
export const searchSourcesInputSchema = z
  .object({ query: z.string().trim().min(3).max(500) })
  .strict();
export const retrieveSourceInputSchema = z.object({ url: z.url().max(2048) }).strict();
export const recordFindingsInputSchema = z
  .object({
    findings: z.array(researchRunFindingSchema.omit({ id: true, question: true })).max(12),
    gaps: z.array(z.string().trim().min(1).max(500)).max(12),
  })
  .strict();
export const publishReportInputSchema = z
  .object({
    answer: z.string().trim().min(1).max(12_000),
    quality: z.enum(["answered", "partial", "conflicting", "insufficient-evidence"]),
    findings: z.array(researchRunFindingSchema.omit({ id: true, question: true })).max(12),
    gaps: z.array(z.string().trim().min(1).max(500)).max(12),
    stopReason: z.enum(["evidence-sufficient", "insufficient-evidence", "limit-reached"]),
  })
  .strict();

export type ResearchAgentFindingInput = Omit<ResearchRunFinding, "id" | "question">;
export type ResolvedResearchAgentFinding = ResearchRunFinding;

export const researchAgentToolSchemas = {
  evidence_lookup: evidenceLookupInputSchema,
  evidence_read: evidenceReadInputSchema,
  search_sources: searchSourcesInputSchema,
  retrieve_source: retrieveSourceInputSchema,
  record_findings: recordFindingsInputSchema,
  publish_report: publishReportInputSchema,
} as const;

export type EvidenceLookupInput = z.infer<typeof evidenceLookupInputSchema>;
export type EvidenceReadInput = z.infer<typeof evidenceReadInputSchema>;
export type SearchSourcesInput = z.infer<typeof searchSourcesInputSchema>;
export type RetrieveSourceInput = z.infer<typeof retrieveSourceInputSchema>;
export type RecordFindingsInput = z.infer<typeof recordFindingsInputSchema>;
export type PublishReportInput = z.infer<typeof publishReportInputSchema>;

export type ResearchAgentToolFailure = {
  ok: false;
  code:
    | "invalid-input"
    | "out-of-scope"
    | "not-found"
    | "stale-evidence"
    | "temporal-ineligible"
    | "unavailable";
  message: string;
};
