import type { Citation, SummaryAnalysis } from "../../contracts/analysis";
import { summaryAnalysisSchema } from "../../contracts/analysis";
import type { SummaryContext } from "./schema";
import { summaryContextSchema } from "./schema";

export function validateSummaryContext(input: unknown): SummaryContext {
  const context = summaryContextSchema.parse(input);
  const evidence = new Set(context.passages.map((passage) => passage.evidenceId));
  const people = new Set(context.people.map((person) => person.personId));

  if (evidence.size !== context.passages.length || people.size !== context.people.length) {
    throw new Error("Context contains duplicate evidence or profile identities.");
  }

  for (const passage of context.passages) {
    if (passage.assignment.kind === "person" && !people.has(passage.assignment.personId)) {
      throw new Error("Context is missing an assigned person's profile.");
    }
  }

  return context;
}

export function validateSummaryAnalysis(input: unknown, snapshot: SummaryContext): SummaryAnalysis {
  const context = validateSummaryContext(snapshot);
  const analysis = summaryAnalysisSchema.parse(input);
  const evidence = new Map(context.passages.map((passage) => [passage.evidenceId, passage]));
  const people = new Set(context.people.map((person) => person.personId));
  const tracks = new Set(context.passages.map((passage) => passage.providerTrackId));

  function person(id: string | null) {
    if (id !== null && !people.has(id)) {
      throw new Error("Analysis references a person outside the snapshot.");
    }
  }

  function citations(items: Citation[]) {
    for (const citation of items) {
      const passage = evidence.get(citation.evidenceId);

      if (!passage || !citation.quote.trim() || !passage.text.includes(citation.quote)) {
        throw new Error("Citation does not resolve to an exact snapshot quotation.");
      }
    }
  }

  const statements = [
    ...analysis.quickSummary,
    ...analysis.detailedSummary,
    ...analysis.decisions,
    ...analysis.nextSteps.map((item) => item.action),
    ...analysis.keyMoments.map((item) => item.significance),
    ...analysis.participants.flatMap((item) => item.contributions),
    ...analysis.engagement.observations,
    ...analysis.memoryCandidates.map((item) => item.observation),
  ];

  for (const statement of statements) {
    citations(statement.citations);
  }

  for (const participant of analysis.participants) {
    person(participant.personId);

    if (participant.providerTrackId !== null && !tracks.has(participant.providerTrackId)) {
      throw new Error("Analysis references a speaker outside the snapshot.");
    }

    if (participant.personId === null && participant.providerTrackId === null) {
      throw new Error("Participant requires a person or run-scoped speaker identity.");
    }
  }

  for (const action of analysis.nextSteps) {
    person(action.ownerPersonId);
  }

  for (const candidate of analysis.memoryCandidates) {
    person(candidate.personId);
  }

  if (analysis.agendaAssessment.length > 0) {
    throw new Error("This snapshot has no agenda to assess.");
  }

  for (const finding of analysis.overlapFindings) {
    if (finding.evidenceIds.some((id) => !evidence.has(id))) {
      throw new Error("Overlap finding references evidence outside the snapshot.");
    }
  }

  return analysis;
}
