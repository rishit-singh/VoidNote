import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import { type ResearchRunPolicy, researchRunPolicySchema } from "../../../config/research-runs";
import type {
  RequestResearchRun,
  ResearchRunDetail,
  ResearchRunExecutionKey,
} from "../../../contracts/research/runs";
import { createInferenceRepository } from "../../../db/inference";
import { createResearchRunsRepository } from "../../../db/research/runs";
import { createServiceBudgetRepository } from "../../../db/service-budgets";
import { executionTrace } from "../../../telemetry/execution";
import type { InferenceUsage } from "../../inference";
import { inferenceInputTokenBound, observeInferenceUsage } from "../../inference";
import { createPublicUrlResearchProvider } from "../sources";
import { createWorkerPublicSourceTransport } from "../worker-transport";
import {
  type ResearchCandidate,
  searchResearchCandidates,
  selectResearchCandidates,
} from "./discovery";
import {
  type ResearchRunEnvironment,
  withResearchRunDatabase as withJobDatabase,
} from "./environment";
import { reportFromFindings, type RunSource, synthesizeResearchQuestions } from "./pipeline";
import { parseResearchSynthesis, researchSynthesisPrompt } from "./synthesis";
export type { ResearchRunEnvironment } from "./environment";

type ResearchRunSource = RunSource & {
  title?: string;
  publishedAt?: string | null;
  originSourceId?: string | null;
  disposition?: "retrieved" | "reused";
};

const SOURCE_RETRIEVAL_CONCURRENCY = 2;

const MATERIAL_GAP_COVERAGE_THRESHOLD = 0.25;

async function mapSettledWithLimit<T, R>(
  values: T[],
  limit: number,
  work: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Map<number, PromiseSettledResult<R>>();

  let next = 0;

  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = next++;

      if (index >= values.length) {
        return;
      }

      try {
        results.set(index, { status: "fulfilled", value: await work(values[index]!) });
      } catch (reason) {
        results.set(index, { status: "rejected", reason });
      }
    }
  });

  await Promise.all(workers);

  return Array.from({ length: values.length }, (_, index) => results.get(index)!);
}

function storedCandidates(value: unknown): ResearchCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }

    const candidate = entry as Partial<ResearchCandidate>;

    if (
      typeof candidate.url !== "string" ||
      typeof candidate.title !== "string" ||
      typeof candidate.snippet !== "string"
    ) {
      return [];
    }

    return [
      {
        url: candidate.url,
        title: candidate.title,
        snippet: candidate.snippet,
        publishedAt: typeof candidate.publishedAt === "string" ? candidate.publishedAt : null,
      },
    ];
  });
}

function sourceCoverage(question: string, sources: ResearchRunSource[]) {
  const questionTerms = new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

  if (!questionTerms.size) {
    return 1;
  }

  let matched = 0;

  for (const term of questionTerms) {
    if (sources.some((source) => source.text.toLowerCase().includes(term))) {
      matched += 1;
    }
  }

  return matched / questionTerms.size;
}

function materialGapQuery(
  question: string,
  sources: ResearchRunSource[],
  timeframe: RequestResearchRun["timeframe"],
) {
  const covered = sources.map((source) => source.text.toLowerCase()).join(" ");

  const tokens = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];

  const missing = tokens.filter((token) => !covered.includes(token)).slice(0, 8);

  const focus =
    timeframe?.mode === "historical"
      ? "historical primary source"
      : timeframe?.mode === "current"
        ? "current primary source"
        : "primary source";

  return `${missing.join(" ")} ${focus}`.trim().slice(0, 500);
}

function normalizedPublishedAt(value: string | null) {
  if (!value) {
    return null;
  }

  const milliseconds = Date.parse(value);

  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function enabled(env: ResearchRunEnvironment) {
  return env.RESEARCH_ENABLED === "true";
}

const safeCode = (error: unknown) =>
  error instanceof Error && error.name === "AbortError" ? "aborted" : "operation_failed";

async function checkpoint<T>(operation: () => Promise<T>): Promise<T> {
  let cause: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      cause = error;
    }
  }

  if (cause instanceof Error && cause.name === "ResearchCheckpointError") {
    throw cause;
  }

  const error = new Error("Research durable checkpoint failed.", { cause });

  error.name = "ResearchCheckpointError";
  throw error;
}

