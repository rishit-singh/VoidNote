import { z } from "zod";
export type { AssistantOutputFrame, AssistantOutputScope } from "./output.ts";
export {
  ASSISTANT_OUTPUT_LEASE_MS,
  ASSISTANT_OUTPUT_PROTOCOL,
  assistantOutputFrameSchema,
  assistantOutputLeaseSchema,
  assistantOutputScopeSchema,
} from "./output.ts";

const id = z.uuid();

const timestamp = z.iso.datetime({ offset: true });

export const assistantScopeSchema = z.object({ workspaceId: id });

export const assistantThreadSchema = z.object({
  id,
  noteId: id.nullable(),
  title: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const assistantTurnStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export const assistantSourceSchema = z.object({
  kind: z.enum(["note", "summary", "transcript", "person", "message", "url", "memory", "artifact"]),
  id: z.string().min(1).max(2000),
  label: z.string().max(300),
  revision: z.number().int().nonnegative().optional(),
  contactRevision: z.number().int().nonnegative().optional(),
  url: z
    .url()
    .max(2000)
    .refine((value) => {
      const target = new URL(value);

      return ["http:", "https:"].includes(target.protocol) && !target.username && !target.password;
    })
    .optional(),
  noteId: id.optional(),
  recordingId: id.optional(),
  runId: id.optional(),
  researchRunId: id.optional(),
  researchBatchId: id.optional(),
  startSeconds: z.number().nonnegative().max(7200).optional(),
  endSeconds: z.number().nonnegative().max(7200).optional(),
});

export const assistantToolResultSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  status: z.enum(["running", "succeeded", "failed", "uncertain"]),
  summary: z.string().max(4000),
  sources: z.array(assistantSourceSchema).max(100),
});

export const assistantMessageSchema = z.object({
  id,
  threadId: id,
  turnId: id,
  role: z.enum(["user", "assistant"]),
  text: z.string().max(100_000),
  tools: z.array(assistantToolResultSchema).max(100),
  sources: z.array(assistantSourceSchema).max(100),
  createdAt: timestamp,
});

export const assistantTurnSchema = z.object({
  id,
  threadId: id,
  status: assistantTurnStatusSchema,
  error: z.string().max(1000).nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const assistantHistorySchema = z.object({
  thread: assistantThreadSchema,
  messages: z.array(assistantMessageSchema),
  activeTurn: assistantTurnSchema.nullable(),
  latestTurn: assistantTurnSchema.nullable().optional(),
  nextCursor: z.string().nullable(),
});

export const openAssistantThreadSchema = assistantScopeSchema.extend({
  threadId: id,
  noteId: id.nullable(),
});

export const sendAssistantTurnSchema = assistantScopeSchema.extend({
  threadId: id,
  turnId: id,
  text: z.string().trim().min(1).max(16_000),
});

export const assistantHistoryInputSchema = assistantScopeSchema.extend({
  threadId: id,
  cursor: z.string().max(2000).optional(),
  limit: z.number().int().min(1).max(50).default(30),
});

export const assistantMemorySchema = z.object({
  id,
  subjectId: id.nullable(),
  kind: z.enum(["preference", "claim", "working-summary"]),
  content: z.string().min(1).max(8000),
  provenance: z.enum(["user-stated", "source-supported", "agent-inferred"]),
  sources: z.array(assistantSourceSchema).max(30),
  status: z.enum(["active", "invalidated", "expired", "needs-review"]),
  revision: z.number().int().positive(),
  expiresAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const rememberAssistantMemorySchema = z.object({
  operationId: id,
  subjectId: id.nullable(),
  kind: assistantMemorySchema.shape.kind,
  content: assistantMemorySchema.shape.content,
  provenance: assistantMemorySchema.shape.provenance,
  sources: assistantMemorySchema.shape.sources,
  expiresAt: timestamp.nullable(),
});

export const assistantArtifactSchema = z.object({
  id,
  kind: z.enum(["note", "file", "annotation"]),
  noteId: id.nullable(),
  name: z.string().min(1).max(300),
  mediaType: z.enum(["text/plain", "text/markdown"]),
  content: z.string().max(100_000),
  sources: z.array(assistantSourceSchema).max(30),
  revision: z.number().int().positive(),
  createdAt: timestamp,
});

export const createAssistantArtifactSchema = z.object({
  operationId: id,
  kind: assistantArtifactSchema.shape.kind,
  noteId: id.nullable(),
  name: assistantArtifactSchema.shape.name,
  mediaType: assistantArtifactSchema.shape.mediaType,
  content: assistantArtifactSchema.shape.content,
  sources: assistantArtifactSchema.shape.sources,
});

export const assistantArtifactListItemSchema = assistantArtifactSchema.omit({ content: true });

export type AssistantThread = z.infer<typeof assistantThreadSchema>;
export type AssistantTurn = z.infer<typeof assistantTurnSchema>;
export type AssistantHistory = z.infer<typeof assistantHistorySchema>;
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export type AssistantToolResult = z.infer<typeof assistantToolResultSchema>;
export type AssistantSource = z.infer<typeof assistantSourceSchema>;
export type AssistantMemory = z.infer<typeof assistantMemorySchema>;
export type RememberAssistantMemory = z.infer<typeof rememberAssistantMemorySchema>;
export type AssistantArtifact = z.infer<typeof assistantArtifactSchema>;
export type AssistantArtifactListItem = z.infer<typeof assistantArtifactListItemSchema>;
export type CreateAssistantArtifact = z.infer<typeof createAssistantArtifactSchema>;
