# Saved notes and people

Plan 02 introduces authenticated, server-backed notes and reusable person profiles.
The setup below is required to use saved data outside the test fixtures.

## Local setup

1. Create or select a Supabase project and enable email sign-in. Set its Site URL
   to the application origin and allow the exact `/auth/callback` URL. The
   repository's `supabase/config.toml` includes the production callback and the
   `localhost:3000` and `localhost:8787` callbacks.
2. Copy `.env.example` to `.env.local` for Next development and set
   `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `APP_URL`. Use
   `http://localhost:3000` for Next development or `http://localhost:8787` for
   the Workers preview. Open the email link in the browser that requested it;
   sign-in uses the PKCE cookie from that browser.
3. Set `DATABASE_URL` in `.env.local` to a Postgres connection for local
   development/migrations.
   The database and Supabase Auth project must belong to the same application.
4. Review the SQL in `drizzle/`, then run `bun run db:migrate` once against the
   selected application database. Use `bun --env-file=.env.local run db:migrate`
   so the migration process receives the private connection URL. Use a single
   migration runner. There is no production `drizzle push` step.
5. Run `bun run dev`, or copy `.dev.vars.example` to `.dev.vars`, set the runtime
   values there, then build with `bun run build:worker` and run
   `bun run preview:worker --env production`. The production Hyperdrive config
   uses a disposable local Postgres URL for preview; start the isolated database
   on port 55432 or override it with
   `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` in your shell.
   Never put a real database credential in Wrangler config or documentation.

Wrangler uses `.dev.vars` instead of `.env` when it exists; include the runtime
settings there for preview. Runtime values come from Wrangler vars/secrets (or
local `.dev.vars`), not `.env.local`; the Worker build removes generated
OpenNext `.env` defaults. Keep credentials out of source control.

## Cloudflare deployment

Production is currently deployed at
<https://voidnote-production.rsrishitsingh.workers.dev>. Its Hyperdrive binding
`HYPERDRIVE` (ID `77f615af9cf34b0e843af2368e133933`) targets the direct Supabase
Postgres endpoint, with caching disabled and origin connection limit 10. For a
new environment, create its own Hyperdrive configuration and database. Set the
exact HTTPS `APP_URL` and matching Supabase callback URLs; migration connections
are separate from request connections. Deploy with:

```bash
bun run build:worker
bunx --no-install opennextjs-cloudflare deploy --env production
```

The production Supabase project is `rbacdtsvrogopijybsep` (Coderish, us-east-1).
All six Drizzle migrations are applied. All seventeen application tables have RLS
enabled, and anon/authenticated roles have no SELECT grants. The runtime
publishable key is configured as a Worker secret. The retired AssemblyAI route
does not consume its previously provisioned secret. `LOGFIRE_TOKEN` enables
optional tracing; the future inference integration is not implemented here.
Never store secrets in this document or `.dev.vars.example`.

Use a direct or compatible session-mode Postgres endpoint. Postgres.js keeps
prepared statements enabled, as required by the current Hyperdrive guidance.
Each request creates and closes its client; Hyperdrive owns the underlying pool.
Tables have RLS enabled without browser policies, and public/Supabase API-role
grants are revoked. The server connection uses the table-owning or a trusted
BYPASSRLS role; application membership authorization remains mandatory.

The deployed Worker version is `824b91e4-b65b-44e4-bc22-eac559b3badb`. Live
email delivery has not been tested.

## Data and commands

### Workspace lifecycle

Next pages compose their own Home, note, profile and Settings content inside
`src/components/workspace/WorkspaceShell.tsx`. The persistent shell owns
`useWorkspace`, authentication notices and audio services. Workspace bootstrap
loads the initial note/profile lists once; concurrent session and record requests
share an in-flight request. Home search does not replace the recent-note navigation.

`useNoteEditor` owns deep-link loading, note selection and draft updates. Loading
errors are scoped by record; Retry can recheck a missing record without reloading
the entire workspace. Save, pending-command retry and history remain explicit.

