# Recording-first UX reset

This reset replaces the procedural recording/correction UI. Titles autosave;
recording and file import automatically enqueue upload and processing. Generated
speech is the main note content. Ordinary screens omit recording lists, revision
numbers, correction history and manual transcript textareas.

The subsequent local state refactor is tracked in
[`2026-11-14-query-state-foundation.md`](2026-11-14-query-state-foundation.md).
Its verification and deployment status are separate from the deployed evidence below.

## Ownership and recovery

- The recording manifest commits its pending processing state alongside successful
  finalization. A shell-owned, account-bound queue resumes it after reload/reconnect.
- Uploads keep the original note identity across navigation. The existing bounded
  hashing and resumable 8 MiB parts support files up to 1 GiB / two hours.
- Playback follows the route; ongoing microphone capture retains its original
  note. Late source loads are generation-checked.
- New recording initialization is serialized per note and rejects a second audio
  identity while allowing exact retries. Existing data is retained. A read-only
  production check found no notes with multiple non-deleted remote recordings.
- Duplicate copies audio to a new note and processes it again. Start over creates
  a new empty note without deleting the original.
- Autosave retains exact pending commands and newer drafts separately. Conflicts
  ask which version to keep without exposing revision numbers.

## Speaker correction

Choose an existing speaker, Unknown, or create a speaker in the same dialog.
Selection uses highlighted words and adjustable audio boundaries. Range playback
stops at the selected endpoint. The initial range is an estimate from turn-level
timing; exact word alignment is not available.

The existing `split` command accepts an optional `selection` with text offsets,
audio bounds, a stable selected-segment ID and assignment. One transaction creates
up to three children and the assignment. One Undo restores the source turn, unless
newer changes prevent it. Immutable provider evidence and internal history remain.

Consecutive same-speaker turns now form readable passages when gaps are at most
one second, without overlaps or intervening speakers. Backend responses include
page-local passage metadata; the UI also groups across loaded pages. Original
segment IDs remain edit targets. Passage speaker assignment updates all its loaded
segments, while individual text spans retain selection correction.

Markdown export is controlled by `NEXT_PUBLIC_TRANSCRIPT_MARKDOWN_EXPORT=true`
at build time and enabled in the demo deployment. It downloads all corrected
transcript pages, with speaker names and timestamps.

## Verification

- Next/OpenNext Worker build, seven TypeScript targets, zero-warning ESLint,
  repository formatting and `git diff --check` passed.
- 81 database/unit tests passed, including concurrent one-recording initialization,
  atomic selected-range assignment/Undo, exact decimal endpoints and repeated
  selection of segments with surrounding whitespace.
- Two read-only subagent reviews completed. Their playback ownership, account-epoch
  job state and selection-boundary findings were fixed.
- All 49 Chromium browser tests passed against the built Worker, including the
  320 MiB interrupted upload/reload/resume journey, upload continuing for its
  original note after navigation, second-tab capture exclusion/recovery, scoped
  playback, desktop/mobile speaker assignment and clearing selection replay bounds.
- Reviewed fresh desktop/mobile speech-selection screenshots; selection, range
  controls and speaker actions fit both viewports.

The UX reset was deployed as `c3a7e02b-513c-4719-b0c0-6e3d8714f48b`, followed
by grouping and Markdown export in `46c2f778-a3e8-4517-9682-8be950aa5117`.
The follow-up passed its build/typecheck, two grouping unit tests and one focused
browser smoke test for grouped assignment plus Markdown download. Changes remain
uncommitted and unpushed on `feat/next-bun-foundation`.

Live multi-speaker provider quality and physical microphone/device-removal
acceptance still require a real recording/device session. Fresh Paper comparison
was blocked by its weekly MCP limit. Summary/Ask inference and live Logfire
ingestion remain unconfigured.
