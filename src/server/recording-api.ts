import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requirePrincipal } from "../auth/server";
import { idSchema, WorkspaceError, type Principal } from "../contracts/workspace";
import { withDatabase } from "../db/client";
import { createRecordingRepository } from "../db/recording-repository";
import { apiResponse, requireSameOrigin } from "./api";
import { recordingBindingsSchema } from "./recording-bindings";

export function recordingEnvironment() {
  const env = getCloudflareContext().env;
  return recordingBindingsSchema.parse(env);
}
export function recordingResponse(
  request: Request,
  workspaceId: string,
  noteId: string,
  work: (
    repo: ReturnType<typeof createRecordingRepository>,
    principal: Principal,
  ) => Promise<unknown>,
) {
  return apiResponse(async () => {
    if (request.method !== "GET") requireSameOrigin(request);
    const principal = await requirePrincipal();
    idSchema.parse(workspaceId);
    idSchema.parse(noteId);
    return withDatabase((db) => work(createRecordingRepository(db), principal));
  });
}

export async function recordingAudioResponse(
  request: Request,
  workspaceId: string,
  noteId: string,
  recordingId: string,
  capability = false,
) {
  let output: Response | undefined;
  const error = await apiResponse(async () => {
    const principal = capability ? null : await requirePrincipal();
    idSchema.parse(workspaceId);
    idSchema.parse(noteId);
    idSchema.parse(recordingId);
    const recording = await withDatabase((db) =>
      principal
        ? createRecordingRepository(db).getRecording(principal, workspaceId, noteId, recordingId)
        : createRecordingRepository(db).capabilityRecording(workspaceId, noteId, recordingId),
    );
    if (recording.status !== "ready")
      throw new WorkspaceError("not_found", "Audio has not been uploaded.");
    const bucket = recordingEnvironment().RECORDING_ARTIFACTS;
    const range = request.headers.get("range");
    if (range && !/^bytes=\d*-\d*$/.test(range)) {
      output = new Response(null, { status: 416 });
      return null;
    }
    const object = await bucket.get(
      recording.objectKey,
      range ? { range: request.headers } : undefined,
    );
    if (!object?.body) throw new WorkspaceError("not_found", "Audio is unavailable.");
    const headers = new Headers({
      "Content-Type": recording.mimeType,
      "Cache-Control": "private, no-store",
      "Accept-Ranges": "bytes",
      ETag: object.httpEtag,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    let status = 200;
    if (
      object.range &&
      "offset" in object.range &&
      "length" in object.range &&
      object.range.offset !== undefined &&
      object.range.length !== undefined
    ) {
      headers.set(
        "Content-Range",
        `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`,
      );
      headers.set("Content-Length", String(object.range.length));
      status = 206;
    } else headers.set("Content-Length", String(object.size));
    output = new Response(object.body, { status, headers });
    return null;
  });
  return output ?? error;
}
