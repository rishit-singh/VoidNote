import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { before, test, type TestContext } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response, type Request } from "miniflare";
import { z } from "zod";

import { assistantPolicySchema } from "../../src/config/assistant.ts";
import {
  assistantOutputFrameSchema,
  assistantOutputLeaseSchema,
  type AssistantOutputFrame,
} from "../../src/contracts/assistant/output.ts";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const threadId = "10000000-0000-4000-8000-000000000002";
const turnId = "10000000-0000-4000-8000-000000000003";
const otherId = "10000000-0000-4000-8000-000000000004";
const policy = assistantPolicySchema.parse({
  version: "assistant-v1",
  skillVersion: "assistant-skills-v1",
  model: "@cf/fixture/local-only",
  budgetId: "10000000-0000-4000-8000-000000000005",
  rateVersionId: "10000000-0000-4000-8000-000000000006",
  timeoutMs: 60_000,
});
let script: string;

before(async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
    entryPoints: ["tests/worker/assistant-output.fixture.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    mainFields: ["browser", "module", "main"],
    conditions: ["workerd", "react-server"],
    external: ["node:*", "cloudflare:*"],
    target: "es2022",
    plugins: [
      {
        name: "node-builtins",
        setup(builder) {
          builder.onResolve({ filter: /^[a-z_]+$/ }, (args) =>
            builtinModules.includes(args.path)
              ? { path: `node:${args.path}`, external: true }
              : undefined,
          );
        },
      },
    ],
  });
  assert.ok(result.outputFiles[0]);
  script = result.outputFiles[0].text;
});

