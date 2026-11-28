import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { before, test, type TestContext } from "node:test";
import { fileURLToPath, URL } from "node:url";

import { build } from "esbuild";
import { Miniflare, type Request, Response, type WebSocket } from "miniflare";
import { z } from "zod";

import {
  ASSISTANT_OUTPUT_LEASE_MS,
  ASSISTANT_OUTPUT_PROTOCOL,
} from "../../src/contracts/assistant/output.ts";

const origin = "https://app.test";
const scope = {
  workspaceId: "10000000-0000-4000-8000-000000000001",
  threadId: "10000000-0000-4000-8000-000000000002",
  turnId: "10000000-0000-4000-8000-000000000003",
};
const ticket = "a".repeat(64);
const endpoint = `${origin}/api/assistant/output?${new URLSearchParams(scope).toString()}`;
let script: string;

before(async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
    entryPoints: ["tests/worker/assistant-output-bridge.fixture.ts"],
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

const eventSchema = z.object({
  type: z.enum(["rpc", "cancel"]),
  caseId: z.string(),
  name: z.string().optional(),
  input: z.unknown().optional(),
});
type FixtureEvent = z.infer<typeof eventSchema>;

function fixture(t: TestContext) {
  const events: FixtureEvent[] = [];
  const cancelled = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const unexpected: string[] = [];
  const deadlineRegistered = Promise.withResolvers<unknown>();
  const releaseDeadline = Promise.withResolvers<void>();

  function cancellation(caseId: string) {
    let entry = cancelled.get(caseId);
    if (!entry) {
      entry = Promise.withResolvers<void>();
      cancelled.set(caseId, entry);
    }
    return entry;
  }

  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "assistant-output-bridge-test",
          compatibilityDate: "2026-11-13",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: script } },
          },
          env: { APP_URL: { type: "text", value: origin } },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            async handler(request: Request): Promise<Response> {
              if (request.url === "https://output-bridge-fixture.test/deadline") {
                deadlineRegistered.resolve(await request.json());
                await releaseDeadline.promise;
                return Response.json(null);
              }
              if (request.url !== "https://output-bridge-fixture.test/event") {
                unexpected.push(request.url);
                return new Response("Unexpected external call.", { status: 502 });
              }
              const event = eventSchema.parse(await request.json());
              events.push(event);
              if (event.type === "cancel") cancellation(event.caseId).resolve();
              return Response.json(null);
            },
          },
        },
      },
    ],
  });
  t.after(async () => {
    releaseDeadline.resolve();
    await mf.dispose();
    assert.deepEqual(unexpected, []);
  });

  return {
    events,
    cancelled: (caseId: string) => cancellation(caseId).promise,
    request(
      caseId: string,
      options: {
        url?: string;
        method?: string;
        headers?: Record<string, string | null>;
        chunks?: string[];
        mode?: string;
      } = {},
    ) {
      const headers: Record<string, string> = {
        upgrade: "websocket",
        origin,
        "sec-websocket-protocol": `${ASSISTANT_OUTPUT_PROTOCOL}, ${ticket}`,
        "x-fixture-case": caseId,
        "x-fixture-mode": options.mode ?? "hold",
        "x-fixture-chunks": encodeURIComponent(JSON.stringify(options.chunks ?? [])),
      };
      if (options.method) headers["x-fixture-method"] = options.method;
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        if (value === null) delete headers[name];
        else headers[name] = value;
      }
      return mf.dispatchFetch(options.url ?? endpoint, {
        headers,
      });
    },
    async expire() {
      const registration = await deadlineRegistered.promise;
      releaseDeadline.resolve();
      return registration;
    },
  };
}

function listen(socket: WebSocket) {
  const messages: unknown[] = [];
  const closed = Promise.withResolvers<{ code: number; reason: string }>();
  socket.addEventListener("message", (event) => {
    assert.equal(typeof event.data, "string");
    messages.push(JSON.parse(event.data as string) as unknown);
  });
  socket.addEventListener("close", (event) => {
    closed.resolve({ code: event.code, reason: event.reason });
  });
  socket.accept();
  return { messages, closed: closed.promise };
}

