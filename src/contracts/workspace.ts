import { z } from "zod";

export const idSchema = z.uuid();
export const noteContentSchema = z.object({
  title: z.string().max(300),
  transcript: z.string().max(500_000),
});
export const personContentSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  description: z.string().max(5_000),
});
const recordFields = {
  id: idSchema,
  workspaceId: idSchema,
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  deletedAt: z.iso.datetime({ offset: true }).nullable(),
};
export const noteSchema = noteContentSchema.extend(recordFields);
export const personSchema = personContentSchema.extend(recordFields);
const commandFields = {
  commandId: idSchema,
  id: idSchema,
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
};
export const saveNoteSchema = z.object({ ...commandFields, content: noteContentSchema }).strict();
export const savePersonSchema = z
  .object({ ...commandFields, content: personContentSchema })
  .strict();
export const deleteSchema = z.object(commandFields).strict();
export const listQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export const peopleQuerySchema = listQuerySchema.extend({ q: z.string().max(200).default("") });
// Literal, case-insensitive title prefix; not full-text or substring search.
export const notesQuerySchema = listQuerySchema.extend({ q: z.string().max(300).default("") });
export const noteListSchema = z.object({
  items: z.array(noteSchema),
  nextCursor: z.string().nullable(),
});
export const personListSchema = z.object({
  items: z.array(personSchema),
  nextCursor: z.string().nullable(),
});
export const eventSchema = z.object({
  id: idSchema,
  entityId: idSchema,
  entityType: z.enum(["note", "person"]),
  revision: z.number().int().positive(),
  operation: z.string(),
  operationVersion: z.number().int().positive(),
  actorId: idSchema,
  commandId: idSchema,
  createdAt: z.iso.datetime({ offset: true }),
});
export const historySchema = z.object({
  items: z.array(eventSchema),
  nextCursor: z.string().nullable(),
});
export const sessionSchema = z.object({
  user: z.object({ id: idSchema, email: z.string().nullable() }),
  workspace: z.object({ id: idSchema, name: z.string() }),
});
export type Principal = { id: string; email: string | null };
export type NoteRecord = z.infer<typeof noteSchema>;
export type PersonRecord = z.infer<typeof personSchema>;
export type SaveNote = z.infer<typeof saveNoteSchema>;
export type SavePerson = z.infer<typeof savePersonSchema>;
export type DeleteCommand = z.infer<typeof deleteSchema>;
export type NotesQuery = z.infer<typeof notesQuerySchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
export type PeopleQuery = z.infer<typeof peopleQuerySchema>;
export type Session = z.infer<typeof sessionSchema>;

export class WorkspaceError extends Error {
  readonly code: "forbidden" | "not_found" | "conflict" | "command_reused" | "invalid_cursor";
  readonly currentRevision: number | undefined;
  readonly affectedTargets: string[] | undefined;
  constructor(
    code: WorkspaceError["code"],
    message: string,
    currentRevision?: number,
    affectedTargets?: string[],
  ) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.currentRevision = currentRevision;
    this.affectedTargets = affectedTargets;
  }
}
