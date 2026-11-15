import {
  completeRecordingUpload,
  recordingUploadStatus,
  uploadRecordingPart,
  cleanRecordingParts,
} from "../../src/server/recording-upload-parts";

const handler = {
  async fetch(request: Request, env: { BUCKET: R2Bucket }) {
    const url = new URL(request.url);
    const recording = {
      id: url.searchParams.get("id") ?? "fixture",
      workspaceId: "workspace",
      objectKey: `workspace/${url.searchParams.get("id") ?? "fixture"}`,
      bytes: Number(request.headers.get("x-total-bytes")),
      sha256: request.headers.get("x-total-sha256")!,
      mimeType: "audio/wav",
    };
    try {
      if (request.method === "PUT") {
        const result = await uploadRecordingPart(
          env.BUCKET,
          recording,
          Number(url.searchParams.get("part")),
          request.headers.get("x-content-sha256")!,
          request.body!.pipeThrough(new TransformStream()),
        );
        return Response.json(result);
      }
      if (request.method === "POST") {
        const object = await completeRecordingUpload(env.BUCKET, recording);
        await cleanRecordingParts(env.BUCKET, recording);
        return Response.json({
          size: object.size,
          sha256: Array.from(new Uint8Array(object.checksums.sha256!), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        });
      }
      if (url.pathname === "/download") {
        const object = await env.BUCKET.get(recording.objectKey);
        return new Response(object?.body ?? null);
      }
      if (url.pathname === "/parts")
        return Response.json(
          (await env.BUCKET.list({ prefix: "recording-uploads/" })).objects.length,
        );
      return Response.json(await recordingUploadStatus(env.BUCKET, recording));
    } catch {
      return new Response("Invalid or incomplete upload", { status: 409 });
    }
  },
};
export default handler;
