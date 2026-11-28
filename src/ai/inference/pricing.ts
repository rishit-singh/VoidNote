export const INFERENCE_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
export const INFERENCE_MAX_TOKENS = 2_147_483_647;
const TOKENS_PER_MILLION = 1_000_000n;

const REQUEST_FRAMING_TOKENS = 2048;

export type InferenceRate = {
  id: string;
  provider: string;
  model: string;
  currency: "USD";
  inputMicroUsdPerMillionTokens: number;
  outputMicroUsdPerMillionTokens: number;
};

export type InferenceUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type InferenceRequestPolicy = {
  maxInputTokens: number;
  maxOutputTokens: number;
  contextWindowTokens: number;
};

export function validInferenceTokenCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= INFERENCE_MAX_TOKENS
  );
}

export function validInferenceUsage(value: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}): value is InferenceUsage {
  return (
    validInferenceTokenCount(value.inputTokens) && validInferenceTokenCount(value.outputTokens)
  );
}

/** Round once, upwards, without losing precision in rate × token multiplication. */
export function inferenceUsageMicroUsd(rate: InferenceRate, usage: InferenceUsage): number {
  if (
    rate.currency !== "USD" ||
    ![rate.inputMicroUsdPerMillionTokens, rate.outputMicroUsdPerMillionTokens].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    !validInferenceUsage(usage)
  ) {
    throw new Error("Inference pricing or usage is invalid.");
  }

  const numerator =
    BigInt(usage.inputTokens) * BigInt(rate.inputMicroUsdPerMillionTokens) +
    BigInt(usage.outputTokens) * BigInt(rate.outputMicroUsdPerMillionTokens);

  const cost = (numerator + TOKENS_PER_MILLION - 1n) / TOKENS_PER_MILLION;

  if (cost > BigInt(INFERENCE_MAX_SAFE_INTEGER)) {
    throw new Error("Inference cost exceeds the supported accounting range.");
  }

  return Number(cost);
}

/**
 * Conservative text-only estimate of the final SDK prompt and tool schemas.
 * Includes history/tool results and framing; never truncates to fit policy.
 * This is an admission bound, not a tokenizer or provider-side spending cap.
 */
export function inferenceInputTokenBound(
  request: { prompt: unknown; tools?: unknown },
  policy: InferenceRequestPolicy,
): number {
  if (
    ![policy.maxInputTokens, policy.maxOutputTokens, policy.contextWindowTokens].every(
      (value) => validInferenceTokenCount(value) && value > 0,
    ) ||
    request.prompt === undefined
  ) {
    throw new Error("Inference request policy is invalid.");
  }

  const serialized = JSON.stringify(
    { prompt: request.prompt, tools: request.tools },
    (_key, value: unknown) => {
      if (
        typeof value === "function" ||
        typeof value === "symbol" ||
        (typeof value === "number" && !Number.isFinite(value)) ||
        (typeof value === "object" &&
          value !== null &&
          (ArrayBuffer.isView(value) ||
            value instanceof ArrayBuffer ||
            ("type" in value && (value.type === "image" || value.type === "file"))))
      ) {
        throw new Error("Inference estimation supports JSON text requests only.");
      }

      return value;
    },
  );

  const bound = new TextEncoder().encode(serialized).byteLength + REQUEST_FRAMING_TOKENS;

  if (
    bound > policy.maxInputTokens ||
    bound + policy.maxOutputTokens > policy.contextWindowTokens
  ) {
    throw new Error("Inference request exceeds the pinned token policy.");
  }

  return bound;
}
