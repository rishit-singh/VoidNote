import { correctionHistoryPageSchema } from "@/contracts/transcript-corrections";
import {
  transcriptCorrectionResponse,
  type CorrectionRouteContext,
} from "@/server/transcript-correction-api";

export async function GET(request: Request, context: CorrectionRouteContext) {
  const { workspaceId, noteId, runId } = await context.params;
  return transcriptCorrectionResponse(request, workspaceId, async (repo, principal) =>
    correctionHistoryPageSchema.parse(
      await repo.history(
        principal,
        workspaceId,
        noteId,
        runId,
        new URL(request.url).searchParams.get("cursor") ?? undefined,
      ),
    ),
  );
}
