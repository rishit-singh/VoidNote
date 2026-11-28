import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response, type Request } from "miniflare";

const root = fileURLToPath(new URL("../../", import.meta.url));
const collectorUrl = "https://collector.test/v1/traces";
const token = "summary-telemetry-test-token";
let script: string;

before(async () => {
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ["tests/worker/summary-telemetry.fixture.ts"],
    tsconfig: "tsconfig.worker-tests.json",
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd"],
    target: "es2022",
  });
  const output = bundle.outputFiles[0];
  assert.ok(output);
  script = output.text;
});

type Capture = { authorization: string | null; body: string };

function startWorker(
  options: {
    token?: string;
    collectorStatus?: number;
    hangCollector?: boolean;
    environment?: string;
  } = {},
) {
  const captures: Capture[] = [];
  const unexpected: string[] = [];
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "summary-telemetry-test",
          compatibilityDate: "2026-11-13",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: script } },
          },
          env: {
            LOGFIRE_BASE_URL: { type: "text", value: "https://collector.test" },
            LOGFIRE_ENVIRONMENT: {
              type: "text",
              value: options.environment ?? "development",
            },
            ...(options.token
              ? { LOGFIRE_TOKEN: { type: "text" as const, value: options.token } }
              : {}),
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            async handler(request: Request) {
              if (request.url === collectorUrl) {
                captures.push({
                  authorization: request.headers.get("authorization"),
                  body: await request.text(),
                });
                if (options.hangCollector) {
                  await new Promise<void>((resolve) => {
                    if (request.signal.aborted) {
                      resolve();
                      return;
                    }
                    request.signal.addEventListener("abort", () => resolve(), { once: true });
                  });
                }
                return new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(new TextEncoder().encode("PRIVATE collector error body"));
                    },
                  }),
                  { status: options.collectorStatus ?? 200 },
                );
              }
              unexpected.push(request.url);
              return new Response(null, { status: 502 });
            },
          },
        },
      },
    ],
  });
  return { mf, captures, unexpected };
}

function spansFrom(capture: Capture) {
  assert.equal(capture.authorization, token);
  const payload = JSON.parse(capture.body) as {
    resourceSpans: Array<{
      scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
    }>;
  };
  return payload.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans),
  );
}

