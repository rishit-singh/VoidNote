import { z } from "zod";

import { contactFieldsSchema } from "../contacts";
import { assistantSourceSchema } from "./index";

const input = z.object({
  memoryId: z.uuid(),
  expectedRevision: z.number().int().positive(),
  // Invalidation validates trimmed nonemptiness but fingerprints the original
  // reason. Preserve it exactly; revision inputs are normalized by their owner.
  reason: z.string().min(1).max(1000),
});

/** Internal publication proof, never a model-authored permission or public DTO.
 * Exact acknowledged inputs let SQL verify the original turn-bound receipt.
 */
export const assistantMemoryMutationSchema = z.discriminatedUnion("name", [
  z
    .object({
      name: z.literal("memory_invalidate"),
      operationId: z.uuid(),
      input: input.strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("memory_revise"),
      operationId: z.uuid(),
      input: input
        .extend({
          content: z.string().trim().min(1).max(8000),
          reason: input.shape.reason.trim(),
          sources: z.array(assistantSourceSchema).max(30),
        })
        .strict(),
    })
    .strict(),
]);

export type AssistantMemoryMutation = z.infer<typeof assistantMemoryMutationSchema>;

const profileSourceInput = z.object({
  operationId: z.uuid(),
  sources: z.array(assistantSourceSchema).min(1).max(30),
});

export const assistantProfileMutationSchema = z.discriminatedUnion("name", [
  z
    .object({
      name: z.literal("contacts_create"),
      operationId: z.uuid(),
      input: profileSourceInput
        .extend({
          displayName: z.string().trim().min(1).max(200),
          fields: contactFieldsSchema.partial().default({}),
        })
        .omit({ operationId: true })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("contacts_update"),
      operationId: z.uuid(),
      input: profileSourceInput
        .extend({
          personId: z.uuid(),
          expectedPersonRevision: z.number().int().nonnegative().max(2_147_483_646),
          expectedContactRevision: z.number().int().nonnegative().max(2_147_483_646),
          fields: contactFieldsSchema
            .partial()
            .strict()
            .refine((patch) => Object.keys(patch).length > 0),
        })
        .omit({ operationId: true })
        .strict(),
    })
    .strict(),
]);

export type AssistantProfileMutation = z.infer<typeof assistantProfileMutationSchema>;
