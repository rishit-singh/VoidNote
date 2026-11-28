import assert from "node:assert/strict";
import { before, test, type TestContext } from "node:test";
import { fileURLToPath, URL } from "node:url";

import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { z } from "zod";

const ACTIVITY_PROTOCOL = "voidnote.activity.v1";
const origin = "https://activity.test";
const workspaceId = "10000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000002";
const otherUser = "10000000-0000-4000-8000-000000000003";
let script: string;

before(async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
    entryPoints: ["tests/worker/activity-hub.fixture.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["node:*", "cloudflare:*"],
    target: "es2022",
  });
  script = result.outputFiles[0]!.text;
});

function fixture(t: TestContext) {
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "activity-hub-test",
          compatibilityDate: "2026-11-13",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: script } },
          },
          exports: { ActivityHub: { type: "durable-object", storage: "sqlite" } },
          env: {
            APP_URL: { type: "text", value: origin },
            ACTIVITY_HUB: {
              type: "durable-object",
              worker: "activity-hub-test",
              exportName: "ActivityHub",
            },
          },
        },
      },
    ],
  });
  t.after(() => mf.dispose());
  function url(path: string, user = userId) {
    return `${origin}${path}?${new URLSearchParams({ workspaceId, userId: user }).toString()}`;
  }
  return {
    async ticket() {
      const result = await mf.dispatchFetch(url("/ticket"));
      assert.equal(result.status, 200);
      return z.object({ ticket: z.string(), expiresAt: z.number() }).parse(await result.json());
    },
    open(ticket: string, options: { user?: string; origin?: string; extraQuery?: string } = {}) {
      return mf.dispatchFetch(
        url("/api/activity/output", options.user) + (options.extraQuery ?? ""),
        {
          headers: {
            upgrade: "websocket",
            origin: options.origin ?? origin,
            "sec-websocket-protocol": `${ACTIVITY_PROTOCOL}, ${ticket}`,
          },
        },
      );
    },
    publish: () => mf.dispatchFetch(url("/publish")),
  };
}

void test(
  "activity ticket is single-use and bound to recipient scope",
  { timeout: 20_000 },
  async (t) => {
    const app = fixture(t);
    const { ticket } = await app.ticket();
    assert.equal((await app.open(ticket, { user: otherUser })).status, 403);
    const response = await app.open(ticket);
    assert.equal(response.status, 101);
    assert.equal(response.headers.get("sec-websocket-protocol"), ACTIVITY_PROTOCOL);
    assert.ok(response.webSocket);
    response.webSocket.accept();
    assert.equal((await app.open(ticket)).status, 403);
    response.webSocket.close(1000);
  },
);

void test(
  "activity bridge rejects cross-origin and URL credentials without consuming ticket",
  { timeout: 20_000 },
  async (t) => {
    const app = fixture(t);
    const { ticket } = await app.ticket();
    assert.equal((await app.open(ticket, { origin: "https://other.test" })).status, 403);
    assert.equal((await app.open(ticket, { extraQuery: `&ticket=${ticket}` })).status, 400);
    const accepted = await app.open(ticket);
    assert.equal(accepted.status, 101);
    accepted.webSocket!.accept();
    accepted.webSocket!.close(1000);
  },
);

void test(
  "activity socket exposes wakeups only and refuses client commands",
  { timeout: 20_000 },
  async (t) => {
    const app = fixture(t);
    const { ticket } = await app.ticket();
    const response = await app.open(ticket);
    assert.ok(response.webSocket);
    const socket = response.webSocket;
    const message = Promise.withResolvers<unknown>();
    const closed = Promise.withResolvers<number>();
    socket.addEventListener("message", (event) => message.resolve(event.data));
    socket.addEventListener("close", (event) => closed.resolve(event.code));
    socket.accept();
    assert.equal((await app.publish()).status, 200);
    assert.deepEqual(JSON.parse(String(await message.promise)), { type: "changed" });
    socket.send('{"command":"start-inference"}');
    assert.equal(await closed.promise, 1008);
  },
);
