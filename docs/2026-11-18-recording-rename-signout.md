# Recording preview and sign-out simplification

## Scope and evidence

The reported symptom is a note mismatch/conflict when renaming during recording.
Recording ownership already uses stable note, workspace and user IDs. Database
recordings reference notes by ID; titles and note revisions are not recording keys.

Source inspection found browser speech results writing into the same note draft
and autosave generation as the title. The saved payload included both title and
browser transcript. This unnecessarily coupled temporary recognition output to
note persistence. It also let incoming speech retain a rejected title while a
"Use latest" conflict read was pending. The original reported conflict has not
yet been reproduced against production.

## Ownership

- Browser recognition is a provisional capture preview, scoped to its recording's
  note and account. It must not write the note title, note transcript, save revision
  or durable note-command queue.
- Audio chunks remain durable in IndexedDB. Upload and finalized transcription
  keep their existing identities and persistence. Final provider transcripts are
  authoritative; browser previews are runtime-only.
- Note autosave retains its existing exact-command retry and conflict checks.
  Previously stored note transcript text is not deleted or migrated.
- Sign-out ends authentication and clears the outgoing in-memory scope. It does
  not implicitly save profile drafts or discard pending commands/local audio.
  Account-scoped unsynced work remains available on the same device after sign-in.
- A clean sign-out needs no draft decision or functioning draft storage. An active
  capture must be stopped first. If actual unsynced edits cannot be checkpointed,
  retain the session and show the specific failure.

## Verification and delivery

Implemented locally on `fix/recording-rename-signout`, based on `36dc79e`.
The built-Worker browser regression also exposed an independent display bug:
after choosing “Use latest”, the editor showed the older cached title. It now
checks the cached detail revision against the accepted draft revision before rendering it.

The Worker build passed. All nine focused Chromium cases passed against its local
preview with simulated microphone/speech and API fixtures, including a delayed rename,
navigation, conflict recovery and logout. All 46 focused store/query tests passed.
These checks do not establish hosted or physical-device acceptance. Not deployed.

The note-store and browser fixtures now check expected revisions on ordinary saves,
matching production behavior instead of silently accepting stale commands. Explicit
browser receipt replay remains ahead of that check.
