import {
  correctionCommandSchema,
  correctionResultSchema,
  correctedTranscriptPageSchema,
} from "@/contracts/transcript-corrections";
import { readJson } from "@/server/api";
import {
  transcriptCorrectionResponse,
  type CorrectionRouteContext,
} from "@/server/transcript-correction-api";

export async function GET(request: Request, context: CorrectionRouteContext) {
  const { workspaceId, noteId, runId } = await context.params;
  return transcriptCorrectionResponse(request, workspaceId, async (repo, principal) =>
    correctedTranscriptPageSchema.parse(
      await repo.transcript(
        principal,
        workspaceId,
        noteId,
        runId,
        new URL(request.url).searchParams.get("cursor") ?? undefined,
      ),
    ),
  );
}

export async function POST(request: Request, context: CorrectionRouteContext) {
  const { workspaceId, noteId, runId } = await context.params;
  return transcriptCorrectionResponse(request, workspaceId, async (repo, principal) =>
    correctionResultSchema.parse(
      await repo.command(
        principal,
        workspaceId,
        noteId,
        runId,
        await readJson(request, correctionCommandSchema),
      ),
    ),
  );
}
