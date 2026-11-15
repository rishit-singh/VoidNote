# Speaker and transcript corrections

Speaker labels from pyannoteAI identify tracks within a recording. They are not
person identities. A saved profile is a workspace-local identity that can be used
across recordings; renaming it does not change which speech is assigned to it.

## Editing speech

Open a finalized transcript and choose a speaker label. Assign the selected speech
to a saved profile, create a guest profile, or explicitly mark the speaker as
unknown. Unknown is a manual decision, separate from speech that has never been
assigned.

Choosing a speaker applies the change immediately. Typing a new name offers
inline creation in the same dialog. The transcript is read-only; select text or
use the scissors action to select a speech range, replay it, and assign its speaker.

Audio range estimates use turn timestamps, not word-level alignment. Adjust the
range while listening. Assigning part of a turn splits and assigns it atomically,
preserving source lineage and any speech on either side. Overlapping speech stays
intact. Selecting the complete turn uses the ordinary assignment command.

Correction history records before/after states internally. The ordinary UI exposes
the latest Undo rather than a history browser. Undo is a new compensating
change: it is rejected when a newer edit changed any affected target. Refresh and
review a conflict rather than replacing someone else's correction.

## Data boundaries

- Provider utterances stay immutable. Effective transcript reads combine them with
  manual corrections and split-segment lineage.
- Attribution revisions are independent of note-title revisions. Exact command
  retries return their stored receipt; reuse with different content is rejected.
- Boundary changes advance attribution revisions too, so an earlier time-range
  preview cannot silently assign a changed audio span. Text-only edits preserve
  the attribution revision.
- Every read and command is authorized for the workspace and active note/recording.
  Profile selection uses the same persisted IDs as the Profiles screen.
- Profile appearances are paginated. Their links select the right recording and
  queue its timestamp in the persistent player without autoplay.
- Corrections retain original text, source utterance IDs, and original audio spans.
  Dependency invalidations are recorded for later analysis consumers. Assignment
  does not automatically enroll a voice sample.

## Future reprocessing

There is still one logical processing run per recording and no user-facing rerun
action. `src/lib/transcript-reprocessing.ts` defines and tests a conservative policy
for that future integration: contiguous, unambiguous audio coverage can preserve a
manual person or manual unknown; conflicting identities, overlaps, gaps, changed
input revisions, and unmatched originals remain reviewable. Text corrections are
retained separately rather than copied blindly onto a new segmentation.

A future publisher must check source revisions again in its commit transaction.
The mapping function alone is not an implemented rerun workflow.

## Previous deployed slice — verification

Migration `0005_transcript_corrections.sql` is applied. The deployed Worker version
is `824b91e4-b65b-44e4-bc22-eac559b3badb` (2026-11-14). Applied migrations 0000–0004
were preserved.

The UX reset described above supersedes that deployed slice's visible controls.
Its verification is recorded in [the UX reset notes](2026-11-14-recording-ux-reset.md).

- All 76 database/provider/recovery tests passed, including 17 real PostgreSQL
  correction cases and 15 deterministic future-resegmentation cases. Coverage
  includes concurrent corrections, exact command replay, actor/workspace isolation,
  late provider publication, rollback, stale undo, split lineage, bounded queries,
  and boundary changes invalidating frozen targets.
- All 55 browser tests passed against the built workerd preview. New cases cover
  desktop/mobile keyboard selection, bulk counts, manual exclusion/opt-in, guests,
  text/timing edits, split/undo/history, stale conflicts, definitive rejection
  recovery, uncertain-command replay, account/route isolation, and profile links
  selecting the correct audio source and timestamp.
- Seven TypeScript targets, zero-warning ESLint, formatting, Next/OpenNext build,
  deployment dry-run, and private-value source/build scanning passed.
- Live authenticated production checks used a temporary account, private R2 audio,
  deterministic provider-output fixtures, real handlers and Postgres. Both desktop
  and mobile exercised single/track assignments, concurrent stale-preview conflict,
  splitting, undo, history and reload. API checks also covered explicit unknown,
  exact retry, concurrent correction, undo after a newer edit, profile rename,
  appearances, manual-note isolation and unauthenticated 401. No paid processing
  job was submitted. Temporary records, account and audio were removed.
- Screenshots of the picker, split, conflict and transcript surfaces were reviewed
  at 1440px and 390px. Mobile save/listen controls remain visible and no horizontal
  overflow was found. Fresh Paper comparison remains blocked by its weekly MCP
  limit; this is not final Paper acceptance.

History snapshots have an approximately 2 MiB atomic limit. Transcript/history
pages are byte-budgeted as well as count-limited; profile appearances return short
excerpts. Nested splits are limited to 256 levels. Saving currently refreshes the
first transcript page, so editing later pages requires loading them again.
Exact submitted commands are recovered locally; unsent correction-dialog drafts
are not persisted. Downstream analysis-invalidations and voice-sample enrollment
consumers remain future work. Real multi-speaker provider quality still needs the
user's recording acceptance.
