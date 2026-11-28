import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { connect, createServer, type Socket } from "node:net";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";

import { build } from "esbuild";
import { Miniflare, Response } from "miniflare";
import ts from "typescript";
import { z } from "zod";

const databaseUrl = process.env.TEST_DATABASE_URL;
const configurationSchema = z.object({
  compatibility_date: z.string(),
  compatibility_flags: z.array(z.string()),
  alias: z.object({ postgres: z.string().min(1) }),
});

void test(
  "job database socket lifecycle in workerd",
  { skip: !databaseUrl, timeout: 60_000 },
  async (t) => {
    assert.ok(databaseUrl);
    const target = new URL(databaseUrl);
    assert.ok(["postgres:", "postgresql:"].includes(target.protocol));
    assert.equal(target.hostname, "127.0.0.1");
    assert.match(target.pathname, /^\/voidnote_(?:[a-z0-9]+_)*test(?:_[a-z0-9]+)*$/);
    assert.equal(target.search, "");
    const upstreamPort = Number(target.port || "5432");

    const parsed = ts.parseConfigFileTextToJson(
      "wrangler.jsonc",
      await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"),
    );
    assert.equal(parsed.error, undefined);
    const configuration = configurationSchema.parse(parsed.config);

    let rejectConnection = false;
    let closeNextWrite = false;
    const sockets = new Set<Socket>();
    const proxy = createServer((incoming) => {
      sockets.add(incoming);
      incoming.on("close", () => sockets.delete(incoming));
      incoming.on("error", () => incoming.destroy());
      if (rejectConnection) {
        incoming.destroy();
        return;
      }
      const upstream = connect({ host: "127.0.0.1", port: upstreamPort });
      sockets.add(upstream);
      upstream.on("close", () => {
        sockets.delete(upstream);
        incoming.destroy();
      });
      upstream.on("error", () => incoming.destroy());
      incoming.on("close", () => upstream.destroy());
      incoming.on("data", (data) => {
        if (closeNextWrite) {
          closeNextWrite = false;
          incoming.destroy();
          upstream.destroy();
        } else {
          upstream.write(data);
        }
      });
      upstream.pipe(incoming);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    target.port = String(address.port);

    const bundle = await build({
      absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
      entryPoints: ["tests/worker/job-database.fixture.ts"],
      tsconfig: "tsconfig.worker-tests.json",
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      conditions: ["workerd"],
      external: ["node:*", "cloudflare:*"],
      target: "es2022",
      // Default coverage follows the actual Wrangler alias. Opt into the
      // original Cloudflare adapter only to reproduce its teardown failure.
      ...(process.env.JOB_DATABASE_LEGACY_ENTRY === "1" ? {} : { alias: configuration.alias }),
      plugins: [
        {
          name: "node-builtins",
          setup(build) {
            build.onResolve({ filter: /^[a-z_]+$/ }, (args) =>
              builtinModules.includes(args.path)
                ? { path: `node:${args.path}`, external: true }
                : undefined,
            );
          },
        },
      ],
    });
    assert.ok(bundle.outputFiles[0]);
    const worker = new Miniflare({
      host: "127.0.0.1",
      port: 0,
      cf: false,
      telemetry: { enabled: false },
      workers: [
        {
          config: {
            name: "job-database-test",
            compatibilityDate: configuration.compatibility_date,
            compatibilityFlags: configuration.compatibility_flags,
            env: {
              TEST_DATABASE_URL: { type: "text", value: databaseUrl },
              FAULT_DATABASE_URL: { type: "text", value: target.toString() },
            },
            manifest: {
              mainModule: "worker.js",
              modules: { "worker.js": { type: "esm", contents: bundle.outputFiles[0].text } },
            },
          },
          dev: {
            outboundService: {
              type: "fetcher",
              handler(request) {
                assert.equal(request.url, "http://fault-control.invalid/close-next-write");
                closeNextWrite = true;
                return new Response(null, { status: 204 });
              },
            },
          },
        },
      ],
    });
    t.after(() => worker.dispose());

    async function dispatch(path: string) {
      const response = await worker.dispatchFetch(`http://localhost${path}`);
      assert.equal(response.status, 200);
      return (await response.json()) as {
        result?: { value: number }[];
        caught: string | null;
        unhandled: string[];
      };
    }

    await t.test("successful repeated query/end", async () => {
      const unhandled: string[] = [];
      for (let i = 0; i < 10; i++) {
        const result = await dispatch("/");
        assert.equal(result.caught, null);
        assert.deepEqual(result.result, [{ value: 1 }]);
        unhandled.push(...result.unhandled);
      }
      assert.deepEqual(unhandled, []);
    });
    await t.test("callback failures remain visible", async () => {
      const result = await dispatch("/callback-error");
      assert.equal(result.caught, "fixture callback failure");
      assert.deepEqual(result.unhandled, []);
    });
    await t.test("forced close rejects the query without an unhandled rejection", async () => {
      const result = await dispatch("/force-close");
      assert.ok(result.caught);
      assert.deepEqual(result.unhandled, []);
    });
    await t.test("failed connection rejects without an unhandled rejection", async () => {
      rejectConnection = true;
      try {
        const result = await dispatch("/failed-connect");
        assert.ok(result.caught);
        assert.deepEqual(result.unhandled, []);
      } finally {
        rejectConnection = false;
      }
    });
    const late = await worker.dispatchFetch("http://localhost/unhandled");
    assert.deepEqual(await late.json(), []);
  },
);
