# VoidNote assets

Import reusable artwork and URLs through `@/assets`:

- `Brand`, `BrandMark`: current waveform identity and wordmark.
- `Waveform`, `LiveWaveform`, `PlayMark`: decorative and live audio artwork.
- `assetUrls`: browser icons and the preserved legacy logo.

`brand-source.ts` owns the shared mark geometry. `legacy-logo.svg` retains the
original artwork. The unused React starter logo was removed.

`@/assets/fonts` configures the bundled IBM Plex Mono regular/medium/semibold/bold
and italic WOFF2 files with `next/font/local`. These are complete font files from
[IBM Plex](https://github.com/IBM/plex/tree/bc6a7e4b37634eb79785d59781893db63ee3edcb/packages/plex-mono),
package version 2.5.0, under the included `fonts/OFL.txt` license. Builds require
no Google Fonts request.

Run `bun run assets:generate` after changing the mark or its palette. It generates
SVG, multi-size ICO and Apple touch icons plus the legacy logo into
`public/assets/brand/`. These delivery files are checked in; the production build
also regenerates them. Do not hand-edit generated files.

Colors live in `src/design/tokens.ts` and are exposed as Tailwind `vn` utilities
(for example `bg-vn-page`, `text-vn-mint`). The shadcn semantic theme lives in
`src/app/globals.css`; that file contains only tokens and base rules. Component
layout, responsive states and visual variants belong in Tailwind classes and
existing shadcn primitives. Runtime animations remain with Motion.

Next metadata uses the asset URL catalog. `/favicon.ico` and the old `/logo.svg`
URL redirect to the assets directory for compatibility.
