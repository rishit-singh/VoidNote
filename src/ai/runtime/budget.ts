import type { SummaryPolicy } from "./policy";

// Checked 2026-11-23 against the Cloudflare model entry. Reserve the entire
// supported input window, not an optimistic character-to-token estimate.
export const summaryBudgetPricing = {
  model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  contextWindowTokens: 1_048_576,
  maxOutputTokens: 8192,
  inputMicroUsdPerMillionTokens: 300_000,
  outputMicroUsdPerMillionTokens: 1_200_000,
} as const;

export type SummaryUsage = { inputTokens: number; outputTokens: number };

// Conservative text-only estimate: one token per UTF-8 byte of the final SDK
// prompt + tool schemas, plus room for provider chat/tool framing. This is an
// admission estimate, not a tokenizer or a provider-side dollar cap.
const REQUEST_FRAMING_TOKENS = 2048;

export function summaryInputTokenBound(request: { prompt: unknown; tools?: unknown }): number {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ prompt: request.prompt, tools: request.tools }),
  ).byteLength;
  const bound = bytes + REQUEST_FRAMING_TOKENS;
  if (bound > summaryBudgetPricing.contextWindowTokens) {
    throw new Error("Summary request exceeds the supported input allowance.");
  }

  return bound;
}

export function validSummaryUsage(usage: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}): usage is SummaryUsage {
  return [usage.inputTokens, usage.outputTokens].every(
    (value) =>
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 2_147_483_647,
  );
}

export function summaryUsageMicroUsd(model: string, usage: SummaryUsage): number {
  if (model !== summaryBudgetPricing.model || !validSummaryUsage(usage)) {
    throw new Error("Summary usage is not covered by the configured pricing.");
  }

  return Math.ceil(
    (usage.inputTokens * summaryBudgetPricing.inputMicroUsdPerMillionTokens +
      usage.outputTokens * summaryBudgetPricing.outputMicroUsdPerMillionTokens) /
      1_000_000,
  );
}

export function summaryReservationMicroUsd(
  policy: SummaryPolicy,
  inputTokenBound: number = summaryBudgetPricing.contextWindowTokens,
): number {
  if (
    policy.model !== summaryBudgetPricing.model ||
    policy.maxSteps !== 1 ||
    policy.maxOutputTokens > summaryBudgetPricing.maxOutputTokens ||
    !Number.isSafeInteger(inputTokenBound) ||
    inputTokenBound < 1 ||
    inputTokenBound > summaryBudgetPricing.contextWindowTokens
  ) {
    throw new Error("Summary policy is not covered by this inference allowance.");
  }

  return summaryUsageMicroUsd(policy.model, {
    inputTokens: inputTokenBound,
    outputTokens: policy.maxOutputTokens,
  });
}
