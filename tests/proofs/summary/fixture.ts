// Entirely synthetic. These fixed identities also bound admission to three jobs.
export const proof = {
  model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  principal: { id: "b02c00a1-0000-4000-8000-000000000001", email: null },
  workspaceId: "b02c00a1-0000-4000-8000-000000000002",
  noteId: "b02c00a1-0000-4000-8000-000000000003",
  recordingId: "b02c00a1-0000-4000-8000-000000000004",
  runId: "b02c00a1-0000-4000-8000-000000000005",
  jobs: [
    "b02c00a1-0000-4000-8000-000000000011",
    "b02c00a1-0000-4000-8000-000000000012",
    "b02c00a1-0000-4000-8000-000000000013",
  ],
  people: [
    {
      id: "b02c00a1-0000-4000-8000-000000000021",
      name: "Ada",
      role: "Project coordinator",
      track: "SPEAKER_00",
    },
    {
      id: "b02c00a1-0000-4000-8000-000000000022",
      name: "Bryn",
      role: "Engineer",
      track: "SPEAKER_01",
    },
    {
      id: "b02c00a1-0000-4000-8000-000000000023",
      name: "Cleo",
      role: "Customer research lead",
      track: "SPEAKER_02",
    },
  ],
} as const;

export const conversation = [
  {
    speaker: "SPEAKER_00",
    text: "Let's decide whether the Maple pilot can start on Friday. We also need an owner for the invitation draft.",
  },
  {
    speaker: "SPEAKER_01",
    text: "The login retry bug is still open. I can reproduce it on slow connections. I cannot promise a fix by Friday.",
  },
  {
    speaker: "SPEAKER_02",
    text: "Three of the five invited testers confirmed that they are available Friday. That is availability, not feedback on the product.",
  },
  {
    speaker: "SPEAKER_00",
    text: "Then could we launch publicly Friday and patch login afterward?",
  },
  {
    speaker: "SPEAKER_01",
    text: "I object to a public launch with this bug. I will post a reproduction and a proposed fix by Thursday afternoon, but that is not a commitment to a working fix.",
  },
  {
    speaker: "SPEAKER_02",
    text: "I agree that public launch should wait. I will draft the invitation, and Ada can review the wording. We should not send it until the login check passes.",
  },
  {
    speaker: "SPEAKER_00",
    text: "Decision: no public launch on Friday. The private pilot is conditional on a successful login check. Bryn owns that check; Cleo owns the invitation draft; I will review it.",
  },
  {
    speaker: "SPEAKER_01",
    text: "Yes. I will report the check outcome on Thursday afternoon. If login still fails, we postpone the pilot rather than invite people into a broken session.",
  },
  {
    speaker: "SPEAKER_02",
    text: "There is no agreed new date if we postpone. Also, please do not interpret the two unanswered invitations as negative feedback.",
  },
  {
    speaker: "SPEAKER_00",
    text: "Agreed. Our next checkpoint is Thursday afternoon. The budget question remains unresolved; we did not discuss any amount today.",
  },
].map((turn, sequence) => ({ ...turn, start: sequence * 12, end: sequence * 12 + 10 }));

// Published pricing checked 2026-11-22. Conservative input ceiling includes
// source JSON, instructions and the structured tool schema; no cached discount.
export const proofBudget = {
  maxAttempts: 3,
  maxEstimatedDollars: 1,
  inputTokensUpperBound: 100_000,
  outputTokensUpperBound: 8192,
  inputDollarsPerMillion: 0.3,
  outputDollarsPerMillion: 1.2,
} as const;
