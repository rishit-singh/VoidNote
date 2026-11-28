import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkersAI } from "workers-ai-provider";

import { summaryBudgetPricing, type SummaryUsage } from "../../src/ai/runtime/budget";
import { observeSummaryUsage } from "../../src/ai/summary/usage";

function fakeBinding(response: unknown) {
  const binding = {
    marker: "original receiver",
    run() {
      assert.equal(this, binding);
      return Promise.resolve(response);
    },
    inspect() {
      assert.equal(this, binding);
      return this.marker;
    },
  };
  return binding as unknown as Ai & { inspect(): string };
}

function bytesStream(text: string, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
}

async function observedStream(
  source: ReadableStream<Uint8Array>,
  observer: (usage: SummaryUsage) => void | Promise<void>,
) {
  const binding = observeSummaryUsage(fakeBinding(source), observer);
  const output: unknown = await binding.run(summaryBudgetPricing.model, { prompt: "fixture" });
  assert.ok(output instanceof ReadableStream);
  return output as ReadableStream<Uint8Array>;
}

void test("real Workers AI adapter cannot turn absent, partial or null usage into a receipt", async () => {
  const cases = [
    { raw: {}, expected: [] },
    { raw: { usage: {} }, expected: [] },
    { raw: { usage: { prompt_tokens: 20 } }, expected: [] },
    { raw: { usage: { completion_tokens: 30 } }, expected: [] },
    { raw: { usage: { prompt_tokens: 20, completion_tokens: null } }, expected: [] },
    { raw: { usage: { prompt_tokens: null, completion_tokens: 30 } }, expected: [] },
    { raw: { usage: { prompt_tokens: 20, completion_tokens: -1 } }, expected: [] },
    { raw: { usage: { prompt_tokens: "20", completion_tokens: 30 } }, expected: [] },
    {
      raw: { usage: { prompt_tokens: 0, completion_tokens: 0 } },
      expected: [{ inputTokens: 0, outputTokens: 0 }],
    },
    {
      raw: { usage: { prompt_tokens: 20, completion_tokens: 30 } },
      expected: [{ inputTokens: 20, outputTokens: 30 }],
    },
  ];
  for (const streaming of [false, true]) {
    for (const { raw, expected } of cases) {
      const receipts: SummaryUsage[] = [];
      const response = { response: "private model output", ...raw };
      const binding = observeSummaryUsage(
        fakeBinding(
          streaming
            ? bytesStream(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, 1)
            : response,
        ),
        (usage) => {
          receipts.push(usage);
        },
      );
      const model = createWorkersAI({ binding })(summaryBudgetPricing.model);
      const result = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "fixture" }] }],
      });
      const chunks = [];
      for await (const chunk of result.stream) chunks.push(chunk);
      assert.deepEqual(receipts, expected, JSON.stringify({ streaming, raw }));
      const finish = chunks.find((chunk) => chunk.type === "finish");
      assert.ok(finish);
      if (!("usage" in raw)) {
        // Reproduce the original blocker through the installed production adapter.
        assert.equal(finish.usage.inputTokens.total, 0);
        assert.equal(finish.usage.outputTokens.total, 0);
        assert.deepEqual(receipts, []);
      }
    }
  }
});

void test("byte-identical forwarding handles UTF-8 splits, BOM, comments, multiline data and every SSE newline", async () => {
  for (const newline of ["\n", "\r", "\r\n"]) {
    const source = `\uFEFF: comment${newline}event: message${newline}data: {"response":"私人",${newline}data: "usage":{"prompt_tokens":4,"completion_tokens":5}}${newline}${newline}data: [DONE]${newline}${newline}`;
    const receipts: SummaryUsage[] = [];
    const output = await observedStream(bytesStream(source, 1), (usage) => {
      receipts.push(usage);
    });
    assert.deepEqual(
      new Uint8Array(await new Response(output).arrayBuffer()),
      new TextEncoder().encode(source),
    );
    assert.deepEqual(receipts, [{ inputTokens: 4, outputTokens: 5 }]);
  }
});

