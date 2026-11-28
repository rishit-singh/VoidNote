import { recordingInputSchema } from "@/contracts/recording-processing";

const audioAliases: Readonly<Record<string, string>> = {
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/mp3": "audio/mpeg",
  "audio/x-mp3": "audio/mpeg",
  "audio/x-flac": "audio/flac",
};

/** Keep previously accepted types (including audio/x-wav) stable for exact retries. */
export function recordingMimeType(value: string) {
  const base = value.split(";")[0]?.trim().toLowerCase() ?? "";
  const result = recordingInputSchema.shape.mimeType.safeParse(audioAliases[base] ?? base);
  if (!result.success) throw new Error("Choose a supported audio file.");
  return result.data;
}

/**
 * MP4 is commonly labelled video/mp4 even when it contains only audio. Let the
 * browser demux and load playable media before accepting that ambiguous label.
 * A media element avoids decoding a potentially 1 GiB file into a PCM buffer.
 */
async function verifyAudioOnlyMp4(file: Blob) {
  const media = document.createElement("video");
  const url = URL.createObjectURL(file);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Could not read this audio. Try another audio format.")),
        8000,
      );
      media.onloadeddata = () => {
        if (
          media.videoWidth !== 0 ||
          media.videoHeight !== 0 ||
          !Number.isFinite(media.duration) ||
          media.duration <= 0
        ) {
          reject(new Error("Choose an audio-only MP4 file."));
          return;
        }
        resolve();
      };
      media.onerror = () => reject(new Error("This browser cannot decode the audio file."));
      media.preload = "auto";
      media.muted = true;
      media.src = url;
    });
  } finally {
    clearTimeout(timer);
    media.onloadeddata = media.onerror = null;
    media.removeAttribute("src");
    media.load();
    URL.revokeObjectURL(url);
  }
}

export async function importedRecordingMimeType(file: Blob) {
  if (!file.size) throw new Error("Choose a non-empty audio file.");
  const base = file.type.split(";")[0]?.trim().toLowerCase();
  if (base === "video/mp4") {
    await verifyAudioOnlyMp4(file);
    return "audio/mp4" as const;
  }
  return recordingMimeType(file.type);
}
