<div align="center">
  <img src="public/assets/brand/favicon.svg" alt="VoidNote Logo" width="64">
  <h1>VoidNote</h1>
  <p><em>Voice-first conversation capture.</em></p>

  <a href="https://opensource.org/licenses/MIT">
    <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License">
  </a>
  <a href="http://makeapullrequest.com">
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome">
  </a>
  <a href="https://nodejs.org/">
    <img src="https://img.shields.io/badge/node-24-brightgreen" alt="Node.js 24">
  </a>
</div>

---

## Features

- Authenticated notes with autosaving titles and reusable speaker profiles.
- One recording per note, with a generated transcript and account-scoped access.
- Paper-based Home, note, profile and Settings screens with responsive navigation.
- Device-local draft recovery and exact retries after an uncertain save.
- Microphone capture that survives navigation, locally persisted audio files,
  recovery, playback and download.
- Private remote audio upload, durable pyannoteAI transcription/diarization, and
  reloadable timestamps connected to the persistent player.
- Immediate speaker assignment, inline speaker creation, visual speech selection,
  bounded selection replay and conflict-safe undo.
- Optional Markdown transcript download: build with
  `NEXT_PUBLIC_TRANSCRIPT_MARKDOWN_EXPORT=true` to show Download Markdown.

Audio is saved locally first. Stopping capture or importing a file automatically
uploads a private remote copy and starts transcription and diarization. Capture
stays with its original note; playback follows the opened note.
Files up to **1 GiB** are supported (two-hour duration limit). Large uploads use
8 MiB parts and resume acknowledged parts after reload or reconnect; interrupted
uploads also offer Retry. Duplicate copies the audio into a new note and processes
it again. Start over creates a fresh note while retaining the original.
See [speaker corrections](docs/2026-11-14-speaker-corrections.md) for the editing
workflow and current limits. Summary and Ask are upcoming work.
Automatic classification and sharing are not implemented.

---

## Getting Started

### Requirements

- Node.js 24 (see `.node-version`)
- Bun 1.4.0
- Current Chromium-based browser with microphone access, IndexedDB and Web Locks
- Docker Desktop or OrbStack for local Supabase Auth, Postgres and email capture
- Internet for initial installation and optional live transcription/AI

---

### Install

```bash
git clone https://github.com/rishit-singh/voidnote.git
cd voidnote
bun install --frozen-lockfile
bun run dev:setup
```

Start Docker first. Setup starts local Supabase, applies Drizzle migrations and
creates `.dev.vars.development` with local auth settings. Existing data and
configuration are preserved. See [local development](docs/local-development.md)
for configuration, persistence and optional real-provider setup.

---

### Run

```bash
bun run dev:local
```

Open **http://localhost:8787**, request an email sign-in link, then open it from
**http://localhost:54324** (Mailpit) in the same browser. This uses real local
Supabase authentication.

`dev:local` builds and runs the complete app in Cloudflare's local Worker runtime.
Use `dev:preview` to restart an unchanged build. Stop the app with Ctrl+C and stop
Supabase with `dev:stop`; data is retained. The existing `dev` command is for
Next-only UI iteration and does not run the background Workflow bindings.

### Checks and Cloudflare preview

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test:worker
bun run test:auth
bun run build:worker
bun run deploy:check
bunx --no-install playwright install chromium
bun run test:e2e
```

`test:e2e` starts its own built app in local Cloudflare `workerd`, not `next dev`.
For authenticated manual development, use `dev:local` as described above.

For offline Summary evaluation, run `bun run eval:summary --list` or
`bun run eval:summary artifact.json`. See the
[frozen quality baseline](docs/experiments/summary-quality-offline/README.md)
for artifact formats and human review. These commands do not call a model.

See [local development](docs/local-development.md) to configure Supabase email
sign-in and Postgres. Notes and person profiles use server storage.
Prototype import, string-label correction and chat endpoints have been retired;
they are not supported compatibility paths. Current speaker correction uses stable
person and utterance identities with revision-checked commands.

The production Worker is deployed at
<https://voidnote-production.rsrishitsingh.workers.dev>.
It includes the responsive frontend, draft recovery, persistent playback and
durable finalized transcription and speaker/text correction.
The remaining product capabilities above are not release-complete.

### Production delivery

`.github/workflows/ci.yml` runs checks on pull requests and deploys successful
pushes to `main`. Deployment uses the same checked OpenNext build, then probes
`/api/health`. The Actions summary and `production-deploy-*` artifact record the
commit, Cloudflare version and smoke-test outcome. Manual workflow dispatch runs
checks only; rerunning a successful main-push run can retry delivery if that commit
is still the current main head.

Configure these **repository Actions secrets** before the first automatic release:

- `CLOUDFLARE_ACCOUNT_ID`: the account hosting `voidnote-production`.
- `CLOUDFLARE_API_TOKEN`: a scoped Workers deployment token for that account, with
  access to this Worker's R2, Hyperdrive and Workflow bindings. See
  [Cloudflare's GitHub Actions setup](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

Application secrets remain configured on the Worker; CI does not copy local `.env`
files or replace those secrets. Production runs are serialized, cannot be cancelled
by a newer push, and skip a superseded main commit before deployment. A failed smoke
test marks the run failed and retains deployment evidence; it does not automatically
roll back an already deployed version. The health probe establishes HTTP availability,
not authenticated database/provider acceptance. Database migrations remain a separate,
explicitly coordinated release operation.

Main uses GitHub's `queue: max` (up to 100 pending runs), so an older rerun cannot
replace the newest queued release. Manual dispatch uses a separate concurrency lane;
PR jobs still cancel superseded checks.

Normal delivery is PR → checks → merge → CI deploy. Manual Wrangler deployment is
reserved for explicitly authorized recovery.

The [foundation setup](docs/2026-11-13-01-foundation.md) covers runtime settings
and optional Logfire tracing. `bun run test:db` requires an isolated
`TEST_DATABASE_URL`; CI supplies a PostgreSQL service.

---

## Contributing

We don’t bite. Fork, branch, commit, push, PR.

```bash
git checkout -b feat/my-thing
git commit -m "Add: my thing"
git push origin feat/my-thing
```

Open a pull request. If you break something in style, we might even keep it.

---

## Docs

- [Saved notes and people setup](docs/2026-11-13-02-saved-notes-and-people.md)
- [Current foundation setup](docs/2026-11-13-01-foundation.md)
- [Re-entry index](docs/2026-05-16-01-project-index.md)
- [Codebase map](docs/2026-05-16-02-codebase-map.md)
- [Runtime and data flow](docs/2026-05-16-03-runtime-and-data-flow.md)
- [Product and design approach](docs/2026-05-16-04-product-and-design-approach.md)
- [Project history](docs/2026-05-16-05-project-history.md)
- [Upgrade backlog](docs/2026-05-16-06-upgrade-backlog.md)

## License

MIT. Use it, remix it.

---

## Support

- [Issues](https://github.com/rishit-singh/voidnote/issues)
- Contact: [X](https://x.com/__coderish__)

---

<div align="center">
  <strong>The Null Node</strong>
</div>
