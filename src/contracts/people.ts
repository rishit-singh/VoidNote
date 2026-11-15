import { z } from "zod";

export const PERSON_DESCRIPTION_PREVIEW_LENGTH = 160;

export const personContentSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  description: z.string().max(5_000),
});

export const personSchema = personContentSchema.extend({
  id: z.uuid(),
  workspaceId: z.uuid(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  deletedAt: z.iso.datetime({ offset: true }).nullable(),
});

// Previews count Unicode code points, matching PostgreSQL left(description, length).
// They cannot stand in for full detail or editable person content.
export const personListItemSchema = personSchema.omit({ description: true }).extend({
  descriptionPreview: z
    .string()
    .refine((value) => Array.from(value).length <= PERSON_DESCRIPTION_PREVIEW_LENGTH, {
      message: `Description preview must contain at most ${PERSON_DESCRIPTION_PREVIEW_LENGTH} code points`,
    }),
});

export const personListSchema = z.object({
  items: z.array(personListItemSchema),
  nextCursor: z.string().nullable(),
});

export const savePersonSchema = z
  .object({
    commandId: z.uuid(),
    id: z.uuid(),
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    content: personContentSchema,
  })
  .strict();

// Literal, case-insensitive display-name prefix; pagination remains UUID ascending.
export const peopleQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
  q: z.string().max(200).default(""),
});

export type PersonRecord = z.infer<typeof personSchema>;

export type PersonListItem = z.infer<typeof personListItemSchema>;

export type SavePerson = z.infer<typeof savePersonSchema>;

export type PeopleQuery = z.infer<typeof peopleQuerySchema>;

export function toPersonListItem(record: PersonRecord): PersonListItem {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    displayName: record.displayName,
    descriptionPreview: Array.from(record.description)
      .slice(0, PERSON_DESCRIPTION_PREVIEW_LENGTH)
      .join(""),
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deletedAt: record.deletedAt,
  };
}
