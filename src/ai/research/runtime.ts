import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import { createInferenceRepository } from "../../db/inference";
import { createResearchRepository } from "../../db/research";
import { createServiceBudgetRepository } from "../../db/service-budgets";
import { executionTrace, tracedOperations } from "../../telemetry/execution";
import { inferenceInputTokenBound, type InferenceUsage, observeInferenceUsage } from "../inference";
import { withJobDatabase } from "../jobs";
import { researchExtractionPrompt } from "./extraction";
import { createFirecrawlResearchDiscovery } from "./firecrawl";
import type { ResearchPipelinePorts } from "./pipeline";
import type {
  ResearchExecutionKey,
  ResearchExecutionStore,
  ResearchExtractionProvider,
} from "./ports";
import { createPublicUrlResearchProvider } from "./sources";
import { createWorkerPublicSourceTransport } from "./worker-transport";

export type ResearchEnvironment = Cloudflare.Env & {
  FIRECRAWL_API_KEY?: string;
  RESEARCH_DISCOVERY_ENABLED?: string;
};

/** Workflow-only outcome read: active execution.load intentionally excludes
 * terminal records, so it cannot establish the enclosing trace's result. */
export function readResearchExecutionOutcome(env: ResearchEnvironment, key: ResearchExecutionKey) {
  return withJobDatabase(env, (db) => createResearchRepository(db).executionOutcome(key));
}

function requireResearchEnabled(enabled: () => boolean) {
  if (!enabled()) {
    throw new Error("Research inference is disabled.");
  }
}

/** Real Workers AI extraction adapter, with one nonstreaming call and no tools,
 * retries or model-side discovery. Raw provider usage is the only receipt source. */
export function createWorkersResearchExtraction(
  binding: Ai,
  enabled: () => boolean = () => false,
): ResearchExtractionProvider {
  return {
    async extract(input, signal) {
      requireResearchEnabled(enabled);

      let usage: InferenceUsage | null = null;

      // The SDK can yield after extract() starts. Check the current kill switch
      // again at the actual provider boundary, not only before request assembly.
      const guarded = new Proxy(binding, {
        get(target, property) {
          if (property === "run") {
            return async (...args: Parameters<Ai["run"]>) => {
              requireResearchEnabled(enabled);

              const response: unknown = await Reflect.apply(target.run.bind(target), target, args);

              return response;
            };
          }

          const value: unknown = Reflect.get(target, property, target);

          const bound: unknown = typeof value === "function" ? value.bind(target) : value;

          return bound;
        },
      });

      const observed = observeInferenceUsage(guarded, (receipt) => {
        usage = receipt;
      });

      const provider = createWorkersAI({ binding: observed });

      const result = await generateText({
        model: provider(input.policy.model),
        prompt: researchExtractionPrompt(input),
        maxOutputTokens: input.policy.maxOutputTokens,
        maxRetries: 0,
        providerOptions: { "workers-ai": { reasoning_effort: input.policy.reasoningEffort } },
        abortSignal: signal,
      });

      // Invalid JSON is kept as an invalid output so complete raw usage can still
      // be settled by the pipeline rather than being lost in a parsing exception.
      let output: unknown = result.text;

      try {
        output = JSON.parse(result.text) as unknown;
      } catch {
        /* validation owns rejection */
      }

      return { output, usage };
    },
  };
}