void test("exports independent OTLP Summary spans with safe correlation and usage fields", async (t) => {
  const worker = startWorker({ token });
  t.after(async () => {
    await worker.mf.dispose();
    assert.deepEqual(worker.unexpected, []);
  });

  const response = await worker.mf.dispatchFetch("https://app.test/ok", {
    headers: { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` },
  });
  const result = (await response.json()) as { outcome: string; traceId: string };
  assert.equal(result.outcome, "ok");
  assert.equal(worker.captures.length, 1);

  const capture = worker.captures[0];
  assert.ok(capture);
  const [span] = spansFrom(capture);
  assert.ok(span);
  assert.equal(span.traceId, result.traceId, "UI correlation ID matches exported Summary traces");
  assert.equal(span.name, "summary workflow.generate");
  assert.match(String(span.traceId), /^[\da-f]{32}$/);
  assert.notEqual(span.traceId, "a".repeat(32), "HTTP trace context is not inherited");
  assert.match(String(span.spanId), /^[\da-f]{16}$/);
  assert.equal("parentSpanId" in span, false, "Durable execution is not assigned a false parent");
  assert.deepEqual(span.events ?? [], []);
  assert.deepEqual(span.links ?? [], []);

  const attributes = span.attributes as Array<{
    key: string;
    value: { stringValue?: string; intValue?: string };
  }>;
  const fields = Object.fromEntries(attributes.map(({ key, value }) => [key, value]));
  assert.equal(
    fields["voidnote.workspace_id"]?.stringValue,
    "11111111-1111-4111-8111-111111111111",
  );
  assert.equal(fields["voidnote.job_id"]?.stringValue, "22222222-2222-4222-8222-222222222222");
  assert.ok(fields["voidnote.workflow_id"]);
  assert.ok(fields["voidnote.snapshot_id"]);
  assert.ok(fields["voidnote.result_id"]);
  assert.equal(fields["voidnote.stage"]?.stringValue, "workflow.generate");
  assert.equal(fields["voidnote.outcome"]?.stringValue, "ok");
  const payload = JSON.parse(capture.body) as {
    resourceSpans: Array<{
      resource: {
        attributes: Array<{ key: string; value: { stringValue?: string } }>;
      };
    }>;
  };
  assert.equal(
    payload.resourceSpans[0]?.resource.attributes.find(
      ({ key }) => key === "deployment.environment.name",
    )?.value.stringValue,
    "development",
  );
  assert.equal(fields["gen_ai.usage.input_tokens"]?.intValue, "123");
  assert.equal(fields["gen_ai.usage.output_tokens"]?.intValue, "45");
  assert.ok(Number(fields["voidnote.duration_ms"]?.intValue) >= 0);
  assert.doesNotMatch(capture.body, /PRIVATE|transcript|prompt|stack|test-token/i);
});

void test("missing credentials disable export and collector failure preserves domain results", async (t) => {
  const disabled = startWorker();
  t.after(async () => {
    await disabled.mf.dispose();
    assert.deepEqual(disabled.unexpected, []);
  });
  const disabledResponse = await disabled.mf.dispatchFetch("https://app.test/ok");
  assert.equal(((await disabledResponse.json()) as { outcome: string }).outcome, "ok");
  assert.deepEqual(disabled.captures, []);

  const failing = startWorker({ token, collectorStatus: 500 });
  t.after(async () => {
    await failing.mf.dispose();
    assert.deepEqual(failing.unexpected, []);
  });
  const response = await failing.mf.dispatchFetch("https://app.test/fail-domain");
  assert.deepEqual(await response.json(), { outcome: "domain-error", sameError: true });
  assert.equal(failing.captures.length, 1);
  const capture = failing.captures[0];
  assert.ok(capture);
  const [span] = spansFrom(capture);
  assert.ok(span);
  const attributes = span.attributes as Array<{ key: string; value: { stringValue?: string } }>;
  assert.equal(
    attributes.find(({ key }) => key === "voidnote.outcome")?.value.stringValue,
    "error",
  );
  assert.doesNotMatch(capture.body, /PRIVATE|transcript|prompt|stack|test-token/i);
});

void test("standalone usage hook emits only allowlisted numeric usage", async (t) => {
  const worker = startWorker({ token });
  t.after(async () => {
    await worker.mf.dispose();
    assert.deepEqual(worker.unexpected, []);
  });
  const response = await worker.mf.dispatchFetch("https://app.test/usage");
  assert.deepEqual(await response.json(), { outcome: "ok" });
  const capture = worker.captures[0];
  assert.ok(capture);
  const [span] = spansFrom(capture);
  assert.ok(span);
  const attributes = span.attributes as Array<{ key: string }>;
  assert.ok(attributes.some(({ key }) => key === "gen_ai.usage.input_tokens"));
  assert.ok(attributes.some(({ key }) => key === "gen_ai.usage.output_tokens"));
  assert.ok(attributes.some(({ key }) => key === "gen_ai.request.model"));
  assert.ok(attributes.some(({ key }) => key === "voidnote.model.response_time_ms"));
  assert.ok(attributes.some(({ key }) => key === "voidnote.model.step_time_ms"));
  assert.ok(attributes.some(({ key }) => key === "voidnote.model.time_to_first_output_ms"));
});

void test("invalid usage values are filtered and invalid scope values are not exported", async (t) => {
  const worker = startWorker({ token });
  t.after(async () => {
    await worker.mf.dispose();
    assert.deepEqual(worker.unexpected, []);
  });

  const invalidUsageResponse = await worker.mf.dispatchFetch("https://app.test/invalid-usage");
  assert.deepEqual(await invalidUsageResponse.json(), { outcome: "ok" });
  assert.equal(worker.captures.length, 1);
  const invalidUsageCapture = worker.captures[0];
  assert.ok(invalidUsageCapture);
  const [span] = spansFrom(invalidUsageCapture);
  assert.ok(span);
  const usageKeys = (span.attributes as Array<{ key: string }>).filter(
    ({ key }) => key.startsWith("gen_ai.") || key.startsWith("voidnote.model."),
  );
  assert.deepEqual(usageKeys, []);

  const invalidScopeResponse = await worker.mf.dispatchFetch("https://app.test/invalid-scope");
  assert.deepEqual(await invalidScopeResponse.json(), { outcome: "ok" });
  assert.equal(worker.captures.length, 1, "invalid scope does not create telemetry");
});

void test("workflow completion is a supported stage and keeps its result correlation", async (t) => {
  const worker = startWorker({ token });
  t.after(async () => {
    await worker.mf.dispose();
    assert.deepEqual(worker.unexpected, []);
  });

  const response = await worker.mf.dispatchFetch("https://app.test/complete");
  assert.deepEqual(await response.json(), { outcome: "ok" });
  const capture = worker.captures[0];
  assert.ok(capture);
  const [span] = spansFrom(capture);
  assert.ok(span);
  const attributes = span.attributes as Array<{ key: string; value: { stringValue?: string } }>;
  assert.equal(
    attributes.find(({ key }) => key === "voidnote.stage")?.value.stringValue,
    "workflow.complete",
  );
  assert.ok(attributes.some(({ key }) => key === "voidnote.result_id"));
});

void test("unrecognized environment values are not added to OTLP resource attributes", async (t) => {
  const worker = startWorker({ token, environment: "PRIVATE environment" });
  t.after(async () => {
    await worker.mf.dispose();
    assert.deepEqual(worker.unexpected, []);
  });

  await worker.mf.dispatchFetch("https://app.test/ok");
  const capture = worker.captures[0];
  assert.ok(capture);
  const payload = JSON.parse(capture.body) as {
    resourceSpans: Array<{
      resource: { attributes: Array<{ key: string }> };
    }>;
  };
  assert.equal(
    payload.resourceSpans[0]?.resource.attributes.some(
      ({ key }) => key === "deployment.environment.name",
    ),
    false,
  );
});

void test("an exporter timeout is bounded and cannot replace a successful domain result", async (t) => {
  const worker = startWorker({ token, hangCollector: true });
  t.after(async () => {
    await worker.mf.dispose();
    assert.deepEqual(worker.unexpected, []);
  });

  const started = performance.now();
  const response = await worker.mf.dispatchFetch("https://app.test/ok");
  const elapsedMs = performance.now() - started;
  assert.equal(((await response.json()) as { outcome: string }).outcome, "ok");
  assert.ok(elapsedMs < 3_000, `export timeout should be bounded, got ${elapsedMs}ms`);
  assert.equal(worker.captures.length, 1);
});
