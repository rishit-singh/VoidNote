import { z } from "zod";

import type { Citation, SummaryAnalysis } from "../../contracts/analysis";
import { citationSchema } from "../../contracts/analysis";
import { idSchema } from "../../contracts/workspace";
import type { SummaryContext } from "../context";
import { validateSummaryAnalysis, validateSummaryContext } from "../context";
import { summaryWordBudget, summaryWordCount } from "./limits.ts";

const claimIdSchema = z.string().min(1).max(80);
const witnessesSchema = z.array(citationSchema).max(10);

// Private v5 model contract. Context-dependent checks belong in the projection,
// leaving the model schema strict and representable as JSON Schema.
export const summaryDraftSchema = z
  .object({
    claims: z
      .array(
        z
          .object({
            id: claimIdSchema,
            text: z.string().min(1).max(1000),
            support: z.array(citationSchema).min(1).max(10),
          })
          .strict(),
      )
      .min(1)
      .max(40),
    quickSummary: z.array(claimIdSchema).min(1).max(3),
    detailedSummary: z.array(claimIdSchema).min(1).max(4),
    decisions: z.array(claimIdSchema).max(12),
    actionCandidates: z
      .array(
        z
          .object({
            claimId: claimIdSchema,
            disposition: z.enum([
              "commitment",
              "assignment",
              "proposal",
              "question",
              "status",
              "rejected",
            ]),
            commitmentEvidence: witnessesSchema,
            ownerPersonId: idSchema.nullable(),
            ownerEvidence: witnessesSchema,
            dueDate: z.string().min(1).max(100).nullable(),
            dueDateEvidence: witnessesSchema,
          })
          .strict(),
      )
      .max(12),
    keywords: z.array(z.string().min(1).max(100)).max(12),
    keyMoments: z
      .array(z.object({ title: z.string().min(1).max(200), claimId: claimIdSchema }).strict())
      .max(2),
    uncertainties: z.array(z.string().min(1).max(2000)).max(6),
  })
  .strict();

// Only v6 adds model-facing guidance. Keep the v5 JSON Schema and projection
// unchanged; descriptions clarify the contract without accepting or repairing prose.
export const summaryDraftV6Schema = summaryDraftSchema.extend({
  quickSummary: summaryDraftSchema.shape.quickSummary.describe(
    'Existing claims[].id values only, for example ["c1"]. Never prose or claim objects.',
  ),
  detailedSummary: summaryDraftSchema.shape.detailedSummary.describe(
    'Existing claims[].id values only, for example ["c2"]. Use distinct claims from quickSummary; never prose or claim objects.',
  ),
  decisions: summaryDraftSchema.shape.decisions.describe(
    'Existing claims[].id values for established decisions only, for example ["c3"]. Put decision prose in claims[].text, not here. Every ID must match a claim. Use [] if none.',
  ),
});

export const summaryDraftV7Schema = summaryDraftV6Schema.extend({
  quickSummary: z
    .array(claimIdSchema)
    .length(1)
    .describe(
      'Exactly one existing claims[].id, for example ["c1"]. Select a short supported claim within the rendered total word budget. Never prose or claim objects.',
    ),
  detailedSummary: z
    .array(claimIdSchema)
    .max(1)
    .describe(
      "Zero or one existing claims[].id, distinct from quickSummary. Use [] unless a nonduplicated detail fits the remaining rendered word budget. Never prose or claim objects.",
    ),
});

function containsDisplayName(quote: string, name: string): boolean {
  if (!name.trim()) {
    return false;
  }

  let offset = quote.indexOf(name);

  while (offset !== -1) {
    const before = Array.from(quote.slice(0, offset)).at(-1) ?? "";
    const after = Array.from(quote.slice(offset + name.length))[0] ?? "";

    // Literal, case-sensitive name boundaries only: Ada must not match Adam.
    // This is not a test of assignment, reference resolution or entailment.
    if (!/[\p{L}\p{N}\p{M}_]/u.test(before) && !/[\p{L}\p{N}\p{M}_]/u.test(after)) {
      return true;
    }

    offset = quote.indexOf(name, offset + 1);
  }

  return false;
}

