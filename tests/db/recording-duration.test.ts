/// <reference lib="dom" />

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, it } from "node:test";
import { recordingDuration } from "../../src/lib/recording-duration";

const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
let cleared = false;
let playableDuration = Number.NaN;
let emitUnknownMetadata = false;
let seekAttempts = 0;
class MetadataAudio {
  duration = playableDuration;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() =>
      Number.isFinite(this.duration) || emitUnknownMetadata
        ? this.onloadedmetadata?.()
        : this.onerror?.(),
    );
  }
  set currentTime(_value: number) {
    seekAttempts += 1;
    throw new Error("Duration probing must not seek the media element.");
  }
  removeAttribute() {
    cleared = true;
  }
  load() {}
}

class ObservedBlob extends Blob {
  constructor(
    source: Blob,
    private readonly onRead: (bytes: number) => void,
  ) {
    super([source], { type: source.type });
  }

  override slice(start?: number, end?: number, contentType?: string): Blob {
    return new ObservedBlob(super.slice(start, end, contentType), this.onRead);
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await super.arrayBuffer();
    this.onRead(bytes.byteLength);
    return bytes;
  }
}

function flacWithRepeatedComments(blockCount: number): Blob {
  const streamInfo = Buffer.alloc(34);
  streamInfo.writeUInt16BE(4096, 0);
  streamInfo.writeUInt16BE(4096, 2);
  // 8 kHz, mono, 16-bit, 16000 samples: valid two-second STREAMINFO timing.
  streamInfo.writeBigUInt64BE((8000n << 44n) | (15n << 36n) | 16000n, 10);
  const comment = Buffer.from(`UNMAPPED=${"a".repeat(1024 * 1024)}`);
  const commentHeader = Buffer.alloc(12);
  commentHeader.writeUInt32LE(1, 4);
  commentHeader.writeUInt32LE(comment.length, 8);
  const payload = new Blob([commentHeader, comment]);
  const parts: BlobPart[] = [Buffer.from("fLaC"), Buffer.from([0, 0, 0, 34]), streamInfo];
  for (let index = 0; index < blockCount; index++) {
    const header = Buffer.alloc(4);
    header[0] = 4 | (index === blockCount - 1 ? 0x80 : 0);
    header.writeUIntBE(payload.size, 1, 3);
    parts.push(header, payload);
  }
  return new Blob(parts, { type: "audio/flac" });
}

beforeEach(() => {
  cleared = false;
  playableDuration = Number.NaN;
  emitUnknownMetadata = false;
  seekAttempts = 0;
  Object.defineProperty(globalThis, "Audio", { value: MetadataAudio, configurable: true });
});
afterEach(() => {
  if (originalAudio) Object.defineProperty(globalThis, "Audio", originalAudio);
  else Reflect.deleteProperty(globalThis, "Audio");
});

void it("reads real container timing after decoder failure without buffering the whole blob", async () => {
  const bytes = await readFile(new URL("../fixtures/audio/tone.ogg", import.meta.url));
  const blob = new Blob([bytes], { type: "audio/ogg" });
  blob.arrayBuffer = () => {
    throw new Error("Full-file buffering is forbidden");
  };
  assert.equal(await recordingDuration(blob, () => {}), 2);
  assert.equal(cleared, true);
});

void it("preserves browser-derived duration for existing playable recordings", async () => {
  playableDuration = 12.125;
  assert.equal(await recordingDuration(new Blob(["not parsed"]), () => {}), 12.125);
  assert.equal(cleared, true);
});

void it("reads headerless WebM timing without an out-of-range duration seek", async () => {
  playableDuration = Infinity;
  emitUnknownMetadata = true;
  const bytes = await readFile(new URL("../fixtures/audio/headerless.webm", import.meta.url));
  const duration = await recordingDuration(new Blob([bytes], { type: "audio/webm" }), () => {});
  assert.ok(duration > 14.9 && duration < 15.1);
  assert.equal(seekAttempts, 0);
  assert.equal(cleared, false);
});

void it("does not pin WebKit's finite first-cluster estimate for headerless WebM", async () => {
  playableDuration = 0.341;
  const bytes = await readFile(new URL("../fixtures/audio/headerless.webm", import.meta.url));
  const duration = await recordingDuration(
    new Blob([bytes], { type: "audio/webm;codecs=opus" }),
    () => {},
  );
  assert.ok(duration > 14.9 && duration < 15.1);
  assert.equal(seekAttempts, 0);
  assert.equal(cleared, false);
});

void it("rejects missing timing rather than inventing a positive duration", async () => {
  await assert.rejects(
    recordingDuration(new Blob(["broken"], { type: "audio/ogg" }), () => {}),
    /Could not read this audio's duration/,
  );
  assert.equal(cleared, true);
});

void it("stops fallback work when the owning workspace is retired", async () => {
  let checks = 0;
  await assert.rejects(
    recordingDuration(new Blob(), () => {
      checks += 1;
      if (checks > 1) throw new Error("Scope retired");
    }),
    /Scope retired/,
  );
  assert.equal(cleared, true);
});

void it("rejects native timing if ownership retires while metadata loads", async () => {
  playableDuration = 2;
  const retired = new Error("Scope retired after native probe");
  let checks = 0;
  await assert.rejects(
    recordingDuration(new Blob(["not parsed"]), () => {
      checks += 1;
      // Throw only once: the ownership failure must not be treated as a probe failure.
      if (checks === 2) throw retired;
    }),
    (error) => error === retired,
  );
  assert.equal(checks, 2);
  assert.equal(cleared, true);
});

void it("caps aggregate reads across individually valid metadata blocks", async () => {
  // Prove the synthetic structure parses before testing its cumulative resource limit.
  assert.equal(await recordingDuration(flacWithRepeatedComments(2), () => {}), 2);
  let readBytes = 0;
  const blob = new ObservedBlob(flacWithRepeatedComments(40), (bytes) => {
    assert.ok(bytes <= 8 * 1024 * 1024);
    readBytes += bytes;
  });
  await assert.rejects(
    recordingDuration(blob, () => {}),
    /metadata safety limit/,
  );
  assert.ok(readBytes > 31 * 1024 * 1024);
  assert.ok(readBytes <= 32 * 1024 * 1024);
});

void it("stops reads and preserves cancellation raised during fallback parsing", async () => {
  const retired = new Error("Scope retired during parser read");
  let reads = 0;
  let readsAtRetirement = 0;
  let shouldRetire = false;
  const blob = new ObservedBlob(flacWithRepeatedComments(3), (bytes) => {
    reads += 1;
    if (bytes > 1024 * 1024 && !readsAtRetirement) {
      readsAtRetirement = reads;
      shouldRetire = true;
    }
  });
  await assert.rejects(
    recordingDuration(blob, () => {
      if (shouldRetire) {
        shouldRetire = false;
        throw retired;
      }
    }),
    (error) => error === retired,
  );
  assert.ok(readsAtRetirement > 0);
  assert.equal(reads, readsAtRetirement);
});
