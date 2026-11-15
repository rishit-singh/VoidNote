import { recordingAudioResponse, recordingEnvironment } from "@/server/recording-api";
import { verifyRecordingURL } from "@/server/recording-capability";
type Context = { params: Promise<{ workspaceId: string; noteId: string; recordingId: string }> };
export async function GET(request: Request, context: Context) {
  const { workspaceId, noteId, recordingId } = await context.params;
  if (!verifyRecordingURL(new URL(request.url), recordingEnvironment().RECORDING_CAPABILITY_SECRET))
    return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  return recordingAudioResponse(request, workspaceId, noteId, recordingId, true);
}
