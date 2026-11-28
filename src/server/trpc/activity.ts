import "server-only";

import { z } from "zod";

import {
  activityChangesInputSchema,
  activityChangesSchema,
  activityPageInputSchema,
  activityPageSchema,
  activityScopeSchema,
  activitySubscriptionSchema,
} from "@/contracts/activity";
import { createActivityRepository } from "@/db/activity";
import { withDatabase } from "@/db/client";
import { createActivitySubscription } from "@/server/activity";

import { authenticatedProcedure as procedure, router } from "./init";

export const activityRouter = router({
  subscribe: procedure
    .input(activityScopeSchema)
    .output(activitySubscriptionSchema)
    .mutation(({ ctx, input }) => createActivitySubscription(ctx.principal, input.workspaceId)),
  list: procedure
    .input(activityPageInputSchema)
    .output(activityPageSchema)
    .query(({ ctx, input }) =>
      withDatabase((db) =>
        createActivityRepository(db).list(
          ctx.principal,
          input.workspaceId,
          input.before,
          input.limit,
        ),
      ),
    ),
  changes: procedure
    .input(activityChangesInputSchema)
    .output(activityChangesSchema)
    .query(({ ctx, input }) =>
      withDatabase((db) =>
        createActivityRepository(db).changes(ctx.principal, input.workspaceId, input.after),
      ),
    ),
  markRead: procedure
    .input(activityScopeSchema.extend({ id: z.uuid() }))
    .output(z.object({ acknowledged: z.literal(true) }))
    .mutation(({ ctx, input }) =>
      withDatabase((db) =>
        createActivityRepository(db).markRead(ctx.principal, input.workspaceId, input.id),
      ),
    ),
});
