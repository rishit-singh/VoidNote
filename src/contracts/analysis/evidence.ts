import { z } from "zod";

import { assignmentSchema } from "../transcript-corrections";
import { idSchema } from "../workspace";

export const transcriptVersionSchema = z
  .object({
    noteId: idSchema,
    recordingId: idSchema,
    runId: idSchema,
    generation: z.number().int().positive(),
  })
  .strict();

// Handles are snapshot-local. The server, never the model, resolves source identity.
export const evidencePassageSchema = z
  .object({
    evidenceId: idSchema,
    segmentId: idSchema,
    segmentRevision: z.number().int().nonnegative(),
    attributionRevision: z.number().int().nonnegative(),
    sourceUtteranceId: idSchema,
    sequence: z.number().int().nonnegative(),
    orderKey: z
      .string()
      .regex(/^[01]*$/)
      .max(256),
    providerTrackId: z.string().max(200),
    assignment: assignmentSchema,
    text: z.string().max(100_000),
    startSeconds: z.number().nonnegative().max(7200),
    endSeconds: z.number().nonnegative().max(7200),
  })
  .strict()
  .refine((value) => value.endSeconds >= value.startSeconds, {
    message: "Evidence audio bounds are reversed.",
  });

export const citationSchema = z
  .object({
    evidenceId: idSchema,
    quote: z.string().min(1).max(4000),
  })
  .strict();

export const summaryEvidenceSchema = z
  .object({
    snapshotId: idSchema,
    source: transcriptVersionSchema,
    passages: z.array(evidencePassageSchema).min(1).max(1000),
  })
  .strict();

export type TranscriptVersion = z.infer<typeof transcriptVersionSchema>;
export type EvidencePassage = z.infer<typeof evidencePassageSchema>;
export type Citation = z.infer<typeof citationSchema>;
