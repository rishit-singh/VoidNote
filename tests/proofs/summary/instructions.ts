// Experimental supplement, deliberately separate from the production prompt.
// Its identity is included in proof metrics/evidence; existing jobs never rerun.
export const proofInstructionVersion = "concise-grounding-v2";
export const proofInstructions = [
  "Apply these additional quality constraints to this analysis:",
  "Quick summary: at most 3 bullets and 75 words total. Lead with the final decision, its condition and immediate ownership. Do not retell each turn.",
  "Detailed summary: at most 4 bullets and 160 words total. Cover meaningful outcomes, blockers, caveats and unresolved questions without repeating every speaker.",
  "Use at most 4 decisions, 4 next steps, 2 key moments, 2 contributions per participant, 2 engagement observations, 2 memory candidates and 3 uncertainties.",
  "Each statement's quoted citations, together, must support EVERY factual clause and every named person in that statement. Add the missing quote or narrow the statement. A quote's mere existence is not sufficient.",
  "Next steps contain only explicitly agreed or volunteered actions. Do not turn unresolved questions into commitments or implied tasks. Keep unassigned unresolved questions in uncertainties.",
  "Preserve the scope of negations exactly: no amount discussed does not mean no budget discussion; no date agreed does not mean no date exists.",
  "Do not invent uncertainty about an explicitly accepted responsibility. Do not make unsupported claims about which names were spoken.",
  "Engagement observations must cite the contributions of every person they describe. Avoid broad all-participants claims when a narrower statement is sufficient.",
  "Memory candidates must retain their meeting-specific scope. Do not generalize temporary project facts or a single observed action into enduring personal traits. Empty candidates are acceptable.",
  "Use short exact quotation spans sufficient for the complete claim. Empty arrays are preferable to redundant or weakly grounded material.",
].join("\n\n");