Supabase sessions stop at the authentication boundary. Application operations use
our user principal and verify workspace membership on every read and write.
Initial sign-in creates an owned private workspace. Person IDs are independent of
names and accounts; a guest person does not need a Supabase account.

Every mutation carries a command ID and expected entity revision. A successful
retry returns its original result before checking the now-stale revision. Reusing
a command ID with a different operation or payload is rejected. State, history,
outbox, and the receipt commit in one transaction. Conflicts return HTTP 409 and
the current revision, preserving the browser draft for an explicit decision.

Deletion writes a tombstone and deletion work to the outbox. History remains
available. Deletion work is recorded; production artifact cleanup consumers remain
unimplemented. Local recording recovery only attaches to
notes already loaded from the authenticated workspace and cannot recreate notes.

Prototype import and legacy transcript DTOs have been retired. Existing database
columns and applied migrations remain intact, but current APIs do not expose the
prototype payload. Stored-data deletion is separate from retiring runtime support.

Local recording sessions carry user and workspace ownership. Recovery only exposes
audio for an acknowledged note in that workspace. Unscoped audio is not attached
to the current account; there is no prototype migration path. Explicit upload
adds private remote durability without removing the local take.

Server note/person records are memory caches in Zustand. Draft content, base
revisions and exact pending commands are persisted locally under the verified
account/workspace using Zustand persist and Zod validation. Server projections,
credentials and audio blobs are not persisted in that recovery store.

Save explicitly. **Saved** means the server acknowledged the revision. A lost
response retains its original command across reload; **Retry pending change**
resolves that command before another save. Conflicts retain the draft and require
explicit reload or rebase followed by save. Recovery checks server existence before
showing previously saved drafts; deleted or unverifiable records are retained
locally without resurrecting them in the workspace. Storage failures are visible
and block mutations whose retry identity cannot be checkpointed.

Home search matches literal, case-insensitive title prefixes. Migration
`0002_notes_title_search.sql` adds its partial index and is applied to production.

## Verification commands

The database tests require an isolated database through `TEST_DATABASE_URL`. They
never fall back to `DATABASE_URL`. For example:

```bash
docker run --detach --rm --name voidnote-test-db \
  --publish 127.0.0.1:55432:5432 \
  --env POSTGRES_USER=voidnote_test \
  --env POSTGRES_PASSWORD=voidnote_test \
  --env POSTGRES_DB=voidnote_test postgres:17-alpine

TEST_DATABASE_URL=postgresql://voidnote_test:voidnote_test@127.0.0.1:55432/voidnote_test bun run test:db
```

CI supplies PostgreSQL 17 as an isolated service. Browser tests use intercepted
authenticated-session/API fixtures; database invariants are tested separately
against real Postgres. Live email delivery remains untested.

Playwright runs its own production preview on port 8788, keeping the usual manual
preview on 8787 available.

## Historical baseline verification — 2026-11-13

- Frozen install, formatting, zero-warning lint and all seven TypeScript targets pass.
- Next/OpenNext production build and production Wrangler packaging dry-run pass.
- 20 real PostgreSQL integration tests pass, covering atomic rollback, concurrent
  receipts, revision conflicts, composite foreign keys, workspace authorization,
  imports, tombstones and bounded pagination. The temporary test database was removed.
- 4 auth-boundary tests exercise the real Supabase SDK with intercepted HTTP and a
  request-cookie fixture: verified identity, fail-closed setup, PKCE/callback safety,
  outages and sign-out.
- All 16 browser/API cases pass against the built local production workerd app.
  CRUD flows use authenticated API fixtures; unauthenticated API guards and health
  run against actual routes. Two assertions were scoped to the note editor rather
  than Next's persistent route-announcer alert, then both affected cases passed.
