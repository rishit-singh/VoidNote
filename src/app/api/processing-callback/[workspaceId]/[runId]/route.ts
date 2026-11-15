import { z } from "zod";
import { idSchema } from "@/contracts/workspace";
import { withDatabase } from "@/db/client";
import { createRecordingRepository } from "@/db/recording-repository";
import { apiResponse, readJson } from "@/server/api";
import { recordingEnvironment } from "@/server/recording-api";
import { verifyRecordingURL } from "@/server/recording-capability";
type Context = { params: Promise<{ workspaceId: string; runId: string }> };
export async function POST(request: Request, context: Context) {
  const { workspaceId, runId } = await context.params;
  if (!verifyRecordingURL(new URL(request.url), recordingEnvironment().RECORDING_CAPABILITY_SECRET))
    return new Response(null, { status: 403 });
  return apiResponse(async () => {
    idSchema.parse(workspaceId);
    idSchema.parse(runId);
    const body = await readJson(
      request,
      z.object({ jobId: z.string().min(1).max(200), status: z.string() }),
    );
    // Callback is merely a job-ID hint. Workflow fetches and validates the real
    // provider result using our secret API key; callback output is never published.
    await withDatabase((db) =>
      createRecordingRepository(db).bindJob(workspaceId, runId, body.jobId),
    );
    const instance = await recordingEnvironment().PROCESS_RECORDING.get(runId);
    const state = await instance.status();
    if (["complete", "errored", "terminated"].includes(state.status)) await instance.restart();
    return { ok: true };
  });
}
