# VoidNote Upgrade Backlog

## Validation Snapshot

- `npm run build`: passes
- `npm run lint`: fails with `20` errors and `6` warnings

## Priority 0

### Move third-party API calls off the client

Why:

- `useDiarization` reads `VITE_ASSEMBLYAI_API_KEY` in browser code.
- `useLLM` reads `VITE_GROQ_API_KEY` in browser code.
- `dangerouslyAllowBrowser: true` is a clear sign this is still prototype mode.

What to do:

- add a server or worker boundary
- proxy AssemblyAI and Groq through that boundary
- remove client-exposed secrets

### Fix note persistence semantics

Why:

- `Blob` values do not survive `localStorage` JSON serialization
- object URLs are not durable across reloads
- `createdAt` stops being a `Date` and becomes a string after persistence

What to do:

- decide whether notes are metadata-only or fully durable
- if durable, move audio into IndexedDB, object storage, or backend storage
- add a proper note serialization and hydration layer

## Priority 1

### Replace the ref-driven active note model

Why:

- `NoteView` uses a mutable ref as the active note source of truth
- several effects intentionally work around React's dependency model
- the current pattern is easy to desync and hard to reason about

What to do:

- move to reducer or store-based note state
- make note updates explicit actions instead of mutable object patching

### Tighten the TypeScript surface

Why:

- lint reports many `any` usages across hooks and components
- diarization results are structurally important but not strongly typed

What to do:

- define a shared typed result shape
- remove `any` from note, results, chat, and speech recognition flows

### Make chat state deterministic

Why:

- `useLLM` updates `messageHistory` and also reads it immediately afterward
- React state timing can make the chat payload stale

What to do:

- compute next history in one place
- send exactly the history that will be committed to state

## Priority 2

### Improve browser capability and error handling

Missing today:

- explicit unsupported-browser handling for Web Speech API
- clear permission-denied states for microphone access
- user-facing errors for diarization and chat failures
- meaningful loading and retry states

### Rehydrate saved notes more completely

Missing today:

- visible transcript is cleared when notes switch
- saved audio is not replayable after reload
- chat is not persisted or tied into note history

### Decide what to do with experimental and unused code

Candidates:

- `src/components/ui/realtime-playback.tsx`
- `src/lib/logger.ts`
- `src/lib/recorder.ts`
- `src/lib/time.ts`
- unused shadcn primitives in `src/components/ui/`

Options:

- integrate them
- move them into an explicit `experimental/` area
- delete them

## Design-Level Upgrades

### Connect the three views of a note

Right now a note is split across:

- raw transcript preview
- diarized result modal
- chat modal

The next product-quality jump is to make those feel like one coherent document instead of three loosely related surfaces.

### Make the visual system more ownable

The current dark theme is coherent, but still stock in places.

Good upgrade directions:

- stronger note identity in the sidebar
- clearer hierarchy between raw transcript and structured output
- less dependence on generic modal patterns for primary content

## Quick Wins

- remove debug logging that is no longer useful
- add an actual supported-browser guard for speech recognition
- add tests around note persistence and speaker relabeling
- update README and setup docs whenever env or runtime assumptions change
