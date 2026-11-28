import { type SummaryUsage, validSummaryUsage } from "../runtime/budget";

// Usage is normally a small terminal SSE event. Oversized events are forwarded
// unchanged but cannot supply accounting evidence. Never persist response text.
const MAX_EVENT_CHARACTERS = 65_536;
const DECODE_SLICE_BYTES = 4096;

type UsageObserver = (usage: SummaryUsage) => void | Promise<void>;

function rawSummaryUsage(value: unknown): SummaryUsage | undefined {
  if (typeof value !== "object" || value === null || !("usage" in value)) {
    return;
  }

  const usage = value.usage;
  if (
    typeof usage !== "object" ||
    usage === null ||
    !("prompt_tokens" in usage) ||
    !("completion_tokens" in usage) ||
    typeof usage.prompt_tokens !== "number" ||
    typeof usage.completion_tokens !== "number"
  ) {
    return;
  }

  const counts = { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };

  return validSummaryUsage(counts) ? counts : undefined;
}

function streamRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNativeStreamTotal(value: unknown): boolean {
  const frame = streamRecord(value);

  return frame !== undefined && !("choices" in frame) && frame.response === "";
}

function usageStream(
  observer: UsageObserver,
  workersAI: boolean,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let line = "";
  let data = "";
  let eventCharacters = 0;
  let oversized = false;
  let lineHasCharacters = false;
  let skipLf = false;
  let completed = false;
  let candidate: SummaryUsage | undefined;
  let conflicting = false;
  let lastUsageComplete = false;
  let sawWorkersChoices = false;
  let nativeTotal = false;
  let choicesAfterTotal = false;

  function endLine() {
    if (!lineHasCharacters) {
      const payload = oversized ? "" : data;
      data = "";
      eventCharacters = 0;
      oversized = false;
      if (payload) {
        if (payload.trim() === "[DONE]") {
          completed = true;

          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          // Never log malformed provider payloads.
          return;
        }

        // Workers AI's run-path hybrid includes choices deltas, finish-only
        // choices and an empty-choices heartbeat. Their usage is NOT the total
        // (the heartbeat can explicitly report zero). Only the later native
        // { response: "", usage } tail is authoritative for this protocol.
        // See Agents' models/core/chat-completions/stream normalizer. Never
        // sum choices usage or compare it with the native cumulative receipt.
        if (workersAI && Array.isArray(streamRecord(parsed)?.choices)) {
          sawWorkersChoices = true;
          choicesAfterTotal ||= candidate !== undefined;

          return;
        }

        const usage = rawSummaryUsage(parsed);
        if (typeof parsed === "object" && parsed !== null && "usage" in parsed) {
          lastUsageComplete = usage !== undefined;
        }

        if (usage) {
          if (
            candidate &&
            (candidate.inputTokens !== usage.inputTokens ||
              candidate.outputTokens !== usage.outputTokens)
          ) {
            conflicting = true;
          }

          candidate = usage;
          nativeTotal = isNativeStreamTotal(parsed);
        }
      }
    } else if (!oversized && (line === "data" || line.startsWith("data:"))) {
      const value = line === "data" ? "" : line.slice(5).replace(/^ /, "");
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
        eventCharacters += character.length;
        if (eventCharacters > MAX_EVENT_CHARACTERS) {
          oversized = true;
          line = "";
          data = "";
        } else if (!oversized) {
          line += character;
        }
      }
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      for (let offset = 0; offset < chunk.byteLength; offset += DECODE_SLICE_BYTES) {
        consume(
          decoder.decode(chunk.subarray(offset, offset + DECODE_SLICE_BYTES), { stream: true }),
        );
      }

      controller.enqueue(chunk);
    },
    async flush() {
      consume(decoder.decode());
      // Wait for clean EOF as well as [DONE]; a failed stream or conflicting
      // reports cannot release a hold. Partial trailing events are uncertain.
      if (
        completed &&
        !conflicting &&
        lastUsageComplete &&
        candidate &&
        (!sawWorkersChoices || nativeTotal) &&
        !choicesAfterTotal &&
        !lineHasCharacters &&
        !data &&
        !oversized
      ) {
        await observer(candidate);
      }
    },
  });
}

/** Observe raw binding responses before the adapter can synthesize zero usage. */
export function observeSummaryUsage(binding: Ai, observer: UsageObserver): Ai {
  return new Proxy(binding, {
    get(target, property) {
      if (property === "run") {
        return async (...args: Parameters<Ai["run"]>) => {
          const response: unknown = await Reflect.apply(target.run.bind(target), target, args);
          if (response instanceof ReadableStream) {
            return response.pipeThrough(usageStream(observer, args[0].startsWith("@cf/")));
          }

          const usage = rawSummaryUsage(response);
          if (usage) {
            await observer(usage);
          }

          return response;
        };
      }

      // Workers bindings can require their original receiver, including getters.
      const value: unknown = Reflect.get(target, property, target);
      const bound: unknown = typeof value === "function" ? value.bind(target) : value;

      return bound;
    },
  });
}
