import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath, URL } from "node:url";

import { build } from "esbuild";
import { Miniflare, Response } from "miniflare";

let worker: Miniflare;
const outbound: string[] = [];

before(async () => {
  const bundle = await build({
    absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
    entryPoints: ["tests/worker/research-runtime.fixture.ts"],
    tsconfig: "tsconfig.worker-tests.json",
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd"],
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
  });
  assert.ok(bundle.outputFiles[0]);
  worker = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "research-runtime-test",
          compatibilityDate: "2026-11-13",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: bundle.outputFiles[0].text } },
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            handler(request) {
              outbound.push(request.url);
              return new Response(null, { status: 503 });
            },
          },
        },
      },
    ],
  });
});

after(async () => {
  await worker?.dispose();
  assert.deepEqual(outbound, [], "No live network/model request is permitted.");
});

void test("real Workers AI adapter preserves complete raw usage and makes one call", async () => {
  const response = await worker.dispatchFetch("https://app.test/extract");
  const result = (await response.json()) as { output: unknown; usage: unknown; calls: number };
  assert.equal(result.calls, 1);
  assert.deepEqual(result.output, { answer: "fixture-only" });
  assert.deepEqual(result.usage, { inputTokens: 13, outputTokens: 7 });
});

void test("missing/partial raw usage never becomes an authoritative zero receipt", async () => {
  for (const mode of ["missing", "partial"]) {
    const response = await worker.dispatchFetch(`https://app.test/extract?mode=${mode}`);
    const result = (await response.json()) as { usage: unknown; calls: number };
    assert.equal(result.calls, 1);
    assert.equal(result.usage, null);
  }
});

void test("model failures are not retried and invalid JSON retains complete usage", async () => {
  const failed = await (await worker.dispatchFetch("https://app.test/extract?mode=failure")).json();
  assert.deepEqual(failed, { failed: true, calls: 1 });
  const invalid = (await (
    await worker.dispatchFetch("https://app.test/extract?mode=invalid")
  ).json()) as {
    output: unknown;
    usage: unknown;
    calls: number;
  };
  assert.equal(invalid.output, "not JSON");
  assert.deepEqual(invalid.usage, { inputTokens: 13, outputTokens: 7 });
  assert.equal(invalid.calls, 1);
});

void test("provider calls require explicit current enablement, including the final raw binding boundary", async () => {
  for (const path of [
    "/guard",
    "/guard?flag=false",
    "/guard?flag=TRUE",
    "/guard?flag=1",
    "/guard?flag=true&mode=default-disabled",
    "/guard?flag=true&mode=disable-before-io",
  ]) {
    const result = await (await worker.dispatchFetch(`https://app.test${path}`)).json();
    assert.deepEqual(result, { failed: true, calls: 0 }, path);
  }
  const result = await (
    await worker.dispatchFetch("https://app.test/guard?flag=true&mode=disable-between-calls")
  ).json();
  assert.deepEqual(result, { failed: true, calls: 1 });
});

void test("disabled admission checks the current flag before any ledger/database access", async () => {
  for (const path of [
    "/admission-guard",
    "/admission-guard?flag=false",
    "/admission-guard?flag=TRUE",
    "/admission-guard?flag=true&mode=disable-after-construction",
  ]) {
    const result = await (await worker.dispatchFetch(`https://app.test${path}`)).json();
    assert.deepEqual(
      result,
      {
        failed: true,
        calls: 0,
        databaseTouches: 0,
        error: "Research inference is disabled.",
      },
      path,
    );
  }
});

void test("runtime enablement does not replace the accepted extraction's pinned model", async () => {
  const result = (await (
    await worker.dispatchFetch("https://app.test/guard?flag=true&mode=pinned-model")
  ).json()) as { calls: number; models: string[] };
  assert.equal(result.calls, 1);
  assert.deepEqual(result.models, ["@cf/test/extraction"]);
});

void test("Workflow IDs distinguish workspace and retry generations and remain stable", async () => {
  const result = (await (await worker.dispatchFetch("https://app.test/identity")).json()) as {
    first: string;
    replay: string;
    otherScope: string;
    retry: string;
  };
  assert.equal(result.first, result.replay);
  assert.notEqual(result.first, result.otherScope);
  assert.notEqual(result.first, result.retry);
  assert.ok(result.first.length <= 100);
});

void test("bounded HTTP parser accepts UTF-8/chunks and rejects ambiguous or interrupted framing", async () => {
  const parse = async (body: string) =>
    worker.dispatchFetch("https://app.test/http", { method: "POST", body });
  const text = "Ada — researcher";
  const bytes = new TextEncoder().encode(text).length;
  const valid = await parse(
    `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${bytes}\r\n\r\n${text}`,
  );
  assert.deepEqual(await valid.json(), { status: 200, text });
  const chunked = await parse(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nAda\r\n0\r\n\r\n",
  );
  assert.deepEqual(await chunked.json(), { status: 200, text: "Ada" });
  for (const body of [
    "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nAda",
    "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Length: 3\r\n\r\nAda",
    "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\nAda",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nAda\r\n0\r\n",
    "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\nAda",
  ])
    assert.equal((await parse(body)).status, 400);
});
