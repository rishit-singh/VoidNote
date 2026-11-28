import type { ResearchRunDetail, ResearchRunExecutionKey } from "../../../contracts/research/runs";
import { validateRunCitations } from "./validation";

export type RunSource = {
  id: string;
  requestedUrl: string;
  url: string;
  text: string;
  retrievedAt: string;
  digest: string;
};

export type RunQuestion = { id: string; operationId: string; question: string };

export type RunSynthesisPort = {
  synthesize(input: {
    key: ResearchRunExecutionKey;
    question: RunQuestion;
    sources: RunSource[];
    signal: AbortSignal;
  }): Promise<ResearchRunDetail["findings"][number]>;
};

export type RunCheckpointPort = {
  saveFinding(
    key: ResearchRunExecutionKey,
    questionId: string,
    finding: ResearchRunDetail["findings"][number],
  ): Promise<boolean>;
  failQuestion(key: ResearchRunExecutionKey, questionId: string, code: string): Promise<void>;
};

/** Only a known, durably accounted validation rejection is local. Unknown
 * provider outcomes and failed persistence stop dependent work and retain fences. */
export async function synthesizeResearchQuestions(input: {
  key: ResearchRunExecutionKey;
  questions: RunQuestion[];
  sources: RunSource[];
  synthesis: RunSynthesisPort;
  checkpoints: RunCheckpointPort;
  signal: AbortSignal;
}) {
  const accepted: ResearchRunDetail["findings"] = [];

  let rejected = 0;

  for (const question of input.questions) {
    input.signal.throwIfAborted();
    let finding: ResearchRunDetail["findings"][number];

    try {
      finding = await input.synthesis.synthesize({
        key: input.key,
        question,
        sources: input.sources,
        signal: input.signal,
      });
    } catch (error) {
      if (
        input.signal.aborted ||
        !(error instanceof Error) ||
        error.name !== "ResearchQuestionRejected"
      ) {
        throw error;
      }

      await input.checkpoints.failQuestion(input.key, question.id, "invalid_synthesis");
      rejected += 1;
      continue;
    }

    const sourceEvidence = input.sources.map((source) => ({
      sourceId: source.id,
      url: source.url,
      text: source.text,
      retrievedAt: source.retrievedAt,
    }));

    const validation = validateRunCitations(finding.citations, sourceEvidence);

    if (!validation.valid) {
      await input.checkpoints.failQuestion(input.key, question.id, validation.reason);
      rejected += 1;
      continue;
    }

    if (!(await input.checkpoints.saveFinding(input.key, question.id, finding))) {
      break;
    }

    accepted.push(finding);
  }

  return { findings: accepted, rejected };
}

export function reportFromFindings(
  question: string,
  findings: ResearchRunDetail["findings"],
  sourceFailures: number,
  questionGaps: string[] = [],
): NonNullable<ResearchRunDetail["report"]> {
  const gaps = findings
    .filter((finding) => finding.outcome !== "supported")
    .map((finding) => finding.explanation || finding.question);

  if (sourceFailures > 0) {
    gaps.push(`${sourceFailures} source retrieval${sourceFailures === 1 ? "" : "s"} failed.`);
  }

  gaps.push(...questionGaps);

  const statements = findings
    .filter((finding) => finding.statement)
    .map((finding) =>
      finding.outcome === "conflicting"
        ? `Conflicting evidence: ${finding.statement}`
        : finding.classification === "deduction"
          ? `Deduction: ${finding.statement}`
          : finding.statement!,
    );

  const answer = statements.length
    ? statements.join("\n\n")
    : `The available sources did not establish an answer to: ${question}`;

  const hasConflict = findings.some((finding) => finding.outcome === "conflicting");

  const supportedCount = findings.filter((finding) => finding.outcome === "supported").length;

  const quality = hasConflict
    ? "conflicting"
    : supportedCount === findings.length &&
        sourceFailures === 0 &&
        questionGaps.length === 0 &&
        findings.length > 0
      ? "answered"
      : supportedCount > 0
        ? "partial"
        : "insufficient-evidence";

  return {
    version: "research-report-v1",
    answer,
    quality,
    findings,
    gaps: [...new Set(gaps)].slice(0, 12),
  };
}
