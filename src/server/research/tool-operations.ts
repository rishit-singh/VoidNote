import {
  evidenceLookupInputSchema,
  evidenceReadInputSchema,
  type PublishReportInput,
  publishReportInputSchema,
  type RecordFindingsInput,
  recordFindingsInputSchema,
  type ResearchAgentScope,
  type ResolvedResearchAgentFinding,
  retrieveSourceInputSchema,
  searchSourcesInputSchema,
} from "../../contracts/research/agent";
import type { ResearchRunFinding } from "../../contracts/research/runs";
import type { ResearchSource } from "../../ai/research/ports";
import { validateRunCitations } from "../../ai/research/runs/validation";
import { publicResearchUrl } from "../../ai/research/sources";

const MAX_TOOL_SOURCE_CHARS = 4000;

type ResearchSourceMetadata = Omit<ResearchSource, "text">;

type ResearchSourcePage = {
  source: ResearchSourceMetadata;
  startOffset: number;
  text: string;
  totalLength: number;
};

export type ResearchAgentToolPorts = {
  evidence: {
    lookup(
      scope: ResearchAgentScope,
      input: { query: string; limit: number },
    ): Promise<
      Array<{
        sourceId: string;
        title: string;
        url: string;
        requestedUrl?: string;
        retrievedAt: string;
        revision: string;
        freshness: "eligible" | "stale" | "unknown";
        totalLength: number;
      }>
    >;
    read(
      scope: ResearchAgentScope,
      input: { sourceId: string; startOffset: number; limit: number },
    ): Promise<ResearchSourcePage | null>;
    source(scope: ResearchAgentScope, sourceId: string): Promise<ResearchSource | null>;
  };
  searchSources(
    scope: ResearchAgentScope,
    input: { operationId: string; query: string },
  ): Promise<Array<{ url: string; title: string; snippet: string; publishedAt: string | null }>>;
  retrieveSource(
    scope: ResearchAgentScope,
    input: { operationId: string; url: string },
  ): Promise<
    | {
        source: ResearchSource;
      }
    | {
        failure: "blocked" | "not-found" | "temporal-ineligible" | "unavailable";
      }
  >;
  recordFindings(
    scope: ResearchAgentScope,
    input: Omit<RecordFindingsInput, "findings"> & {
      findings: ResolvedResearchAgentFinding[];
      operationId: string;
    },
  ): Promise<void>;
  publishReport(
    scope: ResearchAgentScope,
    input: Omit<PublishReportInput, "findings"> & {
      findings: ResolvedResearchAgentFinding[];
      operationId: string;
    },
  ): Promise<{ published: true } | { published: false; reason: "invalid-citations" | "rejected" }>;
};

export type ResearchAgentToolOperationId = (
  tool: "search_sources" | "retrieve_source" | "record_findings" | "publish_report",
  input: unknown,
) => string;

function safeSourceMetadata(source: ResearchSourceMetadata) {
  return {
    sourceId: source.id,
    requestedUrl: source.requestedUrl,
    url: source.url,
    retrievedAt: source.retrievedAt,
    digest: source.digest,
  };
}

function normalizePublicUrl(value: string) {
  try {
    return publicResearchUrl(value).href;
  } catch {
    return null;
  }
}

function sourceIsInScope(scope: ResearchAgentScope, url: string, requestedUrl?: string) {
  const normalized = normalizePublicUrl(url);

  if (!normalized) {
    return false;
  }

  if (!scope.sourceUrls.length) {
    return true;
  }

  const authorizedUrl = normalizePublicUrl(requestedUrl ?? url);

  return Boolean(
    authorizedUrl &&
    scope.sourceUrls.some((sourceUrl) => normalizePublicUrl(sourceUrl) === authorizedUrl),
  );
}

function pageResult(page: ResearchSourcePage) {
  const maxEnd = Math.min(page.startOffset + MAX_TOOL_SOURCE_CHARS, page.totalLength);

  const allowedLength = maxEnd - page.startOffset;

  const text = page.text.slice(0, allowedLength);

  const nextOffset = page.startOffset + text.length;

  return {
    source: safeSourceMetadata(page.source),
    startOffset: page.startOffset,
    endOffset: nextOffset,
    text,
    totalLength: page.totalLength,
    truncated: nextOffset < page.totalLength,
    nextOffset: nextOffset < page.totalLength ? nextOffset : null,
  };
}

async function validateFindings(
  ports: ResearchAgentToolPorts,
  scope: ResearchAgentScope,
  findings: ResearchRunFinding[],
  quality?: PublishReportInput["quality"],
) {
  const citations = findings.flatMap((finding) => finding.citations);

  const evidence: Array<{ sourceId: string; url: string; text: string; retrievedAt: string }> = [];

  for (const sourceId of new Set(citations.map((citation) => citation.sourceId))) {
    const stored = await ports.evidence.source(scope, sourceId);

    if (!stored || !sourceIsInScope(scope, stored.url, stored.requestedUrl)) {
      return false;
    }

    evidence.push({
      sourceId: stored.id,
      url: stored.url,
      text: stored.text,
      retrievedAt: stored.retrievedAt,
    });
  }

  if (!validateRunCitations(citations, evidence).valid) {
    return false;
  }

  if (
    quality === "answered" &&
    !findings.some((finding) => finding.outcome === "supported" && finding.citations.length > 0)
  ) {
    return false;
  }

  return true;
}

