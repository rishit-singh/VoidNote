export type ResearchRunEvidence = {
  sourceId: string;
  url: string;
  text: string;
  retrievedAt: string;
};

export type ResearchRunCitation = {
  sourceId: string;
  url: string;
  excerpt: string;
  startOffset: number;
  endOffset: number;
  retrievedAt: string;
};

/** Validate literal, exact citations; semantic entailment remains an explicit
 * review limitation and is never implied by this deterministic check. */
export function validateRunCitations(
  citations: ResearchRunCitation[],
  sources: ResearchRunEvidence[],
) {
  const byId = new Map(sources.map((source) => [source.sourceId, source]));

  for (const citation of citations) {
    const source = byId.get(citation.sourceId);

    if (!source || source.url !== citation.url || source.retrievedAt !== citation.retrievedAt) {
      return { valid: false as const, reason: "unknown-or-mismatched-source" };
    }

    if (
      !Number.isSafeInteger(citation.startOffset) ||
      !Number.isSafeInteger(citation.endOffset) ||
      citation.startOffset < 0 ||
      citation.endOffset <= citation.startOffset ||
      citation.endOffset > source.text.length ||
      source.text.slice(citation.startOffset, citation.endOffset) !== citation.excerpt
    ) {
      return { valid: false as const, reason: "excerpt-offset-mismatch" };
    }
  }

  return { valid: true as const };
}

export function classifyResearchTemporalScope(
  mode: "current" | "historical" | "unspecified",
  asOf?: string,
) {
  if (mode === "historical") {
    return { mode, asOf: asOf ?? null };
  }

  if (mode === "current") {
    return { mode, asOf: null };
  }

  return { mode, asOf: null };
}