- The 4 existing real workerd telemetry tests still pass.
- Live production checks passed for health, unauthenticated 401, Supabase
  password-session verification through Worker `getUser`, workspace bootstrap
  and isolation, note create/read/update/list/replay/conflict, person rename and
  search, browser reload showing a saved note without API mocks, tombstone/history,
  and sign-out. The temporary smoke account and its records were removed. No live
  email was sent. The 16 browser tests also passed after deployment configuration;
  earlier 44-test local evidence is retained.

## Frontend and local recovery verification — 2026-11-14

- Paper-based Home, note, Profiles and Settings routes share a persistent shell.
  IBM Plex Mono is self-hosted. The prototype import and chat runtime is retired;
  stored database columns and previous migrations remain intact.
- Account/workspace-scoped drafts and exact pending commands survive reload.
  Capture is owned above routes, persists chunks and manifests atomically through
  `idb`, drains writes before finalizing, and uses Web Locks across tabs.
- Frozen install, seven TypeScript targets, zero-warning ESLint, formatting,
  Next/OpenNext build and production packaging pass. Known private environment
  values were absent from source candidates, assets, packaged Worker and source maps.
- 30 repository/recovery tests pass with disposable local PostgreSQL, plus 4 auth
  and 4 workerd telemetry tests. The disposable PostgreSQL process was stopped.
- All 28 browser cases passed across the initial run and focused reruns. Initial
  failures were ambiguous Transcript/alert locators, a navigation timing race and
  an assertion behind a modal. The final CSS change was checked by all 4 shell
  cases against the rebuilt Worker.
- Screenshots reviewed at 1440×900, 390×844 and 820×900 cover Home, note,
  Settings and profile detail. The 820px profile editor now uses the full content
  width. Recorder visibility, scroll-to-save and horizontal overflow checks pass.
  Fresh side-by-side Paper screenshot comparison is blocked by Paper's weekly
  MCP limit; this is not final visual acceptance.
- Migration `0002_notes_title_search.sql` is applied; production has three
  migration records and the expected partial title-prefix index. Worker version
  `51dfa219-7aa2-40c4-b8ab-af5535dbf4b1` serves this slice.
- Live authenticated browser/API checks passed against that version and the fresh
  Supabase project: workspace isolation, note creation/title search/reload, profile
  edit/reload, local draft recovery, exact receipt retry after a real committed
  save's response was intentionally dropped, recording preference persistence,
  history/tombstones and sign-out. The temporary account and its owned application
  records were removed in cleanup. Authentication used a verified test password
  session; this does not verify email delivery.

That historical slice stored audio only in the browser; the integration below
adds remote durability and finalized processing.

## Recording and finalized processing — 2026-11-14

### Setup and behavior

- Apply `0003_recording_processing.sql` and `0004_large_recording_uploads.sql`
  through the normal migration runner.
  Provision a private R2 bucket and bind it as `RECORDING_ARTIFACTS`.
- Bind `PROCESS_RECORDING` to `RecordingProcessingWorkflow` exported by `worker.ts`;
  the minute cron reconciles committed processing outbox entries. Production uses
  `voidnote-recordings-production` and `voidnote-processing-production`.
- Set `PYANNOTE_API_KEY` and a random `RECORDING_CAPABILITY_SECRET` of at least
  32 characters using Worker secrets. Keep `APP_URL` at the reachable HTTPS origin:
  the provider downloads signed media and sends signed callbacks there.
- Use the built workerd preview for runtime checks. Next development alone cannot
  execute this same-script Workflow, and a local-only URL cannot receive provider
  media requests or callbacks.
- Record or add a file, save the note, then select **Upload & transcribe**. The
  selected local take is uploaded; selecting remote audio reuses that recording.
  Limits are 1 GiB and two hours. Upload validates immutable size/hash metadata
  and streams through a fixed-length adapter for OpenNext/R2 compatibility.
