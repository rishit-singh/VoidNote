import { z } from "zod";
import { uploadPartSchema } from "@/contracts/recording-processing";
import { WorkspaceError } from "@/contracts/workspace";
import { recordingResponse, recordingEnvironment } from "@/server/recording-api";
import { recordingPartSize, uploadRecordingPart } from "@/server/recording-upload-parts";

type Context = {
  params: Promise<{ workspaceId: string; noteId: string; recordingId: string; part: string }>;
};
export async function PUT(request: Request, context: Context) {
  const { workspaceId, noteId, recordingId, part } = await context.params;
  return recordingResponse(request, workspaceId, noteId, async (repo, principal) => {
    const index = Number(
      z
        .string()
        .regex(/^(0|[1-9]\d{0,2})$/)
        .parse(part),
    );
    const input = uploadPartSchema.parse({
      index,
      sha256: request.headers.get("x-content-sha256"),
    });
    const recording = await repo.getRecording(principal, workspaceId, noteId, recordingId);
    if (
      !request.body ||
      Number(request.headers.get("content-length")) !== recordingPartSize(recording, index)
    )
      throw new WorkspaceError("conflict", "Upload requires the exact part Content-Length.");
    if (recording.status === "ready")
      throw new WorkspaceError(
        "conflict",
        "Recording is already remotely saved. Refresh its upload status.",
      );
    return uploadRecordingPart(
      recordingEnvironment().RECORDING_ARTIFACTS,
      recording,
      index,
      input.sha256,
      request.body,
    );
  });
}
