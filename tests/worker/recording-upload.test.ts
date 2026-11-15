import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

void test("R2 accepts reconstructed streams with exact lengths and rejects mismatches", async (t) => {
  const bundle = await build({
    entryPoints: ["tests/worker/recording-upload.fixture.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
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
          name: "recording-upload-test",
          compatibilityDate: "2026-11-13",
          env: { BUCKET: { type: "r2", name: "upload-test" } },
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents } },
          },
        },
      },
    ],
  });
  t.after(() => mf.dispose());
  for (const bytes of [2, 4]) {
    const response = await mf.dispatchFetch(`https://test/?bytes=${bytes}`);
    assert.equal(response.status, 400);
  }
  const stored = await mf.dispatchFetch("https://test/");
  assert.equal(stored.status, 200);
  assert.deepEqual(await stored.json(), { size: 3 });
  const duplicate = await mf.dispatchFetch("https://test/");
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { size: null });
});
