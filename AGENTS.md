# VoidNote engineering and agent workflow

## Start here

- Read the relevant source and current implementation notes before changing behavior.
- `docs/2026-11-14-recording-ux-reset.md` records the recording-first baseline.
  May documents are historical snapshots, not current architecture requirements.
- The delivery roadmap lives at
  `/Users/rishit/.opencode/plan/voidnote/2026-11-13-00-shipping-plan.md` when available.
  Reconcile its status against code and deployment evidence; do not assume it is current.
- Preserve existing user changes. Do not commit, push, deploy, or rewrite applied
  migrations without authorization for that action.

## State architecture

The target is tRPC + TanStack Query for application server state. Migration is
incremental: identify remaining legacy paths explicitly instead of describing the
target as already implemented.

- Use typed tRPC procedures over existing authorized repositories. Keep binary
  audio streaming, signed provider callbacks and authentication transport at their
  appropriate HTTP boundaries.
- TanStack Query owns remote records, query status, pagination and freshness.
  Use generated query keys/options; do not introduce component fetch effects,
  request-counter refs, or another authoritative server-data store.
- Local stores own unsaved drafts, durable pending commands, preferences and
  runtime capture/playback state. Component state owns temporary view interactions.
- Every query declares identity scope, freshness, pagination and invalidation
  dependencies. Every mutation defines cache updates and related invalidations.
  Do not invalidate the entire application after ordinary mutations.
- Server QueryClients/context are request-scoped. Browser providers remain stable
  across routes and isolate authenticated user/workspace generations.
- Cancel outgoing reads and reject late completions on scope changes. Clear the
  outgoing in-memory cache without deleting recoverable local work.
- Use narrow subscriptions and structural sharing. Memoize measured expensive
  derivations rather than wrapping every component. Refs remain appropriate for
  audio/DOM handles and imperative resources, not mirrored server state.

## Hydration and recovery

- Each persisted store declares its owner, schema version, hydration status,
  merge rules and reset behavior. Authentication, local recovery and query loading
  are distinct states; failure is not an empty successful hydration.
- Bootstrap once per verified scope. Deduplicate hydration, avoid unrelated eager
  fetches and validate recovered records with bounded work. A route waits only on
  the prerequisites of the feature it uses.
- Persist only intended local data. Do not serialize credentials, runtime handles,
  object URLs or the entire remote query cache by default.
- Hydration/background refresh must not overwrite newer drafts or newer in-memory
  recording manifests. Keep server revisions and local draft generations separate.
- Preserve exact command IDs and payloads across uncertain outcomes. Persist the
  command before sending it; ordinary query retries are not mutation recovery.
- Coordinate focus, reconnect and cross-tab invalidation centrally. Notify peers
  of scoped changes; do not trust broadcast payloads as authoritative records.

## Product invariants

- One recording per note. Capture/upload retain their original owner; playback
  follows the opened note. Navigation must not destroy active capture.
- Audio chunks remain durable in IndexedDB; private remote artifacts live in R2.
  Preserve resumable bounded-memory uploads and private authorization boundaries.
- Postgres owns domain state. Retain transactions, revision conflicts, receipts,
  deletion guards and reconciliation of uncertain provider submissions.
- Preserve source utterances and stable person/segment identities. Grouped passages
  are projections; corrections and Undo retain their underlying edit mappings.
- Use existing shadcn components and the established Paper-derived design.
  Visible controls must correspond to implemented behavior.

## Adaptive delegation

- **Reconciler (normally the main agent):** verify scope/roadmap, define shared
  contracts, assign file ownership, integrate results and report actual status.
- **Implementer:** complete a bounded slice and its focused verification.
- **Reviewer/finalizer:** independently inspect substantive changes, check
  integration/recovery, reconcile documentation and finalize authorized delivery.
- Small isolated changes can stay with the main agent. Medium work usually needs
  one implementer plus main review. Cross-cutting work benefits from parallel,
  disjoint implementers and an independent reviewer. Start with 2–3 active agents;
  add agents only for useful independent work. No orchestration framework required.
- Every handoff states goal, acceptance criteria, exclusions, existing findings,
  shared contracts, owned files, allowed actions, relevant tools/skills and checks.
- Define contracts before parallel edits. One owner per shared file. The reconciler
  owns dependency installation, builds, browser preview and deployments unless
  explicitly delegated. Do not duplicate investigations or launch competing servers.
- Route tools by task: Paper/shadcn/browser for UI; repository/database/framework
  docs for data; Cloudflare/Wrangler for runtime; Logfire for telemetry; Nulldown
  for hosted plans when applicable and authenticated. Load matching skills.
  Verify actual tool availability; prompt guidance is not enforced tool isolation.
- Agents return changes, verification evidence, unresolved issues and integration
  needs. Route findings to their owner and rerun only affected checks.

## Verification and delivery

- Use Node 24 and Bun; preserve `bun.lock`. Keep secrets out of commands/output.
- Run checks appropriate to the change. For state work, prioritize request
  deduplication, hydration races, exact retries, pagination and account switching.
  Use an isolated `TEST_DATABASE_URL`, never application data, for database tests.
- Main commands: `bun run typecheck`, `bun run lint`, `bun run format:check`,
  `bun run test:db`, `bun run build:worker`, `bun run test:e2e`.
  Browser tests use the built Worker preview, not an unrelated dev server.
- Do not repeatedly run a full suite after focused fixes without a new reason.
  UI screenshots, mocked browser tests, real-provider checks and hosted acceptance
  are distinct evidence. Do not claim one establishes the others.
- Report implementation, verification and deployment separately. Update relevant
  docs and roadmap status when authorized; retain explicit outstanding work.
