import { z } from "zod";

import type { ResearchPolicy } from "../../../config/research";
import { publicResearchUrl } from "../sources";

export type ResearchCandidate = {
  url: string;
  title: string;
  snippet: string;
  publishedAt: string | null;
};

const responseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      web: z
        .array(
          z
            .object({
              url: z.string().max(2048),
              title: z.string().max(1000).optional(),
              description: z.string().max(3000).optional(),
              metadata: z
                .object({
                  url: z.string().max(2048).optional(),
                  sourceURL: z.string().max(2048).optional(),
                  title: z.string().max(1000).optional(),
                  description: z.string().max(3000).optional(),
                  date: z.string().max(100).optional(),
                  publishedTime: z.string().max(100).optional(),
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

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal) {
  const length = response.headers.get("content-length");

  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel();
    throw new Error("Discovery response exceeded its pinned byte limit.");
  }

  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("Discovery response had no body.");
  }

  const chunks: Uint8Array[] = [];

  let size = 0;

  const abort = () => void reader.cancel().catch(() => {});

  signal.addEventListener("abort", abort, { once: true });

  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();

      if (part.done) {
        break;
      }

      size += part.value.byteLength;

      if (size > maxBytes) {
        throw new Error("Discovery response exceeded its pinned byte limit.");
      }

      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);

  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

/** The paid Firecrawl call returns only bounded candidates; page retrieval uses
 * the existing pinned public-URL transport after deterministic selection. */
export async function searchResearchCandidates(input: {
  query: string;
  policy: ResearchPolicy;
  apiKey: string;
  signal: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<{ candidates: ResearchCandidate[]; creditsUsed: number | null }> {
  if (input.policy.sourceProvider !== "firecrawl") {
    throw new Error("Research source discovery is unavailable.");
  }

  const response = await (input.fetcher ?? fetch)("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    redirect: "error",
    signal: input.signal,
    body: JSON.stringify({
      query: input.query.slice(0, 500),
      limit: input.policy.maxSearchResults,
      sources: ["web"],
      highlights: false,
      ignoreInvalidURLs: true,
    }),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Research discovery request failed.");
  }

  const raw = await readBounded(response, input.policy.maxDiscoveryBytes, input.signal);

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Research discovery returned malformed JSON.");
  }

  const parsed = responseSchema.safeParse(parsedJson);

  if (!parsed.success || parsed.data.data.web.length > input.policy.maxSearchResults) {
    throw new Error("Research discovery returned an invalid result.");
  }

  if (
    parsed.data.creditsUsed !== undefined &&
    parsed.data.creditsUsed > (input.policy.searchUnitBound ?? 0)
  ) {
    throw new Error("Research discovery exceeded its reserved service allowance.");
  }

  const candidates: ResearchCandidate[] = [];

  const seen = new Set<string>();

  for (const item of parsed.data.data.web) {
    try {
      const url = publicResearchUrl(item.metadata?.url ?? item.url).href;

      if (seen.has(url)) {
        continue;
      }

      seen.add(url);
      candidates.push({
        url,
        title: item.metadata?.title ?? item.title ?? "",
        snippet: item.metadata?.description ?? item.description ?? "",
        publishedAt: item.metadata?.publishedTime ?? item.metadata?.date ?? null,
      });
    } catch {
      // Prohibited candidate URLs are rejected before retrieval.
    }
  }

  return { candidates, creditsUsed: parsed.data.creditsUsed ?? null };
}

const terms = (value: string) => new Set(value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/** Prefer relevance and independent domains; search rank is only a tie breaker. */
export function selectResearchCandidates(
  query: string,
  candidates: ResearchCandidate[],
  limit: number,
) {
  const queryTerms = terms(query);

  const ranked = candidates
    .map((candidate, rank) => {
      const titleTerms = terms(candidate.title);

      const snippetTerms = terms(candidate.snippet);

      const score = [...queryTerms].reduce(
        (total, term) => total + Number(titleTerms.has(term)) * 3 + Number(snippetTerms.has(term)),
        0,
      );

      return { candidate, rank, score, host: new URL(candidate.url).hostname };
    })
    .sort((a, b) => b.score - a.score || a.rank - b.rank);

  const selected: typeof ranked = [];

  const domains = new Set<string>();

  for (const entry of ranked) {
    if (selected.length >= limit) {
      break;
    }

    if (entry.score === 0 || domains.has(entry.host)) {
      continue;
    }

    selected.push(entry);
    domains.add(entry.host);
  }

  return selected.map(({ candidate, score }) => ({ ...candidate, relevanceScore: score }));
}
