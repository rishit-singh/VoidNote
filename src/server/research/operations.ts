import { researchRunPolicySchema } from "../../config/research-runs";
import { researchAgentScopeSchema } from "../../contracts/research/agent";
import { WorkspaceError } from "../../contracts/workspace";
import { createInferenceRepository } from "../../db/inference";
import { createResearchAgentOperationsRepository } from "../../db/research/agent-operations";
import { createResearchRunsRepository } from "../../db/research/runs";
import type {
  ResearchAgentRunKey,
  ResearchAgentServices,
} from "../../contracts/research/execution";
import { createResearchAgentEvidenceTools } from "./evidence";
import { type ResearchRunEnvironment, withResearchRunDatabase } from "./environment";

const MAX_PUBLICATION_FEEDBACK_CHARACTERS = 500;

/** Application authority is re-read for each operation, never inferred from DO state. */
export function createOperations(env: ResearchRunEnvironment): ResearchAgentServices {
  const repository = <T>(
    work: (repo: ReturnType<typeof createResearchRunsRepository>) => Promise<T>,
  ) => withResearchRunDatabase(env, (db) => work(createResearchRunsRepository(db)));

  async function execution(key: ResearchAgentRunKey) {
    const work = await repository((repo) => repo.loadWork(key));

    if (!work) {
      throw new WorkspaceError("not_found", "Research run is unavailable.");
    }

    const policy = researchRunPolicySchema.parse(work.policy);

    const scope = researchAgentScopeSchema.parse({
      workspaceId: key.workspaceId,
      runId: key.runId,
      actorId: work.actorId,
      operationId: key.runId,
      question: work.input.question,
      questions: work.questions.map(({ id, question }) => ({ id, question })),
      noteId: work.input.noteId ?? null,
      personId: work.input.personId ?? null,
      sourceUrls: work.input.sourceUrls,
      discoverSources: work.input.discoverSources,
      timeframe: work.input.timeframe ?? { mode: "unspecified" },
      maxAgeDays: policy.maxSnapshotAgeDays,
    });

    return { status: work.status, scope, policy };
  }

  async function assertActive(key: ResearchAgentRunKey) {
    if (
      env.RESEARCH_ENABLED !== "true" ||
      env.RESEARCH_AGENT_ENABLED !== "true" ||
      !(await repository((repo) => repo.assertRunnable(key)))
    ) {
      throw new WorkspaceError("conflict", "Research execution is no longer active.");
    }
  }

  return {
    execution,
    async beginRun(key) {
      if (env.RESEARCH_ENABLED !== "true" || env.RESEARCH_AGENT_ENABLED !== "true") {
        return false;
      }

      return repository((repo) => repo.claim(key));
    },
    async isCancelled(key) {
      return !(await repository((repo) => repo.assertRunnable(key)));
    },
    async executeTool(name, input, context) {
      await assertActive(context);
      const current = await execution(context);

      const handlers = await createResearchAgentEvidenceTools(
        env,
        current.scope,
        context.operationId,
      );

      return handlers[name](input);
    },
    async publishReport(scope, input, operationId) {
      const current = await execution(scope);

      // Lost publication acknowledgements are reconciled by the adapter's exact
      // operation receipt, including after the run became terminal.
      const handlers = await createResearchAgentEvidenceTools(env, current.scope, operationId);

      const result = await handlers.publish_report(input);

      if (!result.ok) {
        return {
          published: false,
          reason: "invalid-citations",
          feedback: result.message.slice(0, MAX_PUBLICATION_FEEDBACK_CHARACTERS),
        };
      }

      return { published: true, receiptId: operationId };
    },
    async failRun(scope, message) {
      await repository((repo) => repo.finish(scope, { status: "failed", error: message }));
    },
    async admitModelRequest(scope) {
      await assertActive(scope);
      const current = await execution(scope);
      // The accepted run owns its immutable policy. Never authorize inference
      // from a caller's copy or compare entire serialized policy objects.
      const policy = current.policy;

      if (
        scope.inputTokenBound > policy.maxInputTokens ||
        scope.inputTokenBound + policy.maxOutputTokens > policy.contextWindowTokens
      ) {
        throw new WorkspaceError("conflict", "Research model context exceeds its pinned limit.");
      }

      await withResearchRunDatabase(env, async (db) => {
        const operations = createResearchAgentOperationsRepository(db);

        const key = { ...scope, operationId: scope.requestId };

        await operations.prepare(key, {
          kind: "model",
          payload: { model: policy.model, inputTokenBound: scope.inputTokenBound },
        });
        const claim = await operations.claim(key);

        if (claim.status !== "claimed") {
          throw new WorkspaceError("conflict", "Research model operation cannot be resubmitted.");
        }

        await createInferenceRepository(db).reserve({
          workspaceId: scope.workspaceId,
          requestId: scope.requestId,
          budgetId: policy.budgetId,
          rateVersionId: policy.rateVersionId,
          model: policy.model,
          inputTokenBound: scope.inputTokenBound,
          maxOutputTokens: policy.maxOutputTokens,
        });
      });
    },
  };
}
