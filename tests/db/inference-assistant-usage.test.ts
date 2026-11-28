import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { build } from "esbuild";
import { createWorkersAI } from "workers-ai-provider";

type Usage = { inputTokens: number; outputTokens: number };
type Scope = { workspaceId: string; requestId: string };
type Receipt = Scope & Usage;
type Runtime = {
  getAIBinding(): Ai;
  reconcileInferenceUsage(): Promise<void>;
};
type RuntimeConstructor = new () => Runtime;

const model = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
const scope: Scope = { workspaceId: "workspace-a", requestId: "request-a" };
let source: string;

before(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../../src/ai/assistant-runtime.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    plugins: [
      {
        name: "assistant-usage-runtime-boundaries",
        setup(build) {
          build.onResolve(
            {
              filter:
                /^(?:\.\.\/db\/(?:assistant|inference)|\.\/(?:assistant|assistant-services|jobs))$/,
            },
            (args) => ({ path: args.path, external: true }),
          );
        },
      },
    ],
  });
  assert.ok(result.outputFiles[0]);
  source = result.outputFiles[0].text;
});

function fixture(raw: Ai) {
  const receipts: Receipt[] = [];
  const schedules: unknown[][] = [];
  let current: Scope | null = scope;
  const fixtureModule = { exports: {} as { AssistantAgent: RuntimeConstructor } };
  const evaluate = compileFunction(source, ["module", "exports", "require"]) as (
    module: typeof fixtureModule,
    exports: typeof fixtureModule.exports,
    require: (name: string) => unknown,
  ) => void;
  evaluate(fixtureModule, fixtureModule.exports, (name: string) => {
    if (name !== "./assistant") return {};

    return {
      AssistantAgent: class {
        ctx = {
          storage: {
            put: (key: string, receipt: Receipt) => {
              assert.equal(key, `assistant-usage:${receipt.requestId}`);
              receipts.push(receipt);
              return Promise.resolve();
            },
          },
        };
        getAIBinding() {
          return raw;
        }
        currentAssistantModelRequest() {
          assert.ok(current, "capture must happen before the request, not after stream completion");
          return { ...current };
        }
        schedule(...args: unknown[]) {
          schedules.push(args);
          return Promise.resolve();
        }
      },
    };
  });
  const agent = new fixtureModule.exports.AssistantAgent();
  // Isolate raw observation and durable receipt creation from database settlement.
  agent.reconcileInferenceUsage = () => Promise.resolve();

  return {
    binding: agent.getAIBinding(),
    receipts,
    schedules,
    clearScope() {
      current = null;
    },
  };
}

function sse(events: unknown[], done = true) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      (done ? "data: [DONE]\n\n" : ""),
  ).body!;
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const parts: T[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return parts;
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

void test("installed provider requests raw stream usage through Assistant composition and pins the receipt", async () => {
  let calls = 0;
  const raw = {
    run(receivedModel: string, inputs: Record<string, unknown>) {
      calls += 1;
      assert.equal(this, raw);
      assert.equal(receivedModel, model);
      assert.equal(inputs.stream, true);
      assert.equal(inputs.max_tokens, 128);
      assert.equal(inputs.reasoning_effort, "low");
      assert.deepEqual(inputs.stream_options, { include_usage: true });
      return Promise.resolve(
        sse([
          { choices: [{ delta: { content: "hello" }, finish_reason: null }], usage: null },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: null },
          { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
          { response: "", usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 } },
        ]),
      );
    },
  };
  const observed = fixture(raw as unknown as Ai);
  const provider = createWorkersAI({ binding: observed.binding });
  const result = await provider(model).doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "synthetic greeting" }] }],
    maxOutputTokens: 128,
    providerOptions: { "workers-ai": { reasoning_effort: "low" } },
  });
  observed.clearScope();
  const parts = await collect(result.stream);
  assert.ok(parts.some((part) => part.type === "text-delta" && part.delta === "hello"));
  assert.deepEqual(observed.receipts, [{ ...scope, inputTokens: 17, outputTokens: 3 }]);
  assert.deepEqual(observed.schedules, [[60, "reconcileInferenceUsage"]]);
  assert.equal(calls, 1);
});

void test("requesting usage never turns absent, partial or unterminated provider evidence into a receipt", async () => {
  for (const [usage, done] of [
    [undefined, true],
    [{ prompt_tokens: 17 }, true],
    [{ prompt_tokens: 17, completion_tokens: 3 }, false],
  ] as const) {
    const observed = fixture({
      run: () =>
        Promise.resolve(
          sse([{ choices: [{ delta: { content: "hello" }, finish_reason: "stop" }], usage }], done),
        ),
    } as unknown as Ai);
    const result = await createWorkersAI({ binding: observed.binding })(model).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "synthetic greeting" }] }],
    });
    const parts = await collect(result.stream);
    const finish = parts.find((part) => part.type === "finish");
    assert.ok(finish);
    if (usage === undefined) {
      assert.equal(finish.usage.inputTokens.total, 0, "the SDK synthesizes zero without raw usage");
      assert.equal(finish.usage.outputTokens.total, 0);
    }
    assert.deepEqual(observed.receipts, []);
    assert.deepEqual(observed.schedules, []);
  }
});

