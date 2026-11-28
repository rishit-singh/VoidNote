import { z } from "zod";

import type { ResearchSource } from "../ports";
import { publicResearchUrl } from "../sources";

const FIRECRAWL_SCRAPE_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";

const MAX_API_KEY_LENGTH = 512;

const MAX_PROVIDER_REQUEST_ID_LENGTH = 200;

const MAX_RESPONSE_BYTES = 512_000;

const MAX_SOURCE_BYTES = 128_000;

const firecrawlResponseSchema = z
  .object({
    success: z.boolean(),
    data: z
      .object({
        markdown: z.string().optional(),
        metadata: z
          .object({
            url: z.string().max(2048).optional(),
            sourceURL: z.string().max(2048).optional(),
            contentType: z.string().max(200).optional(),
            statusCode: z.number().int().optional(),
            scrapeId: z.string().max(MAX_PROVIDER_REQUEST_ID_LENGTH).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const firecrawlUsageSchema = z
  .object({
    data: z
      .object({
        metadata: z
          .object({
            provider: z
              .object({
                creditsCost: z.number().int().nonnegative().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type FirecrawlScrapeInput = {
  url: string;
  apiKey: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxResponseBytes: number;
  maxSourceBytes: number;
};

export type FirecrawlScrapeFailure =
  | "invalid_input"
  | "request_failed"
  | "response_too_large"
  | "invalid_response"
  | "provider_rejected"
  | "source_status_failed"
  | "unsupported_content"
  | "final_url_unknown"
  | "empty_markdown"
  | "source_too_large";

export type FirecrawlScrapeResult =
  | {
      ok: true;
      source: ResearchSource;
      creditsUsed: number | null;
      providerRequestId?: string;
    }
  | {
      ok: false;
      failure: FirecrawlScrapeFailure;
      creditsUsed: number | null;
      providerRequestId?: string;
    };

type ProviderMetadata = {
  creditsUsed: number | null;
  providerRequestId?: string;
};

function failure(
  reason: FirecrawlScrapeFailure,
  metadata: ProviderMetadata = { creditsUsed: null },
): FirecrawlScrapeResult {
  return {
    ok: false,
    failure: reason,
    ...metadata,
  };
}

function validLimits(input: FirecrawlScrapeInput): boolean {
  return (
    Number.isSafeInteger(input.timeoutMs) &&
    input.timeoutMs >= 1_000 &&
    input.timeoutMs <= 300_000 &&
    Number.isSafeInteger(input.maxResponseBytes) &&
    input.maxResponseBytes > 0 &&
    input.maxResponseBytes <= MAX_RESPONSE_BYTES &&
    Number.isSafeInteger(input.maxSourceBytes) &&
    input.maxSourceBytes > 0 &&
    input.maxSourceBytes <= MAX_SOURCE_BYTES
  );
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const declaredLength = response.headers.get("content-length");

  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    await response.body?.cancel();

    return null;
  }

  const reader = response.body?.getReader();

  if (!reader) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];

  let byteLength = 0;

  const cancelOnAbort = () => void reader.cancel().catch(() => {});

  signal.addEventListener("abort", cancelOnAbort, { once: true });

  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();

      if (part.done) {
        break;
      }

      byteLength += part.value.byteLength;

      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => {});

        return null;
      }

      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);

  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

function providerRequestId(response: Response, body: unknown): string | undefined {
  const responseId = requestIdFromHeaders(response);

  if (responseId && responseId.length <= MAX_PROVIDER_REQUEST_ID_LENGTH) {
    return responseId;
  }

  const parsed = firecrawlResponseSchema.safeParse(body);

  const scrapeId = parsed.success ? parsed.data.data?.metadata?.scrapeId?.trim() : undefined;

  return scrapeId && scrapeId.length > 0 ? scrapeId : undefined;
}

function requestIdFromHeaders(response: Response): string | undefined {
  const responseId = response.headers.get("x-request-id")?.trim();

  return responseId && responseId.length <= MAX_PROVIDER_REQUEST_ID_LENGTH ? responseId : undefined;
}

function usageFrom(body: unknown): number | null {
  const parsed = firecrawlUsageSchema.safeParse(body);

  if (!parsed.success) {
    return null;
  }

  // ScrapeResponse documents provider-routed URL charges at
  // data.metadata.provider.creditsCost. Ordinary scrape cost is not returned
  // in this response contract, so it remains unknown rather than inferred.
  const providerCredits = parsed.data.data?.metadata?.provider?.creditsCost;

  return typeof providerCredits === "number" &&
    Number.isSafeInteger(providerCredits) &&
    providerCredits >= 0
    ? providerCredits
    : null;
}

/**
 * Retrieves one full-page Markdown snapshot. This adapter intentionally does
 * not perform discovery, policy admission, or operation-receipt persistence.
 */
export async function scrape(input: FirecrawlScrapeInput): Promise<FirecrawlScrapeResult> {
  if (
    !input.apiKey ||
    input.apiKey.length > MAX_API_KEY_LENGTH ||
    !validLimits(input) ||
    input.signal.aborted
  ) {
    return failure("invalid_input");
  }

  try {
    publicResearchUrl(input.url);
  } catch {
    return failure("invalid_input");
  }

  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)]);

  let response: Response;

  try {
    response = await fetch(FIRECRAWL_SCRAPE_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: input.url,
        formats: ["markdown"],
        onlyMainContent: true,
        maxAge: 0,
        parsers: [],
        timeout: input.timeoutMs,
      }),
      signal,
      redirect: "error",
    });
  } catch {
    return failure("request_failed");
  }

  let bytes: Uint8Array | null;

  try {
    bytes = await readBoundedBody(response, input.maxResponseBytes, signal);
  } catch {
    const id = requestIdFromHeaders(response);

    return failure("request_failed", {
      creditsUsed: null,
      ...(id ? { providerRequestId: id } : {}),
    });
  }

  if (!bytes) {
    const id = requestIdFromHeaders(response);

    return failure("response_too_large", {
      creditsUsed: null,
      ...(id ? { providerRequestId: id } : {}),
    });
  }

  let body: unknown;

  try {
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } catch {
    const id = requestIdFromHeaders(response);

    return failure("invalid_response", {
      creditsUsed: null,
      ...(id ? { providerRequestId: id } : {}),
    });
  }

  const creditsUsed = usageFrom(body);

  const requestId = providerRequestId(response, body);

  const metadata: ProviderMetadata = {
    creditsUsed,
    ...(requestId ? { providerRequestId: requestId } : {}),
  };

  const parsed = firecrawlResponseSchema.safeParse(body);

  if (!response.ok || !parsed.success || !parsed.data.success || !parsed.data.data) {
    return failure(
      parsed.success && !parsed.data.success ? "provider_rejected" : "invalid_response",
      metadata,
    );
  }

  const { data } = parsed.data;

  const pageStatus = data.metadata?.statusCode;

  if (
    pageStatus !== undefined &&
    !((pageStatus >= 200 && pageStatus < 300) || pageStatus === 304)
  ) {
    return failure("source_status_failed", metadata);
  }

  const contentType = data.metadata?.contentType?.split(";", 1)[0]?.trim().toLowerCase();

  if (
    contentType &&
    contentType !== "text/html" &&
    contentType !== "text/plain" &&
    contentType !== "text/markdown"
  ) {
    return failure("unsupported_content", metadata);
  }

  if (typeof data.markdown !== "string" || !data.markdown.trim()) {
    return failure("empty_markdown", metadata);
  }

  const text = data.markdown.trim();

  const sourceBytes = new TextEncoder().encode(text);

  if (sourceBytes.byteLength > input.maxSourceBytes) {
    return failure("source_too_large", metadata);
  }

  let finalUrl: string;

  const providerUrl = data.metadata?.url;

  if (!providerUrl) {
    return failure("final_url_unknown", metadata);
  }

  try {
    publicResearchUrl(providerUrl);
    finalUrl = providerUrl;
  } catch {
    return failure("unsupported_content", metadata);
  }

  const digestBytes = await crypto.subtle.digest("SHA-256", sourceBytes);

  const digest = Array.from(new Uint8Array(digestBytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return {
    ok: true,
    source: {
      id: crypto.randomUUID(),
      requestedUrl: input.url,
      url: finalUrl,
      text,
      retrievedAt: new Date().toISOString(),
      digest,
    },
    ...metadata,
  };
}
