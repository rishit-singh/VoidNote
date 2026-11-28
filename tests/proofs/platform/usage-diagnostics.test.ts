import assert from "node:assert/strict";
import { test } from "node:test";

import { observeUsageDiagnostics, type UsageDiagnostic } from "./usage-diagnostics.ts";

const model = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
const secret = "PRIVATE_TEXT_DO_NOT_CAPTURE";
const encoder = new TextEncoder();

async function inspect(text: string) {
  const reports: UsageDiagnostic[] = [];
  const raw = {
    run() {
      assert.equal(this, raw);
      const bytes = encoder.encode(text);
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 7) {
              controller.enqueue(bytes.subarray(offset, offset + 7));
            }
            controller.close();
          },
        }),
      );
    },
  };
  const binding = observeUsageDiagnostics(raw as unknown as Ai, (report) => {
    reports.push(report);
  });
  const output: unknown = await binding.run(model, {
    messages: [{ role: "user", content: secret }],
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.ok(output instanceof ReadableStream);
  assert.equal(await new Response(output as ReadableStream<Uint8Array>).text(), text);
  assert.equal(reports.length, 1);
  assert.doesNotMatch(JSON.stringify(reports), new RegExp(secret));
  assert.ok(reports[0]);
  return reports[0];
}

void test("diagnostics preserve bytes and expose terminal usage shape without provider text", async () => {
  const report = await inspect(
    `data: {"response":"${secret}私人","${secret}":"${secret}","usage":null}\r\n\r\n`.repeat(20) +
      `data: {"choices":[],"usage":{"prompt_tokens":23,"completion_tokens":7,"${secret}":"${secret}"}}\r\n\r\n` +
      "data: [DONE]\r\n\r\n",
  );
  assert.deepEqual(report.request, { stream: true, includeUsage: true });
  assert.equal(report.transport, "stream");
  assert.equal(report.outcome, "eof");
  assert.equal(report.doneLines, 1);
  assert.equal(report.doneEvents, 1);
  assert.equal(report.trailingPartialEvent, false);
  assert.equal(report.completeTopLevelUsage, 1);
  assert.equal(report.lastTopLevelUsageComplete, true);
  assert.equal(report.usageSamples.length, 2, "repeated null frames cannot hide terminal counts");
  assert.deepEqual(report.usageSamples[1]?.fields, {
    prompt_tokens: { shape: "number", count: 23 },
    completion_tokens: { shape: "number", count: 7 },
  });
});

void test("diagnostics distinguish observer rejection conditions and alternative usage shapes", async () => {
  const usage = 'data: {"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n';
  const noDone = await inspect(usage);
  assert.equal(noDone.doneEvents, 0);
  assert.equal(noDone.trailingPartialEvent, false);
  for (const tail of ["data: [DONE]", "data: [DONE]\n"]) {
    const partial = await inspect(usage + tail);
    assert.equal(partial.doneLines, 1);
    assert.equal(partial.doneEvents, 0);
    assert.equal(partial.trailingPartialEvent, true);
  }
  const conflict = await inspect(
    usage + 'data: {"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\ndata: [DONE]\n\n',
  );
  assert.equal(conflict.conflictingTopLevelUsage, true);
  const nullLast = await inspect(usage + 'data: {"usage":null}\n\ndata: [DONE]\n\n');
  assert.equal(nullLast.lastTopLevelUsageComplete, false);
  const nested = await inspect(
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":9}}}\n\n',
  );
  assert.equal(nested.completeTopLevelUsage, 0);
  assert.equal(nested.completedTypeFrames, 1);
  assert.equal(nested.usageSamples[0]?.location, "response.usage");
  const oversized = await inspect(`data: {"response":"${"x".repeat(70_000)}"}\n\n`);
  assert.equal(oversized.oversizedEvents, 1);
});

void test("last usage and diagnostic-only sums survive the sample cap without assuming delta semantics", async () => {
  const chunks = Array.from({ length: 12 }, (_, index) => ({
    object: "chat.completion.chunk",
    choices: [{ delta: { content: secret }, finish_reason: index === 11 ? "stop" : null }],
    usage: {
      prompt_tokens: index === 0 ? 3709 : 0,
      completion_tokens: index,
      total_tokens: (index === 0 ? 3709 : 0) + index,
    },
  }));
  const terminal = {
    response: "",
    finish_reason: "stop",
    usage: { prompt_tokens: 3709, completion_tokens: 66, total_tokens: 3775 },
  };
  const report = await inspect(
    [...chunks, terminal].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
  );
  assert.equal(report.usageSamples.length, 8);
  assert.deepEqual(report.lastTopLevelUsage, {
    jsonFrame: 13,
    usageShape: "object",
    promptTokens: 3709,
    completionTokens: 66,
    totalTokens: 3775,
    responseShape: "string",
    responseEmpty: true,
    choicesLength: null,
    firstChoiceHasDelta: false,
    finishReason: "stop",
    objectKind: "missing",
  });
  assert.deepEqual(report.diagnosticOnlyUsageSums, {
    all: { frames: 13, promptTokens: 7418, completionTokens: 132 },
    choices: { frames: 12, promptTokens: 3709, completionTokens: 66 },
    nonChoices: { frames: 1, promptTokens: 3709, completionTokens: 66 },
  });
  const arbitraryFinishReason = await inspect(
    `data: {"response":"${secret}","finish_reason":"${secret}","usage":null}\n\n`,
  );
  assert.equal(arbitraryFinishReason.lastTopLevelUsage?.finishReason, "other");
  assert.equal(arbitraryFinishReason.lastTopLevelUsage?.promptTokens, null);
});

void test("diagnostics preserve object identity and propagate errors/cancellation without recording reasons", async () => {
  const reports: UsageDiagnostic[] = [];
  const response = { response: secret, usage: { prompt_tokens: 1, completion_tokens: 2 } };
  const binding = observeUsageDiagnostics(
    { run: () => Promise.resolve(response) } as unknown as Ai,
    (report) => {
      reports.push(report);
      throw new Error("sink unavailable");
    },
  );
  assert.equal(await binding.run(model, { prompt: secret }), response);
  assert.equal(reports[0]?.outcome, "object");
  for (const stage of ["binding", "stream", "cancel"] as const) {
    let cancelled = false;
    const wrapped = observeUsageDiagnostics(
      {
        run() {
          if (stage === "binding") throw new Error(secret);
          return Promise.resolve(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (stage === "stream") controller.error(new Error(secret));
                else controller.enqueue(encoder.encode('data: {"response":"text"}\n\n'));
              },
              cancel() {
                cancelled = true;
              },
            }),
          );
        },
      } as unknown as Ai,
      (report) => {
        reports.push(report);
      },
    );
    if (stage === "binding") {
      await assert.rejects(wrapped.run(model, { prompt: secret }), new RegExp(secret));
    } else {
      const output: unknown = await wrapped.run(model, { prompt: secret, stream: true });
      assert.ok(output instanceof ReadableStream);
      const reader = (output as ReadableStream<Uint8Array>).getReader();
      if (stage === "stream") await assert.rejects(reader.read(), new RegExp(secret));
      else {
        await reader.read();
        await reader.cancel(secret);
        assert.equal(cancelled, true);
      }
    }
  }
  assert.deepEqual(
    reports.map((report) => report.outcome),
    ["object", "binding-error", "stream-error", "cancelled"],
  );
  assert.doesNotMatch(JSON.stringify(reports), new RegExp(secret));
});