void test(
  "upgrade, origin, query scope, protocol and ticket denials occur before RPC",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t);
    const cases: Array<{
      name: string;
      status: number;
      options: Parameters<typeof worker.request>[1];
    }> = [
      { name: "method", status: 426, options: { method: "POST" } },
      { name: "upgrade", status: 426, options: { headers: { upgrade: null } } },
      { name: "missing-origin", status: 403, options: { headers: { origin: null } } },
      { name: "opaque-origin", status: 403, options: { headers: { origin: "null" } } },
      {
        name: "foreign-origin",
        status: 403,
        options: { headers: { origin: "https://foreign.test" } },
      },
      {
        name: "wrong-app-origin",
        status: 403,
        options: { headers: { "x-fixture-app-url": "https://other.test" } },
      },
      {
        name: "invalid-app-url",
        status: 503,
        options: { headers: { "x-fixture-app-url": "not-a-url" } },
      },
      {
        name: "wrong-request-origin",
        status: 403,
        options: { url: endpoint.replace(origin, "https://other.test") },
      },
      { name: "cross-site", status: 403, options: { headers: { "sec-fetch-site": "cross-site" } } },
      { name: "extra-query", status: 400, options: { url: `${endpoint}&extra=1` } },
      { name: "ticket-in-url", status: 400, options: { url: `${endpoint}&ticket=${ticket}` } },
      {
        name: "missing-scope",
        status: 400,
        options: { url: `${origin}/api/assistant/output?workspaceId=${scope.workspaceId}` },
      },
      {
        name: "invalid-scope",
        status: 400,
        options: { url: endpoint.replace(scope.turnId, "not-a-uuid") },
      },
      {
        name: "missing-protocol",
        status: 400,
        options: { headers: { "sec-websocket-protocol": null } },
      },
      {
        name: "native-protocol",
        status: 400,
        options: { headers: { "sec-websocket-protocol": `agents, ${ticket}` } },
      },
      {
        name: "missing-ticket",
        status: 400,
        options: { headers: { "sec-websocket-protocol": ASSISTANT_OUTPUT_PROTOCOL } },
      },
      {
        name: "reversed-protocols",
        status: 400,
        options: {
          headers: { "sec-websocket-protocol": `${ticket}, ${ASSISTANT_OUTPUT_PROTOCOL}` },
        },
      },
      {
        name: "extra-protocol",
        status: 400,
        options: {
          headers: { "sec-websocket-protocol": `${ASSISTANT_OUTPUT_PROTOCOL}, ${ticket}, extra` },
        },
      },
      {
        name: "short-ticket",
        status: 400,
        options: { headers: { "sec-websocket-protocol": `${ASSISTANT_OUTPUT_PROTOCOL}, abc` } },
      },
      {
        name: "non-hex-ticket",
        status: 400,
        options: {
          headers: { "sec-websocket-protocol": `${ASSISTANT_OUTPUT_PROTOCOL}, ${"g".repeat(64)}` },
        },
      },
      {
        name: "uppercase-ticket",
        status: 400,
        options: {
          headers: { "sec-websocket-protocol": `${ASSISTANT_OUTPUT_PROTOCOL}, ${"A".repeat(64)}` },
        },
      },
    ];

    for (const item of cases) {
      const response = await worker.request(item.name, item.options);
      assert.equal(response.status, item.status, item.name);
      assert.equal(response.webSocket, null, item.name);
      assert.ok(!(await response.text()).includes(ticket), item.name);
    }
    assert.deepEqual(worker.events, []);
  },
);

void test(
  "only scoped text snapshots and terminal frames cross the negotiated read-only socket",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t);
    const snapshot = { type: "snapshot", turnId: scope.turnId, text: "Hello 私人" };
    const terminal = { type: "terminal", turnId: scope.turnId, status: "succeeded" };
    const line = JSON.stringify(snapshot);
    const response = await worker.request("valid", {
      mode: "finite",
      headers: { "x-fixture-app-url": `${origin}/configured/base` },
      chunks: [line.slice(0, 12), `${line.slice(12)}\n\n${JSON.stringify(terminal)}\n`],
    });
    assert.equal(response.status, 101);
    assert.equal(response.headers.get("sec-websocket-protocol"), ASSISTANT_OUTPUT_PROTOCOL);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.ok(![...response.headers.values()].some((value) => value.includes(ticket)));
    assert.ok(response.webSocket);
    const socket = listen(response.webSocket);
    assert.equal((await socket.closed).code, 1000);
    assert.deepEqual(socket.messages, [snapshot, terminal]);
    assert.deepEqual(worker.events, [
      {
        type: "rpc",
        caseId: "valid",
        name: `assistant-${scope.workspaceId}-${scope.threadId}`,
        input: { ...scope, ticket },
      },
    ]);
  },
);

