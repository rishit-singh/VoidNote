// Proof-only visibility. No payloads, arbitrary field names, headers, errors,
// prompts or text leave this parser. This never creates accounting receipts.
const MAX_EVENT_CHARACTERS = 65_536;
const MAX_USAGE_SAMPLES = 8;
const tokenKeys = [
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "inputTokens",
  "outputTokens",
] as const;
type Shape = "missing" | "null" | "array" | "object" | "number" | "string" | "boolean" | "other";
type UsageSample = {
  location: "usage" | "result.usage" | "response.usage" | "usage_metadata" | "token_usage";
  shape: Shape;
  fields: Partial<Record<(typeof tokenKeys)[number], { shape: Shape; count: number | null }>>;
};
type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "function_call"
  | "content_filter"
  | "other"
  | "missing"
  | "null";
type UsageCounts = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};
type UsageSum = { frames: number; promptTokens: number | null; completionTokens: number | null };
type LastUsage = UsageCounts & {
  jsonFrame: number;
  usageShape: Shape;
  responseShape: Shape;
  responseEmpty: boolean | null;
  choicesLength: number | null;
  firstChoiceHasDelta: boolean;
  finishReason: FinishReason;
  objectKind: "chat.completion" | "chat.completion.chunk" | "other" | "missing";
};
export type UsageDiagnostic = {
  version: 1;
  request: { stream: boolean; includeUsage: boolean | null };
  transport: "unknown" | "stream" | "response" | "object" | "other";
  outcome: "object" | "eof" | "cancelled" | "binding-error" | "stream-error";
  chunks: number;
  bytes: number;
  dataEvents: number;
  jsonFrames: number;
  malformedEvents: number;
  oversizedEvents: number;
  doneLines: number;
  doneEvents: number;
  choicesFrames: number;
  textShapeFrames: number;
  errorFrames: number;
  completedTypeFrames: number;
  usageFields: number;
  completeTopLevelUsage: number;
  conflictingTopLevelUsage: boolean;
  lastTopLevelUsageComplete: boolean;
  lastTopLevelUsage: LastUsage | null;
  // Arithmetic diagnostics only. These are NOT inferred deltas or accounting receipts.
  diagnosticOnlyUsageSums: { all: UsageSum; choices: UsageSum; nonChoices: UsageSum };
  trailingPartialEvent: boolean;
  usageSamples: UsageSample[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function shape(value: unknown): Shape {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  return ["object", "number", "string", "boolean"].includes(type) ? (type as Shape) : "other";
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finishReason(value: unknown): FinishReason {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  return typeof value === "string" &&
    ["stop", "length", "tool_calls", "function_call", "content_filter"].includes(value)
    ? (value as FinishReason)
    : "other";
}

function addUsage(sum: UsageSum, input: number, output: number) {
  sum.frames += 1;
  sum.promptTokens = sum.promptTokens === null ? null : count(sum.promptTokens + input);
  sum.completionTokens =
    sum.completionTokens === null ? null : count(sum.completionTokens + output);
}

function inspector(inputs: unknown) {
  const input = record(inputs);
  const streamOptions = record(input?.stream_options);
  const diagnostic: UsageDiagnostic = {
    version: 1,
    request: {
      stream: input?.stream === true,
      includeUsage:
        typeof streamOptions?.include_usage === "boolean" ? streamOptions.include_usage : null,
    },
    transport: "unknown",
    outcome: "object",
    chunks: 0,
    bytes: 0,
    dataEvents: 0,
    jsonFrames: 0,
    malformedEvents: 0,
    oversizedEvents: 0,
    doneLines: 0,
    doneEvents: 0,
    choicesFrames: 0,
    textShapeFrames: 0,
    errorFrames: 0,
    completedTypeFrames: 0,
    usageFields: 0,
    completeTopLevelUsage: 0,
    conflictingTopLevelUsage: false,
    lastTopLevelUsageComplete: false,
    lastTopLevelUsage: null,
    diagnosticOnlyUsageSums: {
      all: { frames: 0, promptTokens: 0, completionTokens: 0 },
      choices: { frames: 0, promptTokens: 0, completionTokens: 0 },
      nonChoices: { frames: 0, promptTokens: 0, completionTokens: 0 },
    },
    trailingPartialEvent: false,
    usageSamples: [],
  };
  let prior: [number, number] | undefined;
  function frame(value: unknown) {
    diagnostic.jsonFrames += 1;
    const object = record(value);
    if (!object) return;
    if (Array.isArray(object.choices)) diagnostic.choicesFrames += 1;
    if (typeof object.response === "string" || typeof object.text === "string") {
      diagnostic.textShapeFrames += 1;
    }
    if ("error" in object || object.type === "error") diagnostic.errorFrames += 1;
    if (object.type === "response.completed" || object.type === "message_stop") {
      diagnostic.completedTypeFrames += 1;
    }
    const locations: [UsageSample["location"], Record<string, unknown> | undefined, string][] = [
      ["usage", object, "usage"],
      ["result.usage", record(object.result), "usage"],
      ["response.usage", record(object.response), "usage"],
      ["usage_metadata", object, "usage_metadata"],
      ["token_usage", object, "token_usage"],
    ];
    for (const [location, parent, key] of locations) {
      if (!parent || !(key in parent)) continue;
      diagnostic.usageFields += 1;
      const usage = record(parent[key]);
      if (diagnostic.usageSamples.length < MAX_USAGE_SAMPLES) {
        const fields: UsageSample["fields"] = {};
        for (const tokenKey of tokenKeys) {
          if (usage && tokenKey in usage) {
            fields[tokenKey] = { shape: shape(usage[tokenKey]), count: count(usage[tokenKey]) };
          }
        }
        const sample = { location, shape: shape(parent[key]), fields };
        if (
          !diagnostic.usageSamples.some((prior) => JSON.stringify(prior) === JSON.stringify(sample))
        ) {
          diagnostic.usageSamples.push(sample);
        }
      }
      if (location === "usage") {
        const inputCount = count(usage?.prompt_tokens);
        const outputCount = count(usage?.completion_tokens);
        const choices = Array.isArray(object.choices) ? object.choices : undefined;
        const firstChoice = record(choices?.[0]);
        diagnostic.lastTopLevelUsage = {
          jsonFrame: diagnostic.jsonFrames,
          usageShape: shape(parent[key]),
          promptTokens: inputCount,
          completionTokens: outputCount,
          totalTokens: count(usage?.total_tokens),
          responseShape: shape(object.response),
          responseEmpty: typeof object.response === "string" ? object.response.length === 0 : null,
          choicesLength: choices?.length ?? null,
          firstChoiceHasDelta: firstChoice !== undefined && "delta" in firstChoice,
          finishReason: finishReason(
            "finish_reason" in object ? object.finish_reason : firstChoice?.finish_reason,
          ),
          objectKind:
            object.object === "chat.completion" || object.object === "chat.completion.chunk"
              ? object.object
              : object.object === undefined
                ? "missing"
                : "other",
        };
        diagnostic.lastTopLevelUsageComplete =
          inputCount !== null &&
          outputCount !== null &&
          inputCount <= 2_147_483_647 &&
          outputCount <= 2_147_483_647;
        if (diagnostic.lastTopLevelUsageComplete && inputCount !== null && outputCount !== null) {
          diagnostic.completeTopLevelUsage += 1;
          addUsage(diagnostic.diagnosticOnlyUsageSums.all, inputCount, outputCount);
          addUsage(
            choices
              ? diagnostic.diagnosticOnlyUsageSums.choices
              : diagnostic.diagnosticOnlyUsageSums.nonChoices,
            inputCount,
            outputCount,
          );
          if (prior && (prior[0] !== inputCount || prior[1] !== outputCount)) {
            diagnostic.conflictingTopLevelUsage = true;
          }
          prior = [inputCount, outputCount];
        }
      }
    }
  }

  const decoder = new TextDecoder();
  let line = "";
  let data = "";
  let characters = 0;
  let oversized = false;
  let lineHasCharacters = false;
  let skipLf = false;
  function endLine() {
    if (!lineHasCharacters) {
      if (oversized) {
        diagnostic.oversizedEvents += 1;
      } else if (data) {
        diagnostic.dataEvents += 1;
        if (data.trim() === "[DONE]") {
          diagnostic.doneEvents += 1;
        } else {
          try {
            frame(JSON.parse(data));
          } catch {
            diagnostic.malformedEvents += 1;
          }
        }
      }
      data = "";
      characters = 0;
      oversized = false;
    } else if (!oversized && (line === "data" || line.startsWith("data:"))) {
      const value = line === "data" ? "" : line.slice(5).replace(/^ /, "");
      if (value.trim() === "[DONE]") diagnostic.doneLines += 1;
      data += `${value}\n`;
    }
    line = "";
    lineHasCharacters = false;
  }
  function consume(text: string) {
    for (const character of text) {
      if (skipLf && character === "\n") {
        skipLf = false;
        continue;
      }
      skipLf = false;
      if (character === "\r" || character === "\n") {
        endLine();
        skipLf = character === "\r";
      } else {
        lineHasCharacters = true;
        characters += character.length;
        if (characters > MAX_EVENT_CHARACTERS) {
          oversized = true;
          line = "";
          data = "";
        } else if (!oversized) {
          line += character;
        }
      }
    }
  }
  return {
    diagnostic,
    frame,
    chunk(chunk: Uint8Array) {
      diagnostic.chunks += 1;
      diagnostic.bytes += chunk.byteLength;
      for (let offset = 0; offset < chunk.byteLength; offset += 4096) {
        consume(decoder.decode(chunk.subarray(offset, offset + 4096), { stream: true }));
      }
    },
    finish() {
      consume(decoder.decode());
      diagnostic.trailingPartialEvent = lineHasCharacters || Boolean(data) || oversized;
      // Identify an unframed final sentinel without treating it as a complete event.
      if (line.trim() === "data: [DONE]") diagnostic.doneLines += 1;
      line = "";
      data = "";
    },
  };
}

/**
 * Place below requestInferenceStreamUsage to inspect the actual injected flag.
 * Summary proof subclass: override observeSummaryAIBinding(binding) and pass
 * observeUsageDiagnostics(binding, report) into super.observeSummaryAIBinding.
 * Reports are metadata only; the caller owns proof-local logging/persistence.
 */
export function observeUsageDiagnostics(
  binding: Ai,
  report: (diagnostic: UsageDiagnostic) => void | Promise<void>,
): Ai {
  return new Proxy(binding, {
    get(target, property) {
      if (property !== "run") {
        const value: unknown = Reflect.get(target, property, target);
        const bound: unknown = typeof value === "function" ? value.bind(target) : value;
        return bound;
      }
      return async (...args: Parameters<Ai["run"]>) => {
        const inspection = inspector(args[1]);
        const diagnostic = inspection.diagnostic;
        let reported = false;
        async function finish(outcome: UsageDiagnostic["outcome"]) {
          if (reported) return;
          reported = true;
          inspection.finish();
          diagnostic.outcome = outcome;
          try {
            await report(diagnostic);
          } catch {
            // Diagnostic sink failure must not change provider/accounting outcomes.
          }
        }
        let response: unknown;
        try {
          response = await Reflect.apply(target.run.bind(target), target, args);
        } catch (error) {
          await finish("binding-error");
          throw error;
        }
        if (!(response instanceof ReadableStream)) {
          diagnostic.transport =
            response instanceof Response ? "response" : record(response) ? "object" : "other";
          inspection.frame(response);
          await finish("object");
          return response;
        }
        diagnostic.transport = "stream";
        const reader = (response as ReadableStream<Uint8Array>).getReader();
        return new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                const next = await reader.read();
                if (next.done) {
                  await finish("eof");
                  reader.releaseLock();
                  controller.close();
                } else {
                  inspection.chunk(next.value);
                  controller.enqueue(next.value);
                }
              } catch (error) {
                await finish("stream-error");
                reader.releaseLock();
                controller.error(error);
              }
            },
            async cancel(reason: unknown) {
              try {
                await reader.cancel(reason);
              } finally {
                await finish("cancelled");
                reader.releaseLock();
              }
            },
          },
          { highWaterMark: 0 },
        );
      };
    },
  });
}
