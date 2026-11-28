import type { AssistantSkill } from "./types";

export const creationSkill = {
  name: "creation",
  version: "1.0.0",
  description:
    "Create or retrieve a saved note, Markdown/text file, or meeting annotation through the application's authorized operations.",
  instructions: `When the user explicitly asks to create or save, gather only missing required details. Use existing conversation evidence rather than rereading it without reason.
Choose artifact_create kind note, file or annotation. An annotation needs the intended note ID. Provide a short name, supported text media type, content and exact source references.
The runtime supplies the operation ID. Never invent an ID or issue a second creation call to repair an uncertain result.
Only say saved/created when the operation returns success with its artifact identity. A draft shown in chat is not a saved artifact. If a tool fails or is uncertain, say so concisely and preserve its receipt for reconciliation.
Use artifact_get to read an existing artifact by returned identity; follow nextOffset only when needed. Use history_search to find an earlier creation result in this conversation. Do not recreate a saved resource just to read it.
Do not claim to have sent an email, uploaded a binary, modified a contact, or edited arbitrary existing content: those operations are not exposed.`,
  allowedTools: ["notes_get", "contacts_get", "artifact_create", "artifact_get", "history_search"],
  completionChecks: [
    "Creation is explicitly requested and targets the intended note where applicable.",
    "Success claims refer to an acknowledged artifact identity.",
    "No duplicate creation follows an uncertain tool outcome.",
  ],
  fixtures: [
    {
      id: "uncertain-save",
      prompt: "Save this as a note. The creation response was lost.",
      expectedTools: ["artifact_create"],
      forbiddenClaims: ["Saved successfully", "I created another copy"],
      checks: ["Report uncertainty.", "Do not call artifact_create again with a new invocation."],
    },
  ],
} as const satisfies AssistantSkill;