void test("oversized and malformed events cannot supply receipts; later valid terminal events recover", async () => {
  const valid = 'data: {"usage":{"prompt_tokens":7,"completion_tokens":8}}';
  const source = [
    `data: {"text":"${"x".repeat(70_000)}","usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n`,
    "data: not JSON\n\n",
    `${valid}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const receipts: SummaryUsage[] = [];
  const output = await observedStream(bytesStream(source, 4093), (usage) => {
    receipts.push(usage);
  });
  assert.equal(await new Response(output).text(), source);
  assert.deepEqual(receipts, [{ inputTokens: 7, outputTokens: 8 }]);
});

void test("binding proxy preserves original run receiver, other methods and object response identity", async () => {
  const response = { usage: { prompt_tokens: 0, completion_tokens: 0 }, response: "private" };
  const original = fakeBinding(response);
  const receipts: SummaryUsage[] = [];
  const binding = observeSummaryUsage(original, (usage) => {
    receipts.push(usage);
  });
  const inspect: unknown = Reflect.get(binding, "inspect");
  assert.equal(typeof inspect, "function");
  assert.equal((inspect as () => string)(), "original receiver");
  assert.equal(await binding.run(summaryBudgetPricing.model, { prompt: "fixture" }), response);
  assert.deepEqual(receipts, [{ inputTokens: 0, outputTokens: 0 }]);
});

void test("raw receipt is persisted before terminal stream completion reaches the adapter", async () => {
  const started = Promise.withResolvers<void>();
  const persisted = Promise.withResolvers<void>();
  const output = await observedStream(
    bytesStream(
      'data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
      1000,
    ),
    async () => {
      started.resolve();
      await persisted.promise;
    },
  );
  const reader = output.getReader();
  assert.equal((await reader.read()).done, false);
  let delivered = false;
  const read = reader.read().then((result) => {
    delivered = true;
    return result;
  });
  await started.promise;
  assert.equal(delivered, false);
  persisted.resolve();
  assert.equal((await read).done, true);
  await reader.cancel();
});

void test("only terminal, consistent complete usage can settle; identical reports are deduplicated", async () => {
  const report = 'data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n';
  for (const source of [
    report,
    `${report}data: [DONE]\n`,
    `${report}data: {"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\ndata: [DONE]\n\n`,
    `${report}data: {"usage":{"prompt_tokens":3}}\n\ndata: [DONE]\n\n`,
    `${report}data: {"usage":null}\n\ndata: [DONE]\n\n`,
    `${report}data: [DONE]\n\ndata: {"usage":`,
  ]) {
    const receipts: SummaryUsage[] = [];
    const output = await observedStream(bytesStream(source), (usage) => {
      receipts.push(usage);
    });
    await new Response(output).text();
    assert.deepEqual(receipts, []);
  }
  const receipts: SummaryUsage[] = [];
  const output = await observedStream(
    bytesStream(`${report}${report}data: [DONE]\n\n`),
    (usage) => {
      receipts.push(usage);
    },
  );
  await new Response(output).text();
  assert.deepEqual(receipts, [{ inputTokens: 1, outputTokens: 2 }]);
});

