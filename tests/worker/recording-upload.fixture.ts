import { uploadRecordingArtifact } from "../../src/server/recording-upload";

const handler = {
  async fetch(request: Request, env: { BUCKET: R2Bucket }) {
    const bytes = new Uint8Array([1, 2, 3]);
    const sha256 = await crypto.subtle.digest("SHA-256", bytes);
    const digest = Array.from(new Uint8Array(sha256), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    // Reconstructed framework stream, deliberately without native length metadata.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const url = new URL(request.url);
    try {
      const object = await uploadRecordingArtifact(
        env.BUCKET,
        "audio",
        body,
        Number(url.searchParams.get("bytes") ?? 3),
        {
          sha256: digest,
          onlyIf: new Headers({ "If-None-Match": "*" }),
          httpMetadata: { contentType: "audio/wav" },
        },
      );
      return Response.json({ size: object?.size ?? null });
    } catch {
      return new Response("Rejected invalid stream", { status: 400 });
    }
  },
};
export default handler;