async function workerSynthesis(input: {
  env: ResearchRunEnvironment;
  key: ResearchRunExecutionKey;
  question: { id: string; operationId: string; question: string };
  sources: RunSource[];
  signal: AbortSignal;
  policy: ResearchRunPolicy;
  personName: string | null;
  timeframe: RequestResearchRun["timeframe"];
}) {
  if (!enabled(input.env)) {
    const rejected = new Error("Research inference is disabled.");

    rejected.name = "ResearchAdmissionRejected";
    throw rejected;
  }

  const synthesisQuestion = input.personName
    ? `${input.question.question}\nResearch subject: ${input.personName}`
    : input.question.question;

  const temporalScope =
    input.timeframe?.mode === "historical"
      ? `Research timeframe: historical${input.timeframe.asOf ? ` as of ${input.timeframe.asOf}` : ""}. Do not replace historical claims with current facts.`
      : input.timeframe?.mode === "current"
        ? "Research timeframe: current. A recent retrieval date does not establish that a claim is current."
        : "Research timeframe: unspecified. Do not imply claims are current without dated evidence.";

  const prompt = researchSynthesisPrompt(`${synthesisQuestion}\n${temporalScope}`, input.sources, {
    maxEvidenceBytes: input.policy.maxEvidenceBytes,
    timeframe: input.timeframe,
  });

  const inputTokenBound = inferenceInputTokenBound({ prompt }, input.policy);

  await checkpoint(() =>
    withJobDatabase(input.env, async (db) => {
      const inference = createInferenceRepository(db);

      const rate = await inference.getRate(input.policy.rateVersionId);

      if (!rate || rate.provider !== input.policy.provider || rate.model !== input.policy.model) {
        throw new Error("Research rate does not match the pinned model.");
      }
    }),
  );
  const work = await checkpoint(() =>
    withJobDatabase(input.env, (db) => createResearchRunsRepository(db).loadWork(input.key)),
  );

  const question = work?.questions.find((candidate) => candidate.id === input.question.id);

  if (!question) {
    throw new Error("Research question checkpoint is missing.");
  }

  const settleNoSubmission = async (operationId: string) =>
    checkpoint(() =>
      withJobDatabase(input.env, async (db) => {
        await createInferenceRepository(db).settle({
          workspaceId: input.key.workspaceId,
          requestId: operationId,
          inputTokens: 0,
          outputTokens: 0,
        });
        await createResearchRunsRepository(db).settleQuestionInference(
          input.key,
          input.question.id,
        );
      }),
    );

  const settleKnownUsage = async (operationId: string, knownUsage: InferenceUsage) =>
    checkpoint(() =>
      withJobDatabase(input.env, async (db) => {
        await createInferenceRepository(db).settle({
          workspaceId: input.key.workspaceId,
          requestId: operationId,
          ...knownUsage,
        });
        await createResearchRunsRepository(db).settleQuestionInference(
          input.key,
          input.question.id,
        );
      }),
    );

  let output: unknown;

  let usage: InferenceUsage | null = question.inferenceUsage;

  if (question.inferenceResult !== null && question.inferenceResult !== undefined) {
    output = question.inferenceResult;
  } else {
    const claim = await checkpoint(() =>
      withJobDatabase(input.env, (db) =>
        createResearchRunsRepository(db).claimQuestionInference(input.key, input.question.id),
      ),
    );

    if (!claim) {
      const latest = await checkpoint(() =>
        withJobDatabase(input.env, (db) => createResearchRunsRepository(db).loadWork(input.key)),
      );

      const latestQuestion = latest?.questions.find((item) => item.id === input.question.id);

      if (
        latestQuestion?.inferenceResult === null ||
        latestQuestion?.inferenceResult === undefined
      ) {
        if (
          !(await checkpoint(() =>
            withJobDatabase(input.env, (db) =>
              createResearchRunsRepository(db).assertRunnable(input.key),
            ),
          ))
        ) {
          const rejected = new Error("Research run was cancelled or lost authority.");

          rejected.name = "ResearchAdmissionRejected";
          throw rejected;
        }

        const uncertain = new Error("Inference submission has an uncertain outcome.");

        uncertain.name = "UncertainInferenceOutcome";
        throw uncertain;
      }

      output = latestQuestion.inferenceResult;
      usage = latestQuestion.inferenceUsage;
    } else {
      await checkpoint(() =>
        withJobDatabase(input.env, async (db) => {
          await createInferenceRepository(db).reserve({
            workspaceId: input.key.workspaceId,
            requestId: claim.operationId,
            budgetId: input.policy.budgetId,
            rateVersionId: input.policy.rateVersionId,
            model: input.policy.model,
            inputTokenBound,
            maxOutputTokens: input.policy.maxOutputTokens,
          });
        }),
      );

      let observedUsage: InferenceUsage | null = null;

      const ai = input.env.AI;

      if (!ai) {
        throw new Error("Research inference binding is unavailable.");
      }

      const binding = new Proxy(ai, {
        get(target, property) {
          if (property === "run") {
            return async (...args: Parameters<Ai["run"]>) => {
              if (!enabled(input.env)) {
                await settleNoSubmission(claim.operationId);
                const rejected = new Error("Research inference was disabled before submission.");

                rejected.name = "ResearchAdmissionRejected";
                throw rejected;
              }

              const live = await checkpoint(() =>
                withJobDatabase(input.env, (db) =>
                  createResearchRunsRepository(db).assertRunnable(input.key),
                ),
              );

              if (!live) {
                await settleNoSubmission(claim.operationId);
                const rejected = new Error("Research run was cancelled or lost authority.");

                rejected.name = "ResearchAdmissionRejected";
                throw rejected;
              }

              return Reflect.apply(target.run.bind(target), target, args);
            };
          }

          const value: unknown = Reflect.get(target, property, target);

          return typeof value === "function"
            ? (...args: unknown[]): unknown => Reflect.apply(value, target, args) as unknown
            : value;
        },
      });

      const observed = observeInferenceUsage(binding, (receipt) => {
        observedUsage = receipt;
      });

      const provider = createWorkersAI({ binding: observed });

      let result: Awaited<ReturnType<typeof generateText>>;

      try {
        result = await generateText({
          model: provider(input.policy.model),
          prompt,
          maxOutputTokens: input.policy.maxOutputTokens,
          maxRetries: 0,
          providerOptions: {
            "workers-ai": { reasoning_effort: input.policy.reasoningEffort },
          },
          abortSignal: AbortSignal.any([
            input.signal,
            AbortSignal.timeout(input.policy.extractionTimeoutMs),
          ]),
        });
      } catch (error) {
        if (observedUsage) {
          await settleKnownUsage(claim.operationId, observedUsage);
        }

        throw error;
      }

      let parsedOutput: unknown = result.text;

      try {
        const jsonOutput: unknown = JSON.parse(result.text);

        parsedOutput = jsonOutput;
      } catch {
        // The strict synthesis schema records invalid output as a local question failure.
      }

      usage = observedUsage;

      if (!usage) {
        const uncertain = new Error("Provider usage was not authoritative.");

        uncertain.name = "UncertainInferenceOutcome";
        throw uncertain;
      }

      try {
        const checkpointSaved = await checkpoint(() =>
          withJobDatabase(input.env, async (db) => {
            const runs = createResearchRunsRepository(db);

            const saved = await runs.saveInferenceResult(
              input.key,
              input.question.id,
              parsedOutput,
              usage,
            );

            if (saved) {
              return true;
            }

            // A previous attempt may have committed while its acknowledgement
            // was lost. Accept only the exact persisted result and usage.
            const latest = await runs.loadWork(input.key);

            const persisted = latest?.questions.find((item) => item.id === input.question.id);

            return (
              persisted?.inferenceResult !== null &&
              persisted?.inferenceResult !== undefined &&
              JSON.stringify(persisted.inferenceResult) === JSON.stringify(parsedOutput) &&
              persisted.inferenceUsage?.inputTokens === usage?.inputTokens &&
              persisted.inferenceUsage?.outputTokens === usage?.outputTokens
            );
          }),
        );

        if (!checkpointSaved) {
          const failed = new Error(
            "Inference result checkpoint did not match the provider response.",
          );

          failed.name = "ResearchCheckpointError";
          throw failed;
        }
      } catch (error) {
        // The provider supplied complete usage, so account for it even when
        // persisting its result repeatedly fails. The question remains fenced
        // against replay; the Workflow retry will surface the missing result.
        await settleKnownUsage(claim.operationId, usage);
        throw error;
      }

      output = parsedOutput;
    }
  }

  if (!usage) {
    const uncertain = new Error("Saved inference checkpoint has no usage receipt.");

    uncertain.name = "UncertainInferenceOutcome";
    throw uncertain;
  }

  await checkpoint(() =>
    withJobDatabase(input.env, async (db) => {
      await createInferenceRepository(db).settle({
        workspaceId: input.key.workspaceId,
        requestId: question.operationId,
        ...usage,
      });
      await createResearchRunsRepository(db).settleQuestionInference(input.key, input.question.id);
    }),
  );

  return parseResearchSynthesis(output, input.question.id, input.question.question);
}