function distinctCitations(items: Citation[]): Citation[] {
  const seen = new Set<string>();

  return items.filter((citation) => {
    const key = JSON.stringify([citation.evidenceId, citation.quote]);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

export function projectSummaryDraft(input: unknown, snapshot: SummaryContext): SummaryAnalysis {
  return projectDraft(summaryDraftSchema.parse(input), snapshot);
}

export function projectSummaryDraftV7(input: unknown, snapshot: SummaryContext): SummaryAnalysis {
  return projectDraft(summaryDraftV7Schema.parse(input), snapshot);
}

function projectDraft(
  draft: z.infer<typeof summaryDraftSchema>,
  snapshot: SummaryContext,
): SummaryAnalysis {
  const context = validateSummaryContext(snapshot);
  const passages = new Map(context.passages.map((passage) => [passage.evidenceId, passage]));
  const people = new Map(context.people.map((person) => [person.personId, person]));
  const claims = new Map<string, (typeof draft.claims)[number]>();
  const texts = new Set<string>();

  function citations(items: Citation[]) {
    for (const citation of items) {
      const passage = passages.get(citation.evidenceId);

      if (!passage || !citation.quote.trim() || !passage.text.includes(citation.quote)) {
        throw new Error("Summary draft citation does not resolve to an exact snapshot quotation.");
      }
    }
  }

  for (const claim of draft.claims) {
    if (!claim.id.trim() || !claim.text.trim()) {
      throw new Error("Summary draft claim IDs and text must not be blank.");
    }

    if (claims.has(claim.id)) {
      throw new Error("Summary draft contains duplicate claim IDs.");
    }

    if (texts.has(claim.text)) {
      throw new Error("Summary draft contains duplicate claim text.");
    }

    citations(claim.support);
    claims.set(claim.id, claim);
    texts.add(claim.text);
  }

  function claimFor(id: string) {
    const claim = claims.get(id);

    if (!claim) {
      throw new Error("Summary draft contains a dangling claim ID.");
    }

    return claim;
  }

  function selection(ids: string[], section: string) {
    if (new Set(ids).size !== ids.length) {
      throw new Error(`Summary draft contains duplicate selected IDs in ${section}.`);
    }

    for (const id of ids) {
      claimFor(id);
    }
  }

  selection(draft.quickSummary, "quickSummary");
  selection(draft.detailedSummary, "detailedSummary");
  selection(draft.decisions, "decisions");
  selection(
    draft.actionCandidates.map((candidate) => candidate.claimId),
    "actionCandidates",
  );
  selection(
    draft.keyMoments.map((moment) => moment.claimId),
    "keyMoments",
  );

  if (draft.quickSummary.some((id) => draft.detailedSummary.includes(id))) {
    throw new Error("Summary draft reuses a claim across quick and detailed summaries.");
  }

  for (const candidate of draft.actionCandidates) {
    citations(candidate.commitmentEvidence);
    citations(candidate.ownerEvidence);
    citations(candidate.dueDateEvidence);

    const publishable =
      candidate.disposition === "commitment" || candidate.disposition === "assignment";

    if (publishable && candidate.commitmentEvidence.length === 0) {
      throw new Error("Summary draft commitment or assignment requires commitment evidence.");
    }

    if (candidate.ownerPersonId === null) {
      if (candidate.ownerEvidence.length !== 0) {
        throw new Error("Summary draft null owner must have no owner evidence.");
      }
    } else {
      const person = people.get(candidate.ownerPersonId);

      if (!person) {
        throw new Error("Summary draft references a person outside the snapshot.");
      }

      if (candidate.ownerEvidence.length === 0) {
        throw new Error("Summary draft owner requires owner evidence.");
      }

      // This checks an identity anchor, not who semantically owns an action.
      // Even a literal name mention or assigned speaker can quote someone else.
      const anchored = candidate.ownerEvidence.some((citation) => {
        const passage = passages.get(citation.evidenceId)!;

        return (
          (passage.assignment.kind === "person" &&
            passage.assignment.personId === person.personId) ||
          containsDisplayName(citation.quote, person.displayName)
        );
      });

      if (!anchored) {
        throw new Error("Summary draft owner evidence lacks an assigned person or exact name.");
      }
    }

    if (candidate.dueDate === null) {
      if (candidate.dueDateEvidence.length !== 0) {
        throw new Error("Summary draft null due date must have no due date evidence.");
      }
    } else if (!candidate.dueDate.trim() || candidate.dueDateEvidence.length === 0) {
      throw new Error("Summary draft due date requires a nonblank date and due date evidence.");
    }
  }

  const { sourceWords, maxSummaryWords } = summaryWordBudget(context);
  const summaryWords = [...draft.quickSummary, ...draft.detailedSummary].reduce(
    (total, id) => total + summaryWordCount(claimFor(id).text),
    0,
  );

  if (summaryWords > maxSummaryWords) {
    throw new Error(
      `Summary draft exceeds compression limit: ${summaryWords} summary words; maximum ${maxSummaryWords} for ${sourceWords} source words.`,
    );
  }

  function statement(id: string, witnesses: Citation[] = []) {
    const claim = claimFor(id);

    return {
      text: claim.text,
      citations: distinctCitations([...claim.support, ...witnesses]),
    };
  }

  const analysis: SummaryAnalysis = {
    quickSummary: draft.quickSummary.map((id) => statement(id)),
    detailedSummary: draft.detailedSummary.map((id) => statement(id)),
    decisions: draft.decisions.map((id) => statement(id)),
    nextSteps: draft.actionCandidates
      .filter(
        (candidate) =>
          candidate.disposition === "commitment" || candidate.disposition === "assignment",
      )
      .map((candidate) => ({
        action: statement(candidate.claimId, [
          ...candidate.commitmentEvidence,
          ...candidate.ownerEvidence,
          ...candidate.dueDateEvidence,
        ]),
        ownerPersonId: candidate.ownerPersonId,
        dueDate: candidate.dueDate,
      })),
    keywords: draft.keywords,
    keyMoments: draft.keyMoments.map((moment) => ({
      title: moment.title,
      significance: statement(moment.claimId),
    })),
    uncertainties: draft.uncertainties,
    participants: [],
    engagement: { observations: [], limitations: [] },
    agendaAssessment: [],
    memoryCandidates: [],
    overlapFindings: [],
  };

  return validateSummaryAnalysis(analysis, context);
}
