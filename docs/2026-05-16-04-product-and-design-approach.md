# VoidNote Product And Design Approach

## Product Thesis

This app is built around one clear idea: spoken conversation is the source material, and structure is something the product adds after capture.

It is not trying to be a rich text notebook first. It is trying to be a voice capture and interpretation tool.

## Interaction Model

The interaction sequence is intentionally linear:

1. choose a note
2. capture or upload audio
3. generate structure
4. clean up speaker identity
5. query the result

The code strongly reflects that sequence. Each stage unlocks the next one instead of presenting every tool at once.

## Visual Language

The current UI reads as:

- dark-first
- monochrome
- border-defined
- low ornament
- utility over flourish

The app mostly uses shadcn's `new-york` style as a base, then keeps the palette tight and lets spacing, borders, and typography carry the hierarchy.

## Layout Philosophy

There are three main surfaces:

- left sidebar for note switching
- main work surface for the current note workflow
- modal overlays for secondary detail views like results and chat

That says a lot about the intended product behavior.

The main canvas is supposed to stay clean and focused on the current step. Secondary complexity is hidden until the user asks for it.

## UX Priorities Visible In Code

- Empty-state friction is low. If there are no notes, the product immediately prompts for a new one.
- Capture is the primary action. Recording sits at the center of the note screen.
- Structured review is separated from raw capture. Results are not always visible.
- AI is downstream of structure. Chat only becomes meaningful after diarization exists.

## Design Strengths

- The product loop is easy to explain.
- The dark theme matches the tooling/prototype tone.
- The sidebar plus workspace layout scales naturally to more note metadata later.
- Speaker relabeling is a smart human-in-the-loop correction point.

## Design Tensions

- Raw transcript, diarized result, and chat each live in separate UI zones, so the full story is fragmented.
- Modal-heavy detail views keep the main page clean but also hide a lot of useful context.
- The visual system is coherent, but still generic in places because it leans heavily on stock shadcn primitives.
- The data model is thinner than the experience suggests. The UI implies durable saved notes, but the audio layer is not truly durable yet.

## If You Pick This Back Up

If the goal is to preserve the current design spirit, keep these constraints:

- stay dark-first
- keep one dominant action per stage
- preserve the note list plus focused workspace composition
- avoid turning the app into a giant dashboard
- let structure and analysis remain downstream of capture

If the goal is to mature the product, the next design step is probably not more chrome. It is tighter state continuity between transcript, speakers, audio, and AI output.