function resolveFindings(
  scope: ResearchAgentScope,
  findings: RecordFindingsInput["findings"],
): ResolvedResearchAgentFinding[] | null {
  const questions = new Map(scope.questions.map((question) => [question.id, question.question]));

  const seen = new Set<string>();

  const resolved: ResolvedResearchAgentFinding[] = [];

  for (const finding of findings) {
    const question = questions.get(finding.questionId);

    if (!question || seen.has(finding.questionId)) {
      return null;
    }

    seen.add(finding.questionId);
    resolved.push({
      ...finding,
      id: finding.questionId,
      question,
    });
  }

  return resolved;
}

function coversAdmittedQuestions(scope: ResearchAgentScope, findings: ResearchRunFinding[]) {
  return (
    findings.length === scope.questions.length &&
    scope.questions.every((question) =>
      findings.some((finding) => finding.questionId === question.id),
    )
  );
}

/** Stateless handlers; all authority and durable side effects remain behind ports. */
export function createResearchAgentTools(
  ports: ResearchAgentToolPorts,
  scope: ResearchAgentScope,
  operationIdFor: ResearchAgentToolOperationId,
) {
  const authorizedScope = Object.freeze(scope);

  return {
    async evidence_lookup(raw: unknown) {
      const parsed = evidenceLookupInputSchema.safeParse(raw);

      if (!parsed.success) {
        return {
          ok: false as const,
          code: "invalid-input" as const,
          message: "Invalid evidence lookup.",
        };
      }

      const matches = await ports.evidence.lookup(authorizedScope, parsed.data);

      const inScope = matches.filter((match) =>
        sourceIsInScope(authorizedScope, match.url, match.requestedUrl),
      );

      const ineligibleCount = matches.filter(
        (match) =>
          match.freshness !== "eligible" ||
          !sourceIsInScope(authorizedScope, match.url, match.requestedUrl),
      ).length;

      const eligibleMatches = inScope.filter((match) => match.freshness === "eligible");

      const returnedCount = eligibleMatches.slice(0, parsed.data.limit).length;

      return {
        ok: true as const,
        evidence: eligibleMatches.slice(0, parsed.data.limit).map((match) => ({
          sourceId: match.sourceId,
          title: match.title.slice(0, 300),
          titleTruncated: match.title.length > 300,
          url: match.url,
          ...(match.requestedUrl ? { requestedUrl: match.requestedUrl } : {}),
          retrievedAt: match.retrievedAt,
          revision: match.revision,
          totalLength: match.totalLength,
          freshness: match.freshness,
        })),
        returnedCount,
        omittedCount: eligibleMatches.length - returnedCount,
        omittedIneligibleCount: ineligibleCount,
      };
    },

    async evidence_read(raw: unknown) {
      const parsed = evidenceReadInputSchema.safeParse(raw);

      if (!parsed.success) {
        return {
          ok: false as const,
          code: "invalid-input" as const,
          message: "Invalid evidence handle.",
        };
      }

      const evidence = await ports.evidence.read(authorizedScope, parsed.data);

      if (!evidence || evidence.source.id !== parsed.data.sourceId) {
        return {
          ok: false as const,
          code: "not-found" as const,
          message: "Evidence handle is unavailable.",
        };
      }

      if (!sourceIsInScope(authorizedScope, evidence.source.url, evidence.source.requestedUrl)) {
        return {
          ok: false as const,
          code: "out-of-scope" as const,
          message: "Evidence is outside the permitted source scope.",
        };
      }

      if (
        evidence.startOffset !== parsed.data.startOffset ||
        evidence.totalLength < 0 ||
        evidence.startOffset > evidence.totalLength ||
        evidence.text.length > parsed.data.limit ||
        evidence.startOffset + evidence.text.length > evidence.totalLength
      ) {
        return {
          ok: false as const,
          code: "unavailable" as const,
          message: "The requested evidence range is unavailable.",
        };
      }

      return { ok: true as const, ...pageResult(evidence) };
    },

    async search_sources(raw: unknown) {
      const parsed = searchSourcesInputSchema.safeParse(raw);

      if (!parsed.success) {
        return {
          ok: false as const,
          code: "invalid-input" as const,
          message: "Invalid source search.",
        };
      }

      if (authorizedScope.sourceUrls.length || !authorizedScope.discoverSources) {
        return {
          ok: false as const,
          code: "out-of-scope" as const,
          message: "Source discovery is disabled for this run.",
        };
      }

      const candidates = await ports.searchSources(authorizedScope, {
        ...parsed.data,
        operationId: operationIdFor("search_sources", parsed.data),
      });

      return {
        ok: true as const,
        candidates: candidates.slice(0, 6).map((candidate) => ({
          ...candidate,
          title: candidate.title.slice(0, 300),
          titleTruncated: candidate.title.length > 300,
          snippet: candidate.snippet.slice(0, 500),
          snippetTruncated: candidate.snippet.length > 500,
        })),
        returnedCount: Math.min(candidates.length, 6),
        omittedCount: Math.max(0, candidates.length - 6),
      };
    },

    async retrieve_source(raw: unknown) {
      const parsed = retrieveSourceInputSchema.safeParse(raw);

      if (!parsed.success) {
        return {
          ok: false as const,
          code: "invalid-input" as const,
          message: "Invalid source URL.",
        };
      }

      const requested = normalizePublicUrl(parsed.data.url);

      if (!requested) {
        return {
          ok: false as const,
          code: "invalid-input" as const,
          message: "Source URL must be a public HTTPS address.",
        };
      }

      if (!sourceIsInScope(authorizedScope, requested)) {
        return {
          ok: false as const,
          code: "out-of-scope" as const,
          message: "URL is outside the supplied source set.",
        };
      }

      const result = await ports.retrieveSource(authorizedScope, {
        operationId: operationIdFor("retrieve_source", { url: requested }),
        url: requested,
      });

      if ("failure" in result) {
        if (result.failure === "temporal-ineligible") {
          return {
            ok: false as const,
            code: "temporal-ineligible" as const,
            message:
              "Source temporal eligibility could not be established for this run; it was not saved.",
          };
        }

        return {
          ok: false as const,
          code: "unavailable" as const,
          message: `Source retrieval failed (${result.failure}).`,
        };
      }

      if (
        normalizePublicUrl(result.source.requestedUrl) !== requested ||
        !normalizePublicUrl(result.source.url) ||
        !sourceIsInScope(authorizedScope, result.source.url, result.source.requestedUrl)
      ) {
        return {
          ok: false as const,
          code: "out-of-scope" as const,
          message: "Retrieved source is outside the permitted source set.",
        };
      }

      const firstPage: ResearchSourcePage = {
        source: {
          id: result.source.id,
          requestedUrl: result.source.requestedUrl,
          url: result.source.url,
          retrievedAt: result.source.retrievedAt,
          digest: result.source.digest,
        },
        startOffset: 0,
        text: result.source.text.slice(0, MAX_TOOL_SOURCE_CHARS),
        totalLength: result.source.text.length,
      };

      return { ok: true as const, ...pageResult(firstPage) };
    },

    async record_findings(raw: unknown) {
      const parsed = recordFindingsInputSchema.safeParse(raw);

      if (!parsed.success) {
        return { ok: false as const, code: "invalid-input" as const, message: "Invalid findings." };
      }

      const findings = resolveFindings(authorizedScope, parsed.data.findings);

      if (!findings) {
        return {
          ok: false as const,
          code: "invalid-input" as const,
          message: "Finding question is not admitted for this run or is duplicated.",
        };
      }

      if (!(await validateFindings(ports, authorizedScope, findings))) {
        return {
          ok: false as const,
          code: "invalid-input" as const,
          message: "Finding citations did not validate against permitted evidence.",
        };
      }

      await ports.recordFindings(authorizedScope, {
        ...parsed.data,
        findings,
        operationId: operationIdFor("record_findings", parsed.data),
      });

      return {
        ok: true as const,
        recorded: parsed.data.findings.length,
        gaps: parsed.data.gaps.length,
      };
    },

    async publish_report(raw: unknown) {
      const parsed = publishReportInputSchema.safeParse(raw);

      if (!parsed.success) {
        return { ok: false as const, code: "invalid-input" as const, message: "Invalid report." };
      }

      const findings = resolveFindings(authorizedScope, parsed.data.findings);

      if (!findings || !coversAdmittedQuestions(authorizedScope, findings)) {
        return {
          ok: false as const,
          code: "invalid-input" as const,
          message: "Finding question is not admitted for this run or is duplicated.",
        };
      }

      if (
        findings.some(
          (finding) =>
            finding.outcome === "failed" ||
            (finding.outcome === "insufficient-evidence" && !finding.explanation.trim()),
        )
      ) {
        return {
          ok: false as const,
          code: "invalid-input" as const,
          message: "Unresolved questions require an explained insufficient-evidence finding.",
        };
      }

      if (
        parsed.data.quality === "answered" &&
        (parsed.data.gaps.length > 0 ||
          findings.some(
            (finding) => finding.outcome !== "supported" || finding.citations.length === 0,
          ))
      ) {
        return {
          ok: false as const,
          code: "invalid-input" as const,
          message:
            "Answered reports require supported cited findings for every question and no gaps.",
        };
      }

      if (!(await validateFindings(ports, authorizedScope, findings, parsed.data.quality))) {
        return {
          ok: false as const,
          code: "invalid-input" as const,
          message: "Report citations did not validate.",
        };
      }

      const result = await ports.publishReport(authorizedScope, {
        ...parsed.data,
        findings,
        operationId: operationIdFor("publish_report", parsed.data),
      });

      return result.published
        ? { ok: true as const, published: true }
        : {
            ok: false as const,
            code: "unavailable" as const,
            message: "Report publication was rejected.",
          };
    },
  };
}
