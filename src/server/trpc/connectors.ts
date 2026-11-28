import "server-only";

import { z } from "zod";

import {
  connectorStatusSchema,
  shareBriefInputSchema,
  shareBriefResultSchema,
  slackConnectLinkSchema,
} from "@/contracts/connectors";
import {
  getSlackConnectorStatus,
  createSlackConnection,
  shareSavedBrief,
} from "@/server/connectors";

import { authenticatedProcedure as procedure, router } from "./init";

const workspaceInput = z.object({ workspaceId: z.uuid() }).strict();

export const connectorsRouter = router({
  slackStatus: procedure
    .input(workspaceInput)
    .output(connectorStatusSchema)
    .query(({ ctx, input }) => getSlackConnectorStatus(ctx.principal, input.workspaceId)),
  connectSlack: procedure
    .input(workspaceInput.extend({ operationId: z.uuid() }).strict())
    .output(slackConnectLinkSchema)
    .mutation(({ ctx, input }) =>
      createSlackConnection(
        ctx.principal,
        input.workspaceId,
        input.operationId,
        new URL(ctx.request.url).origin,
      ),
    ),
  shareBrief: procedure
    .input(shareBriefInputSchema)
    .output(shareBriefResultSchema)
    .mutation(({ ctx, input }) => {
      const origin = new URL(ctx.request.url).origin;
      return shareSavedBrief({
        principal: ctx.principal,
        ...input,
        origin,
      });
    }),
});
