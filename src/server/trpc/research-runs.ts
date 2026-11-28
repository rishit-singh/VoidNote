import "server-only";

import { z } from "zod";

import { requestResearchRunSchema, researchRunDetailSchema } from "@/contracts/research/runs";
import {
  cancelResearchRun,
  listResearchRuns,
  readResearchRun,
  requestResearchRun,
} from "@/server/research-runs";

import { authenticatedProcedure as procedure, router } from "./init";

const scope = z.object({ workspaceId: z.uuid(), runId: z.uuid() }).strict();

export const researchRunsRouter = router({
  request: procedure
    .input(requestResearchRunSchema)
    .output(researchRunDetailSchema)
    .mutation(({ ctx, input }) => requestResearchRun(ctx.principal, input)),
  get: procedure
    .input(scope)
    .output(researchRunDetailSchema)
    .query(({ ctx, input }) => readResearchRun(ctx.principal, input.workspaceId, input.runId)),
  list: procedure
    .input(
      z
        .object({
          workspaceId: z.uuid(),
          noteId: z.uuid().optional(),
          threadId: z.uuid().optional(),
          status: z.enum(["active", "finished", "all"]).default("active"),
          limit: z.number().int().min(1).max(20).default(6),
        })
        .strict(),
    )
    .output(z.array(researchRunDetailSchema))
    .query(({ ctx, input: { workspaceId, ...filters } }) =>
      listResearchRuns(ctx.principal, workspaceId, filters),
    ),
  cancel: procedure
    .input(scope)
    .output(researchRunDetailSchema)
    .mutation(({ ctx, input }) => cancelResearchRun(ctx.principal, input.workspaceId, input.runId)),
});