- Files over 8 MiB upload in fixed-size parts through authenticated routes. Retry
  discovers acknowledged parts and skips matching hashes, including after reload.
  Browser hashing uses bounded 1 MiB slices. Completion streams parts from private
  R2 storage into the final object and verifies its full SHA-256 before database
  acknowledgment. Successful completion deletes temporary parts; abandoned uploads
  retain their parts for resume (automatic expiry is not configured).
- Processing persists intent before submitting to pyannoteAI. An uncertain paid
  submission is not automatically repeated. Retry status observes/restarts the
  same Workflow. One logical processing run per recording is currently supported.
- Raw provider results live in R2. Validated utterances, stable IDs, timestamps,
  provider speaker labels and run provenance are published transactionally in
  Postgres. Manual note text is not overwritten. Timestamp clicks select the
  matching remote recording in the single persistent player.
- Browser live text is optional and independent of capture/finalized processing.
  Preferences and errors are scoped locally; retrying recognition does not restart
  the microphone. Local/remote playback selection restores without autoplay.

### Verification

- All seven TypeScript targets, full lint and formatting passed after the upload
  fix. Production build/deployment passed; the earlier packaging dry-run passed.
  Final source/build scans found no configured private values. The disposable
  PostgreSQL process was stopped after verification.
- 43 database/provider/recovery cases passed across the initial and corrected
  recording-repository runs; four auth cases and four telemetry cases passed.
  A new workerd/R2 regression covers exact-length streams, mismatches and duplicate
  conditional writes.
- The full browser run passed 38 of 40 cases. After correcting rapid keyboard
  seeking and an obsolete test label, all 12 affected audio/processing/shell cases
  passed. This includes Chromium MediaRecorder capture, reload, remote timestamp
  playback and navigation with one persistent player.
- Responsive screenshots were reviewed at 1440×900, 390×844 and 820×900. Fresh
  Paper comparison remains blocked by its weekly MCP limit.
- Live authenticated browser/API smoke passed against version
  `c3ca0463-de54-4fdd-92d4-a8da178ef19e`: private audio upload, real pyannoteAI
  processing, finalized transcript reload, timestamp playback and remote selection
  restoration, alongside saves, recovery, profiles and isolation. Temporary smoke
  accounts, database rows and scoped R2 artifacts were removed.

Speaker/text correction was added in the [next verified slice](2026-11-14-speaker-corrections.md).
Reruns, usage accounting, artifact-cleanup consumers, Summary/Ask and automatic
recognition remain incomplete. Physical
microphone/device removal, email-link delivery and live Logfire ingestion remain
unverified. Changes remain uncommitted.

### Large-file upload verification — 2026-11-14

Migration `0004_large_recording_uploads.sql` raises the size constraint to 1 GiB;
previous migrations are unchanged. The duration constraint remains two hours.
Version `a94f4851-895c-48b2-8863-86fa099e4243` is deployed with this change.

- A real workerd/R2 test uploaded 320 MiB plus a trailing partial chunk, checked
  missing/invalid parts, exact retries, resumable status, streamed assembly,
  final download hash and temporary-part cleanup.
- A 320 MiB browser test deliberately dropped an acknowledged part response,
  reloaded and resumed without sending that part twice. The existing finalized
  processing/player and account-scoped recovery journeys also passed.
- Eleven database/provider tests passed, including 320 MiB and 1 GiB manifests
  and direct database rejection above 1 GiB. All seven TypeScript targets, full
  lint, formatting, build and deployment packaging checks passed.
- Live authenticated production smoke uploaded a 320 MiB WAV, recovered from a
  deliberately lost response/reload, completed verification and read an authorized
  audio range. An unauthenticated read returned 401. The large synthetic silence
  file was not submitted to the paid provider; this verifies upload and playback,
  not long-audio transcription quality. The earlier real pyannoteAI speech smoke
  remains the provider evidence. Temporary smoke account, records and objects were
  removed; private-value source/build scans were clean.

The larger per-file limit does not implement a multiple-file batch queue. That,
longer-than-two-hour recordings and automatic processing after Stop are separate
remaining work.
