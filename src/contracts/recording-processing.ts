import { z } from "zod";
import { idSchema } from "./workspace";

export const MAX_RECORDING_BYTES = 1024 * 1024 * 1024;
export const RECORDING_UPLOAD_PART_BYTES = 8 * 1024 * 1024;
export const RECORDING_SIZE_LABEL = "1 GiB";

export const uploadPartSchema = z.object({
  index: z.number().int().nonnegative().max(127),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const recordingUploadSchema = z.object({
  ready: z.boolean(),
  parts: z.array(uploadPartSchema).max(128),
});
export const MAX_RECORDING_SECONDS = 2 * 60 * 60;
export const recordingInputSchema = z
  .object({
    id: idSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive().max(MAX_RECORDING_BYTES),
    mimeType: z.enum([
      "audio/webm",
      "audio/ogg",
      "audio/mp4",
      "audio/mpeg",
      "audio/wav",
      "audio/flac",
      "audio/x-wav",
    ]),
    durationSeconds: z.number().positive().max(MAX_RECORDING_SECONDS),
  })
  .strict();
export const recordingSchema = recordingInputSchema.extend({
  workspaceId: idSchema,
  noteId: idSchema,
  status: z.enum(["upload_pending", "ready"]),
  createdAt: z.iso.datetime({ offset: true }),
});
export const processingStatusSchema = z.enum([
  "queued",
  "submitting",
  "submission_unknown",
  "submitted",
  "running",
  "succeeded",
  "failed",
  "blocked",
]);
export const processingRunSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  noteId: idSchema,
  recordingId: idSchema,
  status: processingStatusSchema,
  providerJobId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export const processingRequestSchema = z.object({ id: idSchema, recordingId: idSchema }).strict();
export const recordingOverviewSchema = z.object({
  recordings: z.array(recordingSchema).max(30),
  runs: z.array(processingRunSchema).max(30),
});
export const utteranceSchema = z.object({
  id: idSchema,
  runId: idSchema,
  recordingId: idSchema,
  sequence: z.number().int().nonnegative(),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().nonnegative(),
  speakerLabel: z.string().max(200),
  text: z.string().max(100_000),
});
export const transcriptPageSchema = z.object({
  items: z.array(utteranceSchema).max(100),
  nextCursor: z.number().int().nonnegative().nullable(),
});
export const workflowParamsSchema = z.object({ workspaceId: idSchema, runId: idSchema });
export type RecordingInput = z.infer<typeof recordingInputSchema>;
export type RemoteRecording = z.infer<typeof recordingSchema>;
export type ProcessingRun = z.infer<typeof processingRunSchema>;
export type ProcessingStatus = z.infer<typeof processingStatusSchema>;
export type Utterance = z.infer<typeof utteranceSchema>;
export type ProcessingParams = z.infer<typeof workflowParamsSchema>;
