import type { ArtifactBucket } from "./recording-bindings";

// Workers runtime primitive. Next/OpenNext reconstructs request bodies as Web
// streams, which no longer carry the native known-length information R2 needs.
declare const FixedLengthStream: new (bytes: number) => {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

export async function uploadRecordingArtifact(
  bucket: ArtifactBucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  bytes: number,
  options: Parameters<ArtifactBucket["put"]>[2],
) {
  const stream = new FixedLengthStream(bytes);
  const abort = new AbortController();
  const pumping = body.pipeTo(stream.writable, { signal: abort.signal }).catch((error: unknown) => {
    if (!abort.signal.aborted) throw error;
  });
  const storing = Promise.resolve()
    .then(() => bucket.put(key, stream.readable, options))
    .then((object) => {
      // A failed conditional write need not consume the incoming body.
      if (!object) abort.abort();
      return object;
    });
  try {
    const [object] = await Promise.all([storing, pumping]);
    return object;
  } catch (error) {
    abort.abort();
    await Promise.allSettled([storing, pumping]);
    throw error;
  }
}
