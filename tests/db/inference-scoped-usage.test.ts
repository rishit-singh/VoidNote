import assert from "node:assert/strict";
import { test } from "node:test";

import type { InferenceUsage } from "../../src/ai/inference/pricing";
import { observeScopedInferenceUsage } from "../../src/ai/inference/scoped-usage";

type Scope = { workspaceId: string; requestId: string };
type Receipt = Scope & InferenceUsage;

const originalScope: Scope = { workspaceId: "workspace-a", requestId: "request-a" };
const replacementScope: Scope = { workspaceId: "workspace-b", requestId: "request-b" };
const model = "@cf/meta/llama-3.1-8b-instruct";

void test("delayed responses settle their invocation scope when requests finish out of order", async () => {
  const first = Promise.withResolvers<unknown>();
  const second = Promise.withResolvers<unknown>();
  const pending = [first.promise, second.promise];
  const receipts: Receipt[] = [];
  let current: Scope | null = null;
  let captures = 0;
  let calls = 0;
  const raw = {
    run() {
      assert.equal(this, raw, "the binding retains its original receiver");
      const response = pending[calls++];
      assert.ok(response, "no unexpected provider invocation");
      return response;
    },
  };
  const observed = observeScopedInferenceUsage(
    raw as unknown as Ai,
    () => {
      captures += 1;
      assert.ok(current, "a request must be admitted before invocation");
      return { ...current };
    },
    (scope, usage) => {
      receipts.push({ ...scope, ...usage });
      return Promise.resolve();
    },
  );

  // Reading/caching the method must not capture a scope before a request exists.
  const run = observed.run.bind(observed);
  assert.equal(captures, 0);
  current = originalScope;
  const firstResult = run(model, { prompt: "first request" });
  current = replacementScope;
  const secondResult = run(model, { prompt: "second request" });
  current = null;

  const secondResponse = { usage: { prompt_tokens: 20, completion_tokens: 3 } };
  second.resolve(secondResponse);
  assert.equal(await secondResult, secondResponse);
  assert.deepEqual(receipts, [{ ...replacementScope, inputTokens: 20, outputTokens: 3 }]);

  const firstResponse = { usage: { prompt_tokens: 7, completion_tokens: 2 } };
  first.resolve(firstResponse);
  assert.equal(await firstResult, firstResponse);
  assert.deepEqual(receipts, [
    { ...replacementScope, inputTokens: 20, outputTokens: 3 },
    { ...originalScope, inputTokens: 7, outputTokens: 2 },
  ]);
  assert.equal(captures, 2);
  assert.equal(calls, 2);
});

void test("late terminal stream usage retains the original receipt after active scope is cleared", async () => {
  const response = Promise.withResolvers<unknown>();
  const source = new TransformStream<Uint8Array, Uint8Array>();
  const writer = source.writable.getWriter();
  const receipts: Receipt[] = [];
  let current: Scope | null = originalScope;
  let captures = 0;
  const observed = observeScopedInferenceUsage(
    { run: () => response.promise } as unknown as Ai,
    () => {
      captures += 1;
      assert.ok(current, "late usage must not consult the cleared active request");
      return { ...current };
    },
    (scope, usage) => {
      receipts.push({ ...scope, ...usage });
      return Promise.resolve();
    },
  );

  const pending = observed.run(model, { prompt: "streamed request", stream: true });
  current = replacementScope;
  response.resolve(source.readable);
  const output: unknown = await pending;
  assert.ok(output instanceof ReadableStream);
  const forwarded = new Response(output as ReadableStream<Uint8Array>).text();
  const text = 'data: {"response":"late answer"}\n\n';
  const usage = 'data: {"usage":{"prompt_tokens":11,"completion_tokens":0}}\n\n';
  const done = "data: [DONE]\n\n";
  const encoder = new TextEncoder();

  await writer.write(encoder.encode(text));
  current = null;
  await writer.write(encoder.encode(usage));
  await writer.write(encoder.encode(done));
  assert.deepEqual(receipts, [], "usage remains uncertain until clean EOF");
  await writer.close();
  assert.equal(await forwarded, text + usage + done);
  assert.deepEqual(receipts, [{ ...originalScope, inputTokens: 11, outputTokens: 0 }]);
  assert.equal(captures, 1);
});

void test("failure to capture an admitted scope prevents provider invocation", () => {
  let calls = 0;
  const receipts: Receipt[] = [];
  const observed = observeScopedInferenceUsage<Scope>(
    {
      run() {
        calls += 1;
        return Promise.resolve({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    } as unknown as Ai,
    () => {
      throw new Error("No admitted request");
    },
    (scope, usage) => {
      receipts.push({ ...scope, ...usage });
      return Promise.resolve();
    },
  );

  assert.throws(() => observed.run(model, { prompt: "must not run" }), /No admitted request/);
  assert.equal(calls, 0);
  assert.deepEqual(receipts, []);
});
