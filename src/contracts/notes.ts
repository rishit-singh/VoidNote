import { z } from "zod";

export const noteContentSchema = z.object({
  title: z.string().max(300),
  transcript: z.string().max(500_000),
});

export const noteSchema = noteContentSchema.extend({
  id: z.uuid(),
  workspaceId: z.uuid(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  deletedAt: z.iso.datetime({ offset: true }).nullable(),
});

// List metadata cannot stand in for a full note or an editable transcript.
export const noteListItemSchema = noteSchema.omit({ transcript: true });

export const noteListSchema = z.object({
  items: z.array(noteListItemSchema),
  nextCursor: z.string().nullable(),
});

export const saveNoteSchema = z
  .object({
    commandId: z.uuid(),
    id: z.uuid(),
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    content: noteContentSchema,
  })
  .strict();

// Literal, case-insensitive title prefix; not full-text or substring search.
export const notesQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
  q: z.string().max(300).default(""),
});

export type NoteRecord = z.infer<typeof noteSchema>;

export type NoteListItem = z.infer<typeof noteListItemSchema>;

export type SaveNote = z.infer<typeof saveNoteSchema>;

export type NotesQuery = z.infer<typeof notesQuerySchema>;