void test("installed Workers AI adapter settles the explicit hybrid total, never per-delta counts", async () => {
  const delta = (input: number, output: number) => ({
    object: "chat.completion.chunk",
    choices: [{ delta: { content: "synthetic" }, finish_reason: null }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  });
  // Matches the installed Agents normalizer's documented Workers AI protocol.
  // Deliberately differs from the delta sum: only the raw total is authoritative.
  const frames = [
    delta(3709, 0),
    delta(0, 18),
    delta(0, 315),
    {
      choices: [{ index: 0, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
    { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
    { response: "", usage: { prompt_tokens: 3709, completion_tokens: 400, total_tokens: 4109 } },
  ];
  const source =
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
  const receipts: SummaryUsage[] = [];
  const binding = observeSummaryUsage(fakeBinding(bytesStream(source, 7)), (usage) => {
    receipts.push(usage);
  });
  const result = await createWorkersAI({ binding })(
    "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  ).doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "synthetic" }] }],
  });
  for await (const part of result.stream) void part;
  assert.deepEqual(receipts, [{ inputTokens: 3709, outputTokens: 400 }]);
});

void test("hybrid usage retains holds for absent, ambiguous, conflicting or nonterminal totals", async () => {
  const delta =
    'data: {"choices":[{"delta":{"content":"synthetic"}}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n';
  const total = 'data: {"response":"","usage":{"prompt_tokens":7,"completion_tokens":9}}\n\n';
  const done = "data: [DONE]\n\n";
  const heartbeat = 'data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\n';
  for (const source of [
    delta + done,
    delta + heartbeat + done,
    heartbeat + done,
    delta + 'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":9}}\n\n' + done,
    delta + 'data: {"usage":{"prompt_tokens":7,"completion_tokens":9}}\n\n' + done,
    delta + 'data: {"response":"","usage":{"prompt_tokens":7}}\n\n' + done,
    delta + total,
    delta +
      total +
      'data: {"response":"","usage":{"prompt_tokens":7,"completion_tokens":10}}\n\n' +
      done,
    delta + total + 'data: {"usage":null}\n\n' + done,
    delta + total + delta + done,
    delta + total + heartbeat + done,
  ]) {
    const receipts: SummaryUsage[] = [];
    const output = await observedStream(bytesStream(source), (usage) => {
      receipts.push(usage);
    });
    assert.equal(await new Response(output).text(), source);
    assert.deepEqual(receipts, []);
  }
  // The same shaped events from another provider must not inherit Workers AI rules.
  const receipts: SummaryUsage[] = [];
  const binding = observeSummaryUsage(fakeBinding(bytesStream(delta + total + done)), (usage) => {
    receipts.push(usage);
  });
  const output: unknown = await binding.run("vendor/model", { prompt: "synthetic", stream: true });
  assert.ok(output instanceof ReadableStream);
  await new Response(output as ReadableStream<Uint8Array>).text();
  assert.deepEqual(receipts, []);
});

void test("recorded proof tail counts survive zero-usage heartbeat frames without summing choices", async () => {
  // Final counts from frozen-low's safe metadata. Payloads below are synthetic;
  // the frame order follows the installed Agents run-path protocol contract.
  for (const [inputTokens, outputTokens] of [
    [8781, 68],
    [9072, 183],
    [3733, 1795],
    [9481, 94],
  ] as const) {
    const frames = [
      {
        choices: [{ delta: { role: "assistant", content: "" } }],
        usage: { prompt_tokens: inputTokens, completion_tokens: 0 },
      },
      {
        choices: [{ delta: { content: "synthetic response" } }],
        usage: { prompt_tokens: 0, completion_tokens: outputTokens },
      },
      {
        choices: [{ finish_reason: "stop", delta: null }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      },
      { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } },
      {
        response: "",
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      },
    ];
    const source =
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
    const receipts: SummaryUsage[] = [];
    const output = await observedStream(bytesStream(source, 7), (usage) => {
      receipts.push(usage);
    });
    assert.equal(await new Response(output).text(), source);
    assert.deepEqual(receipts, [{ inputTokens, outputTokens }]);
  }
});

void test("a failure after complete raw usage still retains the uncertain hold", async () => {
  const receipts: SummaryUsage[] = [];
  let sent = false;
  const output = await observedStream(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
            ),
          );
          return;
        }
        controller.error(new Error("interrupted"));
      },
    }),
    (usage) => {
      receipts.push(usage);
    },
  );
  await assert.rejects(new Response(output).text(), /interrupted/);
  assert.deepEqual(receipts, []);
});

void test("source cancellation and stream failures propagate without inventing usage", async () => {
  const cancelled = Promise.withResolvers<void>();
  const receipts: SummaryUsage[] = [];
  const output = await observedStream(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"response":"private"}\n\n'));
      },
      cancel() {
        cancelled.resolve();
      },
    }),
    (usage) => {
      receipts.push(usage);
    },
  );
  const reader = output.getReader();
  await reader.read();
  await reader.cancel();
  await cancelled.promise;
  assert.equal(receipts.length, 0);
  const failed = await observedStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("fixture failure"));
      },
    }),
    (usage) => {
      receipts.push(usage);
    },
  );
  await assert.rejects(new Response(failed).text(), /fixture failure/);
  assert.deepEqual(receipts, []);
});
