import type { AssistantSkill } from "./types";

export const memorySkill = {
  name: "memory",
  version: "1.0.0",
  description:
    "Retrieve saved conversation history, recall, explicitly remember, revise or forget scoped preferences and claims with provenance, expiry and revision.",
  instructions: `Recall only relevant memory, with bounded results. Active memory is historical context, not proof that a mutable fact remains true. Ignore expired/invalidated records and treat needs-review or agent-inferred claims as unverified.
Use history_search for older messages or tool results in this conversation. Search results remain historical context; use current contact/evidence tools for mutable facts.
Write only when the user explicitly asks to remember. Use user-stated for the user's own explicit statement, source-supported for a claim with returned source evidence, and agent-inferred only when explicitly requested and clearly qualified. Never silently promote an inference into an authored fact.
Preserve subject identity, provenance, source IDs and expiry. Do not save credentials or unnecessary sensitive details. Distinguish user preferences from claims about a contact.
For forgetting, recall the exact record and call memory_invalidate with its current revision. For a requested correction, use memory_revise with the current revision, replacement content, sources and reason. Report a conflict rather than overwriting a newer record.
Only claim remembered/forgotten after acknowledgement. Do not write a speculative replacement after an uncertain outcome.`,
  allowedTools: [
    "memory_recall",
    "history_search",
    "memory_remember",
    "memory_invalidate",
    "memory_revise",
    "contacts_get",
    "notes_get",
  ],
  completionChecks: [
    "Memory writes reflect explicit user intent and correct provenance.",
    "Forgetting uses a recalled ID and expected revision.",
    "Expired, inferred and current authored facts are not conflated.",
  ],
  fixtures: [
    {
      id: "explicit-preference",
      prompt: "Remember that I prefer concise replies.",
      expectedTools: ["memory_remember"],
      forbiddenClaims: ["source-supported"],
      checks: [
        "Use user-stated provenance and preference kind.",
        "Acknowledge only after success.",
      ],
    },
    {
      id: "stale-role",
      prompt: "Where does Sam work now? Recalled memory says Sam worked at Acme last year.",
      expectedTools: ["memory_recall", "contacts_get"],
      forbiddenClaims: ["Sam currently works at Acme"],
      checks: ["Check a current source or state that current employment is unknown."],
    },
  ],
} as const satisfies AssistantSkill;
