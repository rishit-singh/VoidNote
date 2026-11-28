import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath, URL } from "node:url";

import { build } from "esbuild";
import { Miniflare, Response } from "miniflare";

let worker: Miniflare;
let mode: "answer" | "redirect" | "failure" = "answer";
const requests: string[] = [];

before(async () => {
  const bundle = await build({
    absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
    entryPoints: ["tests/worker/research-transport.fixture.ts"],
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
          name: "research-transport-test",
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
              requests.push(request.url);
              if (mode === "redirect") {
                return new Response(null, {
                  status: 302,
                  headers: { location: "https://untrusted-resolver.invalid/" },
                });
              }
              if (mode === "failure") return new Response(null, { status: 503 });
              return Response.json({
                Status: 0,
                Answer: [
                  { type: 5, data: "alias.example.org" },
                  { type: 1, data: "93.184.215.14" },
                ],
              });
            },
          },
        },
      },
    ],
  });
});

after(async () => {
  await worker?.dispose();
});

void test("workerd DNS request reaches the trusted resolver with manual redirects", async () => {
  mode = "answer";
  requests.length = 0;
  const response = await worker.dispatchFetch("http://localhost/");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { addresses: ["93.184.215.14"] });
  assert.deepEqual(requests, [
    "https://cloudflare-dns.com/dns-query?name=simonwillison.net&type=A",
  ]);
});

void test("DNS redirects fail closed without following the replacement endpoint", async () => {
  mode = "redirect";
  requests.length = 0;
  const response = await worker.dispatchFetch("http://localhost/");
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "Public source DNS lookup failed." });
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]!).hostname, "cloudflare-dns.com");
});

void test("non-success DNS response fails before returning addresses", async () => {
  mode = "failure";
  requests.length = 0;
  const response = await worker.dispatchFetch("http://localhost/");
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "Public source DNS lookup failed." });
  assert.equal(requests.length, 1);
});

void test("pinned-IP retrieval rejects prohibited destinations without an unpinned fallback", async () => {
  requests.length = 0;
  const response = await worker.dispatchFetch("http://localhost/pinned-request");
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Unvalidated source address.",
  });
  assert.deepEqual(requests, [], "No unpinned fetch fallback is allowed.");
});

void test("pinned transport rejects response limits above the global cap before connecting", async () => {
  const response = await worker.dispatchFetch("http://localhost/oversized-limit");
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Source response byte limit is invalid.",
  });
});
