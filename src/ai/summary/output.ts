import type { z } from "zod";

import { summaryAnalysisV1Schema } from "../../contracts/analysis";
import type { SummaryContext } from "../context";
import { validateSummaryAnalysis } from "../context";
import {
  projectSummaryDraft,
  projectSummaryDraftV7,
  summaryDraftSchema,
  summaryDraftV6Schema,
  summaryDraftV7Schema,
} from "./draft";
import { resolveSummaryPrompt } from "./instructions";

export class SummaryOutputValidationError extends Error {
  constructor() {
    super("Summary output did not meet its pinned evidence and compression requirements.");
    this.name = "SummaryOutputValidationError";
  }
}

// Select the private model contract and its publication interpretation together
// from the immutable job pin. Saved summaries keep their existing public DTO.
export function summaryModelOutputSchema(version: string): z.ZodObject {
  resolveSummaryPrompt(version);

  if (version === "summary-v7" || version === "summary-v8") {
    return summaryDraftV7Schema;
  }

  if (version === "summary-v6") {
    return summaryDraftV6Schema;
  }

  return version === "summary-v5" ? summaryDraftSchema : summaryAnalysisV1Schema;
}

export function interpretSummaryOutput(version: string, input: unknown, context: SummaryContext) {
  resolveSummaryPrompt(version);
  try {
    if (version === "summary-v7" || version === "summary-v8") {
      return projectSummaryDraftV7(input, context);
    }

    return version === "summary-v5" || version === "summary-v6"
      ? projectSummaryDraft(input, context)
      : validateSummaryAnalysis(summaryAnalysisV1Schema.parse(input), context);
  } catch {
    // Validation diagnostics may embed private source/model text. Expose only a
    // stable domain error; the durable submission retains the private draft.
    throw new SummaryOutputValidationError();
  }
}
