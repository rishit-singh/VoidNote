import { z } from "zod";
import { idSchema } from "./workspace";
import { utteranceSchema } from "./recording-processing";

export const MAX_CORRECTION_TARGETS = 500;
export const assignmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unassigned") }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
  z.object({ kind: z.literal("person"), personId: idSchema }).strict(),
]);
export const correctedTurnSchema = utteranceSchema
  .extend({
    sequence: z.number().nonnegative(),
    sourceUtteranceId: idSchema,
    parentId: idSchema.nullable(),
    revision: z.number().int().nonnegative(),
    attributionRevision: z.number().int().nonnegative(),
    assignment: assignmentSchema,
    assignmentSource: z.enum(["unassigned", "manual"]),
    personName: z.string().nullable(),
    reviewState: z.enum(["unreviewed", "confirmed", "needs_review"]),
    providerScore: z.number().nullable(),
    sampleSuitability: z.enum(["not_evaluated", "candidate", "invalidated"]),
    originalText: z.string(),
    originalStartSeconds: z.number().nonnegative().max(7200),
    originalEndSeconds: z.number().nonnegative().max(7200),
  })
  .superRefine((turn, context) => {
    if ((turn.assignment.kind === "unassigned") !== (turn.assignmentSource === "unassigned"))
      context.addIssue({
        code: "custom",
        path: ["assignmentSource"],
        message: "Assignment source must match its identity state.",
      });
    if (turn.endSeconds < turn.startSeconds || turn.endSeconds > 7200)
      context.addIssue({ code: "custom", path: ["endSeconds"], message: "Invalid audio span." });
    if (turn.originalEndSeconds < turn.originalStartSeconds)
      context.addIssue({
        code: "custom",
        path: ["originalEndSeconds"],
        message: "Invalid source audio span.",
      });
  });
export const transcriptPassageSchema = z.object({
  id: idSchema,
  turnIds: z.array(idSchema).min(1),
  startSeconds: z.number().nonnegative().max(7200),
  endSeconds: z.number().nonnegative().max(7200),
  text: z.string(),
});
export const correctedTranscriptPageSchema = z.object({
  items: z.array(correctedTurnSchema).max(100),
  passages: z.array(transcriptPassageSchema).max(100).optional(),
  nextCursor: z.string().nullable(),
});
export const correctionTargetSchema = z
  .object({
    id: idSchema,
    expectedAttributionRevision: z.number().int().nonnegative(),
  })
  .strict();
export const correctionTargetsSchema = z.object({
  targets: z.array(correctionTargetSchema).max(MAX_CORRECTION_TARGETS),
  excludedManualCount: z.number().int().nonnegative(),
});
const targets = z
  .array(correctionTargetSchema)
  .min(1)
  .max(MAX_CORRECTION_TARGETS)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length);
export const correctionCommandSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("assign"),
        commandId: idSchema,
        targets,
        assignment: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("unknown") }).strict(),
          z.object({ kind: z.literal("person"), personId: idSchema }).strict(),
        ]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("edit"),
        commandId: idSchema,
        utteranceId: idSchema,
        expectedRevision: z.number().int().nonnegative(),
        text: z
          .string()
          .min(1)
          .max(100_000)
          .refine((value) => value.trim().length > 0),
        startSeconds: z.number().nonnegative().max(7200),
        endSeconds: z.number().nonnegative().max(7200),
      })
      .strict(),
    z
      .object({
        kind: z.literal("split"),
        commandId: idSchema,
        utteranceId: idSchema,
        expectedRevision: z.number().int().nonnegative(),
        splitSeconds: z.number().positive().max(7200),
        textOffset: z.number().int().positive().max(100_000),
        leftId: idSchema,
        rightId: idSchema,
        selection: z
          .object({
            startOffset: z.number().int().nonnegative().max(100_000),
            endOffset: z.number().int().positive().max(100_000),
            startSeconds: z.number().nonnegative().max(7200),
            endSeconds: z.number().positive().max(7200),
            selectedId: idSchema,
            assignment: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("unknown") }).strict(),
              z.object({ kind: z.literal("person"), personId: idSchema }).strict(),
            ]),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z.object({ kind: z.literal("undo"), commandId: idSchema, correctionId: idSchema }).strict(),
  ])
  .superRefine((command, context) => {
    if (command.kind === "edit" && command.endSeconds <= command.startSeconds)
      context.addIssue({
        code: "custom",
        path: ["endSeconds"],
        message: "End must be after start.",
      });
    if (
      command.kind === "split" &&
      new Set([command.utteranceId, command.leftId, command.rightId]).size !== 3
    )
      context.addIssue({
        code: "custom",
        path: ["leftId"],
        message: "Split segments need new, distinct identities.",
      });
  });
export const correctionReceiptSchema = z.object({
  id: idSchema,
  commandId: idSchema,
  kind: z.enum(["assign", "edit", "split", "undo"]),
  affectedCount: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  undoOf: idSchema.nullable(),
});
export const correctionHistoryItemSchema = correctionReceiptSchema.extend({
  actorId: idSchema,
  before: z.array(correctedTurnSchema),
  after: z.array(correctedTurnSchema),
});
export const correctionHistoryPageSchema = z.object({
  items: z.array(correctionHistoryItemSchema).max(20),
  nextCursor: z.string().nullable(),
});
export const personAppearancesSchema = z.object({
  items: z
    .array(
      z
        .object({
          noteId: idSchema,
          noteTitle: z.string(),
          recordingId: idSchema,
          runId: idSchema,
          utteranceId: idSchema,
          startSeconds: z.number().nonnegative().max(7200),
          endSeconds: z.number().nonnegative().max(7200),
          text: z.string(),
        })
        .refine((item) => item.endSeconds >= item.startSeconds),
    )
    .max(20),
  nextCursor: z.string().nullable(),
});
export type Assignment = z.infer<typeof assignmentSchema>;
export type CorrectedTurn = z.infer<typeof correctedTurnSchema>;
export type TranscriptPassage = z.infer<typeof transcriptPassageSchema>;
export type CorrectionCommand = z.infer<typeof correctionCommandSchema>;
export type CorrectionTarget = z.infer<typeof correctionTargetSchema>;
export type CorrectionReceipt = z.infer<typeof correctionReceiptSchema>;
