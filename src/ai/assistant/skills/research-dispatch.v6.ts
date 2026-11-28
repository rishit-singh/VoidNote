import type { AssistantSkill } from "./types";

export const researchDispatchSkillV6 = {
  name: "research-dispatch",
  version: "6.0.0",
  description: "Reuse saved research or dispatch bounded research for general questions.",
  allowedTools: [
    "research_lookup",
    "research_get",
    "research_dispatch",
    "research_status",
    "research_cancel",
    "work_list",
  ],
  instructions: `Research can answer general questions; a resolved contact is optional. Before a new run, call research_lookup with the user's question and relevant known person/note IDs. Inspect promising or active candidates with research_get and establish whether exact question, subject, temporal scope, evidence date and freshness actually answer the request. Reuse adequate evidence; similarity alone is not proof.

Dispatch only for uncovered questions or materially stale evidence, and only through research_dispatch. Use the user's requested discovery/time scope as supplied; do not imply an unavailable capability was used. A queued/running result is accepted work, not an answer. Use work_list for current conversation work and research_status for a known run/batch when necessary; do not poll repeatedly. Use research_cancel only when the user asks to stop their work and the tool authorizes it.

Never invent a price, URL, source, finding or claim that no evidence exists. Report actual capability blockers and partial coverage. Keep historical findings explicitly historical; retrieval date alone does not make a fact current. Do not ask permission again for already-requested research. External research requires the application's own authorization and budget; this skill grants neither.`,
  completionChecks: [
    "Saved evidence and active work were checked before dispatch.",
    "General research does not require a contact identity.",
    "Queued work is not represented as a completed finding.",
    "Prices, absence claims, sources and capability are never invented.",
  ],
  fixtures: [
    {
      id: "reuse-before-dispatch",
      prompt: "What did we already find about the product's pricing?",
      expectedTools: ["research_lookup", "research_get"],
      forbiddenClaims: ["I started a new paid research run"],
      checks: ["Use suitable saved findings and preserve their temporal scope."],
    },
    {
      id: "general-research-question",
      prompt: "Research current prices for this product.",
      expectedTools: ["research_lookup", "research_dispatch"],
      forbiddenClaims: ["The price is $"],
      checks: [
        "A general product question needs no person identity; dispatch only after checking existing evidence.",
      ],
    },
  ],
} as const satisfies AssistantSkill;
