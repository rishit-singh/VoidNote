import { z } from "zod";
import { transcriptPageSchema } from "@/contracts/recording-processing";
import { recordingResponse } from "@/server/recording-api";
type Context = { params: Promise<{ workspaceId: string; noteId: string; runId: string }> };
export async function GET(request: Request, context: Context) {
  const { workspaceId, noteId, runId } = await context.params;
  const cursor = z.coerce
    .number()
    .int()
    .min(-1)
    .max(10_000)
    .parse(new URL(request.url).searchParams.get("after") ?? -1);
  return recordingResponse(request, workspaceId, noteId, async (repo, principal) =>
    transcriptPageSchema.parse(
      await repo.transcript(principal, workspaceId, noteId, runId, cursor),
    ),
  );
}
