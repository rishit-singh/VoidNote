import { SummaryOutputValidationError } from "./output";

/** Workflows wrap NonRetryableError across the durable step boundary. Match only
 * the application's fixed rejection text, never arbitrary provider diagnostics.
 */
export function summaryPublicationFailureMessage(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : undefined;
  const validationMessage = new SummaryOutputValidationError().message;

  if (
    error instanceof SummaryOutputValidationError ||
    message === validationMessage ||
    message === `NonRetryableError: ${validationMessage}` ||
    message ===
      `Step threw a NonRetryableError with message "NonRetryableError: ${validationMessage}"`
  ) {
    return "The generated Summary did not pass source-evidence validation. No automatic model retry was issued.";
  }

  return undefined;
}

export type SummaryFailureKind =
  "output_limit" | "missing_final_answer" | "interrupted" | "provider" | "schema";

export type SummaryFailureEvidence = {
  kind: SummaryFailureKind;
  confidence: "provider" | "inferred";
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  };
};

type SummaryUsageEvidence = NonNullable<SummaryFailureEvidence["usage"]>;

const SAFE_FINISH_REASON = /^[a-zA-Z0-9_.-]{1,40}$/;

function safeUsage(value: unknown): SummaryUsageEvidence | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const fields = ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"] as const;
  const usage = Object.fromEntries(
    fields.flatMap((field) =>
      typeof record[field] === "number" && Number.isSafeInteger(record[field]) && record[field] >= 0
        ? [[field, record[field]]]
        : [],
    ),
  ) as SummaryUsageEvidence;

  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Bounded protocol evidence only. Provider error strings are never retained. */
export function classifySummaryFailure(input: {
  finishReason?: unknown;
  outputTokenLimit?: number;
  finalAnswerPresent?: boolean;
  interrupted?: boolean;
  schemaFailure?: boolean;
  providerFailure?: boolean;
  usage?: unknown;
}): SummaryFailureEvidence {
  const finishReason =
    typeof input.finishReason === "string" && SAFE_FINISH_REASON.test(input.finishReason)
      ? input.finishReason
      : undefined;
  const usage = safeUsage(input.usage);
  const hasOutputCapEvidence =
    input.finalAnswerPresent === false &&
    typeof input.outputTokenLimit === "number" &&
    Number.isSafeInteger(input.outputTokenLimit) &&
    input.outputTokenLimit > 0 &&
    usage?.outputTokens === input.outputTokenLimit;
  const outputFinishReason = finishReason === "length" || finishReason === "max_tokens";
  const kind: SummaryFailureKind = input.schemaFailure
    ? "schema"
    : input.interrupted
      ? "interrupted"
      : outputFinishReason || hasOutputCapEvidence
        ? "output_limit"
        : input.finalAnswerPresent === false
          ? "missing_final_answer"
          : "provider";

  return {
    kind,
    confidence: outputFinishReason ? "provider" : hasOutputCapEvidence ? "inferred" : "provider",
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  };
}

export function summaryFailureMessage(evidence: SummaryFailureEvidence): string {
  switch (evidence.kind) {
    case "output_limit":
      return evidence.confidence === "inferred"
        ? "Summary generation likely reached the provider output limit; usage reached the configured cap without a final answer."
        : "Summary generation reached the provider output limit before a final answer was produced.";
    case "missing_final_answer":
      return "Summary generation ended without the required final answer.";
    case "interrupted":
      return "Summary inference was interrupted. No automatic model retry was issued.";
    case "schema":
      return "Summary generation returned an answer that did not match the required schema.";
    case "provider":
      return "The Summary provider failed before a valid answer was produced.";
  }
}

/** Map only known Think error signatures; arbitrary provider text stays private. */
export function classifyThinkSubmissionError(error: unknown): SummaryFailureKind | undefined {
  if (typeof error !== "string" || error.length > 512) {
    return undefined;
  }

  if (
    /think_final_answer.*(missing|required|not found)|(?:missing|required)[^.]{0,80}think_final_answer|final answer.*(missing|required|not found)/i.test(
      error,
    )
  ) {
    return "missing_final_answer";
  }

  if (/timeout|timed out|aborted|interrupted|cancelled/i.test(error)) {
    return "interrupted";
  }

  if (
    /(invalid|failed to parse|does not match).*(schema|output)|schema.*(invalid|fail)/i.test(error)
  ) {
    return "schema";
  }

  if (
    /provider|model (?:request|call) failed|inference (?:request )?failed|request failed/i.test(
      error,
    )
  ) {
    return "provider";
  }

  return undefined;
}
