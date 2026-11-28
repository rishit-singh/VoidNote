import assert from "node:assert/strict";
import { before, test, type TestContext } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response } from "miniflare";

let script: string;
before(async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
    entryPoints: ["tests/worker/execution-telemetry.fixture.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    conditions: ["workerd"],
    external: ["node:*"],
  });
  script = result.outputFiles[0]!.text;
});

type Span = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  status: { code: number };
  attributes: Array<{ key: string; value: { stringValue?: string } }>;
};

function start(t: TestContext, enabled = true, failCollector = false, hangCollector = false) {
  const bodies: string[] = [];
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "execution-telemetry-test",
          compatibilityDate: "2026-11-13",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: script } },
          },
          env: {
            LOGFIRE_BASE_URL: { type: "text", value: "https://collector.test" },
            ...(enabled ? { LOGFIRE_TOKEN: { type: "text" as const, value: "TEST-secret" } } : {}),
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            async handler(request) {
              assert.equal(request.url, "https://collector.test/v1/traces");
              assert.equal(request.headers.get("authorization"), "TEST-secret");
              bodies.push(await request.text());
              if (hangCollector) {
                await new Promise<void>((resolve) => {
                  if (request.signal.aborted) resolve();
                  else request.signal.addEventListener("abort", () => resolve(), { once: true });
                });
              }
              return new Response(null, { status: failCollector ? 500 : 200 });
            },
          },
        },
      },
    ],
  });
  t.after(() => mf.dispose());
  return { mf, bodies };
}

function spans(body: string): Span[] {
  const payload = JSON.parse(body) as {
    resourceSpans: Array<{ scopeSpans: Array<{ spans: Span[] }> }>;
  };
  return payload.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
}

void test("research exports execution completion separately from evidence quality", async (t) => {
  const { mf, bodies } = start(t);
  const response = await mf.dispatchFetch("https://app.test/quality");
  assert.equal(response.status, 200);
  const [root] = spans(bodies[0]!);
  assert.equal(root?.status.code, 1);
  const attributes = new Map(root?.attributes.map((attribute) => [attribute.key, attribute.value]));
  assert.equal(attributes.get("voidnote.result_status")?.stringValue, "completed");
  assert.equal(attributes.get("voidnote.result_quality")?.stringValue, "insufficient-evidence");
  assert.equal(attributes.get("voidnote.actor_type")?.stringValue, "workflow");
  assert.ok(attributes.has("voidnote.reused_source_count"));
  assert.ok(attributes.has("voidnote.run_id") || attributes.has("voidnote.runId"));
});

void test("nested persistence uses actual parents; concurrent durable executions stay isolated", async (t) => {
  const { mf, bodies } = start(t);
  const responses = await Promise.all([
    mf.dispatchFetch("https://app.test/ok"),
    mf.dispatchFetch("https://app.test/ok"),
  ]);
  for (const response of responses) assert.equal(response.status, 200);
  assert.equal(bodies.length, 2);
  const traceIds = new Set<string>();
  for (const body of bodies) {
    assert.doesNotMatch(body, /PRIVATE|TEST-secret/);
    const exported = spans(body);
    const root = exported.find((span) => span.name === "research.workflow")!;
    const child = exported.find((span) => span.name === "research.persistence.save-finding")!;
    assert.equal(exported.length, 2);
    assert.equal(child.parentSpanId, root.spanId);
    assert.equal(child.traceId, root.traceId);
    assert.equal(root.parentSpanId, undefined);
    assert.ok(root.attributes.some((a) => a.value.stringValue === "invoke_agent"));
    traceIds.add(root.traceId);
  }
  assert.equal(traceIds.size, 2);
});

void test("errors and uncertain outcomes are visible without exporting content or changing errors", async (t) => {
  const { mf, bodies } = start(t);
  const failure = await mf.dispatchFetch("https://app.test/failure");
  assert.deepEqual(await failure.json(), { sameError: true });
  await mf.dispatchFetch("https://app.test/uncertain");
  for (const body of bodies) {
    assert.doesNotMatch(body, /PRIVATE|TEST-secret/);
    for (const span of spans(body)) assert.equal(span.status.code, 2);
  }
  assert.equal(bodies.length, 2);
});

