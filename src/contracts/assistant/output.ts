import { z } from "zod";

export const assistantOutputScopeSchema = z
  .object({
    workspaceId: z.uuid(),
    threadId: z.uuid(),
    turnId: z.uuid(),
  })
  .strict();

export type AssistantOutputScope = z.infer<typeof assistantOutputScopeSchema>;

export const assistantOutputLeaseSchema = z
  .object({
    ticket: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const assistantOutputFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("snapshot"),
      turnId: z.uuid(),
      text: z.string().max(64_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("terminal"),
      turnId: z.uuid(),
      status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
    })
    .strict(),
]);

export type AssistantOutputFrame = z.infer<typeof assistantOutputFrameSchema>;

export const ASSISTANT_OUTPUT_PROTOCOL = "voidnote-output-v1";
export const ASSISTANT_OUTPUT_LEASE_MS = 30_000;
