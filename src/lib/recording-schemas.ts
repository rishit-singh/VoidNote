import { z } from "zod";

// Ownerless prototype records stay on disk; never adopt them into an account.
export const recordingSessionSchema = z.object({
  id: z.string().min(1),
  noteId: z.string().min(1),
  userId: z.uuid(),
  workspaceId: z.uuid(),
  status: z.enum(["recording", "recoverable", "finalized", "failed"]),
  mimeType: z.string(),
  chunkCount: z.number().int().nonnegative(),
  byteCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  source: z.enum(["microphone", "file"]).optional(),
  processing: z.enum(["pending", "submitted"]).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LocalRecordingSession = z.infer<typeof recordingSessionSchema>;
export const recordingChunkSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  sequence: z.number().int().positive(),
  blob: z.instanceof(Blob),
  createdAt: z.string(),
});