export function createResearchRuntime(
  env: ResearchEnvironment,
  key: ResearchExecutionKey,
): ResearchPipelinePorts {
  const enabled = () => env.RESEARCH_ENABLED === "true";

  const extraction = createWorkersResearchExtraction(env.AI, enabled);

  const repository = <T>(work: (repo: ReturnType<typeof createResearchRepository>) => Promise<T>) =>
    withJobDatabase(env, (db) => work(createResearchRepository(db)));

  const store: ResearchExecutionStore = {
    load: (scope) => repository((repo) => repo.execution.load(scope)),
    start: (scope) => repository((repo) => repo.execution.start(scope)),
    saveSource: (scope, source) => repository((repo) => repo.execution.saveSource(scope, source)),
    claimDiscovery: (scope) => repository((repo) => repo.execution.claimDiscovery(scope)),
    markDiscoveryReserved: (scope) =>
      repository((repo) => repo.execution.markDiscoveryReserved(scope)),
    resetDiscoveryReservation: (scope) =>
      repository((repo) => repo.execution.resetDiscoveryReservation(scope)),
    claimDiscoverySubmission: (scope) =>
      repository((repo) => repo.execution.claimDiscoverySubmission(scope)),
    saveDiscoveredSources: (scope, sources, creditsUsed) =>
      repository((repo) => repo.execution.saveDiscoveredSources(scope, sources, creditsUsed)),
    markDiscoverySettled: (scope) =>
      repository((repo) => repo.execution.markDiscoverySettled(scope)),
    claimFact: (scope, factKey) => repository((repo) => repo.execution.claimFact(scope, factKey)),
    saveFinding: (scope, factKey, finding, usage) =>
      repository((repo) => repo.execution.saveFinding(scope, factKey, finding, usage)),
    saveRejectedFailure: (scope, factKey, failureCode, usage) =>
      executionTrace(
        env,
        scope,
        "research.validation.rejected",
        () =>
          repository((repo) =>
            repo.execution.saveRejectedFailure(scope, factKey, failureCode, usage),
          ),
        { failureCode },
      ),
    markSettled: (scope, factKey) =>
      repository((repo) => repo.execution.markSettled(scope, factKey)),
    finish: async (scope, status, error) => {
      await executionTrace(env, scope, "research.result", async () => {
        await repository((repo) => repo.execution.finish(scope, status, error));

        return { status };
      });
    },
  };

  const runtime: ResearchPipelinePorts = {
    store: tracedOperations(env, key, "research.persistence", store),
    sources: tracedOperations(
      env,
      key,
      "research.sources",
      createPublicUrlResearchProvider(createWorkerPublicSourceTransport()),
    ),
    discovery:
      env.RESEARCH_DISCOVERY_ENABLED === "true" && env.FIRECRAWL_API_KEY
        ? createFirecrawlResearchDiscovery({
            apiKey: env.FIRECRAWL_API_KEY,
            canExecute: async () => {
              if (env.RESEARCH_ENABLED !== "true" || env.RESEARCH_DISCOVERY_ENABLED !== "true") {
                return false;
              }

              const current = await withJobDatabase(env, (db) =>
                createResearchRepository(db).execution.load(key),
              );

              return (
                current?.status === "running" &&
                env.RESEARCH_ENABLED === "true" &&
                env.RESEARCH_DISCOVERY_ENABLED === "true"
              );
            },
          })
        : undefined,
    extraction: {
      extract(input, signal) {
        const scope = { ...key, requestId: input.operationId };

        return executionTrace(
          env,
          scope,
          "research.model.extract",
          async () => {
            const result = await extraction.extract(input, signal);

            if (result.usage) {
              await executionTrace(env, scope, "research.model.usage", () => Promise.resolve(), {
                model: input.policy.model,
                ...result.usage,
              });
            }

            return result;
          },
          { model: input.policy.model },
        );
      },
    },
    enabled,
    admission: {
      async admit(input) {
        requireResearchEnabled(enabled);

        const bound = inferenceInputTokenBound(
          { prompt: researchExtractionPrompt(input) },
          input.policy,
        );

        await withJobDatabase(env, async (db) => {
          const ledger = createInferenceRepository(db);

          const rate = await ledger.getRate(input.policy.rateVersionId);

          if (
            !rate ||
            rate.provider !== input.policy.provider ||
            rate.model !== input.policy.model
          ) {
            throw new Error("Research rate does not match the pinned provider/model.");
          }

          requireResearchEnabled(enabled);

          await ledger.reserve({
            workspaceId: key.workspaceId,
            requestId: input.operationId,
            budgetId: input.policy.budgetId,
            rateVersionId: input.policy.rateVersionId,
            model: input.policy.model,
            inputTokenBound: bound,
            maxOutputTokens: input.policy.maxOutputTokens,
          });
        });
      },
      async settle(operationId, usage) {
        await withJobDatabase(env, (db) =>
          createInferenceRepository(db).settle({
            workspaceId: key.workspaceId,
            requestId: operationId,
            ...usage,
          }),
        );
      },
    },
    serviceBudget: {
      async reserve(input) {
        if (!enabled() || env.RESEARCH_DISCOVERY_ENABLED !== "true") {
          throw new Error("Research discovery is disabled.");
        }

        const reservation = await withJobDatabase(env, (db) =>
          createServiceBudgetRepository(db).reserve({
            ...input,
            provider: "firecrawl",
          }),
        );

        return { status: reservation.status };
      },
      async settle(input) {
        await withJobDatabase(env, (db) =>
          createServiceBudgetRepository(db).settle({
            ...input,
            provider: "firecrawl",
          }),
        );
      },
    },
  };

  return {
    ...runtime,
    ...(runtime.discovery
      ? { discovery: tracedOperations(env, key, "research.discovery", runtime.discovery) }
      : {}),
    admission: tracedOperations(env, key, "research.inference-budget", runtime.admission),
    ...(runtime.serviceBudget
      ? {
          serviceBudget: tracedOperations(
            env,
            key,
            "research.service-budget",
            runtime.serviceBudget,
          ),
        }
      : {}),
  };
}