function selectReusableSources(
  question: string,
  personName: string | null,
  sources: ResearchRunSource[],
  maxSources: number,
  requestedUrls: string[] = [],
  exactOnly = false,
) {
  const terms = new Set(
    (question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
      (term) => !REUSE_STOPWORDS.has(term),
    ),
  );

  const requested = new Set(requestedUrls);

  return sources
    .map((source) => {
      const text = source.text.toLowerCase();

      const score = [...terms].reduce((total, term) => total + Number(text.includes(term)), 0);

      const identityMatch = personName ? text.includes(personName.toLowerCase()) : false;

      const requestedMatch = requested.has(source.url) || requested.has(source.requestedUrl);

      // Retrieval time breaks ties and enforces snapshot-age eligibility only;
      // it is not evidence of when any source claim became true.
      const retrievedAt = Date.parse(source.retrievedAt);

      return {
        source,
        score,
        identityMatch,
        requestedMatch,
        retrievedAt: Number.isFinite(retrievedAt) ? retrievedAt : 0,
      };
    })
    .filter(
      ({ score, requestedMatch }) =>
        requestedMatch || (!exactOnly && terms.size > 0 && score >= Math.min(2, terms.size)),
    )
    .sort(
      (a, b) =>
        Number(b.requestedMatch) - Number(a.requestedMatch) ||
        Number(b.identityMatch) - Number(a.identityMatch) ||
        b.score - a.score ||
        b.retrievedAt - a.retrievedAt,
    )
    .slice(0, maxSources)
    .map(({ source }) => source);
}

