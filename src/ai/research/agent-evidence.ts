import { researchRunPolicySchema } from "../../config/research-runs";
import type {
  PublishReportInput,
  ResolvedResearchAgentFinding,
} from "../../contracts/research/agent";
import { type ResearchAgentScope, researchAgentScopeSchema } from "../../contracts/research/agent";
import { WorkspaceError } from "../../contracts/workspace";
import { createResearchAgentOperationsRepository } from "../../db/research/agent-operations";
import { publishResearchAgentReport } from "../../db/research/agent-publication";
import { createResearchRunsRepository } from "../../db/research/runs";
import { createServiceBudgetRepository } from "../../db/service-budgets";
import { executionTrace } from "../../telemetry/execution";
import {
  createResearchAgentTools,
  type ResearchAgentToolOperationId,
  type ResearchAgentToolPorts,
} from "./agent-tools";
import type { ResearchSource } from "./ports";
import { searchResearchCandidates } from "./runs/discovery";
import { type ResearchRunEnvironment, withResearchRunDatabase } from "./runs/environment";
import { createPublicUrlResearchProvider, publicResearchUrl } from "./sources";
import { createWorkerPublicSourceTransport } from "./worker-transport";

export type ResearchAgentEvidenceEnvironment = ResearchRunEnvironment & {
  RESEARCH_AGENT_ENABLED?: string;
};

export type ResearchAgentEvidenceTools = ReturnType<typeof createResearchAgentTools>;

type RunWork = Awaited<ReturnType<ReturnType<typeof createResearchRunsRepository>["loadWork"]>>;

type ToolName = Parameters<ResearchAgentToolOperationId>[0];

type SearchResult = {
  candidates: Awaited<ReturnType<typeof searchResearchCandidates>>["candidates"];
  creditsUsed: number | null;
};

type FirecrawlSearchUsage = {
  provider: "firecrawl";
  creditsUsed: number;
  operationId: string;
};

type SnapshotSource = ResearchSource & {
  title?: string;
  publishedAt?: string | null;
  originSourceId?: string | null;
};

type LookupSource = Pick<
  ResearchSource,
  "id" | "requestedUrl" | "url" | "text" | "retrievedAt" | "digest"
> & {
  title?: string | null;
  publishedAt?: string | null;
};

type ResolvedReportInput = Omit<PublishReportInput, "findings"> & {
  findings: ResolvedResearchAgentFinding[];
};

const directSourceProvider = createPublicUrlResearchProvider(createWorkerPublicSourceTransport());

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function scopeMatchesWork(scope: ResearchAgentScope, work: NonNullable<RunWork>) {
  const input = work.input;

  const timeframe = input.timeframe ?? { mode: "unspecified" as const };

  const questions = work.questions.map(({ id, question }) => ({ id, question }));

  return (
    scope.workspaceId === input.workspaceId &&
    scope.actorId === work.actorId &&
    scope.question === input.question &&
    scope.noteId === (input.noteId ?? null) &&
    scope.personId === (input.personId ?? null) &&
    scope.discoverSources === input.discoverSources &&
    urlsMatch(scope.sourceUrls, input.sourceUrls) &&
    canonical(scope.timeframe) === canonical(timeframe) &&
    canonical(scope.questions) === canonical(questions)
  );
}

function normalizedUrl(value: string) {
  try {
    return publicResearchUrl(value).href;
  } catch {
    return null;
  }
}

function urlsMatch(left: string[], right: string[]) {
  const canonicalLeft = left.map(normalizedUrl);

  const canonicalRight = right.map(normalizedUrl);

  return (
    canonicalLeft.every(Boolean) &&
    canonicalRight.every(Boolean) &&
    canonical(canonicalLeft) === canonical(canonicalRight)
  );
}

function sourceIsInScope(
  scope: ResearchAgentScope,
  source: Pick<ResearchSource, "url" | "requestedUrl">,
) {
  if (!scope.sourceUrls.length) {
    return true;
  }

  const sourceUrl = normalizedUrl(source.url);

  const requestedUrl = normalizedUrl(source.requestedUrl);

  const permitted = new Set(
    scope.sourceUrls.map(normalizedUrl).filter((url): url is string => url !== null),
  );

  return Boolean(
    (sourceUrl && permitted.has(sourceUrl)) || (requestedUrl && permitted.has(requestedUrl)),
  );
}

