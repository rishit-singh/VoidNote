import assert from "node:assert/strict";
import { test } from "node:test";

import { scrape, type FirecrawlScrapeInput } from "../../src/ai/research/firecrawl/index";

const input: FirecrawlScrapeInput = {
  url: "https://example.org/original?version=1#section",
  apiKey: "test-key",
  signal: new AbortController().signal,
  timeoutMs: 5_000,
  maxResponseBytes: 16_384,
  maxSourceBytes: 8_192,
};

function jsonResponse(body: unknown, headers?: HeadersInit): Response {
  return Response.json(body, headers ? { headers } : undefined);
}

async function withFetcher(
  fetcher: (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void test("scrape returns a full-page Markdown snapshot and requests fresh Markdown only", async () => {
  await withFetcher(
    (request, init) => {
      assert.equal(request, "https://api.firecrawl.dev/v2/scrape");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
      assert.equal(init?.redirect, "error");
      const requestBody = init?.body;
      assert.equal(typeof requestBody, "string");
      assert.deepEqual(JSON.parse(requestBody as string), {
        url: input.url,
        formats: ["markdown"],
        onlyMainContent: true,
        maxAge: 0,
        parsers: [],
        timeout: input.timeoutMs,
      });

      return Promise.resolve(
        jsonResponse(
          {
            success: true,
            data: {
              markdown: "# Research snapshot\n\nPrimary source text.",
              metadata: {
                url: "https://example.org/final?edition=2",
                sourceURL: input.url,
                contentType: "text/html; charset=utf-8",
                statusCode: 200,
                scrapeId: "scrape-123",
                provider: { creditsCost: 4 },
              },
            },
          },
          { "x-request-id": "request-123" },
        ),
      );
    },
    async () => {
      const result = await scrape(input);

      assert.equal(result.ok, true);

      if (!result.ok) {
        return;
      }

      assert.equal(result.source.requestedUrl, input.url);
      assert.equal(result.source.url, "https://example.org/final?edition=2");
      assert.equal(result.source.text, "# Research snapshot\n\nPrimary source text.");
      assert.equal(result.creditsUsed, 4);
      assert.equal(result.providerRequestId, "request-123");
      assert.match(result.source.digest, /^[a-f0-9]{64}$/);
    },
  );
});

void test("scrape rejects unsafe URLs before making a provider request", async () => {
  let called = false;

  await withFetcher(
    () => {
      called = true;
      return Promise.resolve(jsonResponse({}));
    },
    async () => {
      const result = await scrape({ ...input, url: "http://127.0.0.1/private" });
      assert.deepEqual(result, { ok: false, failure: "invalid_input", creditsUsed: null });
    },
  );

  assert.equal(called, false);
});

void test("malformed and oversized responses fail closed without inventing usage", async () => {
  await withFetcher(
    () =>
      Promise.resolve(new Response("{not-json", { headers: { "x-request-id": "malformed-1" } })),
    async () => {
      assert.deepEqual(await scrape(input), {
        ok: false,
        failure: "invalid_response",
        creditsUsed: null,
        providerRequestId: "malformed-1",
      });
    },
  );

  await withFetcher(
    () =>
      Promise.resolve(
        new Response("x".repeat(100), {
          headers: { "content-length": "100", "x-request-id": "large-1" },
        }),
      ),
    async () => {
      const result = await scrape({ ...input, maxResponseBytes: 32 });
      assert.deepEqual(result, {
        ok: false,
        failure: "response_too_large",
        creditsUsed: null,
        providerRequestId: "large-1",
      });
    },
  );
});

void test("invalid response content preserves documented provider usage", async () => {
  await withFetcher(
    () =>
      Promise.resolve(
        jsonResponse(
          {
            success: true,
            data: {
              markdown: 17,
              metadata: {
                url: "https://example.org/final",
                provider: { creditsCost: 6 },
              },
            },
          },
          { "x-request-id": "schema-invalid-1" },
        ),
      ),
    async () => {
      assert.deepEqual(await scrape(input), {
        ok: false,
        failure: "invalid_response",
        creditsUsed: 6,
        providerRequestId: "schema-invalid-1",
      });
    },
  );
});

void test("sourceURL alone does not masquerade as a final URL", async () => {
  await withFetcher(
    () =>
      Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            markdown: "# Source body",
            metadata: {
              sourceURL: input.url,
              contentType: "text/html",
              provider: { creditsCost: 2 },
            },
          },
        }),
      ),
    async () => {
      assert.deepEqual(await scrape(input), {
        ok: false,
        failure: "final_url_unknown",
        creditsUsed: 2,
      });
    },
  );
});

void test("missing documented charge remains unknown instead of inferring a scrape price", async () => {
  await withFetcher(
    () =>
      Promise.resolve(
        jsonResponse({
          success: true,
          // The official ScrapeResponse schema does not define top-level creditsUsed.
          creditsUsed: 99,
          data: {
            markdown: "# Full page",
            metadata: {
              url: "https://example.org/final",
              contentType: "text/html",
              statusCode: 200,
            },
          },
        }),
      ),
    async () => {
      const result = await scrape(input);
      assert.equal(result.ok, true);
      assert.equal(result.creditsUsed, null);
    },
  );
});

void test("unusable content preserves authoritative provider usage and request id", async () => {
  await withFetcher(
    () =>
      Promise.resolve(
        jsonResponse(
          {
            success: true,
            data: {
              markdown: "",
              metadata: {
                contentType: "text/html",
                scrapeId: "charged-scrape",
                provider: { creditsCost: 7 },
              },
            },
          },
          { "x-request-id": "charged-request" },
        ),
      ),
    async () => {
      assert.deepEqual(await scrape(input), {
        ok: false,
        failure: "empty_markdown",
        creditsUsed: 7,
        providerRequestId: "charged-request",
      });
    },
  );
});

void test("non-Markdown source formats fail while retaining returned usage", async () => {
  await withFetcher(
    () =>
      Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            markdown: "# Parsed document",
            metadata: {
              contentType: "application/pdf",
              scrapeId: "pdf-scrape",
              provider: { creditsCost: 3 },
            },
          },
        }),
      ),
    async () => {
      assert.deepEqual(await scrape(input), {
        ok: false,
        failure: "unsupported_content",
        creditsUsed: 3,
        providerRequestId: "pdf-scrape",
      });
    },
  );
});

void test("non-success page status fails while retaining returned usage", async () => {
  await withFetcher(
    () =>
      Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            markdown: "# Not found",
            metadata: {
              contentType: "text/html",
              statusCode: 404,
              scrapeId: "missing-page",
              provider: { creditsCost: 2 },
            },
          },
        }),
      ),
    async () => {
      assert.deepEqual(await scrape(input), {
        ok: false,
        failure: "source_status_failed",
        creditsUsed: 2,
        providerRequestId: "missing-page",
      });
    },
  );
});
