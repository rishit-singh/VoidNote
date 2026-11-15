import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { RECORDING_UPLOAD_PART_BYTES } from "@/contracts/recording-processing";

// Bounded slices avoid allocating a full-file ArrayBuffer for large recordings.
export async function hashRecording(
  blob: Blob,
  checkActive: () => void,
  onProgress: (fraction: number) => void,
) {
  const hash = sha256.create();
  try {
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
      checkActive();
      hash.update(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()));
      onProgress(Math.min(1, (offset + 1024 * 1024) / blob.size));
    }
    checkActive();
    return bytesToHex(hash.digest());
  } finally {
    hash.destroy();
  }
}

export function recordingPart(blob: Blob, index: number) {
  return blob.slice(index * RECORDING_UPLOAD_PART_BYTES, (index + 1) * RECORDING_UPLOAD_PART_BYTES);
}
