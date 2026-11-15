import { recordingResponse, recordingEnvironment } from "@/server/recording-api";
import {
  recordingUploadStatus,
  completeRecordingUpload,
  cleanRecordingParts,
} from "@/server/recording-upload-parts";

type Context = { params: Promise<{ workspaceId: string; noteId: string; recordingId: string }> };

export async function GET(request: Request, context: Context) {
  const { workspaceId, noteId, recordingId } = await context.params;
  return recordingResponse(request, workspaceId, noteId, async (repo, principal) => {
    const recording = await repo.getRecording(principal, workspaceId, noteId, recordingId);
    return recordingUploadStatus(recordingEnvironment().RECORDING_ARTIFACTS, recording);
  });
}

export async function POST(request: Request, context: Context) {
  const { workspaceId, noteId, recordingId } = await context.params;
  return recordingResponse(request, workspaceId, noteId, async (repo, principal) => {
    const recording = await repo.getRecording(principal, workspaceId, noteId, recordingId);
    const bucket = recordingEnvironment().RECORDING_ARTIFACTS;
    const object = await completeRecordingUpload(bucket, recording);
    // Recheck authorization/deletion after streaming; only a verified object is published.
    const ready = await repo.acknowledge(principal, workspaceId, noteId, recordingId, object.size);
    await cleanRecordingParts(bucket, recording);
    return ready;
  });
}
