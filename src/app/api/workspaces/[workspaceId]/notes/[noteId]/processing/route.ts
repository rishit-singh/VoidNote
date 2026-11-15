import { processingRequestSchema } from "@/contracts/recording-processing";
import { recordingResponse, recordingEnvironment } from "@/server/recording-api";
import { readJson } from "@/server/api";
type Context = { params: Promise<{ workspaceId: string; noteId: string }> };
export async function POST(request: Request, context: Context) {
  const { workspaceId, noteId } = await context.params;
  return recordingResponse(request, workspaceId, noteId, async (repo, principal) => {
    const env = recordingEnvironment();
    if (!env.PYANNOTE_API_KEY || !env.RECORDING_CAPABILITY_SECRET)
      throw new Error("Configure the finalized transcription provider.");
    const command = await readJson(request, processingRequestSchema);
    const run = await repo.requestProcessing(
      principal,
      workspaceId,
      noteId,
      command.recordingId,
      command.id,
    );
    // The committed outbox survives failure here; cron reconciles the same ID.
    const result = await env.PROCESS_RECORDING.createBatch({
      instances: [{ id: run.id, params: { workspaceId, runId: run.id } }],
    });
    if (result.created.length || result.errors.some((error) => error.code === 10405))
      await repo.dispatched(workspaceId, run.id);
    return run;
  });
}
