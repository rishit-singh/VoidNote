import { z } from "zod";

import { idSchema } from "../workspace";
import { transcriptVersionSchema } from "./evidence";

export const requestSummarySchema = z
  .object({
    commandId: idSchema,
    noteId: idSchema,
  })
  .strict();

export const analysisJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
  "blocked",
]);

export const analysisJobSchema = z
  .object({
    id: idSchema,
    noteId: idSchema,
    commandId: idSchema,
    status: analysisJobStatusSchema,
    source: transcriptVersionSchema,
    resultId: idSchema.nullable(),
    error: z.string().max(1000).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

// Exact replay can return any terminal state; it never implicitly restarts a job.
export const summaryAcceptedSchema = z.object({ job: analysisJobSchema }).strict();

export type RequestSummary = z.infer<typeof requestSummarySchema>;
export type AnalysisJobStatus = z.infer<typeof analysisJobStatusSchema>;
export type AnalysisJob = z.infer<typeof analysisJobSchema>;
