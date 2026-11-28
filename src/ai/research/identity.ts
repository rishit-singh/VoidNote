import { z } from "zod";

import type { ResearchExecutionKey } from "./ports";

export const researchExecutionKeySchema = z
  .object({
    workspaceId: z.uuid(),
    batchId: z.uuid(),
    personId: z.uuid(),
    generation: z.number().int().positive(),
  })
  .strict();

export function researchWorkflowId(key: ResearchExecutionKey): string {
  const identity = [key.workspaceId, key.batchId, key.personId]
    .map((id) => {
      const hex = id.replaceAll("-", "");

      const bytes = Array.from({ length: 16 }, (_, index) =>
        parseInt(hex.slice(index * 2, index * 2 + 2), 16),
      );

      return btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    })
    .join("-");

  return `r-${identity}-${key.generation}`;
}