void test("binding adaptation preserves inputs/options and nonstreaming raw usage", async () => {
  const calls: unknown[][] = [];
  const raw = {
    run(...args: unknown[]) {
      assert.equal(this, raw);
      calls.push(args);
      return Promise.resolve({ usage: { prompt_tokens: 0, completion_tokens: 0 } });
    },
    get marker() {
      assert.equal(this, raw);
      return "binding-receiver";
    },
  };
  const observed = fixture(raw as unknown as Ai);
  const inputs = Object.freeze({
    messages: [{ role: "user", content: "synthetic greeting" }],
    stream: true,
    stream_options: Object.freeze({ include_usage: false, include_obfuscation: false }),
  });
  const options = { extraHeaders: { "x-session-affinity": "synthetic-session" } };
  await observed.binding.run(model, inputs, options);
  assert.deepEqual(calls[0], [
    model,
    { ...inputs, stream_options: { include_usage: true, include_obfuscation: false } },
    options,
  ]);
  assert.equal(inputs.stream_options.include_usage, false);
  const nonstreaming = { messages: inputs.messages, stream: false };
  await observed.binding.run(model, nonstreaming, options);
  assert.equal(calls[1]?.[1], nonstreaming);
  assert.equal(calls[1]?.[2], options);
  assert.equal(Reflect.get(observed.binding, "marker"), "binding-receiver");
  assert.deepEqual(observed.receipts, [
    { ...scope, inputTokens: 0, outputTokens: 0 },
    { ...scope, inputTokens: 0, outputTokens: 0 },
  ]);
});

void test("Summary composition requests streaming usage and persists only complete raw receipts", async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../../src/ai/summary/agent.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    plugins: [
      {
        name: "summary-usage-runtime-boundaries",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (
              args.importer.endsWith("/src/ai/summary/agent.ts") &&
              args.path !== "../inference" &&
              args.path !== "./usage"
            ) {
              return { path: args.path, external: true };
            }
          });
        },
      },
    ],
  });
  assert.ok(result.outputFiles[0]);
  type SummaryState = { scope: { policy: { budgetId: string } }; pendingUsage: Usage | null };
  type SummaryRuntime = { getAIBinding(): Ai; state: SummaryState };

  for (const usage of [undefined, { prompt_tokens: 23, completion_tokens: 7 }]) {
    const persisted: SummaryState[] = [];
    const schedules: unknown[][] = [];
    let calls = 0;
    const raw = {
      run(receivedModel: string, inputs: Record<string, unknown>) {
        calls += 1;
        assert.equal(this, raw);
        assert.equal(receivedModel, model);
        assert.equal(inputs.stream, true);
        assert.deepEqual(inputs.stream_options, { include_usage: true });
        return Promise.resolve(
          sse([
            { choices: [{ delta: { content: "synthetic summary" }, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
            { response: "", usage },
          ]),
        );
      },
    };
    const fixtureModule = {
      exports: {} as { SummaryAgent: new () => SummaryRuntime },
    };
    const evaluate = compileFunction(result.outputFiles[0].text, [
      "module",
      "exports",
      "require",
    ]) as (
      module: typeof fixtureModule,
      exports: typeof fixtureModule.exports,
      require: (name: string) => unknown,
    ) => void;
    evaluate(fixtureModule, fixtureModule.exports, (name) => {
      if (name !== "@cloudflare/think") return {};
      return {
        Think: class {
          state: SummaryState = {
            scope: { policy: { budgetId: "approved-synthetic-budget" } },
            pendingUsage: null,
          };
          getAIBinding() {
            return raw;
          }
          setState(state: SummaryState) {
            this.state = state;
            persisted.push(state);
          }
          schedule(...args: unknown[]) {
            assert.equal(persisted.length, 1, "persist raw evidence before scheduling settlement");
            schedules.push(args);
            return Promise.resolve();
          }
        },
      };
    });
    const agent = new fixtureModule.exports.SummaryAgent();
    const output = await createWorkersAI({ binding: agent.getAIBinding() })(model).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "synthetic summary request" }] }],
    });
    await collect(output.stream);
    assert.equal(calls, 1);
    assert.equal(persisted.length, usage ? 1 : 0);
    assert.deepEqual(agent.state.pendingUsage, usage ? { inputTokens: 23, outputTokens: 7 } : null);
    assert.deepEqual(schedules, usage ? [[60, "reconcileSummaryUsage"]] : []);
  }
});
