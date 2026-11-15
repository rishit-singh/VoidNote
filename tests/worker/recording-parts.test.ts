import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

void test("320 MiB chunked upload resumes, verifies the complete hash and cleans staging parts", async (t) => {
  const bundle = await build({
    entryPoints: ["tests/worker/recording-parts.fixture.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["node:*"],
    target: "es2022",
  });
  const contents = bundle.outputFiles[0]?.text;
  assert.ok(contents);
  const mf = new Miniflare({
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "recording-parts-test",
          compatibilityDate: "2026-11-13",
          compatibilityFlags: ["nodejs_compat"],
          env: { BUCKET: { type: "r2", name: "parts-test" } },
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents } },
          },
        },
      },
    ],
  });
  t.after(() => mf.dispose());
  const part = Buffer.alloc(8 * 1024 * 1024, 37);
  const tail = Buffer.alloc(123, 19);
  const hash = createHash("sha256");
  for (let index = 0; index < 40; index++) hash.update(part);
  hash.update(tail);
  const sha256 = hash.digest("hex");
  const bytes = part.length * 40 + tail.length;
  const headers = { "x-total-bytes": String(bytes), "x-total-sha256": sha256 };
  const send = (
    index: number,
    data = part,
    checksum = createHash("sha256").update(data).digest("hex"),
  ) =>
    mf.dispatchFetch(`https://test/?part=${index}`, {
      method: "PUT",
      headers: { ...headers, "x-content-sha256": checksum },
      body: data,
    });
  assert.equal((await send(0, part, "0".repeat(64))).status, 409);
  assert.equal((await send(41)).status, 409);
  assert.equal((await send(0)).status, 200);
  assert.equal((await send(0)).status, 200); // Exact replay.
  assert.equal((await send(0, part, "f".repeat(64))).status, 409);
  assert.equal((await mf.dispatchFetch("https://test/", { method: "POST", headers })).status, 409);
  const resumed = await mf.dispatchFetch("https://test/", { headers });
  assert.deepEqual(await resumed.json(), {
    ready: false,
    parts: [{ index: 0, sha256: createHash("sha256").update(part).digest("hex") }],
  });
  for (let index = 1; index < 40; index++) assert.equal((await send(index)).status, 200);
  assert.equal((await send(40, tail)).status, 200);
  const complete = await mf.dispatchFetch("https://test/", { method: "POST", headers });
  assert.equal(complete.status, 200);
  assert.deepEqual(await complete.json(), { size: bytes, sha256 });
  assert.equal((await mf.dispatchFetch("https://test/", { method: "POST", headers })).status, 200);
  assert.equal(await (await mf.dispatchFetch("https://test/parts", { headers })).json(), 0);
  const downloaded = await mf.dispatchFetch("https://test/download", { headers });
  assert.ok(downloaded.body);
  const actual = createHash("sha256");
  for await (const chunk of downloaded.body) {
    assert.ok(chunk instanceof Uint8Array);
    actual.update(chunk);
  }
  assert.equal(actual.digest("hex"), sha256);
});
