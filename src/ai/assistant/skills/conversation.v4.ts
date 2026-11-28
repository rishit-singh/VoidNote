import type { AssistantSkill } from "./types";

export const conversationSkillV4 = {
  name: "conversation",
  version: "4.0.0",
  description:
    "Respond naturally to general questions and follow conversational references without unnecessary tools.",
  allowedTools: [
    "notes_search",
    "notes_get",
    "contacts_search",
    "contacts_get",
    "artifact_create",
    "research_status",
  ],
  instructions: `Answer ordinary questions and greetings directly without tools. Understand common typos from context; do not derail the answer to correct harmless spelling.
Follow references such as "that", "the other one", and "what about pricing?" from the recent conversation. Apply the user's corrections and narrowed intent. Ask one concise clarifying question only when different interpretations would materially change the answer or a write destination.
For questions about what was discussed, search and read relevant saved notes; use saved completed research when the user refers to it. Distinguish remembered/local evidence from current external facts. The research tools are for resolved contacts, not general product pricing or arbitrary web search; do not dispatch them for unrelated research or imply current verification.
Draft requested material in chat. Preparing interview questions from saved notes/research does not imply saving. Use the existing artifact_create operation only after an explicit save request, and clarify a genuinely ambiguous new-note versus annotation destination before writing. Do not invent agenda, global-chat, or new search capabilities.
Keep the answer direct, grounded in retrieved evidence when needed, and concise. Preserve contradictions and express uncertainty rather than guessing.`,
  completionChecks: [
    "A straightforward greeting or general question is answered without tools.",
    "Follow-ups use conversational context and honor later corrections.",
    "Local meeting-pricing questions use saved evidence; general current-pricing requests are not sent to contact research.",
    "Prepared interview questions remain a chat draft unless saving is explicitly requested.",
    "Ambiguous save destinations are clarified before any mutation.",
  ],
  fixtures: [
    {
      id: "geohot-followup-and-correction",
      prompt:
        "Conversation: the user opened a saved note titled 'George Hotz interview'. User: 'What did geo hot say about open source?' User correction: 'I meant his point about signing drivers.'",
      expectedTools: ["notes_get"],
      forbiddenClaims: ["He said signing drivers was unnecessary"],
      checks: [
        "Treat 'geo hot' as a likely reference to George Hotz in this context.",
        "Follow the correction to driver signing and read the referenced note.",
        "Do not invent the note's answer if its evidence does not support one.",
      ],
    },
    {
      id: "meeting-pricing-is-local-evidence",
      prompt:
        "In the meeting notes we just discussed, what price did they say the plan would cost?",
      expectedTools: ["notes_get"],
      forbiddenClaims: ["I researched the current price"],
      checks: [
        "Answer from the relevant saved meeting evidence.",
        "Do not dispatch external contact research for a meeting quote.",
      ],
    },
    {
      id: "current-product-price-is-not-contact-research",
      prompt: "What is ExampleApp's current price today?",
      expectedTools: [],
      forbiddenClaims: ["The current price is $19", "I verified the current price"],
      checks: [
        "Do not use research_dispatch, which is limited to resolved-contact research.",
        "Briefly explain that current external pricing is not available through the exposed tools.",
      ],
    },
    {
      id: "greeting-needs-no-tool",
      prompt: "Hi! What kinds of things can you help me with?",
      expectedTools: [],
      forbiddenClaims: ["I searched your notes"],
      checks: ["Give a friendly concise overview without calling a tool."],
    },
  ],
} as const satisfies AssistantSkill;
