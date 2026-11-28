import { creationSkill as previous } from "./creation.v2";
import type { AssistantSkill } from "./types";

export const creationSkill = {
  ...previous,
  version: "3.0.0",
  instructions: `${previous.instructions}
Preparing content is not the same as saving it. When asked to prepare interview questions from saved notes or completed research, read only the relevant authorized evidence and draft the questions in your reply. Do not call artifact_create unless the user explicitly asks to save the draft.
If the user asks to save, choose a new authored note only when that is their clear intent and use noteId=null. If "save that" could mean a new note or an annotation on an existing note, ask one concise destination question before writing. Never invent an agenda, new research provider, or global-chat persistence workflow.`,
  completionChecks: [
    ...previous.completionChecks,
    "Preparing interview questions produces a draft in chat and does not save unless asked.",
    "Ambiguous save destinations are clarified before any write.",
  ],
  fixtures: [
    ...previous.fixtures,
    {
      id: "prepare-interview-questions-no-save",
      prompt:
        "Use the saved interview notes and completed research to prepare questions for my next conversation.",
      expectedTools: ["notes_get", "research_status"],
      forbiddenClaims: ["I saved the questions", "I created a new note"],
      checks: [
        "Use only the referenced saved evidence.",
        "Return useful drafted questions in chat.",
        "Do not call artifact_create because saving was not requested.",
      ],
    },
    {
      id: "explicit-save-interview-questions",
      prompt:
        "Save those interview questions as a new note using the meeting and research sources.",
      expectedTools: ["artifact_create"],
      forbiddenClaims: ["I updated the meeting transcript"],
      checks: [
        'Use artifact_create with kind="note" and noteId=null.',
        "Include only the returned evidence sources.",
        "Acknowledge only after confirmed success.",
      ],
    },
    {
      id: "ambiguous-save-destination",
      prompt:
        "We have the interview questions ready. Save that. It could be a note or an annotation on the open meeting.",
      expectedTools: [],
      forbiddenClaims: ["Saved the questions", "I chose the meeting for you"],
      checks: ["Ask one concise question about the intended destination before writing."],
    },
  ],
} as const satisfies AssistantSkill;
