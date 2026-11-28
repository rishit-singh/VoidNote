import "server-only";

import { z } from "zod";

import {
  assistantArtifactListItemSchema,
  assistantArtifactSchema,
  assistantHistoryInputSchema,
  assistantHistorySchema,
  assistantOutputLeaseSchema,
  assistantOutputScopeSchema,
  assistantScopeSchema,
  assistantThreadSchema,
  assistantTurnSchema,
  openAssistantThreadSchema,
  sendAssistantTurnSchema,
} from "@/contracts/assistant";
import {
  conversationSummarySchema,
  conversationSummaryScopeSchema,
} from "@/contracts/conversation-summaries";
import { WorkspaceError } from "@/contracts/workspace";
import { createAssistantRepository } from "@/db/assistant";
import { withDatabase } from "@/db/client";
import { createConversationSummaryRepository } from "@/db/conversation-summaries";
import { createInferenceRepository } from "@/db/inference";
import {
  assistantPolicy,
  createAssistantOutputLease,
  notifyAssistantTurn,
} from "@/server/assistant";

import { authenticatedProcedure as procedure, router } from "./init";

function repository<T>(work: (repo: ReturnType<typeof createAssistantRepository>) => Promise<T>) {
  return withDatabase((db) => work(createAssistantRepository(db)));
}

export const assistantRouter = router({
  conversationSummary: procedure
    .input(conversationSummaryScopeSchema)
    .output(conversationSummarySchema.nullable())
    .query(({ ctx, input }) =>
      withDatabase((db) =>
        createConversationSummaryRepository(db).latest(
          ctx.principal,
          input.workspaceId,
          input.threadId,
        ),
      ),
    ),
  outputLease: procedure
    .input(assistantOutputScopeSchema)
    .output(assistantOutputLeaseSchema)
    .mutation(({ ctx, input }) => createAssistantOutputLease(ctx.principal, input)),
  availability: procedure
    .input(assistantScopeSchema)
    .output(z.object({ enabled: z.boolean(), reason: z.string().nullable() }))
    .query(async ({ ctx, input }) => {
      const policy = assistantPolicy();

      return withDatabase(async (db) => {
        await createAssistantRepository(db).listThreads(ctx.principal, input.workspaceId);

        if (!policy) {
          return {
            enabled: false,
            reason: "Assistant inference needs a configured model and approved allowance.",
          };
        }

        const ledger = createInferenceRepository(db);

        const allowance = await ledger.getBudgetAvailability({
          workspaceId: input.workspaceId,
          budgetId: policy.budgetId,
        });

        const rate = await ledger.getRate(policy.rateVersionId);

        const enabled = Boolean(
          allowance?.approved &&
          allowance.availableMicroUsd > 0 &&
          allowance.rateVersionId === policy.rateVersionId &&
          rate?.provider === "workers-ai" &&
          rate.model === policy.model,
        );

        return {
          enabled,
          reason: enabled ? null : "Assistant allowance is unavailable or exhausted.",
        };
      });
    }),
  threads: procedure
    .input(assistantScopeSchema.extend({ noteId: z.uuid().optional() }))
    .output(z.array(assistantThreadSchema))
    .query(({ ctx, input }) =>
      repository((repo) => repo.listThreads(ctx.principal, input.workspaceId, input.noteId)),
    ),
  open: procedure
    .input(openAssistantThreadSchema)
    .output(assistantThreadSchema)
    .mutation(({ ctx, input }) =>
      repository((repo) =>
        repo.openThread(ctx.principal, input.workspaceId, input.threadId, input.noteId),
      ),
    ),
  history: procedure
    .input(assistantHistoryInputSchema)
    .output(assistantHistorySchema)
    .query(({ ctx, input }) =>
      repository((repo) =>
        repo.history(ctx.principal, input.workspaceId, input.threadId, input.cursor, input.limit),
      ),
    ),
  send: procedure
    .input(sendAssistantTurnSchema)
    .output(assistantTurnSchema)
    .mutation(async ({ ctx, input }) => {
      const policy = assistantPolicy();

      if (!policy) {
        // Exact retry remains a read of the accepted command even after a flag
        // changes. The repository rejects a new acceptance without a policy.
        return repository((repo) =>
          repo.requestTurn(
            ctx.principal,
            input.workspaceId,
            input.threadId,
            input.turnId,
            input.text,
            null,
          ),
        );
      }

      const turn = await repository((repo) =>
        repo.requestTurn(
          ctx.principal,
          input.workspaceId,
          input.threadId,
          input.turnId,
          input.text,
          policy,
        ),
      );

      if (turn.status === "queued") {
        notifyAssistantTurn(input.workspaceId, input.threadId, input.turnId);
      }

      return turn;
    }),
  cancel: procedure
    .input(assistantScopeSchema.extend({ turnId: z.uuid() }))
    .output(assistantTurnSchema)
    .mutation(async ({ ctx, input }) => {
      const turn = await repository((repo) =>
        repo.cancelTurn(ctx.principal, input.workspaceId, input.turnId),
      );

      if (turn.status === "cancelled") {
        notifyAssistantTurn(input.workspaceId, turn.threadId, turn.id, true);
      }

      return turn;
    }),
  artifacts: procedure
    .input(assistantScopeSchema.extend({ noteId: z.uuid().optional() }))
    .output(z.array(assistantArtifactListItemSchema))
    .query(({ ctx, input }) =>
      repository((repo) => repo.listArtifacts(ctx.principal, input.workspaceId, input.noteId)),
    ),
  artifact: procedure
    .input(assistantScopeSchema.extend({ id: z.uuid() }))
    .output(assistantArtifactSchema)
    .query(async ({ ctx, input }) => {
      const artifact = await repository((repo) =>
        repo.getArtifact(ctx.principal, input.workspaceId, input.id),
      );

      if (!artifact) {
        throw new WorkspaceError("not_found", "Artifact not found.");
      }

      return artifact;
    }),
});
