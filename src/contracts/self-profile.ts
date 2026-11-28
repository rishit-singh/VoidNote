import { z } from "zod";
import { personContentSchema, personSchema } from "./people";

export const selfProfileGetSchema = z.object({ workspaceId: z.uuid() }).strict();
export const selfProfileCreateSchema = selfProfileGetSchema
  .extend({
    commandId: z.uuid(),
    displayName: personContentSchema.shape.displayName,
  })
  .strict();
export const selfProfileLinkSchema = selfProfileGetSchema
  .extend({
    commandId: z.uuid(),
    personId: z.uuid(),
    expectedRevision: z.number().int().min(1).max(2_147_483_646),
    expectedSelfId: z.uuid().nullable(),
  })
  .strict();
export const selfProfileSchema = personSchema.nullable();

export type SelfProfileGet = z.infer<typeof selfProfileGetSchema>;
export type SelfProfileCreate = z.infer<typeof selfProfileCreateSchema>;
export type SelfProfileLink = z.infer<typeof selfProfileLinkSchema>;
