import "server-only";

import { z } from "zod";

import {
  requestResearchSchema,
  researchBatchSchema,
  researchScopeSchema,
  retryResearchSchema,
} from "@/contracts/research";
import {
  cancelContactResearch,
  listContactResearch,
  readContactResearch,
  requestContactResearch,
  researchPolicy,
  retryContactResearch,
} from "@/server/research";

import { authenticatedProcedure as procedure, router } from "./init";

export const researchRouter = router({
  availability: procedure
    .input(z.object({ workspaceId: z.uuid() }).strict())
    .output(z.object({ enabled: z.boolean(), reason: z.string().nullable() }))
    .query(() => {
      const enabled = researchPolicy() !== null;

      return {
        enabled,
        reason: enabled
          ? null
          : "Research needs configured public-source retrieval, a model and an approved inference allowance.",
      };
    }),
  request: procedure
    .input(requestResearchSchema)
    .output(researchBatchSchema)
    .mutation(({ ctx, input }) => requestContactResearch(ctx.principal, input)),
  get: procedure
    .input(researchScopeSchema)
    .output(researchBatchSchema)
    .query(({ ctx, input }) =>
      readContactResearch(ctx.principal, input.workspaceId, input.batchId),
    ),
  list: procedure
    .input(z.object({ workspaceId: z.uuid(), personId: z.uuid().optional() }).strict())
    .output(z.array(researchBatchSchema))
    .query(({ ctx, input }) =>
      listContactResearch(ctx.principal, input.workspaceId, input.personId),
    ),
  cancel: procedure
    .input(researchScopeSchema)
    .output(researchBatchSchema)
    .mutation(({ ctx, input }) =>
      cancelContactResearch(ctx.principal, input.workspaceId, input.batchId),
    ),
  retry: procedure
    .input(retryResearchSchema)
    .output(researchBatchSchema)
    .mutation(({ ctx, input }) => retryContactResearch(ctx.principal, input)),
});
