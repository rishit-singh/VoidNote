import { z } from "zod";

import { idSchema } from "../workspace";
import { analysisJobSchema } from "./commands";
import { citationSchema, transcriptVersionSchema } from "./evidence";

export const SUMMARY_SCHEMA_VERSION = "summary-v1";
export const SUMMARY_PROMPT_VERSIONS = [
  "summary-v1",
  "summary-v2",
  "summary-v3",
  "summary-v4",
  "summary-v5",
  "summary-v6",
  "summary-v7",
  "summary-v8",
] as const;
export const SUMMARY_PROMPT_VERSION = "summary-v8";

const statementSchema = z
  .object({
    text: z.string().min(1).max(8000),
    citations: z.array(citationSchema).min(1).max(20),
  })
  .strict();

// Frozen public model contract used by historical v1–v4 prompts and v1–v6
// evaluation artifacts. Keep its JSON Schema byte-stable.
export const summaryAnalysisV1Schema = z
  .object({
    quickSummary: z.array(statementSchema).min(1).max(12),
    detailedSummary: z.array(statementSchema).min(1).max(40),
    keywords: z.array(z.string().min(1).max(100)).max(40),
    decisions: z.array(statementSchema).max(40),
    nextSteps: z
      .array(
        z
          .object({
            action: statementSchema,
            ownerPersonId: idSchema.nullable(),
            dueDate: z.string().max(100).nullable(),
          })
          .strict(),
      )
      .max(40),
    keyMoments: z
      .array(
        z.object({ title: z.string().min(1).max(200), significance: statementSchema }).strict(),
      )
      .max(30),
    participants: z
      .array(
        z
          .object({
            personId: idSchema.nullable(),
            providerTrackId: z.string().max(200).nullable(),
            contributions: z.array(statementSchema).max(20),
          })
          .strict(),
      )
      .max(100),
    engagement: z
      .object({
        observations: z.array(statementSchema).max(20),
        limitations: z.array(z.string().min(1).max(1000)).max(20),
      })
      .strict(),
    agendaAssessment: z
      .array(
        z
          .object({
            itemId: idSchema,
            status: z.enum(["covered", "partial", "unresolved", "not-discussed"]),
            explanation: z
              .object({
                text: z.string().min(1).max(8000),
                // Absence of discussion has no supporting utterance to fabricate.
                citations: z.array(citationSchema).max(20),
              })
              .strict(),
          })
          .strict(),
      )
      .max(40),
    memoryCandidates: z
      .array(
        z
          .object({
            personId: idSchema.nullable(),
            kind: z.enum(["explicit-statement", "observed-behavior"]),
            observation: statementSchema,
          })
          .strict(),
      )
      .max(40),
    overlapFindings: z
      .array(
        z
          .object({
            evidenceIds: z.array(idSchema).min(1).max(20),
            concern: z.string().min(1).max(2000),
            requiresAudioReview: z.boolean(),
          })
          .strict(),
      )
      .max(30),
    uncertainties: z.array(z.string().min(1).max(2000)).max(30),
  })
  .strict();

// The saved DTO keeps the same array shape. V7 may omit a redundant detail;
// quick-summary and citation requirements remain unchanged.
export const summaryAnalysisSchema = summaryAnalysisV1Schema.extend({
  detailedSummary: z.array(statementSchema).max(40),
});

export const summaryProvenanceSchema = z
  .object({
    model: z.string().min(1).max(200),
    promptVersion: z.enum(SUMMARY_PROMPT_VERSIONS),
    schemaVersion: z.literal(SUMMARY_SCHEMA_VERSION),
    policyVersion: z.string().min(1).max(100),
  })
  .strict();

export const savedSummarySchema = z
  .object({
    id: idSchema,
    noteId: idSchema,
    jobId: idSchema,
    version: z.number().int().positive(),
    snapshotId: idSchema,
    source: transcriptVersionSchema,
    analysis: summaryAnalysisSchema,
    provenance: summaryProvenanceSchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const summaryOverviewInputSchema = z
  .object({ workspaceId: idSchema, noteId: idSchema })
  .strict();
export const summaryOverviewSchema = z
  .object({
    latestJob: analysisJobSchema.nullable(),
    latestSummaryJobId: idSchema.nullable(),
    canGenerate: z.boolean(),
    unavailableReason: z.string().nullable(),
  })
  .strict();
export const summaryHistoryInputSchema = z
  .object({
    workspaceId: idSchema,
    noteId: idSchema,
    cursor: z.string().max(2000).optional(),
    // tRPC's infinite-query adapter includes direction even on the first page.
    direction: z.literal("forward").optional(),
    limit: z.number().int().min(1).max(50).default(30),
  })
  .strict();
export const summaryHistorySchema = z
  .object({
    items: z.array(
      z
        .object({
          jobId: idSchema,
          version: z.number().int().positive(),
          createdAt: z.iso.datetime({ offset: true }),
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type SummaryOverviewInput = z.infer<typeof summaryOverviewInputSchema>;
export type SummaryOverview = z.infer<typeof summaryOverviewSchema>;
export type SummaryHistoryInput = z.infer<typeof summaryHistoryInputSchema>;
export type SummaryHistory = z.infer<typeof summaryHistorySchema>;

export type SummaryAnalysis = z.infer<typeof summaryAnalysisSchema>;
export type SummaryProvenance = z.infer<typeof summaryProvenanceSchema>;
export type SavedSummary = z.infer<typeof savedSummarySchema>;