function fixture(t: TestContext, options: { rejectPublication?: boolean } = {}) {
  let status = "queued";
  let actorId = workspaceId;
  let executionUnavailable = false;
  let exportOutage = false;
  let modelCalls = 0;
  let admissions = 0;
  let completionCalls = 0;
  let executionCalls = 0;
  let modelController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const modelStarted = Promise.withResolvers<void>();
  const published = Promise.withResolvers<void>();
  const attemptedPublication = Promise.withResolvers<void>();
  const firstOutputCheck = Promise.withResolvers<void>();
  const unexpected: string[] = [];

  async function outbound(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== "https://assistant-service.test") {
      unexpected.push(request.url);

      return new Response("Unexpected request", { status: 502 });
    }
    if (url.pathname === "/model") {
      modelCalls++;

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            modelController = controller;
            modelStarted.resolve();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    const args = z.array(z.unknown()).parse(await request.json());
    switch (url.pathname) {
      case "/execution":
        executionCalls++;
        if (executionCalls === 3) firstOutputCheck.resolve();
        if (executionUnavailable) return new Response("Revoked", { status: 403 });

        return Response.json({
          principal: { id: actorId, email: null },
          thread: {
            id: threadId,
            noteId: null,
            title: "Output test",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
          turn: {
            id: turnId,
            threadId,
            status,
            error: null,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
          text: "Hello",
          policy,
        });
      case "/beginTurn":
        status = "running";

        return Response.json(true);
      case "/history":
        return Response.json([]);
      case "/authorize":
        return Response.json(null);
      case "/isCancelled":
        return Response.json(status === "cancelled");
      case "/admitModelRequest":
        admissions++;

        return Response.json(null);
      case "/completeTurn":
        completionCalls++;
        attemptedPublication.resolve();
        if (exportOutage) return new Response("Unavailable", { status: 503 });
        if (options.rejectPublication) {
          return new Response("Source conflict", {
            status: 409,
            headers: { "x-fixture-error-code": "conflict" },
          });
        }
        status = "succeeded";
        published.resolve();

        return Response.json(null);
      case "/failTurn":
        if (status !== "cancelled") status = String(args[2]);
        published.resolve();

        return Response.json(null);
      case "/cancelTurn":
        status = "cancelled";
        published.resolve();

        return Response.json(null);
      default:
        unexpected.push(request.url);

        return new Response("Unexpected operation", { status: 502 });
    }
  }
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "assistant-output-test",
          compatibilityDate: "2026-11-13",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: script } },
          },
          exports: { AssistantAgent: { type: "durable-object", storage: "sqlite" } },
          env: {
            ASSISTANT_ENABLED: { type: "text", value: "true" },
            ASSISTANT_MODEL: { type: "text", value: policy.model },
            ASSISTANT_BUDGET_ID: { type: "text", value: policy.budgetId },
            ASSISTANT_RATE_VERSION_ID: { type: "text", value: policy.rateVersionId },
            ASSISTANT_AGENT: {
              type: "durable-object",
              worker: "assistant-output-test",
              exportName: "AssistantAgent",
            },
          },
        },
        dev: { outboundService: { type: "fetcher", handler: outbound } },
      },
    ],
  });
  t.after(async () => {
    await mf.dispose();
    assert.deepEqual(unexpected, []);
  });
  async function request(path: string, extra: Record<string, string> = {}) {
    const query = new URLSearchParams({ workspaceId, threadId, turnId, ...extra });

    return mf.dispatchFetch(`https://fixture.test${path}?${query.toString()}`);
  }
  async function lease() {
    const response = await request("/lease");
    assert.equal(response.status, 200);

    return assistantOutputLeaseSchema.parse(await response.json());
  }
  async function open(ticket?: string) {
    const response = await request("/output", { ticket: ticket ?? (await lease()).ticket });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    let buffer = "";
    const decoder = new TextDecoder();
    async function next(): Promise<AssistantOutputFrame | null> {
      while (!buffer.includes("\n")) {
        const result = await reader.read();
        if (result.done) return null;
        const value: unknown = result.value;
        assert.ok(value instanceof Uint8Array);
        buffer += decoder.decode(value, { stream: true });
      }
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);

      return assistantOutputFrameSchema.parse(JSON.parse(line));
    }

    return { next, cancel: () => reader.cancel() };
  }
  function send(delta: Record<string, unknown>) {
    assert.ok(modelController);
    modelController.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`),
    );
  }
  function finish() {
    assert.ok(modelController);
    modelController.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
      ),
    );
    modelController.close();
  }

  return {
    request,
    lease,
    open,
    send,
    finish,
    modelStarted: modelStarted.promise,
    published: published.promise,
    attemptedPublication: attemptedPublication.promise,
    firstOutputCheck: firstOutputCheck.promise,
    counts: () => ({ modelCalls, admissions, completionCalls, executionCalls }),
    changeActor: () => {
      actorId = otherId;
    },
    revoke: () => {
      executionUnavailable = true;
    },
    setOutage: (value: boolean) => {
      exportOutage = value;
    },
  };
}

void test(
  "output tickets reject wrong actor/thread/turn, malformed input and concurrent replay",
  { timeout: 15_000 },
  async (t) => {
    const worker = fixture(t);
    for (const extra of [{ actorId: otherId }, { threadId: otherId }, { turnId: otherId }]) {
      assert.equal((await worker.request("/lease", extra)).status, 403);
    }
    assert.equal((await worker.request("/output", { ticket: "invalid" })).status, 403);
    const lease = await worker.lease();
    const responses = await Promise.all([
      worker.request("/output", { ticket: lease.ticket }),
      worker.request("/output", { ticket: lease.ticket }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 403]);
    for (const response of responses) await response.body?.cancel();
    const otherLease = await worker.lease();
    assert.equal(
      (await worker.request("/output", { ticket: otherLease.ticket, turnId: otherId })).status,
      403,
    );
    assert.equal((await worker.request("/output", { ticket: otherLease.ticket })).status, 403);
    assert.equal(worker.counts().modelCalls, 0);
    assert.equal(worker.counts().admissions, 0);
  },
);

void test(
  "a connection before native submission streams text only and reconnect replays without inference",
  { timeout: 20_000 },
  async (t) => {
    const worker = fixture(t);
    const output = await worker.open();
    assert.equal((await worker.request("/start")).status, 200);
    await worker.modelStarted;
    worker.send({ reasoning_content: "PRIVATE reasoning" });
    worker.send({ content: "Hello" });
    assert.deepEqual(await output.next(), { type: "snapshot", turnId, text: "Hello" });
    await output.cancel();
    const reconnect = await worker.open();
    assert.deepEqual(await reconnect.next(), { type: "snapshot", turnId, text: "Hello" });
    worker.send({ content: " world" });
    assert.deepEqual(await reconnect.next(), { type: "snapshot", turnId, text: "Hello world" });
    worker.finish();
    await worker.published;
    assert.deepEqual(await reconnect.next(), { type: "terminal", turnId, status: "succeeded" });
    assert.equal(await reconnect.next(), null);
    const completed = await worker.open();
    assert.deepEqual(await completed.next(), { type: "snapshot", turnId, text: "Hello world" });
    assert.deepEqual(await completed.next(), { type: "terminal", turnId, status: "succeeded" });
    assert.equal(await completed.next(), null);
    assert.equal(worker.counts().modelCalls, 1);
    assert.equal(worker.counts().admissions, 1);
  },
);

void test(
  "late source rejection emits failed SQL status, never saved success",
  { timeout: 20_000 },
  async (t) => {
    const worker = fixture(t, { rejectPublication: true });
    const output = await worker.open();
    await worker.request("/start");
    await worker.modelStarted;
    worker.send({ content: "Provisional answer" });
    assert.deepEqual(await output.next(), { type: "snapshot", turnId, text: "Provisional answer" });
    worker.finish();
    await worker.published;
    assert.deepEqual(await output.next(), { type: "terminal", turnId, status: "failed" });
    assert.equal(await output.next(), null);
    const reconnect = await worker.open();
    assert.deepEqual(await reconnect.next(), { type: "terminal", turnId, status: "failed" });
    assert.equal(worker.counts().modelCalls, 1);
    assert.equal(worker.counts().completionCalls, 1);
  },
);

void test(
  "native cutover remains provisional during SQL outage and exports through the existing retry",
  { timeout: 20_000 },
  async (t) => {
    const worker = fixture(t);
    worker.setOutage(true);
    await worker.request("/start");
    await worker.modelStarted;
    worker.send({ content: "Unsaved reply" });
    worker.finish();
    await worker.attemptedPublication;
    const output = await worker.open();
    assert.deepEqual(await output.next(), { type: "snapshot", turnId, text: "Unsaved reply" });
    worker.setOutage(false);
    await worker.request("/export");
    await worker.published;
    assert.deepEqual(await output.next(), { type: "terminal", turnId, status: "succeeded" });
    assert.equal(worker.counts().modelCalls, 1);
  },
);

for (const change of ["changeActor", "revoke"] as const) {
  void test(
    `${change} closes an active reader before its next output batch`,
    { timeout: 20_000 },
    async (t) => {
      const worker = fixture(t);
      const output = await worker.open();
      await worker.request("/start");
      await worker.modelStarted;
      worker.send({ content: "Allowed" });
      assert.deepEqual(await output.next(), { type: "snapshot", turnId, text: "Allowed" });
      worker[change]();
      worker.send({ content: " must not be delivered" });
      assert.equal(await output.next(), null);
      worker.finish();
      assert.equal(worker.counts().modelCalls, 1);
    },
  );
}

void test(
  "pre-submission cancellation emits only persisted cancellation",
  { timeout: 15_000 },
  async (t) => {
    const worker = fixture(t);
    const output = await worker.open();
    await worker.request("/cancel");
    assert.deepEqual(await output.next(), { type: "terminal", turnId, status: "cancelled" });
    assert.equal(await output.next(), null);
    assert.equal(worker.counts().modelCalls, 0);
  },
);

void test(
  "installed native segment decoder filters raw tool/reasoning payloads and bounds text",
  { timeout: 15_000 },
  async (t) => {
    const worker = fixture(t);
    const decoded = await worker.request("/codec");
    assert.equal(decoded.status, 200);
    assert.deepEqual(await decoded.json(), { text: "First\nSecond", boundedLength: 64_000 });
    assert.equal(worker.counts().modelCalls, 0);
  },
);

void test(
  "idle authorization revocation closes without waiting for model output or lease expiry",
  { timeout: 12_000 },
  async (t) => {
    const worker = fixture(t);
    const output = await worker.open();
    await worker.firstOutputCheck;
    worker.revoke();
    assert.equal(await output.next(), null);
    assert.equal(worker.counts().modelCalls, 0);
  },
);

void test(
  "idle expiry closes at the 30-second lease deadline and expires unused tickets",
  { timeout: 40_000 },
  async (t) => {
    const worker = fixture(t);
    const unused = await worker.lease();
    const lease = await worker.lease();
    const output = await worker.open(lease.ticket);
    assert.equal(await output.next(), null);
    assert.ok(Date.now() >= Date.parse(lease.expiresAt) - 100);
    assert.equal((await worker.request("/output", { ticket: unused.ticket })).status, 403);
    assert.equal(worker.counts().modelCalls, 0);
    assert.ok(worker.counts().executionCalls < 15, "idle authorization must not rapidly poll SQL");
  },
);
