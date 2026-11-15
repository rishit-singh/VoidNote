import { z } from "zod";
import { correctionTargetsSchema } from "@/contracts/transcript-corrections";
import {
  transcriptCorrectionResponse,
  type CorrectionRouteContext,
} from "@/server/transcript-correction-api";

const querySchema = z
  .object({
    speakerLabel: z.string().max(200).optional(),
    startSeconds: z
      .string()
      .trim()
      .min(1)
      .pipe(z.coerce.number<string>().min(0).max(7200))
      .optional(),
    endSeconds: z
      .string()
      .trim()
      .min(1)
      .pipe(z.coerce.number<string>().min(0).max(7200))
      .optional(),
    includeManual: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

export async function GET(request: Request, context: CorrectionRouteContext) {
  const { workspaceId, noteId, runId } = await context.params;
  return transcriptCorrectionResponse(request, workspaceId, async (repo, principal) => {
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return correctionTargetsSchema.parse(
      await repo.targets(principal, workspaceId, noteId, runId, query),
    );
  });
}
