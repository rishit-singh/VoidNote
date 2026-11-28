import type { AssistantToolName } from "../tools";

export type AssistantSkill = {
  name: string;
  version: "1.0.0" | "2.0.0" | "3.0.0" | "4.0.0" | "5.0.0" | "6.0.0";
  description: string;
  instructions: string;
  allowedTools: readonly AssistantToolName[];
  completionChecks: readonly string[];
  fixtures: readonly {
    id: string;
    prompt: string;
    expectedTools: readonly AssistantToolName[];
    forbiddenClaims: readonly string[];
    checks: readonly string[];
  }[];
};
