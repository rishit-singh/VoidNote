import { z } from "zod";

// Bounded facade for existing mixed workspace callers; each domain owns its contracts.
export {
  noteContentSchema,
  noteListItemSchema,
  noteListSchema,
  noteSchema,
  notesQuerySchema,
  saveNoteSchema,
} from "./notes";
export type { NoteListItem, NoteRecord, NotesQuery, SaveNote } from "./notes";
export {
  PERSON_DESCRIPTION_PREVIEW_LENGTH,
  peopleQuerySchema,
  personContentSchema,
  personListItemSchema,
  personListSchema,
  personSchema,
  savePersonSchema,
  toPersonListItem,
} from "./people";
export type { PeopleQuery, PersonListItem, PersonRecord, SavePerson } from "./people";

export const idSchema = z.uuid();
const commandFields = {
  commandId: idSchema,
  id: idSchema,
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
};
export const deleteSchema = z.object(commandFields).strict();
export const listQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
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
export type DeleteCommand = z.infer<typeof deleteSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
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
