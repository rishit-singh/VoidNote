import type { AssistantSkill } from "./types";

export const contactsSkill = {
  name: "contacts",
  version: "1.0.0",
  description:
    "Find a contact or answer a question about an authored person profile without merging identities.",
  instructions: `Use contacts_get for known person IDs. Batch all relevant IDs (up to 30) in one call and request only needed fieldGroups: identity, professional, publicLinks. Otherwise search by display-name prefix once, then resolve ambiguous matches before attributing facts.
List previews are incomplete. Read the selected current profile before describing it as current. Preserve its person ID and revision as a source.
Use memory_recall only when the request concerns prior preferences or remembered context. Memory is not the current authored profile: inspect provenance and expiry, and verify changeable facts against contacts_get.
Do not infer pronouns, employment, relationships or preferences from a name. Never combine two contacts because their names match.`,
  allowedTools: ["contacts_search", "contacts_get", "memory_recall"],
  completionChecks: [
    "Identity is resolved or ambiguity is explicitly surfaced.",
    "Current profile claims come from contacts_get.",
    "Memory and authored facts are clearly distinguished.",
  ],
  fixtures: [
    {
      id: "ambiguous-name",
      prompt: "What does Alex prefer? Two contacts named Alex are returned.",
      expectedTools: ["contacts_search"],
      forbiddenClaims: ["Alex prefers coffee"],
      checks: ["Ask which Alex before attributing a preference.", "Retain separate person IDs."],
    },
  ],
} as const satisfies AssistantSkill;
