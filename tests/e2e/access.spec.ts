import { expect, test } from "@playwright/test";

const workspace = "11111111-1111-4111-8111-111111111111";

test("built RPC transport rejects unauthenticated reads and foreign-origin writes", async ({
  request,
}) => {
  const read = await request.get("/api/workspace.session");
  expect([401, 503]).toContain(read.status());
  expect(read.headers()["cache-control"]).toBe("private, no-store");
  expect(await read.json()).toMatchObject({
    error: { data: { domainCode: expect.stringMatching(/^(unauthorized|auth_not_configured)$/) } },
  });
  const write = await request.post("/api/notes.save", {
    headers: { Origin: "https://foreign.example" },
    data: {},
  });
  expect(write.status()).toBe(403);
  expect(write.headers()["cache-control"]).toBe("private, no-store");
});

test("RPC mount preserves dedicated routes and retires its old prefix", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expect((await request.get("/api/trpc/workspace.session")).status()).toBe(404);
  const wrongMethod = await request.get("/api/notes.save");
  expect(wrongMethod.status()).toBe(405);
  expect((await request.put("/api/workspace.session", { data: {} })).status()).toBe(405);
  const unknown = await request.get("/api/unknown.procedure");
  expect(unknown.status()).toBe(404);
  expect(await unknown.json()).toMatchObject({ error: { data: { code: "NOT_FOUND" } } });
});

test("server routes require a verified session before database or provider work", async ({
  request,
}) => {
  const responses = await Promise.all([
    request.get("/api/session"),
    request.get(`/api/workspaces/${workspace}/notes`),
    request.get(`/api/workspaces/${workspace}/people`),
  ]);
  for (const response of responses) {
    // An unconfigured local auth service is deliberately closed too.
    expect([401, 503]).toContain(response.status());
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      code: expect.stringMatching(/^(unauthorized|auth_not_configured)$/),
    });
  }
});

test("workspace mutations reject a foreign browser origin before accepting a command", async ({
  request,
}) => {
  const response = await request.post(`/api/workspaces/${workspace}/notes`, {
    headers: { Origin: "https://foreign.example" },
    data: {},
  });
  expect(response.status()).toBe(403);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
});
