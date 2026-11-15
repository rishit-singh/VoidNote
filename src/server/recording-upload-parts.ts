import {
  RECORDING_UPLOAD_PART_BYTES,
  type RecordingInput,
} from "../contracts/recording-processing";
import { WorkspaceError } from "../contracts/workspace";
import type { ArtifactBucket, StoredArtifact } from "./recording-bindings";
import { uploadRecordingArtifact } from "./recording-upload";

type Manifest = Pick<RecordingInput, "id" | "sha256" | "bytes"> & {
  objectKey: string;
  workspaceId: string;
  mimeType: string;
};
const count = (recording: Manifest) => Math.ceil(recording.bytes / RECORDING_UPLOAD_PART_BYTES);
export const recordingPartKey = (recording: Manifest, index: number) =>
  `recording-uploads/${recording.workspaceId}/${recording.id}/${recording.sha256}/${index}`;
const digest = (object: StoredArtifact) =>
  object.checksums.sha256 ? Buffer.from(object.checksums.sha256).toString("hex") : null;

export function recordingPartSize(recording: Manifest, index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= count(recording))
    throw new WorkspaceError("conflict", "Invalid recording part index.");
  return Math.min(
    RECORDING_UPLOAD_PART_BYTES,
    recording.bytes - index * RECORDING_UPLOAD_PART_BYTES,
  );
}

function verified(object: StoredArtifact | null, bytes: number, sha256: string) {
  if (!object || object.size !== bytes || digest(object) !== sha256)
    throw new WorkspaceError("conflict", "Stored audio failed manifest verification.");
  return object;
}

export async function recordingUploadStatus(bucket: ArtifactBucket, recording: Manifest) {
  const final = await bucket.head(recording.objectKey);
  if (final) {
    verified(final, recording.bytes, recording.sha256);
    return { ready: true, parts: [] };
  }
  const parts: { index: number; sha256: string }[] = [];
  // Keep R2 concurrency bounded; at most 128 small metadata reads for a 1 GiB file.
  for (let start = 0; start < count(recording); start += 4) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(4, count(recording) - start) }, async (_, offset) => {
        const index = start + offset;
        const object = await bucket.head(recordingPartKey(recording, index));
        const sha256 = object && digest(object);
        return object?.size === recordingPartSize(recording, index) && sha256
          ? { index, sha256 }
          : null;
      }),
    );
    for (const part of batch) if (part) parts.push(part);
  }
  return { ready: false, parts };
}

export async function uploadRecordingPart(
  bucket: ArtifactBucket,
  recording: Manifest,
  index: number,
  sha256: string,
  body: ReadableStream<Uint8Array>,
) {
  const bytes = recordingPartSize(recording, index);
  const key = recordingPartKey(recording, index);
  let object = await bucket.head(key);
  if (!object)
    object = await uploadRecordingArtifact(bucket, key, body, bytes, {
      sha256,
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "application/octet-stream" },
    });
  object ??= await bucket.head(key);
  verified(object, bytes, sha256);
  return { index, sha256 };
}

export async function completeRecordingUpload(bucket: ArtifactBucket, recording: Manifest) {
  let object = await bucket.head(recording.objectKey);
  if (!object) {
    let index = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          for (;;) {
            if (!reader) {
              if (index === count(recording)) {
                controller.close();
                return;
              }
              const part = await bucket.get(recordingPartKey(recording, index));
              if (
                !part?.body ||
                part.size !== recordingPartSize(recording, index) ||
                !digest(part)
              ) {
                await part?.body?.cancel();
                throw new WorkspaceError(
                  "conflict",
                  "Upload is incomplete. Retry to resume the missing parts.",
                );
              }
              reader = part.body.getReader();
              index++;
            }
            const chunk = await reader.read();
            if (!chunk.done) {
              controller.enqueue(chunk.value);
              return;
            }
            reader.releaseLock();
            reader = undefined;
          }
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await reader?.cancel();
      },
    });
    object = await uploadRecordingArtifact(bucket, recording.objectKey, body, recording.bytes, {
      sha256: recording.sha256,
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: recording.mimeType },
    });
    object ??= await bucket.head(recording.objectKey);
  }
  return verified(object, recording.bytes, recording.sha256);
}

export async function cleanRecordingParts(bucket: ArtifactBucket, recording: Manifest) {
  await bucket.delete(
    Array.from({ length: count(recording) }, (_, index) => recordingPartKey(recording, index)),
  );
}