void test("wrapped database failures export only bounded cause classes and SQLSTATE", async (t) => {
  const { mf, bodies } = start(t);
  const response = await mf.dispatchFetch("https://app.test/wrapped-failure");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { sameError: false });
  const body = bodies[0]!;
  assert.doesNotMatch(body, /PRIVATE|23505.*SQL|provider token/);
  const failure = spans(body).find((span) => span.name === "research.persistence.save-finding")!;
  const attributes = failure.attributes.map((attribute) => [
    attribute.key,
    attribute.value.stringValue,
  ]);
  assert.deepEqual(
    attributes.filter(([key]) => key === "voidnote.error.cause_type").map(([, value]) => value),
    ["Error"],
  );
  assert.ok(attributes.some(([key, value]) => key === "db.sqlstate" && value === "23505"));
});

void test("source failures expose a static stage without raw upstream errors", async (t) => {
  const { mf, bodies } = start(t);
  const response = await mf.dispatchFetch("https://app.test/source-error");
  assert.equal(response.status, 503);
  const body = bodies[0]!;
  assert.doesNotMatch(body, /PRIVATE|TLS detail/);
  const failure = spans(body).find((span) => span.name === "research.run.retrieve")!;
  const attributes = new Map(failure.attributes.map(({ key, value }) => [key, value.stringValue]));
  assert.equal(attributes.get("error.type"), "ResearchSourceError");
  assert.equal(attributes.get("voidnote.source_error_code"), "source_tls_failed");
});

void test("WorkspaceError exposes only an allowlisted domain code", async (t) => {
  const { mf, bodies } = start(t);
  const response = await mf.dispatchFetch("https://app.test/workspace-error");
  assert.equal(response.status, 503);
  const body = bodies[0]!;
  assert.doesNotMatch(body, /PRIVATE|workspace message/);
  const failure = spans(body).find((span) => span.name === "research.workflow")!;
  const attributes = new Map(failure.attributes.map(({ key, value }) => [key, value.stringValue]));
  assert.equal(attributes.get("error.type"), "WorkspaceError");
  assert.equal(attributes.get("voidnote.error.domain_code"), "forbidden");
});

void test("missing credentials and collector failure preserve successful work", async (t) => {
  const disabled = start(t, false);
  const failing = start(t, true, true);
  for (const worker of [disabled, failing]) {
    const response = await worker.mf.dispatchFetch("https://app.test/ok");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "completed", text: "PRIVATE" });
  }
  assert.equal(disabled.bodies.length, 0);
  assert.equal(failing.bodies.length, 1);
});

void test("escaped work exports after its parent; later invocations do not reuse closed parents", async (t) => {
  const { mf, bodies } = start(t);
  await mf.dispatchFetch("https://app.test/detached");
  const [root, child] = bodies.flatMap(spans);
  assert.ok(root);
  assert.ok(child);
  assert.equal(child.parentSpanId, root.spanId);
  assert.equal(child.traceId, root.traceId);
  bodies.length = 0;
  await mf.dispatchFetch("https://app.test/after-root");
  const [previous, next] = bodies.flatMap(spans);
  assert.ok(previous);
  assert.ok(next);
  assert.equal(next.parentSpanId, undefined);
  assert.notEqual(next.traceId, previous.traceId);
});

void test("a stalled collector is bounded and cannot cause completed work to be retried", async (t) => {
  const { mf, bodies } = start(t, true, false, true);
  const startTime = Date.now();
  const response = await mf.dispatchFetch("https://app.test/ok");
  assert.equal(response.status, 200);
  assert.ok(Date.now() - startTime < 4_000);
  assert.equal(bodies.length, 1);
  assert.equal(spans(bodies[0]!).length, 2);
});
