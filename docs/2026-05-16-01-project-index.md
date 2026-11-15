# VoidNote Re-Entry Index

Snapshot date: `2026-05-16`

Historical snapshot. For the current Next/Cloudflare toolchain and commands, start
with [the November foundation setup](./2026-11-13-01-foundation.md).

This is the fast way back into the project.

## What VoidNote Is

VoidNote is a browser-first, voice-first note workspace.

The current product loop is:

1. Create or select a note.
2. Record audio or upload an audio file.
3. Run diarization to split speech by speaker.
4. Rename speakers for readability.
5. Ask the LLM questions about the structured result.
6. Export the diarization JSON.

There is no backend in this repo right now. Local note metadata lives in `localStorage`, while AssemblyAI and Groq are called directly from the browser.

## Re-Entry In Five Minutes

1. Copy `.env.example` to `.env` and fill in `VITE_ASSEMBLYAI_API_KEY` and `VITE_GROQ_API_KEY`.
2. Install dependencies with `pnpm install` or `npm install`.
3. Start the dev server with `npm run dev`.
4. Open the local HTTPS URL shown by Vite. HTTPS matters here because the app depends on microphone and speech APIs.
5. Start reading at `src/components/NoteView.tsx`, then `src/components/Note.tsx`, then the hooks in `src/hooks/`.

## Current Health Snapshot

- `npm run build` passes.
- `npm run lint` fails with `20` errors and `6` warnings.
- Most lint failures are type looseness (`any`) and hook dependency issues.
- The app is a functional prototype, not yet a hardened product shell.

## Documentation Map

- [02 codebase map](./2026-05-16-02-codebase-map.md)
- [03 runtime and data flow](./2026-05-16-03-runtime-and-data-flow.md)
- [04 product and design approach](./2026-05-16-04-product-and-design-approach.md)
- [05 project history](./2026-05-16-05-project-history.md)
- [06 upgrade backlog](./2026-05-16-06-upgrade-backlog.md)

## Highest-Leverage Files

- `src/components/NoteView.tsx`: top-level note list, current-note selection, local persistence bridge.
- `src/components/Note.tsx`: core record, upload, diarize, and render workflow.
- `src/components/Results.tsx`: speaker relabeling, modal review, JSON export.
- `src/components/Chat.tsx`: note-scoped LLM chat UI.
- `src/hooks/useSpeechRecognition.tsx`: live browser speech recognition.
- `src/hooks/useVoiceRecorder.tsx`: raw microphone capture.
- `src/hooks/useDiarization.tsx`: AssemblyAI browser call.
- `src/hooks/useLLM.tsx`: Groq browser call.

## Risks At A Glance

- Secrets are exposed client-side for both third-party APIs.
- The active note model is ref-driven, which makes updates easy to patch in but hard to reason about.
- Audio blobs and object URLs do not survive `localStorage` serialization.
- Existing transcripts are stored on the note object but are not fully rehydrated into the visible editor flow.
- There is a partially integrated experimental file at `src/components/ui/realtime-playback.tsx`.
