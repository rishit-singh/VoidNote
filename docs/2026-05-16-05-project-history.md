# VoidNote Project History

This timeline is reconstructed from `git log --reverse`.

## 2024-10-13: Foundation

- `91dce88` Initial commit
- `5b2eb37` Added speech recognition
- `d6f7273` Added audio recording

What changed in practice:

- the app started as a lightweight browser capture experiment
- live transcript and mic recording were the first real product capabilities

## 2024-10-26: Structure Arrives

- `fa4fc86` Added AssemblyAI based diarization, and a newish UI
- `595fff0` Added diarization status
- `df0aa45` Added Results component
- `af29727` Added new UI logic

What changed in practice:

- the project moved from raw capture into interpreted conversation
- diarization became the core differentiator
- the UI shifted toward a workflow instead of a bare demo

## 2024-11-03: Notes Become A Workspace

- `685cc77` Added support for multiple notes
- `cff242a` Moved the add button to the side bar

What changed in practice:

- the app stopped being single-session only
- the sidebar pattern and note switching model were established

## 2024-11-18: Editing Ergonomics

- `4bf87f4` Fixed diarization button
- `4a34499` Added on enter save to result label editting

What changed in practice:

- speaker cleanup became faster and less awkward
- the app started acknowledging human correction as part of the flow

## 2024-11-21 To 2024-12-17: Theme And AI Layer

- `7c615ff` Added a dark theme, with a Chat component
- `2bb0c8a` Added LLM support
- `cc44af6` Misc updates
- `79005bb` Major UI updates
- `79bfb57` Added chat back in

What changed in practice:

- the dark, tool-like product identity became explicit
- chat moved from idea to product surface
- the repo shows some iteration churn around whether chat belonged in the experience and how

## 2024-12-01: Documentation Cleanup

- `de4f2e8` Removed Mongo from the README, was never supposed to be there
- `b3331b8` Update README
- `4c698e5` Fixed logo image in README

What changed in practice:

- public-facing project framing was corrected
- the README became more honest about the stack

## 2025-06-14 To 2025-06-25: Branding And Recorder Refactors

- `4de5bbb` rebrand: YapNote → VoidNote
- `b7d9d3b` Added a recorder lib with a standard browser recorder implementation
- `523310e` Update README
- `032f997` Update logo favicon

What changed in practice:

- product identity shifted from YapNote to VoidNote
- recording internals were still being revisited well after the original product loop existed

## Current Uncommitted State

At the time of this documentation pass, the worktree also contains:

- a simplified `src/hooks/useVoiceRecorder.tsx`
- a small cleanup in `src/components/Results.tsx`
- an untracked experimental component at `src/components/ui/realtime-playback.tsx`

That suggests the codebase is still in active experimentation, especially around the audio pipeline.
