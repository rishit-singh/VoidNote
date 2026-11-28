import { creationSkill as previous } from "./creation.v1";
import type { AssistantSkill } from "./types";

export const creationSkill = {
  ...previous,
  version: "2.0.0",
  instructions: `${previous.instructions}
For artifact_create kind="note", noteId MUST be null: it creates a NEW authored note, even when a meeting note is open. Do not pass the opened note ID or imply that this edits it.
For kind="annotation", use the existing destination noteId and a real note/transcript source belonging to that note. Choose between a new note and annotation from the user's intent; never silently reinterpret a rejected request.
A definitive failed rejection permits a corrected new tool call when the user still wants the operation and the correction is clear. A conflict on a revision requires a fresh read; forbidden access is not permission to bypass authorization. An uncertain result never permits a replacement write.`,
  completionChecks: [
    ...previous.completionChecks,
    "New authored notes use noteId null; annotations use the intended existing note and evidence.",
    "Only definitive rejection permits correction; uncertainty requires reconciliation.",
  ],
  fixtures: [
    ...previous.fixtures,
    {
      id: "new-note-from-open-meeting",
      prompt: "Save this outline as a new note. A meeting note is currently open.",
      expectedTools: ["artifact_create"],
      forbiddenClaims: ["I updated the meeting note"],
      checks: ['Use kind="note" with noteId=null.', "Acknowledge only after success."],
    },
  ],
} as const satisfies AssistantSkill;
