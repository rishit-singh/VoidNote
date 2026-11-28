import { z } from "zod";

export const assistantPolicySchema = z.object({
  version: z.literal("assistant-v1"),
  skillVersion: z.enum([
    "assistant-skills-v1",
    "assistant-skills-v2",
    "assistant-skills-v3",
    "assistant-skills-v4",
    "assistant-skills-v5",
    "assistant-skills-v6",
  ]),
  model: z.string().trim().min(1).max(200),
  budgetId: z.uuid(),
  rateVersionId: z.uuid(),
  reasoningEffort: z.enum(["none", "low", "high"]).default("none"),
  // Keep historical omissions compatible; new admissions reserve v4's retrieval budget.
  maxSteps: z.number().int().min(1).max(10).default(4),
  maxToolCalls: z.number().int().min(1).max(20).default(10),
  maxOutputTokens: z.number().int().min(128).max(8192).default(2048),
  timeoutMs: z.number().int().min(1000).max(180_000).default(90_000),
  maxContextBytes: z.number().int().min(4000).max(256_000).default(96_000),
  maxToolResultBytes: z.number().int().min(1000).max(64_000).default(24_000),
  maxHistoryMessages: z.number().int().min(1).max(100).default(30),
});

export type AssistantPolicy = z.infer<typeof assistantPolicySchema>;

export type AssistantPolicyEnvironment = {
  ASSISTANT_ENABLED?: string;
  ASSISTANT_MODEL?: string;
  ASSISTANT_BUDGET_ID?: string;
  ASSISTANT_RATE_VERSION_ID?: string;
};

export function readAssistantPolicy(env: AssistantPolicyEnvironment): AssistantPolicy | null {
  if (env.ASSISTANT_ENABLED !== "true") {
    return null;
  }

  const result = assistantPolicySchema.safeParse({
    version: "assistant-v1",
    skillVersion: "assistant-skills-v6",
    // Leave a final tool-free synthesis step after skill activation and paging.
    maxSteps: 8,
    model: env.ASSISTANT_MODEL,
    budgetId: env.ASSISTANT_BUDGET_ID,
    rateVersionId: env.ASSISTANT_RATE_VERSION_ID,
  });

  return result.success ? result.data : null;
}
