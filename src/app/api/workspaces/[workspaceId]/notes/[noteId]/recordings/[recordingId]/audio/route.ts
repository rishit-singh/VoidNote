import { WorkspaceError } from "@/contracts/workspace";
import { uploadRecordingArtifact } from "@/server/recording-upload";
import {
  recordingResponse,
  recordingEnvironment,
  recordingAudioResponse,
} from "@/server/recording-api";
type Context = { params: Promise<{ workspaceId: string; noteId: string; recordingId: string }> };
export async function GET(request: Request, context: Context) {
  const { workspaceId, noteId, recordingId } = await context.params;
  return recordingAudioResponse(request, workspaceId, noteId, recordingId);
}
export async function PUT(request: Request, context: Context) {
  const { workspaceId, noteId, recordingId } = await context.params;
  return recordingResponse(request, workspaceId, noteId, async (repo, principal) => {
    const recording = await repo.getRecording(principal, workspaceId, noteId, recordingId);
    if (Number(request.headers.get("content-length")) !== recording.bytes || !request.body)
      throw new WorkspaceError("conflict", "Upload requires the exact manifest Content-Length.");
    const bucket = recordingEnvironment().RECORDING_ARTIFACTS;
    let object = await bucket.head(recording.objectKey);
    if (!object)
      object = await uploadRecordingArtifact(
        bucket,
        recording.objectKey,
        request.body,
        recording.bytes,
        {
          sha256: recording.sha256,
          onlyIf: new Headers({ "If-None-Match": "*" }),
          httpMetadata: { contentType: recording.mimeType },
        },
      );
    object ??= await bucket.head(recording.objectKey);
    if (
      !object ||
      object.size !== recording.bytes ||
      !object.checksums.sha256 ||
      Buffer.from(object.checksums.sha256).toString("hex") !== recording.sha256
    )
      throw new WorkspaceError("conflict", "Stored audio failed manifest verification.");
    // Rechecks membership and note deletion after the independent object write.
    return repo.acknowledge(principal, workspaceId, noteId, recordingId, object.size);
  });
}
