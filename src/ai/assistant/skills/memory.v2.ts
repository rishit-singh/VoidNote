import { memorySkill as previous } from "./memory.v1";
import type { AssistantSkill } from "./types";

export const memorySkill = {
  ...previous,
  version: "2.0.0",
  instructions: `${previous.instructions}
memory_recall query is literal text, not semantic search. Prefer a short distinctive phrase. After zero matches, try a shorter phrase or query="" within the relevant subject scope before asserting absence. A bounded list is not proof that no other memories exist; say what you searched when coverage is incomplete.
memory_revise sources must NEVER contain the target memory itself, directly or through a dependency. The target memoryId and expectedRevision identify what to change; they are not supporting evidence.
For a user-authored correction of user-stated memory, sources=[] is allowed when there is no separate evidence. Source-supported memory still requires valid independent evidence; never drop that requirement or silently change provenance.
After definitive rejection, correct a clear input mistake in a new tool call if still authorized. Re-read changed revisions before proposing a correction. Never replace or repeat an uncertain mutation.`,
  completionChecks: [
    ...previous.completionChecks,
    "Zero literal recall matches are not reported as absence without a broader scoped check.",
    "Revision sources exclude the target memory and retain required independent evidence.",
  ],
  fixtures: [
    ...previous.fixtures,
    {
      id: "literal-recall-fallback",
      prompt:
        "What interview preparation format do I prefer? The long literal query had zero hits.",
      expectedTools: ["memory_recall"],
      forbiddenClaims: ["You have no saved preference"],
      checks: ['Try "interview preparation" or query="" before asserting absence.'],
    },
    {
      id: "user-stated-correction",
      prompt: "Change my saved interview preparation preference to short bullet points.",
      expectedTools: ["memory_recall", "memory_revise"],
      forbiddenClaims: ["Saved successfully"],
      checks: [
        "Use the recalled identity/revision, never the target memory as its own source.",
        "A user-stated correction may use sources=[]; acknowledge only after success.",
      ],
    },
  ],
} as const satisfies AssistantSkill;
