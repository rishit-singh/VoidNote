import { z } from "zod";

import type { ResearchPolicy } from "../../config/research";
import type { ResearchDiscoveryInput, ResearchDiscoveryProvider, ResearchSource } from "./ports";
import { publicResearchUrl } from "./sources";

const firecrawlResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      web: z
        .array(
          z
            .object({
              url: z.string().max(2048),
              title: z.string().max(1000).optional(),
              markdown: z.string().nullable().optional(),
              metadata: z
                .object({
                  sourceURL: z.string().max(2048).optional(),
                  url: z.string().max(2048).optional(),
                  title: z.string().max(1000).optional(),
                })
                .passthrough()
                .optional(),
            })
            .passthrough(),
        )
        .max(10),
    }),
    creditsUsed: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export type FirecrawlFetch = typeof fetch;

export type FirecrawlResearchOptions = {
  apiKey: string;
  canExecute: () => boolean | Promise<boolean>;
  fetcher?: FirecrawlFetch;
};

function discoveryQuery(input: ResearchDiscoveryInput) {
  const context = [
    input.person.displayName,
    input.person.professional.organization,
    input.person.professional.role,
    input.person.description,
    ...(input.person.verifiedAliases ?? []),
  ].filter(Boolean);

  const questions = input.facts.map((fact) => fact.question);

  // A single query keeps the paid operation bounded while explicitly disambiguating
  // against the profile context; full-page contents, not these results, ground claims.
  return `${context.join(" ")} ${questions.join("; ")}`.trim().slice(0, 500);
}

function validFullPage(markdown: unknown): markdown is string {
  return typeof markdown === "string" && markdown.trim().length > 0;
}

export function createFirecrawlResearchDiscovery(
  options: FirecrawlResearchOptions,
): ResearchDiscoveryProvider {
  const fetcher = options.fetcher ?? fetch;

  const endpoint = "https://api.firecrawl.dev/v2/search";

  return {
    async discover(
      input: ResearchDiscoveryInput,
      policy: ResearchPolicy,
      signal: AbortSignal,
    ): Promise<{ sources: ResearchSource[]; creditsUsed: number | null }> {
      if (!options.apiKey || options.apiKey.length > 512) {
        throw new Error("Research discovery is not configured.");
      }

      if (!(await options.canExecute())) {
        throw new Error("Research discovery is disabled.");
      }

      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: discoveryQuery(input),
          limit: policy.maxSearchResults,
          sources: ["web"],
          highlights: false,
          ignoreInvalidURLs: true,
          scrapeOptions: {
            formats: ["markdown"],
            onlyMainContent: true,
            timeout: policy.discoveryTimeoutMs,
          },
        }),
        signal,
        redirect: "error",
      });

      if (!response.ok) {
        await response.body?.cancel();
        // Never include provider response bodies, which may contain request details.
        throw new Error("Firecrawl discovery request failed.");
      }

      const declaredSize = response.headers.get("content-length");

      if (
        declaredSize &&
        (!/^\d+$/.test(declaredSize) || Number(declaredSize) > policy.maxDiscoveryBytes)
      ) {
        await response.body?.cancel();
        throw new Error("Firecrawl discovery response exceeds the configured byte limit.");
      }

      const reader = response.body?.getReader();

      if (!reader) {
        throw new Error("Firecrawl discovery returned no response body.");
      }

      const chunks: Uint8Array[] = [];

      let byteLength = 0;

      const abort = () => void reader.cancel().catch(() => {});

      signal.addEventListener("abort", abort, { once: true });

      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();

          if (part.done) {
            break;
          }

          byteLength += part.value.byteLength;

          if (byteLength > policy.maxDiscoveryBytes) {
            throw new Error("Firecrawl discovery response exceeds the configured byte limit.");
          }

          chunks.push(part.value);
        }
      } finally {
        signal.removeEventListener("abort", abort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }

      signal.throwIfAborted();
      const bytes = new Uint8Array(byteLength);

      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      let raw: unknown;

      try {
        raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
        ) as unknown;
      } catch {
        throw new Error("Firecrawl discovery returned malformed JSON.");
      }

      const result = firecrawlResponseSchema.safeParse(raw);

      if (!result.success) {
        throw new Error("Firecrawl discovery returned an invalid response.");
      }

      if (result.data.data.web.length > policy.maxSearchResults) {
        throw new Error("Firecrawl returned more web results than the pinned request limit.");
      }

      if (
        result.data.creditsUsed !== undefined &&
        result.data.creditsUsed > (policy.searchUnitBound ?? 0)
      ) {
        throw new Error("Firecrawl usage exceeded the reserved service-unit bound.");
      }

      const retrievedAt = new Date().toISOString();

      const sources: ResearchSource[] = [];

      const seen = new Set<string>();

      let totalSourceBytes = 0;

      for (const item of result.data.data.web) {
        if (!validFullPage(item.markdown)) {
          continue;
        }

        let url: URL;

        try {
          url = publicResearchUrl(item.metadata?.url ?? item.url);
        } catch {
          continue;
        }

        if (seen.has(url.href)) {
          continue;
        }

        seen.add(url.href);
        const text = item.markdown.trim();

        const size = new TextEncoder().encode(text).byteLength;

        if (totalSourceBytes + size > policy.maxSourceBytes) {
          continue;
        }

        totalSourceBytes += size;
        const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

        const digest = Array.from(new Uint8Array(digestBytes), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");

        sources.push({
          id: crypto.randomUUID(),
          requestedUrl: url.href,
          url: url.href,
          text,
          digest,
          retrievedAt,
        });

        if (sources.length >= policy.maxDiscoveredSources) {
          break;
        }
      }

      return {
        sources,
        creditsUsed: result.data.creditsUsed ?? null,
      };
    },
  };
}
