import { z } from "zod";

import type { Principal } from "../workspace";

export const researchRunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type ResearchRunStatus = z.infer<typeof researchRunStatusSchema>;

export const researchRunStageSchema = z.enum([
  "queued",
  "planning",
  "retrieving",
  "analyzing",
  "synthesizing",
  "publishing",
  "finished",
]);
export type ResearchRunStage = z.infer<typeof researchRunStageSchema>;

export const researchRunFindingSchema = z
  .object({
    id: z.uuid(),
    questionId: z.uuid(),
    question: z.string(),
    outcome: z.enum(["supported", "conflicting", "insufficient-evidence", "failed"]),
    statement: z.string().nullable(),
    classification: z.enum(["direct-evidence", "deduction"]).nullable(),
    explanation: z.string(),
    citations: z
      .array(
        z
          .object({
            sourceId: z.uuid(),
            url: z.url().max(2048),
            excerpt: z.string().min(1).max(2000),
            startOffset: z.number().int().nonnegative(),
            endOffset: z.number().int().positive(),
            retrievedAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type ResearchRunFinding = z.infer<typeof researchRunFindingSchema>;

export const researchRunDetailSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    noteId: z.uuid().nullable(),
    personId: z.uuid().nullable(),
    question: z.string(),
    status: researchRunStatusSchema,
    stage: researchRunStageSchema,
    report: z
      .object({
        version: z.literal("research-report-v1"),
        answer: z.string(),
        quality: z.enum(["answered", "partial", "conflicting", "insufficient-evidence"]),
        findings: z.array(researchRunFindingSchema),
        gaps: z.array(z.string()),
      })
      .strict()
      .nullable(),
    quality: z.enum(["answered", "partial", "conflicting", "insufficient-evidence"]).nullable(),
    findings: z.array(researchRunFindingSchema),
    gaps: z.array(z.string()),
    error: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type ResearchRunDetail = z.infer<typeof researchRunDetailSchema>;

export const requestResearchRunSchema = z
  .object({
    workspaceId: z.uuid(),
    commandId: z.uuid(),
    question: z.string().trim().min(3).max(2000),
    subquestions: z.array(z.string().trim().min(3).max(500)).max(5).default([]),
    noteId: z.uuid().nullable().optional(),
    personId: z.uuid().nullable().optional(),
    sourceUrls: z.array(z.url().max(2048)).max(6).default([]),
    discoverSources: z.boolean().default(false),
    timeframe: z
      .object({
        mode: z.enum(["current", "historical", "unspecified"]),
        asOf: z.iso.datetime().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.subquestions.map((question) => question.toLowerCase())).size ===
      input.subquestions.length,
    {
      message: "Research subquestions must be unique.",
    },
  )
  .refine((input) => input.discoverSources || input.sourceUrls.length > 0, {
    message: "Provide source URLs or explicitly request source discovery.",
  });
export type RequestResearchRun = z.infer<typeof requestResearchRunSchema>;

export const researchRunLookupInputSchema = z
  .object({
    query: z.string().trim().max(300).default(""),
    personIds: z.array(z.uuid()).max(10).default([]),
    noteId: z.uuid().optional(),
    maxAgeDays: z.number().int().min(1).max(3650).optional(),
    limit: z.number().int().min(1).max(10).default(6),
    includeActiveRuns: z.boolean().default(true),
  })
  .strict();
export type ResearchRunLookupInput = z.infer<typeof researchRunLookupInputSchema>;

export const researchRunListInputSchema = z
  .object({
    noteId: z.uuid().optional(),
    threadId: z.uuid().optional(),
    status: z.enum(["active", "finished", "all"]).default("all"),
    limit: z.number().int().min(1).max(20).default(20),
  })
  .strict();
export type ResearchRunListInput = z.infer<typeof researchRunListInputSchema>;

export const researchRunLookupCandidateSchema = z
  .object({
    runId: z.uuid(),
    question: z.string(),
    status: researchRunStatusSchema,
    freshness: z.enum(["current-enough", "stale", "unknown"]),
    updatedAt: z.iso.datetime(),
    statement: z.string().nullable(),
  })
  .strict();
export type ResearchRunLookupCandidate = z.infer<typeof researchRunLookupCandidateSchema>;

export const researchRunExecutionKeySchema = z.object({
  workspaceId: z.uuid(),
  runId: z.uuid(),
});
export type ResearchRunExecutionKey = z.infer<typeof researchRunExecutionKeySchema>;

/** Integration contract for the research server/router and durable runner. */
export type ResearchRunsService = {
  request(
    principal: Principal,
    input: RequestResearchRun,
    policy: unknown,
    originTurnId?: string,
  ): Promise<ResearchRunDetail>;
  get(principal: Principal, workspaceId: string, runId: string): Promise<ResearchRunDetail>;
  lookup(
    principal: Principal,
    workspaceId: string,
    input: ResearchRunLookupInput,
  ): Promise<ResearchRunLookupCandidate[]>;
  list(
    principal: Principal,
    workspaceId: string,
    input: ResearchRunListInput,
  ): Promise<ResearchRunDetail[]>;
  cancel(
    principal: Principal,
    workspaceId: string,
    runId: string,
    originTurnId?: string,
  ): Promise<ResearchRunDetail>;
};