function sourceFromWork(work: NonNullable<RunWork>, sourceId: string) {
  return work.sources.find((source) => source.id === sourceId) ?? null;
}

function sourceByteLength(source: ResearchSource) {
  return new TextEncoder().encode(source.text).byteLength;
}

function maxSourceSnapshotBytes(policy: ReturnType<typeof researchRunPolicySchema.parse>) {
  return Math.min(policy.maxDiscoveryBytes, policy.maxSourceBytes * policy.maxSources);
}

export function researchAgentTemporalEligibility(
  source: Pick<ResearchSource, "url"> & { publishedAt?: string | null },
  scope: ResearchAgentScope,
): "eligible" | "stale" | "unknown" {
  if (scope.timeframe.mode !== "historical" || !scope.timeframe.asOf) {
    return "eligible";
  }

  if (!source.publishedAt) {
    return "unknown";
  }

  const publishedAt = Date.parse(source.publishedAt);

  const asOf = Date.parse(scope.timeframe.asOf);

  if (!Number.isFinite(publishedAt) || !Number.isFinite(asOf)) {
    return "unknown";
  }

  return publishedAt <= asOf ? "eligible" : "stale";
}

function freshness(
  source: LookupSource,
  maxAgeDays: number,
  scope: ResearchAgentScope,
): "eligible" | "stale" | "unknown" {
  const temporalEligibility = researchAgentTemporalEligibility(source, scope);

  if (temporalEligibility !== "eligible") {
    return temporalEligibility;
  }

  const retrievedAt = Date.parse(source.retrievedAt);

  if (!Number.isFinite(retrievedAt)) {
    return "unknown";
  }

  const now = Date.now();

  if (retrievedAt > now) {
    return "unknown";
  }

  return now - retrievedAt <= maxAgeDays * 86_400_000 ? "eligible" : "stale";
}