const REUSE_STOPWORDS = new Set([
  "the",
  "and",
  "what",
  "when",
  "where",
  "which",
  "does",
  "are",
  "was",
  "were",
  "for",
  "with",
  "this",
  "that",
  "from",
  "about",
  "how",
  "can",
  "could",
  "would",
  "should",
  "research",
  "find",
  "using",
  "sources",
]);

async function settleKnownDiscoveryUsage(input: {
  env: ResearchRunEnvironment;
  workspaceId: string;
  operationId: string;
  actualUnits: number;
}) {
  await checkpoint(() =>
    withJobDatabase(input.env, (db) =>
      createServiceBudgetRepository(db).settle({
        workspaceId: input.workspaceId,
        provider: "firecrawl",
        operationId: input.operationId,
        actualUnits: input.actualUnits,
      }),
    ),
  );
}

export async function runResearchRun(
  env: ResearchRunEnvironment,
  key: ResearchRunExecutionKey,
  signal: AbortSignal,
) {
  const repo = {
    claim: (runKey: ResearchRunExecutionKey) =>
      checkpoint(() =>
        withJobDatabase(env, (db) => createResearchRunsRepository(db).claim(runKey)),
      ),
    loadWork: (runKey: ResearchRunExecutionKey) =>
      checkpoint(() =>
        withJobDatabase(env, (db) => createResearchRunsRepository(db).loadWork(runKey)),
      ),
    setStage: (runKey: ResearchRunExecutionKey, stage: ResearchRunDetail["stage"]) =>
      checkpoint(() =>
        withJobDatabase(env, (db) => createResearchRunsRepository(db).setStage(runKey, stage)),
      ),
    assertRunnable: (runKey: ResearchRunExecutionKey) =>
      checkpoint(() =>
        withJobDatabase(env, (db) => createResearchRunsRepository(db).assertRunnable(runKey)),
      ),
    reusableSources: (
      principal: { id: string; email: string | null },
      workspaceId: string,
      input: Parameters<ReturnType<typeof createResearchRunsRepository>["reusableSources"]>[2],
    ) =>
      checkpoint(() =>
        withJobDatabase(env, (db) =>
          createResearchRunsRepository(db).reusableSources(principal, workspaceId, input),
        ),
      ),
    saveSource: (runKey: ResearchRunExecutionKey, source: ResearchRunSource) =>
      checkpoint(() =>
        withJobDatabase(env, (db) => createResearchRunsRepository(db).saveSource(runKey, source)),
      ),
    claimDiscovery: (runKey: ResearchRunExecutionKey, ordinal: number, query: string) =>
      checkpoint(() =>
        withJobDatabase(env, (db) =>
          createResearchRunsRepository(db).claimDiscovery(runKey, ordinal, query),
        ),
      ),
    markDiscoveryCompleted: (
      runKey: ResearchRunExecutionKey,
      ordinal: number,
      credits: number | null,
      candidates: unknown[],
    ) =>
      checkpoint(() =>
        withJobDatabase(env, (db) =>
          createResearchRunsRepository(db).markDiscoveryCompleted(
            runKey,
            ordinal,
            credits,
            candidates,
          ),
        ),
      ),
    saveQuestionFinding: (
      runKey: ResearchRunExecutionKey,
      questionId: string,
      finding: ResearchRunDetail["findings"][number],
    ) =>
      checkpoint(() =>
        withJobDatabase(env, (db) =>
          createResearchRunsRepository(db).saveQuestionFinding(runKey, questionId, finding),
        ),
      ),
    failQuestion: (runKey: ResearchRunExecutionKey, questionId: string, code: string) =>
      checkpoint(() =>
        withJobDatabase(env, (db) =>
          createResearchRunsRepository(db).failQuestion(runKey, questionId, code),
        ),
      ),
    finish: (
      runKey: ResearchRunExecutionKey,
      result: Parameters<ReturnType<typeof createResearchRunsRepository>["finish"]>[1],
    ) =>
      checkpoint(() =>
        withJobDatabase(env, (db) => createResearchRunsRepository(db).finish(runKey, result)),
      ),
  };

  if (!(await repo.claim(key))) {
    const existing = await repo.loadWork(key);

    return existing
      ? { status: existing.status, quality: existing.quality }
      : { status: "failed", quality: null as ResearchRunDetail["quality"] };
  }

  const work = await repo.loadWork(key);

  if (!work) {
    return { status: "failed", quality: null as ResearchRunDetail["quality"] };
  }

  const persistedOutcome = async () => {
    const latest = await repo.loadWork(key);

    return {
      status: latest?.status ?? "failed",
      quality: latest?.quality ?? null,
    };
  };

  const policy = researchRunPolicySchema.parse(work.policy);

  const sourceProvider = createPublicUrlResearchProvider(createWorkerPublicSourceTransport());

  let sourceFailures = 0;

  let discoveryFailure = false;

  const sourceByteLimit = Math.min(
    policy.maxDiscoveryBytes,
    policy.maxSourceBytes * policy.maxSources,
  );

  const sources: ResearchRunSource[] = work.sources.map((source) => {
    const { title, ...rest } = source;

    return {
      ...rest,
      ...(title ? { title } : {}),
      originSourceId: source.originSourceId ?? null,
      disposition: source.disposition === "reused" ? "reused" : "retrieved",
    };
  });

  const sourceDigests = new Set(sources.map((source) => source.digest));

  let sourceBytes = sources.reduce(
    (total, source) => total + new TextEncoder().encode(source.text).byteLength,
    0,
  );

  const addSource = async (source: ResearchRunSource, disposition: "retrieved" | "reused") => {
    if (
      sourceDigests.has(source.digest) ||
      sources.some(
        (existing) => existing.url === source.url || existing.requestedUrl === source.requestedUrl,
      ) ||
      sources.length >= policy.maxSources
    ) {
      return false;
    }

    const size = new TextEncoder().encode(source.text).byteLength;

    if (size > policy.maxSourceBytes || sourceBytes + size > sourceByteLimit) {
      sourceFailures += 1;

      return false;
    }

    const originalId = source.id;

    const isUuid = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
      source.id,
    );

    const persistedSource: ResearchRunSource = {
      ...source,
      id: isUuid ? source.id : crypto.randomUUID(),
      ...(source.title ? { title: source.title } : {}),
      disposition,
      ...(disposition === "reused" ? { originSourceId: originalId } : {}),
    };

    if (!(await repo.saveSource(key, persistedSource))) {
      const rejected = new Error("Research run was cancelled or lost authority.");

      rejected.name = "ResearchAdmissionRejected";
      throw rejected;
    }

    sourceDigests.add(source.digest);
    sources.push(persistedSource);
    sourceBytes += size;

    return true;
  };

  try {
    if (!(await repo.assertRunnable(key))) {
      const rejected = new Error("Research authority or scope was revoked.");

      rejected.name = "ResearchAdmissionRejected";
      throw rejected;
    }

    await repo.setStage(key, "retrieving");

    const reusableRecords = await executionTrace(
      env,
      {
        workspaceId: key.workspaceId,
        runId: key.runId,
        actorId: work.actorId,
        ...(work.originTurnId ? { originTurnId: work.originTurnId } : {}),
      },
      "research.run.lookup",
      () =>
        repo.reusableSources({ id: work.actorId, email: null }, key.workspaceId, {
          ...(work.input.personId !== undefined ? { personId: work.input.personId } : {}),
          ...(work.input.noteId !== undefined ? { noteId: work.input.noteId } : {}),
          maxRuns: 5,
          limit: Math.min(30, policy.maxSources * 5),
          maxSnapshotAgeDays: policy.maxSnapshotAgeDays,
          maxBytes: sourceByteLimit,
        }),
      {
        stage: "lookup",
        actorType: "workflow",
        lookupOutcome: "unknown",
      },
    );

    const reusableCandidates: ResearchRunSource[] = reusableRecords.map((record) => {
      const source = record as ResearchRunSource;

      return {
        id: source.id,
        requestedUrl: source.requestedUrl,
        url: source.url,
        text: source.text,
        retrievedAt: source.retrievedAt,
        digest: source.digest,
        ...(source.title ? { title: source.title } : {}),
        publishedAt: source.publishedAt ?? null,
        originSourceId: source.originSourceId ?? null,
        disposition: source.disposition === "reused" ? "reused" : "retrieved",
      };
    });

    const requestedReusable = selectReusableSources(
      work.input.question,
      work.personName,
      reusableCandidates,
      Math.min(policy.maxSources, work.input.sourceUrls.length),
      work.input.sourceUrls,
      true,
    );

    for (const source of requestedReusable) {
      await addSource(source, "reused");
    }

    const sourceUrls = work.input.sourceUrls
      .filter((url) => !sources.some((source) => source.url === url || source.requestedUrl === url))
      .slice(0, policy.maxSources - sources.length);

    const retrieved = await mapSettledWithLimit(
      sourceUrls,
      SOURCE_RETRIEVAL_CONCURRENCY,
      async (url) => {
        if (!(await repo.assertRunnable(key))) {
          const rejected = new Error("Research authority or scope was revoked.");

          rejected.name = "ResearchAdmissionRejected";
          throw rejected;
        }

        return executionTrace(
          env,
          {
            workspaceId: key.workspaceId,
            runId: key.runId,
            actorId: work.actorId,
            ...(work.originTurnId ? { originTurnId: work.originTurnId } : {}),
          },
          "research.run.retrieve",
          () =>
            sourceProvider.retrieve(
              url,
              policy,
              AbortSignal.any([signal, AbortSignal.timeout(policy.sourceTimeoutMs)]),
            ),
          { stage: "retrieve", actorType: "workflow" },
        );
      },
    );

    for (const result of retrieved) {
      if (result.status === "rejected") {
        if (
          result.reason instanceof Error &&
          ["ResearchCheckpointError", "ResearchAdmissionRejected"].includes(result.reason.name)
        ) {
          throw result.reason;
        }

        sourceFailures += 1;
        continue;
      }

      await addSource(result.value, "retrieved");
    }

    const supplementalReusable = selectReusableSources(
      work.input.question,
      work.personName,
      reusableCandidates.filter(
        (candidate) =>
          !sources.some(
            (source) =>
              source.digest === candidate.digest ||
              source.url === candidate.url ||
              source.requestedUrl === candidate.requestedUrl,
          ),
      ),
      Math.max(0, policy.maxSources - sources.length),
    );

    for (const source of supplementalReusable) {
      await addSource(source, "reused");
    }

    if (
      work.input.discoverSources &&
      sources.length < policy.maxSources &&
      sourceBytes < sourceByteLimit
    ) {
      const discoveries = work.discoveries as Array<{
        ordinal: number;
        operationId: string;
        state: "pending" | "submitted" | "completed";
        creditsUsed: number | null;
        candidates: unknown[];
      }>;

      const runDiscoveryQuery = async (ordinal: number, query: string) => {
        if (sources.length >= policy.maxSources || sourceBytes >= sourceByteLimit) {
          return;
        }

        const stored = discoveries.find((item) => item.ordinal === ordinal);

        if (!stored) {
          return;
        }

        let candidates: ResearchCandidate[] = [];

        if (stored.state === "completed") {
          candidates = storedCandidates(stored.candidates);
        } else if (stored.state === "submitted") {
          discoveryFailure = true;
          sourceFailures += 1;

          return;
        } else {
          if (!env.FIRECRAWL_API_KEY || env.RESEARCH_DISCOVERY_ENABLED !== "true") {
            discoveryFailure = true;
            sourceFailures += 1;

            return;
          }

          const claimed = await repo.claimDiscovery(key, ordinal, query);

          if (!claimed) {
            const latest = await repo.loadWork(key);

            const updated = latest?.discoveries.find(
              (item: { ordinal: number }) => item.ordinal === ordinal,
            );

            if (updated?.state === "completed") {
              candidates = storedCandidates(updated.candidates);
            } else {
              discoveryFailure = true;
              sourceFailures += 1;

              return;
            }
          } else {
            const maximumUnits = policy.searchUnitBound;

            const budgetId = policy.serviceBudgetId;

            if (!maximumUnits || !budgetId) {
              const rejected = new Error("Pinned discovery budget is unavailable.");

              rejected.name = "ResearchAdmissionRejected";
              throw rejected;
            }

            try {
              await checkpoint(() =>
                withJobDatabase(env, (db) =>
                  createServiceBudgetRepository(db).reserve({
                    workspaceId: key.workspaceId,
                    provider: "firecrawl",
                    budgetId,
                    operationId: claimed.operationId,
                    maximumUnits,
                  }),
                ),
              );
            } catch (error) {
              if (error instanceof Error && error.name === "ResearchCheckpointError") {
                throw error;
              }

              discoveryFailure = true;
              sourceFailures += 1;

              return;
            }

            if (!(await repo.assertRunnable(key))) {
              const rejected = new Error("Research authority or scope was revoked.");

              rejected.name = "ResearchAdmissionRejected";
              throw rejected;
            }

            const discoveryApiKey = env.FIRECRAWL_API_KEY;

            if (!discoveryApiKey) {
              discoveryFailure = true;
              sourceFailures += 1;

              return;
            }

            let searchResult: Awaited<ReturnType<typeof searchResearchCandidates>>;

            try {
              searchResult = await executionTrace(
                env,
                { workspaceId: key.workspaceId, runId: key.runId, actorId: work.actorId },
                "research.run.search",
                () =>
                  searchResearchCandidates({
                    query,
                    policy,
                    apiKey: discoveryApiKey,
                    signal: AbortSignal.any([
                      signal,
                      AbortSignal.timeout(policy.discoveryTimeoutMs),
                    ]),
                  }),
                {
                  stage: "search",
                  actorType: "workflow",
                  policyVersion: "research-run-v1",
                  candidateCount: policy.maxSearchResults,
                },
              );
            } catch (error) {
              if (signal.aborted) {
                throw error;
              }

              discoveryFailure = true;
              sourceFailures += 1;

              return;
            }

            const selected = selectResearchCandidates(
              query,
              searchResult.candidates,
              Math.min(policy.maxDiscoveredSources, policy.maxSources - sources.length),
            ).map((candidate) => ({
              ...candidate,
              selectionReason: "question-term-relevance-and-domain-diversity",
            }));

            // Persist authoritative returned usage and selected candidate metadata
            // before any page retrieval or cancellation-sensitive evidence write.
            try {
              const checkpointed = await repo.markDiscoveryCompleted(
                key,
                ordinal,
                searchResult.creditsUsed,
                selected,
              );

              if (!checkpointed) {
                const failedCheckpoint = new Error(
                  "Search candidates or known usage were not checkpointed.",
                );

                failedCheckpoint.name = "ResearchCheckpointError";
                throw failedCheckpoint;
              }
            } catch (error) {
              if (searchResult.creditsUsed !== null) {
                await settleKnownDiscoveryUsage({
                  env,
                  workspaceId: key.workspaceId,
                  operationId: claimed.operationId,
                  actualUnits: searchResult.creditsUsed,
                });
              }

              throw error;
            }

            candidates = selected;

            if (searchResult.creditsUsed !== null) {
              await settleKnownDiscoveryUsage({
                env,
                workspaceId: key.workspaceId,
                operationId: claimed.operationId,
                actualUnits: searchResult.creditsUsed,
              });
            }
          }
        }

        const urls = candidates
          .filter((candidate) => !sources.some((source) => source.url === candidate.url))
          .slice(0, Math.max(0, policy.maxSources - sources.length));

        const pageResults = await mapSettledWithLimit(
          urls,
          SOURCE_RETRIEVAL_CONCURRENCY,
          async (candidate) => {
            if (!(await repo.assertRunnable(key))) {
              const rejected = new Error("Research authority or scope was revoked.");

              rejected.name = "ResearchAdmissionRejected";
              throw rejected;
            }

            const fetched = await sourceProvider.retrieve(
              candidate.url,
              policy,
              AbortSignal.any([signal, AbortSignal.timeout(policy.sourceTimeoutMs)]),
            );

            return {
              ...fetched,
              title: candidate.title,
              publishedAt: normalizedPublishedAt(candidate.publishedAt),
            };
          },
        );

        for (const result of pageResults) {
          if (result.status === "rejected") {
            if (
              result.reason instanceof Error &&
              ["ResearchCheckpointError", "ResearchAdmissionRejected"].includes(result.reason.name)
            ) {
              throw result.reason;
            }

            sourceFailures += 1;
            continue;
          }

          await addSource(result.value, "retrieved");
        }
      };

      await runDiscoveryQuery(0, work.input.question);
      const secondaryDiscovery = work.discoveries.find(
        (item: { ordinal: number }) => item.ordinal === 1,
      );

      const secondaryCandidates =
        secondaryDiscovery?.state === "completed"
          ? storedCandidates(secondaryDiscovery.candidates)
          : [];

      const missingSecondarySnapshots = secondaryCandidates.some(
        (candidate) => !sources.some((source) => source.url === candidate.url),
      );

      const needsSecondaryDiscovery =
        secondaryDiscovery !== undefined &&
        (secondaryDiscovery.state === "completed"
          ? missingSecondarySnapshots
          : sourceCoverage(work.input.question, sources) < MATERIAL_GAP_COVERAGE_THRESHOLD);

      if (needsSecondaryDiscovery) {
        await runDiscoveryQuery(
          1,
          materialGapQuery(work.input.question, sources, work.input.timeframe),
        );
      }
    }

    await repo.setStage(key, "analyzing");
    const checkpoints = {
      saveFinding: (
        runKey: ResearchRunExecutionKey,
        questionId: string,
        finding: ResearchRunDetail["findings"][number],
      ) => repo.saveQuestionFinding(runKey, questionId, finding),
      failQuestion: (runKey: ResearchRunExecutionKey, questionId: string, code: string) =>
        repo.failQuestion(runKey, questionId, code),
    };

    const remainingQuestions = work.questions.filter((question) => question.outcome === "pending");

    let findings: ResearchRunDetail["findings"] = [];

    let rejectedQuestionCount = 0;

    if (sources.length === 0) {
      for (const question of remainingQuestions) {
        const finding: ResearchRunDetail["findings"][number] = {
          id: crypto.randomUUID(),
          questionId: question.id,
          question: question.question,
          outcome: "insufficient-evidence",
          statement: null,
          classification: null,
          explanation: "No source snapshot could be retrieved for this question.",
          citations: [],
        };

        await repo.saveQuestionFinding(key, question.id, finding);
      }
    } else {
      const synthesized = await synthesizeResearchQuestions({
        key,
        questions: remainingQuestions,
        sources,
        synthesis: {
          synthesize: (input) =>
            workerSynthesis({
              env,
              key,
              question: input.question,
              sources: input.sources,
              signal: input.signal,
              policy,
              personName: work.personName,
              timeframe: work.input.timeframe,
            }),
        },
        checkpoints,
        signal,
      });

      findings = synthesized.findings;
      rejectedQuestionCount = synthesized.rejected;
    }

    if (discoveryFailure && sources.length === 0) {
      const terminalized = await repo.finish(key, {
        status: "failed",
        error: "Requested source discovery did not complete; no report was published.",
      });

      return terminalized
        ? { status: "failed", quality: null as ResearchRunDetail["quality"] }
        : await persistedOutcome();
    }

    await repo.setStage(key, "publishing");
    const current = await repo.loadWork(key);

    const persistedFindings = current?.findings ?? findings;

    const questionGaps =
      current?.questions
        .filter((question) => question.outcome === "failed")
        .map(
          (question) => `A finding for "${question.question}" could not be validated or completed.`,
        ) ?? [];

    if (persistedFindings.length === 0) {
      const terminalized = await repo.finish(key, {
        status: "failed",
        error: "No question produced a validated finding; no report was published.",
      });

      return terminalized
        ? { status: "failed", quality: null as ResearchRunDetail["quality"] }
        : await persistedOutcome();
    }

    const report = reportFromFindings(
      work.input.question,
      persistedFindings,
      sourceFailures,
      questionGaps,
    );

    if (!(await repo.finish(key, { status: "completed", report }))) {
      return await persistedOutcome();
    }

    return {
      status: "completed",
      quality: report.quality,
      answeredQuestionCount: report.findings.filter((finding) => finding.outcome === "supported")
        .length,
      rejectedQuestionCount,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "ResearchCheckpointError") {
      throw error;
    }

    if (signal.aborted) {
      return { status: "cancelled", quality: null as ResearchRunDetail["quality"] };
    }

    const terminalized = await repo
      .finish(key, {
        status: "failed",
        error: safeCode(error),
      })
      .catch(() => false);

    if (!terminalized) {
      return await persistedOutcome().catch(() => ({
        status: "failed" as const,
        quality: null as ResearchRunDetail["quality"],
      }));
    }

    return { status: "failed", quality: null as ResearchRunDetail["quality"] };
  }
}
