import "server-only";

import { z } from "zod";

import { contactDetailsSchema, saveContactDetailsSchema } from "@/contracts/contacts";
import { WorkspaceError } from "@/contracts/workspace";
import { withDatabase } from "@/db/client";
import { createContactRepository } from "@/db/contacts";

import { authenticatedProcedure as procedure, router } from "./init";

export const contactsRouter = router({
  get: procedure
    .input(z.object({ workspaceId: z.uuid(), personId: z.uuid() }))
    .output(contactDetailsSchema)
    .query(async ({ ctx, input }) => {
      const [contact] = await withDatabase((db) =>
        createContactRepository(db).getMany(ctx.principal, input.workspaceId, [input.personId]),
      );

      if (!contact) {
        throw new WorkspaceError("not_found", "Contact is unavailable.");
      }

      return contactDetailsSchema.parse(contact);
    }),
  save: procedure
    .input(saveContactDetailsSchema)
    .output(contactDetailsSchema)
    .mutation(({ ctx, input }) =>
      withDatabase((db) => createContactRepository(db).save(ctx.principal, input)),
    ),
});
