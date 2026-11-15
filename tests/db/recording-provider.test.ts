import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  recordingInputSchema,
  MAX_RECORDING_BYTES,
} from "../../src/contracts/recording-processing";
import {
  normalizePyannote,
  pyannote,
  ProviderRequestError,
  boundedJSON,
} from "../../src/server/pyannote";
import { signedRecordingURL, verifyRecordingURL } from "../../src/server/recording-capability";
import { randomUUID } from "node:crypto";

void describe("recording/provider contracts (offline; no paid API requests)", () => {
  void it("normalizes real pyannote turn fields without converting track labels to people", () => {
    const result = {
      jobId: "provider-job",
      status: "succeeded",
      output: {
        diarization: [{ start: 0, end: 1, speaker: "SPEAKER_00", confidence: { SPEAKER_00: 97 } }],
        turnLevelTranscription: [
          { start: 0.1, end: 1.2, speaker: "SPEAKER_00", text: "Actual speech" },
        ],
      },
    };
    const original = structuredClone(result);
    assert.deepEqual(
      normalizePyannote(result, "provider-job"),
      result.output.turnLevelTranscription,
    );
    assert.deepEqual(result, original, "raw scores and fields remain unchanged for retention");
    assert.throws(() => normalizePyannote(result, "another-job"));
    assert.throws(() =>
      normalizePyannote(
        {
          ...result,
          output: { turnLevelTranscription: [{ start: 2, end: 1, speaker: "S", text: "bad" }] },
        },
        "provider-job",
      ),
    );
    assert.throws(
      () => normalizePyannote({ ...result, output: { diarization: [] } }, "provider-job"),
      "missing transcript is not a successful empty result",
    );
  });

  void it("submits the documented combined operation exactly once and distinguishes uncertain outcomes", async () => {
    let calls = 0;
    const fetcher: typeof fetch = (_url, init) => {
      calls++;
      assert.equal(init?.method, "POST");
      assert.equal(typeof init?.body, "string");
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      assert.equal(body.model, "precision-3");
      assert.equal(body.transcription, true);
      assert.deepEqual(body.transcriptionConfig, { model: "parakeet-tdt-0.6b-v3" });
      assert.equal(body.webhookStatusOnly, true);
      return Promise.resolve(new Response("failure", { status: 503 }));
    };
    await assert.rejects(
      pyannote("offline-test-key", fetcher).submit(
        "https://example.invalid/audio",
        "https://example.invalid/callback",
      ),
      (error: unknown) => error instanceof ProviderRequestError && error.ambiguous,
    );
    assert.equal(calls, 1);
    const rejected: typeof fetch = () => Promise.resolve(new Response("rejected", { status: 402 }));
    await assert.rejects(
      pyannote("offline-test-key", rejected).submit(
        "https://example.invalid/audio",
        "https://example.invalid/callback",
      ),
      (error: unknown) => error instanceof ProviderRequestError && !error.ambiguous,
    );
    const invalid: typeof fetch = () => Promise.resolve(new Response("invalid json"));
    await assert.rejects(
      pyannote("offline-test-key", invalid).submit(
        "https://example.invalid/audio",
        "https://example.invalid/callback",
      ),
      (error: unknown) => error instanceof ProviderRequestError && error.ambiguous,
    );
  });

  void it("bounds provider response consumption and rejects unsupported upload manifests", async () => {
    await assert.rejects(boundedJSON(new Response("x".repeat(100)), 50), /exceeds/);
    const manifest = {
      id: randomUUID(),
      sha256: "a".repeat(64),
      bytes: 10,
      durationSeconds: 1,
      mimeType: "audio/webm",
    };
    recordingInputSchema.parse(manifest);
    for (const invalid of [
      { ...manifest, bytes: MAX_RECORDING_BYTES + 1 },
      { ...manifest, durationSeconds: Infinity },
      { ...manifest, mimeType: "text/html" },
      { ...manifest, sha256: "bad" },
    ])
      assert.equal(recordingInputSchema.safeParse(invalid).success, false);
  });

  void it("binds signed media capabilities to a path and bounded expiry", () => {
    const secret = "offline-test-secret-not-a-real-secret";
    const url = new URL(
      signedRecordingURL(
        "https://example.invalid",
        "/api/recording-media/workspace/note/recording",
        secret,
        60,
      ),
    );
    assert.equal(verifyRecordingURL(url, secret), true);
    url.pathname += "/another";
    assert.equal(verifyRecordingURL(url, secret), false);
    url.pathname = "/api/recording-media/workspace/note/recording";
    url.searchParams.set("expires", "1");
    assert.equal(verifyRecordingURL(url, secret), false);
    assert.throws(() => signedRecordingURL("https://example.invalid", "/audio", secret, 86401));
  });
});