export function createResearchAgentEvidenceTools(
  env: ResearchAgentEvidenceEnvironment,
  rawScope: ResearchAgentScope,
  operationId: string,
): Promise<ResearchAgentEvidenceTools> {
  const scope = researchAgentScopeSchema.parse(rawScope);

  const runKey = { workspaceId: scope.workspaceId, runId: scope.runId };

  const principal = { id: scope.actorId, email: null };

  const operationKey = { ...runKey, operationId };

  async function loadAuthorizedWork(options?: { allowCompletedReceipt?: boolean }) {
    return withResearchRunDatabase(env, async (db) => {
      const runs = createResearchRunsRepository(db);

      const work = await runs.loadWork(runKey);

      if (!work || work.actorId !== scope.actorId || !scopeMatchesWork(scope, work)) {
        throw new WorkspaceError("forbidden", "Research run scope is unavailable.");
      }

      const completedReceipt = options?.allowCompletedReceipt
        ? await createResearchAgentOperationsRepository(db).get(operationKey)
        : null;

      const receiptPayload = completedReceipt?.payload as { tool?: unknown } | null;

      const replayingPublication =
        work.status === "completed" &&
        completedReceipt?.state === "completed" &&
        receiptPayload?.tool === "publish_report";

      if (!replayingPublication && !(await runs.assertRunnable(runKey))) {
        throw new WorkspaceError("conflict", "Research run is no longer active.");
      }

      return { work, policy: researchRunPolicySchema.parse(work.policy) };
    });
  }

  async function assertActive() {
    await loadAuthorizedWork();
  }

  async function runFencedTool<T>(
    toolName: ToolName,
    input: unknown,
    work: () => Promise<T>,
    options?: {
      allowCompletedReplay?: boolean;
      usage?: (result: T) => unknown;
    },
  ): Promise<T> {
    if (!options?.allowCompletedReplay) {
      await assertActive();
    }

    const prepared = await withResearchRunDatabase(env, (db) =>
      createResearchAgentOperationsRepository(db).prepare(operationKey, {
        kind: "tool",
        payload: { tool: toolName, input },
      }),
    );

    if (!prepared) {
      throw new WorkspaceError("conflict", "Research operation receipt could not be prepared.");
    }

    if (prepared.state === "completed") {
      return prepared.result as T;
    }

    const claimed = await withResearchRunDatabase(env, (db) =>
      createResearchAgentOperationsRepository(db).claim(operationKey),
    );

    if (claimed.status === "completed" && claimed.operation) {
      return claimed.operation.result as T;
    }

    if (claimed.status !== "claimed") {
      throw new WorkspaceError(
        "conflict",
        claimed.status === "uncertain"
          ? "Research operation outcome is uncertain and will not be replayed."
          : "Research operation is not authorized to run.",
      );
    }

    try {
      const result = await work();

      const usage = options?.usage?.(result);

      const completed = await withResearchRunDatabase(env, (db) =>
        createResearchAgentOperationsRepository(db).complete(operationKey, {
          result,
          ...(usage !== undefined ? { usage } : {}),
        }),
      );

      if (!completed) {
        throw new WorkspaceError("conflict", "Research operation result could not be recorded.");
      }

      return result;
    } catch (error) {
      await withResearchRunDatabase(env, (db) =>
        createResearchAgentOperationsRepository(db).markUncertain(operationKey),
      ).catch(() => undefined);

      throw error;
    }
  }

  async function saveRunSource(source: SnapshotSource, disposition: "retrieved" | "reused") {
    const persisted = await withResearchRunDatabase(env, async (db) => {
      const runs = createResearchRunsRepository(db);

      const current = await runs.loadWork(runKey);

      if (!current || current.actorId !== scope.actorId || !(await runs.assertRunnable(runKey))) {
        return false;
      }

      const policy = researchRunPolicySchema.parse(current.policy);

      const sourceSnapshotLimit = maxSourceSnapshotBytes(policy);

      const currentBytes = current.sources.reduce(
        (total, item) => total + new TextEncoder().encode(item.text).byteLength,
        0,
      );

      const alreadyPresent = current.sources.find(
        (item) =>
          item.digest === source.digest ||
          item.url === source.url ||
          item.requestedUrl === source.requestedUrl,
      );

      if (alreadyPresent) {
        return alreadyPresent.id;
      }

      if (
        current.sources.length >= policy.maxSources ||
        currentBytes + sourceByteLength(source) > sourceSnapshotLimit
      ) {
        return null;
      }

      const saved = await runs.saveSource(runKey, {
        id: source.id,
        requestedUrl: source.requestedUrl,
        url: source.url,
        ...(source.title ? { title: source.title } : {}),
        ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
        ...(source.originSourceId
          ? { originSourceId: source.originSourceId }
          : disposition === "reused"
            ? { originSourceId: source.id }
            : {}),
        digest: source.digest,
        retrievedAt: source.retrievedAt,
        text: source.text,
        ...(disposition === "reused" ? { disposition } : {}),
      });

      return saved ? source.id : null;
    });

    return persisted;
  }

  async function readCurrentRunSource(sourceId: string) {
    const { work } = await loadAuthorizedWork();

    return sourceFromWork(work, sourceId);
  }

  const ports: ResearchAgentToolPorts = {
    evidence: {
      async lookup(currentScope, input) {
        const { work, policy } = await loadAuthorizedWork();

        const maxAgeDays = Math.min(
          policy.maxSnapshotAgeDays,
          currentScope.maxAgeDays ?? policy.maxSnapshotAgeDays,
        );

        const candidates: LookupSource[] = [...work.sources];

        const sourceSnapshotLimit = maxSourceSnapshotBytes(policy);

        const candidateDigests = new Set(candidates.map((source) => source.digest));

        const reusable = await withResearchRunDatabase(env, (db) =>
          createResearchRunsRepository(db).reusableSources(principal, runKey.workspaceId, {
            personId: currentScope.personId,
            noteId: currentScope.noteId,
            maxSnapshotAgeDays: maxAgeDays,
            maxBytes: sourceSnapshotLimit,
            limit: policy.maxSources,
          }),
        );

        let remainingBytes =
          sourceSnapshotLimit -
          candidates.reduce((total, source) => total + sourceByteLength(source), 0);

        for (const source of reusable) {
          if (candidateDigests.has(source.digest) || !sourceIsInScope(currentScope, source)) {
            continue;
          }

          const sourceFreshness = freshness(source, maxAgeDays, currentScope);

          if (sourceFreshness !== "eligible") {
            candidates.push(source);
            candidateDigests.add(source.digest);
            continue;
          }

          const bytes = sourceByteLength(source);

          if (candidates.length >= policy.maxSources || bytes > remainingBytes) {
            continue;
          }

          const savedSourceId = await saveRunSource(source, "reused");

          if (!savedSourceId) {
            continue;
          }

          const savedSource = sourceFromWork(work, savedSourceId) ?? {
            ...source,
            id: savedSourceId,
          };

          candidates.push(savedSource);
          candidateDigests.add(savedSource.digest);
          remainingBytes -= bytes;
        }

        const query = input.query.toLocaleLowerCase();

        const queryTerms = query.split(/\s+/u).filter(Boolean);

        const matching = candidates.filter((source) => {
          if (!sourceIsInScope(currentScope, source)) {
            return false;
          }

          if (!queryTerms.length) {
            return true;
          }

          const searchable =
            `${source.title ?? ""} ${source.url} ${source.text}`.toLocaleLowerCase();

          return queryTerms.some((term) => searchable.includes(term));
        });

        return matching.slice(0, policy.maxSources).map((source) => ({
          sourceId: source.id,
          title: source.title ?? source.url,
          url: source.url,
          requestedUrl: source.requestedUrl,
          retrievedAt: source.retrievedAt,
          revision: source.digest,
          freshness: freshness(source, maxAgeDays, currentScope),
          totalLength: source.text.length,
        }));
      },

      async read(currentScope, input) {
        const { work } = await loadAuthorizedWork();

        const source = sourceFromWork(work, input.sourceId);

        if (
          !source ||
          !sourceIsInScope(currentScope, source) ||
          researchAgentTemporalEligibility(source, currentScope) !== "eligible"
        ) {
          return null;
        }

        return {
          source: {
            id: source.id,
            requestedUrl: source.requestedUrl,
            url: source.url,
            retrievedAt: source.retrievedAt,
            digest: source.digest,
          },
          startOffset: input.startOffset,
          text: source.text.slice(input.startOffset, input.startOffset + input.limit),
          totalLength: source.text.length,
        };
      },

      async source(currentScope, sourceId) {
        const { work } = await loadAuthorizedWork({ allowCompletedReceipt: true });

        const source = sourceFromWork(work, sourceId);

        return source &&
          sourceIsInScope(currentScope, source) &&
          researchAgentTemporalEligibility(source, currentScope) === "eligible"
          ? source
          : null;
      },
    },

    async searchSources(currentScope, input) {
      if (!env.FIRECRAWL_API_KEY || env.RESEARCH_DISCOVERY_ENABLED !== "true") {
        throw new WorkspaceError(
          "service_unavailable",
          "Research source search is unavailable: the application Firecrawl credential or discovery setting is missing.",
        );
      }

      const result = await runFencedTool<SearchResult>(
        "search_sources",
        { query: input.query },
        async () => {
          const { policy } = await loadAuthorizedWork();

          if (
            policy.sourceProvider !== "firecrawl" ||
            !policy.serviceBudgetId ||
            !policy.searchUnitBound
          ) {
            throw new WorkspaceError(
              "service_unavailable",
              "Research source search has no pinned provider budget.",
            );
          }

          const reservation = await withResearchRunDatabase(env, (db) =>
            createServiceBudgetRepository(db).reserve({
              workspaceId: currentScope.workspaceId,
              provider: "firecrawl",
              budgetId: policy.serviceBudgetId!,
              operationId: input.operationId,
              maximumUnits: policy.searchUnitBound!,
            }),
          );

          if (reservation.status !== "created") {
            throw new WorkspaceError(
              "conflict",
              "Research search budget receipt already exists; provider call was not repeated.",
            );
          }

          await assertActive();
          const search = await searchResearchCandidates({
            query: input.query,
            policy,
            apiKey: env.FIRECRAWL_API_KEY!,
            signal: AbortSignal.timeout(policy.discoveryTimeoutMs),
          });

          return {
            candidates: search.candidates,
            creditsUsed: search.creditsUsed,
          };
        },
        {
          usage: (searchResult): FirecrawlSearchUsage | undefined =>
            searchResult.creditsUsed === null
              ? undefined
              : {
                  provider: "firecrawl",
                  creditsUsed: searchResult.creditsUsed,
                  operationId: input.operationId,
                },
        },
      );

      const creditsUsed = result.creditsUsed;

      if (creditsUsed !== null) {
        await withResearchRunDatabase(env, (db) =>
          createServiceBudgetRepository(db).settle({
            workspaceId: currentScope.workspaceId,
            provider: "firecrawl",
            operationId: input.operationId,
            actualUnits: creditsUsed,
          }),
        );
        await withResearchRunDatabase(env, (db) =>
          createResearchAgentOperationsRepository(db).markUsageSettled(operationKey),
        );
      }

      return result.candidates;
    },

    async retrieveSource(currentScope, input) {
      const result = await runFencedTool<
        | {
            sourceId: string;
          }
        | {
            failure: "blocked" | "not-found" | "temporal-ineligible" | "unavailable";
          }
      >("retrieve_source", { url: input.url }, async () => {
        const { work, policy } = await loadAuthorizedWork();

        const sourceSnapshotLimit = maxSourceSnapshotBytes(policy);

        const duplicate = work.sources.find(
          (source) => source.requestedUrl === input.url || source.url === input.url,
        );

        if (duplicate) {
          return { sourceId: duplicate.id };
        }

        if (
          work.sources.length >= policy.maxSources ||
          work.sources.reduce((total, source) => total + sourceByteLength(source), 0) >=
            sourceSnapshotLimit
        ) {
          return { failure: "unavailable" as const };
        }

        await assertActive();
        let source: ResearchSource;

        try {
          source = await executionTrace(
            env,
            {
              workspaceId: currentScope.workspaceId,
              runId: currentScope.runId,
              actorId: currentScope.actorId,
            },
            "research.agent.retrieve",
            () =>
              directSourceProvider.retrieve(
                input.url,
                policy,
                AbortSignal.timeout(policy.sourceTimeoutMs),
              ),
            { stage: "retrieve", policyVersion: "research-agent-v2" },
          );
        } catch {
          return { failure: "unavailable" as const };
        }

        if (!sourceIsInScope(currentScope, source)) {
          return { failure: "blocked" as const };
        }

        if (researchAgentTemporalEligibility(source, currentScope) !== "eligible") {
          return { failure: "temporal-ineligible" as const };
        }

        try {
          const savedSourceId = await saveRunSource(source, "retrieved");

          if (!savedSourceId) {
            return { failure: "unavailable" as const };
          }

          return { sourceId: savedSourceId };
        } catch {
          return { failure: "unavailable" as const };
        }
      });

      if ("failure" in result) {
        return result;
      }

      const stored = await readCurrentRunSource(result.sourceId);

      return stored ? { source: stored } : { failure: "unavailable" as const };
    },

    async recordFindings(currentScope, input) {
      await runFencedTool("record_findings", { findings: input.findings, gaps: input.gaps }, () =>
        Promise.resolve({ findings: input.findings, gaps: input.gaps }),
      );
    },

    async publishReport(_currentScope, input) {
      const publication = input as ResolvedReportInput;

      const report = {
        version: "research-report-v1" as const,
        answer: publication.answer,
        quality: publication.quality,
        findings: publication.findings,
        gaps: publication.gaps,
      };

      const result = await withResearchRunDatabase(env, (db) =>
        publishResearchAgentReport(db, operationKey, report),
      );

      return result.published
        ? { published: true as const }
        : { published: false as const, reason: "rejected" as const };
    },
  };

  return Promise.resolve(createResearchAgentTools(ports, scope, () => operationId));
}
