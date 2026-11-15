# VoidNote Runtime And Data Flow

## Startup Flow

1. `src/main.tsx` mounts `App`.
2. `src/App.tsx` wraps the app in `ThemeProvider` and renders a minimal shell.
3. `src/components/NoteView.tsx` loads the saved `notes` array from `localStorage`.

## Note Lifecycle

### 1. Create Or Select A Note

- Notes are stored in `NoteView`.
- The active note is kept in a mutable ref, not plain React state.
- `updateNote()` acts as the bridge between that mutable ref and the persisted `notes` array.

This is important: the current architecture treats the note object like a mutable draft, then periodically syncs it back into React state.

### 2. Start Recording

When the user presses `Start Recording` in `src/components/Note.tsx`:

- `useSpeechRecognition().startListening()` starts live speech-to-text.
- `useVoiceRecorder().startRecording()` starts the raw mic recording.

These run in parallel.

### 3. Live Transcript Preview

- Only final speech recognition segments are appended into `transcriptOutput`.
- Interim segments stay inside the browser recognition engine.
- The visible transcript is session-local state until recording stops.

### 4. Stop Recording

When the user presses `Stop Recording`:

- speech recognition stops
- media recording stops
- the finalized transcript, audio blob, and object URL are copied into the active note object
- `onResult` pushes that updated note back into the saved notes list

### 5. Optional Upload Path

If the user does not record inside the app, they can upload `audio/*` directly.

That path skips speech recognition and calls diarization immediately.

### 6. Diarization

`useDiarization()` sends a file to AssemblyAI with speaker labels enabled.

The returned transcript is normalized down to the narrow UI shape used by the rest of the app:

```ts
{
  speaker: string | number,
  text: string
}
```

The current UI deliberately ignores richer metadata from AssemblyAI such as timestamps, confidence, or utterance-level detail.

### 7. Results Review

`src/components/Results.tsx` receives the diarization output.

- It keeps a local editable copy in `localResults`.
- Speaker relabeling is applied across every utterance that shares the same speaker identifier.
- A blob URL is regenerated so JSON export always matches the edited result.

### 8. Chat

`src/components/Chat.tsx` opens a note-scoped chat modal.

- `useLLM()` seeds the conversation with the diarized JSON.
- The assistant response is streamed.
- Stream chunks are appended into the last assistant message bubble.

The chat is analysis over structured speaker results, not over a richer note document model.

## Data Model

The core note shape lives in `src/components/Note.tsx` as `NoteModel`.

Fields:

- `id`
- `transcript`
- `diarizationResults`
- `createdAt`
- `audio`
- `url`

## Persistence Reality

What is actually safe to persist today:

- `id`
- `transcript`
- `diarizationResults`
- `createdAt` as a serialized string

What does not round-trip cleanly through `localStorage` JSON serialization:

- `audio: Blob | null`
- `url: string | null` when it is an object URL from `URL.createObjectURL`

That means audio persistence is currently aspirational, not real.

## Important Behavioral Gaps

- Switching to a saved note rehydrates diarization results, but not the visible transcript preview.
- Saved audio URLs are not durable across reloads.
- Chat history is modal-local, not part of the saved note.
- Most failures only surface in the console.

## Why The App Feels Prototype-Heavy

The architecture is optimized for getting the loop working quickly:

- mutable ref for active note
- local persistence with no backend
- direct browser calls to AI services
- modal drill-downs instead of permanent secondary panes

That makes iteration fast, but it leaves state flow and persistence rough around the edges.
