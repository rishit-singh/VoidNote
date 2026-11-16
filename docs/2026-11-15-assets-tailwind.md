# Shared assets and Tailwind design system

This slice preserves the recording-first UI and the released landing design while
moving component styling from the legacy stylesheets into Tailwind utilities and
shadcn variants.

## Ownership

- `src/assets` owns custom brand/audio artwork and its public export surface.
  The current landing waveform is the favicon identity. The original logo is
  retained as `legacy-logo.svg`; unused React starter artwork is removed.
  IBM Plex Mono WOFF2 files and their OFL license are bundled under `assets/fonts`
  and loaded through `next/font/local`, removing the build-time Google fetch.
- `src/design/tokens.ts` owns the exact Paper-derived palette. Tailwind exposes
  it through `vn` colors and retains the existing typography scale. shadcn
  semantic tokens remain in `src/app/globals.css` alongside base rules.
- Responsive layout, focus, selection and reduced-motion styling live with
  components as Tailwind utilities. Existing Motion animations remain in place.
- `bun run assets:generate` produces the SVG favicon, multi-frame ICO, 180px
  Apple touch icon and legacy SVG under `public/assets/brand`. The production
  build regenerates these checked-in files. Sharp is a pinned development
  dependency for reproducible raster generation.
- Next metadata consumes the asset URL catalog. Conventional `/favicon.ico` and
  historical `/logo.svg` URLs redirect to the assets directory.
- The legacy Vite entry point now imports the same global foundation as Next.

See [`src/assets/README.md`](../src/assets/README.md) for asset authoring.

## Verification and delivery

- All seven TypeScript targets, zero-warning ESLint, repository formatting and
  `git diff --check` passed under Node 24 and Bun.
- The production Next/OpenNext Worker build passed. The initial external font
  timeout was resolved by bundling fonts. The isolated worktree uses local
  hardlinked dependencies because Turbopack rejects an external `node_modules`
  symlink.
- Built-Worker Chromium checks: 32 passed in the combined assets, landing, shell,
  workspace and transcript-correction run. The delayed correction/navigation test
  timed out waiting for Retry, then passed unchanged in an isolated rerun.
  One Markdown-export demo was skipped because its feature flag was disabled.
- PR #8 CI reproduced that failure (69 browser tests passed, one skipped).
  The test released its delayed acknowledgement before Next navigation committed,
  allowing the original editor to legitimately clear recovery. It now waits for
  the destination URL/title and old editor disappearance before releasing the
  response, observes acknowledgement, and verifies exact command retry on return.
  The corrected test passed ten consecutive built-Worker executions with CI
  settings, one worker and no retries; focused lint, formatting and e2e TypeScript
  checks also passed.
- Favicon metadata, SVG/ICO/Apple icon responses, conventional `/favicon.ico`
  fallback and legacy `/logo.svg` compatibility passed.
- Landing tests cover widths 320–768px and 1440px, live reduced-motion changes,
  replay, sign-in and focus restoration. Shell tests cover 390/820/1440px with
  note/profile editing, settings and recorder positioning. Desktop/mobile
  screenshots were visually reviewed.
- Compared captured production and migrated landing screenshots at 375px and
  1440px: identical image dimensions, with only 115 and 138 pixels respectively
  differing by more than four channel values. This supports landing fidelity;
  application screenshots are separate mocked-journey evidence.
- Independent source reviews found no remaining blockers. Corrected mobile
  sign-in padding, paths with spaces in asset generation, custom typography
  recognition by `tailwind-merge`, and ambiguous transition utilities before
  final verification.

Implemented in the isolated `feat/assets-tailwind` worktree based on release
`8345857`, prepared for a pull request targeting `main`. Deployment remains pending.
These browser checks use mocked application data and do not establish real
provider or hosted authenticated acceptance.