void test(
  "mismatched, native, non-text and oversized upstream frames close and cancel without forwarding",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t);
    const cases = [
      {
        name: "scope-mismatch",
        frame: { type: "snapshot", turnId: scope.threadId, text: "private" },
      },
      { name: "native-state", frame: { type: "cf_agent_state", state: { private: true } } },
      {
        name: "extra-fields",
        frame: { type: "snapshot", turnId: scope.turnId, text: "answer", tools: ["private-tool"] },
      },
      {
        name: "non-text",
        frame: { type: "snapshot", turnId: scope.turnId, text: { secret: true } },
      },
      {
        name: "non-terminal",
        frame: { type: "terminal", turnId: scope.turnId, status: "running" },
      },
      { name: "malformed-json", chunks: ["{not-json}\n"] },
      { name: "oversized-chunk", mode: "oversized-chunk" },
      { name: "oversized-pending", mode: "oversized-pending" },
      { name: "overlong-text", mode: "overlong-text" },
    ];

    for (const item of cases) {
      const response = await worker.request(item.name, {
        mode: item.mode ?? "hold",
        chunks:
          item.chunks ?? (item.frame === undefined ? [] : [`${JSON.stringify(item.frame)}\n`]),
      });
      assert.equal(response.status, 101, item.name);
      assert.ok(response.webSocket);
      const socket = listen(response.webSocket);
      assert.equal((await socket.closed).code, 1011, item.name);
      await worker.cancelled(item.name);
      assert.deepEqual(socket.messages, [], item.name);
      assert.equal(
        worker.events.filter((event) => event.caseId === item.name && event.type === "cancel")
          .length,
        1,
      );
    }
  },
);

void test(
  "terminal output closes and cancels without forwarding later snapshots",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t);
    const terminal = { type: "terminal", turnId: scope.turnId, status: "cancelled" };
    const response = await worker.request("terminal-fence", {
      chunks: [
        `${JSON.stringify(terminal)}\n${JSON.stringify({
          type: "snapshot",
          turnId: scope.turnId,
          text: "Must not arrive after termination.",
        })}\n`,
      ],
    });
    assert.ok(response.webSocket);
    const socket = listen(response.webSocket);
    assert.equal((await socket.closed).code, 1000);
    await worker.cancelled("terminal-fence");
    assert.deepEqual(socket.messages, [terminal]);
  },
);

void test(
  "cumulative lease output is bounded even when every individual snapshot is valid",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t);
    const response = await worker.request("lease-budget", { mode: "lease-budget" });
    assert.ok(response.webSocket);
    const socket = listen(response.webSocket);
    assert.equal((await socket.closed).code, 1011);
    await worker.cancelled("lease-budget");
    assert.ok(socket.messages.length > 1 && socket.messages.length < 40);
    const sizes = socket.messages.map((message) => Buffer.byteLength(JSON.stringify(message)));
    const bytes = sizes.reduce((total, size) => total + size, 0);
    assert.ok(bytes <= 2_000_000, "no frame may exceed the cumulative lease budget");
    assert.ok(bytes + sizes[0]! > 2_000_000, "the next complete frame would exceed the budget");
  },
);

void test(
  "native client protocol messages close the output-only connection and cancel its reader",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t);
    const response = await worker.request("client-write");
    assert.ok(response.webSocket);
    const socket = listen(response.webSocket);
    response.webSocket.send(
      JSON.stringify({ type: "cf_agent_chat_request", id: "new-turn", body: { messages: [] } }),
    );
    assert.equal((await socket.closed).code, 1008);
    await worker.cancelled("client-write");
    assert.deepEqual(socket.messages, []);
    assert.equal(worker.events.filter((event) => event.type === "rpc").length, 1);
  },
);

void test("client disconnect cancels a blocked upstream reader", { timeout: 10_000 }, async (t) => {
  const worker = fixture(t);
  const disconnected = await worker.request("disconnect");
  assert.ok(disconnected.webSocket);
  listen(disconnected.webSocket);
  disconnected.webSocket.close(1000, "Client left.");
  await worker.cancelled("disconnect");
  assert.equal(worker.events.filter((event) => event.type === "cancel").length, 1);
});

void test(
  "the registered lease deadline cancels a blocked upstream reader",
  { timeout: 10_000 },
  async (t) => {
    const worker = fixture(t);
    const expiring = await worker.request("deadline", { mode: "manual-deadline" });
    assert.ok(expiring.webSocket);
    const second = listen(expiring.webSocket);
    assert.deepEqual(await worker.expire(), {
      caseId: "deadline",
      delay: ASSISTANT_OUTPUT_LEASE_MS,
    });
    assert.equal((await second.closed).code, 1000);
    await worker.cancelled("deadline");
    assert.deepEqual(second.messages, []);
  },
);

void test(
  "RPC rejection returns a generic denial without reflecting ticket or exception details",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t);
    const response = await worker.request("rpc-rejected", { mode: "reject" });
    assert.equal(response.status, 403);
    assert.equal(response.webSocket, null);
    assert.equal(await response.text(), "Output subscription unavailable.");
    assert.equal(worker.events.filter((event) => event.type === "rpc").length, 1);
  },
);
