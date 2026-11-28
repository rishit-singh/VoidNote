import { z } from "zod";

import { idSchema } from "../contracts/workspace";

const DEFAULT_RESEARCH_SEARCH_RESULTS = 5;

export const DEFAULT_RESEARCH_MAX_RESPONSE_BYTES = 512_000;

export const researchPolicySchema = z
  .object({
    version: z.literal("research-v1"),
    promptVersion: z.enum(["research-extract-v1", "research-extract-v2"]),
    provider: z.literal("workers-ai"),
    sourceProvider: z.enum(["direct", "firecrawl"]).default("direct"),
    maxSearchResults: z.number().int().min(1).max(10).default(5),
    serviceBudgetId: z.uuid().optional(),
    searchUnitBound: z.number().int().min(1).max(100).optional(),
    maxDiscoveredSources: z.number().int().min(1).max(8).default(5),
    maxDiscoveryBytes: z.number().int().min(1000).max(512_000).default(128_000),
    discoveryTimeoutMs: z.number().int().min(1000).max(60_000).default(30_000),
    model: z.string().trim().min(1).max(200),
    budgetId: z.uuid(),
    rateVersionId: z.uuid(),
    reasoningEffort: z.enum(["none", "low", "high"]).default("none"),
    // Retained/extracted source text; raw page responses have a separate bound.
    maxSourceBytes: z.number().int().min(1000).max(128_000).default(128_000),
    maxResponseBytes: z
      .number()
      .int()
      .min(1000)
      .max(DEFAULT_RESEARCH_MAX_RESPONSE_BYTES)
      .default(DEFAULT_RESEARCH_MAX_RESPONSE_BYTES),
    sourceTimeoutMs: z.number().int().min(1000).max(30_000).default(10_000),
    maxRedirects: z.number().int().min(0).max(5).default(3),
    maxOutputTokens: z.number().int().min(256).max(8192).default(2048),
    maxInputTokens: z.number().int().min(4000).max(256_000).default(64_000),
    contextWindowTokens: z.number().int().min(8000).max(512_000).default(128_000),
    extractionTimeoutMs: z.number().int().min(1000).max(180_000).default(90_000),
    deadlineMs: z.number().int().min(60_000).max(86_400_000).default(3_600_000),
    maxAttempts: z.number().int().min(1).max(5).default(3),
  })
  .superRefine((policy, context) => {
    if (policy.sourceProvider !== "firecrawl") {
      return;
    }

    const requiredUnits = Math.ceil(policy.maxSearchResults / 10) * 2 + policy.maxSearchResults;

    if (!policy.serviceBudgetId) {
      context.addIssue({
        code: "custom",
        path: ["serviceBudgetId"],
        message: "Firecrawl discovery requires an approved service budget.",
      });
    }

    if (!policy.searchUnitBound || policy.searchUnitBound < requiredUnits) {
      context.addIssue({
        code: "custom",
        path: ["searchUnitBound"],
        message: "Search unit bound must conservatively cover search plus full-page retrieval.",
      });
    }
  });
export type ResearchPolicy = z.infer<typeof researchPolicySchema>;
export type ResearchPolicyEnvironment = {
  RESEARCH_ENABLED?: string;
  RESEARCH_MODEL?: string;
  RESEARCH_BUDGET_ID?: string;
  RESEARCH_RATE_VERSION_ID?: string;
  RESEARCH_DISCOVERY_ENABLED?: string;
  FIRECRAWL_API_KEY?: string;
  RESEARCH_SERVICE_BUDGET_ID?: string;
  RESEARCH_SEARCH_UNIT_BOUND?: string;
};

export function readResearchPolicy(env: ResearchPolicyEnvironment): ResearchPolicy | null {
  if (env.RESEARCH_ENABLED !== "true") {
    return null;
  }

  const maxSearchResults = DEFAULT_RESEARCH_SEARCH_RESULTS;

  const parsedUnitBound = Number(env.RESEARCH_SEARCH_UNIT_BOUND);

  // Firecrawl's documented maximum is 2 search credits per 10 web results plus
  // one scrape credit per result when full-page markdown is requested.
  const requiredSearchUnits = Math.ceil(maxSearchResults / 10) * 2 + maxSearchResults;

  const hasDiscoveryBudget =
    idSchema.safeParse(env.RESEARCH_SERVICE_BUDGET_ID).success &&
    Number.isSafeInteger(parsedUnitBound) &&
    parsedUnitBound >= requiredSearchUnits;

  const sourceProvider =
    env.RESEARCH_DISCOVERY_ENABLED === "true" &&
    Boolean(env.FIRECRAWL_API_KEY) &&
    hasDiscoveryBudget
      ? "firecrawl"
      : "direct";

  const result = researchPolicySchema.safeParse({
    version: "research-v1",
    promptVersion: "research-extract-v2",
    provider: "workers-ai",
    model: env.RESEARCH_MODEL,
    budgetId: env.RESEARCH_BUDGET_ID,
    rateVersionId: env.RESEARCH_RATE_VERSION_ID,
    sourceProvider,
    maxSearchResults,
    ...(sourceProvider === "firecrawl"
      ? {
          serviceBudgetId: env.RESEARCH_SERVICE_BUDGET_ID,
          searchUnitBound: parsedUnitBound,
        }
      : {}),
  });

  return result.success ? result.data : null;
}
