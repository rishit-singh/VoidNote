const MEDIA_METADATA_TIMEOUT_MS = 8_000;
const MAX_METADATA_ALLOCATION_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_ENTRIES = 1_024;
const MAX_METADATA_READ_BYTES = 32 * 1024 * 1024;

class MetadataReadBudget {
  private remainingBytes = MAX_METADATA_READ_BYTES;
  private failure: { error: unknown } | undefined;

  constructor(private readonly checkActive: () => void) {}

  check() {
    if (this.failure) throw this.failure.error;
    try {
      this.checkActive();
    } catch (error) {
      this.failure = { error };
      throw error;
    }
  }

  async read(blob: Blob): Promise<ArrayBuffer> {
    this.check();
    if (blob.size > MAX_METADATA_ALLOCATION_BYTES || blob.size > this.remainingBytes) {
      const error = new Error(
        "Reading this audio's duration exceeds the metadata safety limit. Try another audio file.",
      );
      this.failure = { error };
      throw error;
    }
    // Charge before I/O, including repeated/overlapping reads and concurrent requests.
    this.remainingBytes -= blob.size;
    const bytes = await blob.arrayBuffer();
    this.check();
    return bytes;
  }
}

/** parseBlob's random-access tokenizer reads through slice().arrayBuffer(). */
class MetadataBlob extends Blob {
  constructor(
    private readonly source: Blob,
    private readonly budget: MetadataReadBudget,
  ) {
    // Blob composition retains immutable backing data without reading it into JS memory.
    super([source], { type: source.type });
  }

  override slice(start?: number, end?: number, contentType?: string): Blob {
    this.budget.check();
    return new MetadataBlob(this.source.slice(start, end, contentType), this.budget);
  }

  override arrayBuffer(): Promise<ArrayBuffer> {
    return this.budget.read(this.source);
  }
}

/** Playback support varies by browser; container timing does not need a decoder. */
export async function recordingDuration(blob: Blob, checkActive: () => void): Promise<number> {
  checkActive();
  // Headerless WebM can expose a finite first-cluster estimate (0.341s for a
  // 15s recording in Linux WebKit). Finite does not make that timing final.
  // Read its container timeline before pinning a durable upload command.
  if (blob.type.split(";")[0] === "audio/webm") {
    return recordingContainerDuration(blob, checkActive);
  }
  let nativeDuration: number | undefined;
  try {
    nativeDuration = await mediaDuration(blob);
  } catch {
    checkActive();
  }
  if (nativeDuration !== undefined) {
    checkActive();
    return nativeDuration;
  }

  return recordingContainerDuration(blob, checkActive);
}

/** Read timing without changing a media element's playback position. */
export async function recordingContainerDuration(
  blob: Blob,
  checkActive: () => void,
): Promise<number> {
  checkActive();
  // Keep the format parsers off the ordinary capture/playback loading path.
  const { parseBlob } = await import("music-metadata");
  checkActive();
  // Per-payload parser limits do not cap accumulated tags. Bound all fallback reads,
  // including rereads, independently of the recording's size. Scan-heavy large files
  // may safely fail here; the native path still supports the application's 1 GiB cap.
  // 32 MiB is an input budget, not a JS heap cap: decoded strings/objects add overhead.
  const budget = new MetadataReadBudget(checkActive);
  try {
    const metadata = await parseBlob(new MetadataBlob(blob, budget), {
      duration: true,
      skipCovers: true,
      skipPostHeaders: true,
      maxMemoryAllocation: MAX_METADATA_ALLOCATION_BYTES,
      maxMetadataEntries: MAX_METADATA_ENTRIES,
      observer: () => budget.check(),
    });
    budget.check();
    const duration = metadata.format.duration;
    if (duration !== undefined && Number.isFinite(duration) && duration > 0) {
      return duration;
    }
  } catch {
    // Parsers may recover from read errors and return partial timing. A latched
    // budget/ownership failure must win over both partial results and generic errors.
    budget.check();
  }

  throw new Error("Could not read this audio's duration. Try another audio file.");
}

async function mediaDuration(blob: Blob): Promise<number> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<number>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Audio metadata timed out.")),
        MEDIA_METADATA_TIMEOUT_MS,
      );
      const check = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) resolve(audio.duration);
      };
      audio.onloadedmetadata = () => {
        check();
        // Chromium's headerless MediaRecorder output can remain Infinity.
        // Safari can report NaN briefly and publish finite timing shortly after.
        // Seeking past the end to force discovery can fail with a Blob range error.
        if (audio.duration === Infinity) reject(new Error("Audio has no duration header."));
      };
      audio.ondurationchange = check;
      audio.ontimeupdate = check;
      audio.onerror = () => reject(new Error("Browser cannot decode this audio."));
      audio.preload = "metadata";
      audio.src = url;
    });
  } finally {
    clearTimeout(timer);
    audio.onloadedmetadata = audio.ondurationchange = audio.ontimeupdate = audio.onerror = null;
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
  }
}
