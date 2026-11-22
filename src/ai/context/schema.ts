import { z } from "zod";

import { evidencePassageSchema, transcriptVersionSchema } from "../../contracts/analysis";
import { idSchema } from "../../contracts/workspace";

export const profileContextSchema = z
  .object({
    personId: idSchema,
    revision: z.number().int().positive(),
    displayName: z.string().max(200),
    authoredDescription: z.string().max(100_000),
  })
  .strict();

// The proof has no agenda/history provider yet. Literal null/empty prevents it
// from claiming those inputs were assessed. Later versions expand this contract.
export const summaryContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: idSchema,
    workspaceId: idSchema,
    source: transcriptVersionSchema,
    noteRevision: z.number().int().positive(),
    title: z.string().max(300),
    passages: z.array(evidencePassageSchema).min(1).max(1000),
    people: z.array(profileContextSchema).max(100),
    agenda: z.null(),
    relatedConversations: z.array(z.never()).max(0),
    coverage: z.object({ complete: z.literal(true), passageCount: z.number().int().positive() }),
  })
  .strict()
  .refine((value) => value.coverage.passageCount === value.passages.length, {
    message: "Snapshot coverage does not match its passages.",
  });

export const contextReferenceSchema = z
  .object({
    snapshotId: idSchema,
    objectKey: z.string().min(1).max(500),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    source: transcriptVersionSchema,
    noteRevision: z.number().int().positive(),
    profiles: z
      .array(z.object({ personId: idSchema, revision: z.number().int().positive() }).strict())
      .max(100),
  })
  .strict();

export type SummaryContext = z.infer<typeof summaryContextSchema>;
export type ContextReference = z.infer<typeof contextReferenceSchema>;
