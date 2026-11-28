import type { AssistantSkill } from "./types";

export const researchDispatchSkill = {
  name: "research-dispatch",
  version: "1.0.0",
  description:
    "Dispatch or retrieve bounded, source-backed fact research about resolved contacts through the authorized application research service.",
  instructions: `Use existing meeting/contact evidence for local questions. Dispatch research only when the user asks for external/current investigation and local context is insufficient.
Resolve each person before dispatch. Batch contacts_get for professional/publicLinks fields to obtain current revisions and known source URLs. Pass people with personId, expectedProfileRevision, requestedFacts (unique key, precise question, optional maxAgeDays), and sourceUrls to research_dispatch. Batch up to 10 contacts rather than dispatching one job per person. Do not invent URLs or source identities.
External research requires its own application authorization and budget; this skill grants neither.
If dispatch returns queued/running, report that status and the returned batch identity; do not present it as findings. Use research_status once when the user asks about an existing batch; do not busy-poll. Cite returned URLs only when actual evidence is returned. Distinguish supported facts, not-found, ambiguous and conflicting results.
If the research service is disabled/unavailable, explain that briefly. Do not bypass it using workspace shell, fetch, MCP, client tools, another model, or fabricated browsing.
Never retry an uncertain dispatch as a new operation.`,
  allowedTools: [
    "research_dispatch",
    "research_status",
    "notes_get",
    "contacts_search",
    "contacts_get",
  ],
  completionChecks: [
    "External research was requested and dispatched at most once.",
    "Queued status is distinguished from completed findings.",
    "No unsupported current facts or invented URLs appear.",
  ],
  fixtures: [
    {
      id: "queued-research",
      prompt:
        "Research Sam's current employer from the resolved profile's public URL. The service returns queued with batch R1.",
      expectedTools: ["research_dispatch"],
      forbiddenClaims: ["Sam currently works at Acme", "Research is complete"],
      checks: ["Report queued status and R1.", "Do not fabricate findings."],
    },
    {
      id: "saved-conflicting-finding",
      prompt: "What did batch R1 find? Its saved employer finding is conflicting.",
      expectedTools: ["research_status"],
      forbiddenClaims: ["The employer is confirmed", "I ran research again"],
      checks: ["Read the existing batch once.", "Report the conflict with its returned citations."],
    },
  ],
} as const satisfies AssistantSkill;
