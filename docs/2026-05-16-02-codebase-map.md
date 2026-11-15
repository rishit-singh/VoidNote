# VoidNote Codebase Map

## Top-Level Layout

- `src/`: source of truth for the app.
- `public/`: static assets, currently mostly branding.
- `dist/`: build output. Useful for deploy artifacts, not for source edits.
- `README.md`: public-facing summary and setup notes.
- `vite.config.ts`: Vite config with HTTPS support and browser-worker tuning.
- `tailwind.config.js`: Tailwind theme extension for the shadcn-based design tokens.
- `components.json`: shadcn UI configuration.

## Source Tree

### App Shell

- `src/main.tsx`: React bootstrap.
- `src/App.tsx`: theme provider and one-frame app shell.
- `src/App.css`: root height only.
- `src/index.css`: base Vite styles plus the actual design tokens used by the app.

### Product Components

- `src/components/NoteView.tsx`: owns the note list, current note selection, and `localStorage` note persistence.
- `src/components/Note.tsx`: owns recording, upload, transcript preview, diarization trigger, and results rendering.
- `src/components/Results.tsx`: note review modal, speaker relabeling, JSON export, and chat entry point.
- `src/components/Chat.tsx`: modal LLM chat seeded from diarization output.
- `src/components/theme-provider.tsx`: dark and light theme class toggling.

### Hooks

- `src/hooks/useLocalStorage.tsx`: generic `localStorage` wrapper.
- `src/hooks/useCrypto.tsx`: tiny browser crypto accessor.
- `src/hooks/useSpeechRecognition.tsx`: Web Speech API wrapper.
- `src/hooks/useVoiceRecorder.tsx`: `MediaRecorder` wrapper.
- `src/hooks/useDiarization.tsx`: AssemblyAI transcription with `speaker_labels: true`.
- `src/hooks/useLLM.tsx`: Groq chat wrapper with streaming response handling.

### UI Primitives

- `src/components/ui/`: mostly shadcn/Radix primitives.
- Only a subset is currently used in the product flow: `button`, `alert-dialog`.
- `realtime-playback.tsx` is an experimental, currently unmounted streaming-audio component.

### Utilities And Unused Support Code

- `src/lib/utils.ts`: Tailwind class merge helper.
- `src/lib/logger.ts`: richer logger, currently only used by the experimental realtime playback component.
- `src/lib/recorder.ts`: recorder interface type from an earlier abstraction attempt.
- `src/lib/time.ts`: unused timestamp helper.

## External Services

- AssemblyAI: diarization and transcription.
- Groq: chat analysis on diarized results.

## Browser APIs

- `window.SpeechRecognition` or `window.webkitSpeechRecognition`
- `navigator.mediaDevices.getUserMedia`
- `MediaRecorder`
- `window.localStorage`
- `window.crypto.randomUUID`
- `URL.createObjectURL`

## Environment Variables

- `VITE_ASSEMBLYAI_API_KEY`
- `VITE_GROQ_API_KEY`

Both are used in browser code today. That means both secrets are effectively client-exposed.

## Architecture In One Sentence

This repo is a single-page React prototype where note state is mostly local, service calls happen directly from the browser, and UI composition is intentionally simple: sidebar, workspace, modal drill-downs.
