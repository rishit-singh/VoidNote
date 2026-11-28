# VoidNote engineering and agent workflow

## Reviewable explanations and progress

Use short outcomes, tiny flow diagrams and relevant code/contract snippets to
make architectural changes reviewable. Link owning files; distinguish existing
implementation from proposed pseudocode. Updates state actual evidence, blockers
and the next action. Diagnostics and supporting tests are not full acceptance.

## Start here

- Read the relevant source and current implementation notes before changing behavior.
- `docs/2026-11-14-recording-ux-reset.md` records the recording-first baseline.
  May documents are historical snapshots, not current architecture requirements.
- `docs/2026-11-22-summary-agent-foundation.md` records the bounded Think/Workflow
  proof and its separate provider/product acceptance gates.
- The delivery roadmap lives at
  `/Users/rishit/.opencode/plan/voidnote/2026-11-13-00-shipping-plan.md` when available.
  Reconcile its status against code and deployment evidence; do not assume it is current.
- Preserve existing user changes. Do not commit, push, deploy, or rewrite applied
  migrations without authorization for that action.

## Modification and module conventions

- Start with the simplest approach that meets the current requirement. Durability
  is required, not a justification for speculative machinery, repeated checks or
  extra persistence. Add complexity only for a demonstrated failure, measured
  bottleneck or explicit product requirement; state the evidence and tradeoff.
- Load `change-with-confidence` for substantive fixes, modifications and refactors.
  Load `domain-first-stack` for cross-layer architecture or domain slices. Canonical
  instructions live in `.opencode/skills/`; the plan-directory copies are handoff records.
- Use domain → responsibility consistently across contracts, server operations,
  persistence, queries, stores, UI, workflows and agents. Cohesive modules may be
  single files; multi-file modules expose explicit `index.ts` exports. Consumers
  use public entry points and internal files import siblings directly.
- Keep public DTOs consumer-specific, server/provider models internal and framework
  routes thin. Preserve stable IDs, source evidence and concurrency tokens.
- Write readable logical stages, named units and multiline complex object/type
  shapes. Enforce supported conventions with lint/format rather than relying on prose.
- Give tunable policy one typed owner with validated defaults/bounds; use named
  constants for domain/protocol invariants. Preserve settings pinned to durable work.
- Show optimistic pending feedback separately from acknowledgement. Successful
  mutations must not wait for background refetch; rollback preserves newer edits.
- Define each command's acknowledgement boundary. Keep accepted work visible
  across stale/missing query projections; read failures are not command failures.
  Rehydrate exact intent and durable acknowledgements, not stale in-flight flags.
  All submission paths share atomic acknowledgement persistence. Follow the
  transition/recovery checks in `change-with-confidence`.
- Review verified lessons at the end of a substantive slice and before major
  refactors/runtime upgrades. Update the owning canonical skill only when evidence
  warrants it; record material changes in its changelog. Product decisions and
  deployment evidence belong in project instructions and implementation notes.
- Workers AI, Think and ThinkWorkflow are approved for the bounded summary proof.
  Keep inference disabled until a model/environment/budget is explicitly selected.
  Memory writes, overlap auto-application and Ask/tool policies still need agreement.

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

- In this project, **testing** means verifying the requested end-to-end user
  behavior in its intended deployed environment, with real authentication,
  storage, enabled background providers, semantic quality, UX, notifications,
  recovery, telemetry and usage checked as applicable. Unit, mocked, integration,
  build and health checks are supporting evidence, not completion. A disabled
  feature blocks acceptance: report the exact blockers rather than claiming it was
  fully tested. Keep actual paid calls within existing authorization; never infer
  or silently grant a new allowance.
- Production delivery belongs to `.github/workflows/ci.yml`: checked pushes to
  `main` deploy the tested build, record its commit/Cloudflare version and run a
  health smoke test. PRs and manual workflow dispatch run checks only. Treat local
  Wrangler deployment as an explicitly authorized recovery exception, not normal
  delivery. Commit/push/merge authorization remains separate from implementation.

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
