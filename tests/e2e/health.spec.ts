import { expect, test, type APIResponse } from "@playwright/test";

async function expectHealthyResponse(response: APIResponse): Promise<string> {
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers()["content-type"]).toContain("application/json");

  const requestId = response.headers()["x-request-id"] ?? "";
  expect(requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

  const body: unknown = await response.json();
  expect(body).toEqual({ status: "ok", requestId });

  return requestId;
}

test("concurrent health requests return independent, uncached request IDs", async ({ request }) => {
  // Identical URLs also catch accidentally cached responses or shared request state.
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => request.get("/api/health", { maxRedirects: 0 })),
  );
  const requestIds = await Promise.all(responses.map(expectHealthyResponse));

  expect(new Set(requestIds).size).toBe(responses.length);
});

test("health ignores caller request IDs and does not reflect query or header values", async ({
  request,
}) => {
  const suppliedRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const queryValue = "private-query-health-smoke";
  const headerValue = "private-header-health-smoke";

  const responses = await Promise.all(
    Array.from({ length: 2 }, () =>
      request.get("/api/health", {
        maxRedirects: 0,
        params: { note: queryValue, requestId: suppliedRequestId },
        headers: {
          "x-request-id": suppliedRequestId,
          "x-note-content": headerValue,
        },
      }),
    ),
  );
  const requestIds = await Promise.all(responses.map(expectHealthyResponse));

  expect(new Set(requestIds).size).toBe(responses.length);
  expect(requestIds).not.toContain(suppliedRequestId);

  for (const response of responses) {
    const body = await response.text();
    const headers = JSON.stringify(response.headers());

    for (const value of [suppliedRequestId, queryValue, headerValue]) {
      expect(body, "Health response bodies must not echo caller metadata").not.toContain(value);
      expect(headers, "Health response headers must not echo caller metadata").not.toContain(value);
    }
  }
});
