# WebKit audio upload compatibility

## Reproduction

A generated two-second Vorbis/Ogg file loads with duration `2` in Chromium but
fails the metadata probe in macOS Playwright WebKit 27.2. Against the previous
built Worker, normal-profile WebKit shows "This browser cannot decode the audio
file" and never sends the upload. WebM and M4A diagnostic fixtures load in both
engines, though M4A timing differs slightly between them.

The user subsequently clarified that both microphone recording and WebM uploads
fail on Mac and iPhone, with Safari 18.3.1 reported on the Mac. The exact UI error
was the local **playback** error, accompanied by `WebKitBlobResource error 3` and
a `recordings.overview` 404. The initial Ogg reproduction alone does not establish
that it reproduces that report.

## Native Safari follow-up (November 22)

Safari DevTools MCP connected to installed Safari 18.3.1. Small WebM files and a
native microphone recording initially loaded successfully. A generated headerless
15-second WebM (218,964 bytes) then reproduced a concrete duration-probe defect:

- `preload="metadata"` with no seek settles to duration `15.0135`, without error.
- The old metadata handler's `currentTime = 1e10` fails with `MediaError.code = 2`
  and duration `NaN`. WebKit identifies Blob resource error 3 as a range error.

The upload metadata probe now waits for normal duration events, or parses container
timing when native timing stays unavailable. Playback also replaces its
`Number.MAX_SAFE_INTEGER` probe with bounded, cancellable container parsing.
Neither path seeks past the audio to discover duration. Parsed playback timing
survives native `Infinity`, while later finite native timing takes precedence.
The optional parser stops when native timing appears or the source/owner changes.

The overview 404 has a separate verified client race: new-note navigation requests
recordings before debounced autosave persists the note. Overview observers now wait
for current-scope recovery and acknowledgement of known local creations. The query
key stays stable, title edits do not disable it, and real server 404s remain errors.

## Implementation

- Read WebM container timing before initialization: Linux WebKit CI exposed a
  finite first-cluster estimate (`0.341` seconds for the 15-second fixture).
  A positive finite native duration is therefore insufficient for that format.
  Previously pinned or remotely accepted initialization commands remain exact.
- Keep browser-derived timing for other formats when available. On metadata failure or timeout,
  lazily load pinned `music-metadata@12.8.0` and read container timing without
  requiring a playback decoder. Missing/nonfinite/nonpositive timing is rejected.
- Bound fallback reads to 32 MiB cumulatively, including rereads, with an 8 MiB
  per-read/allocation cap and 1,024 entries per parsed metadata list. This is an
  input budget, not an exact heap limit. Large scan-heavy files may exceed it;
  native metadata probing for other formats retains the existing 1 GiB/two-hour
  application limits.
- Check ownership at read boundaries and after native probing. Latch cancellation
  and budget failures so parser error recovery cannot accept partial results.
- Persist the exact initialization command in the finalized IndexedDB manifest
  before sending it. Atomic first-writer-wins pinning preserves the same duration,
  hash, size, MIME type and recording ID across retries, reloads and decoder changes.
- Older manifests without a pin first read the authorized recording overview.
  Matching remote hash/size/MIME allows recovery of the server's exact duration.
  New recordings derive timing locally. Both paths persist the command before send.

Audio bytes remain unchanged and durable. Upload compatibility does not add codec
playback support; unsupported playback still offers the saved audio for download.

## Browser test context

WebKit ephemeral contexts independently reject every IndexedDB Blob, including
two-byte memory-backed Blobs. Persistent contexts successfully store the same
values. See [WebKit 156347](https://bugs.webkit.org/show_bug.cgi?id=156347) and
[Playwright 42795](https://github.com/microsoft/playwright/issues/42795).

The compatibility suite uses a fresh persistent WebKit profile, removed after each
test, to exercise normal Safari storage semantics. It does not alter application
audio storage to bypass the private-context limitation. CI installs WebKit and
runs this focused project alongside the existing Chromium suite.

WebKit's interception protocol also omits Blob request bodies. The upload tests
therefore forward the real PUT to a test-local HTTP receiver and compare its bytes
with the fixture. Initialization and processing APIs remain mocked.

## Verification and delivery

- Nine focused duration tests cover real Ogg timing, preserved browser
  timing, malformed input, native/fallback ownership retirement, and cumulative
  reads across individually valid FLAC comment blocks, plus headerless WebM timing
  without a duration seek and rejection of WebKit's finite first-cluster estimate.
- Built Worker compilation and affected application/tool/database-test/E2E
  TypeScript checks pass. Changed-file ESLint passes with zero warnings.
- The initial ten compatibility cases passed against the built Worker (five Chromium, five
  WebKit): lost initialization response, legacy unpinned initialization recovery,
  interrupted upload, committed upload with lost response, and malformed audio.
  Reload tests change the available browser duration and verify identical commands,
  actual transmitted bytes and a single processing submission.
- Six existing Chromium audio/processing integration cases passed in the initial
  slice, including capture, playback ownership and upload/reload behavior.
- All 27 follow-up browser cases pass against the rebuilt Worker: 21 Chromium and
  six WebKit cases, including safe headerless WebM upload/play/seek/reload,
  current-scope recovery and held-create acknowledgement, native Chromium capture,
  existing processing/playback journeys, and 320 MiB interrupted upload recovery.
- Installed Safari 18.3.1 loaded the updated built-app harness's 218,964-byte
  headerless WebM with duration `15.0135`, zero captured media errors and no
  duration seeks. Trusted keyboard activation advanced playback beyond four
  seconds. Script-triggered playback was correctly rejected by Safari's gesture
  policy. This harness mocks API/authentication responses.
- A native Safari microphone capture completed and loaded before the follow-up
  playback change. A later capture attempt awaited permission and was cancelled.
  Full native Safari reload acceptance was limited by the harness's unimplemented
  remote-audio GET; automated Chromium/WebKit reload coverage passed.
- Independent source review found no remaining blocking issues after fixes.

Production delivery was authorized on November 22 and follows the checked `main`
CI workflow. Its production-delivery artifact records the released commit,
Cloudflare version and health-smoke result; local verification above does not
establish deployment. Native macOS Safari diagnostics and a built-app harness
with mocked APIs are distinct from physical iPhone and live transcription-provider
acceptance, which remain outstanding.
