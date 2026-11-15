# Full-stack quality — notes, people and correction slices

Prepared for release on `release/quality-and-landing` from the local implementation
on `feat/next-bun-foundation`. Hosted verification and production delivery are pending.
These are the first vertical slices of 02b, not completion of the cross-stack roadmap.

## Installed guidance and enforcement

- `.opencode/skills/domain-first-stack/SKILL.md` owns structural conventions.
- `.opencode/skills/change-with-confidence/SKILL.md` owns modification/refactoring,
  verification and evidence-led maintenance. Both were discovered and loaded using
  OpenCode's skill tool. Project copies are canonical; plan copies are handoff records.
- `AGENTS.md` directs substantive work to these skills. A verified replay-cache
  finding from this slice was added to the modification skill and its changelog.
- ESLint adds maintained Stylistic/import-sort plugins, braces, type-import guidance,
  grouped imports and logical statement spacing. `qualityFiles` explicitly scopes
  the initial rollout to notes domain modules, query/configuration, RPC transport
  and migrated client adapters/hooks. Other domains still need migration.
- Notes-domain alias deep imports are disallowed; query modules receive the same
  browser/server import restrictions as other client code. Single-file notes modules
  expose their exports directly; no empty directories/barrels were introduced.
- Prettier explicitly preserves authored multiline objects. Semantic grouping and
  complex type readability still require review rather than a line-wrapping claim.

## Notes contracts and ownership

`src/contracts/notes.ts` owns note contracts. `workspace.ts` retains explicit
reexports for mixed workspace consumers. Notes lists omit transcript text in both
the SQL selection and public response; detail, full-content saves and immutable
receipts retain it. Title edits must not manufacture empty transcript content.

Home now displays title/date metadata rather than interpreting missing legacy text
as “No transcript yet.” Its generated transcript remains in the recording view.

`src/stores/notes.ts` owns draft lifecycle, acknowledged editing/media baselines and
note command preparation. The existing store remains the workspace coordinator and
public facade. Shared command delivery, people state and hydration remain there;
`noteRecords` still supports media ownership and editing baselines. This is not a
complete store split or removal of all compatibility paths.

`src/queries/notes.ts` owns generated list options and the save mutation lifecycle.
Existing local drafts provide immediate pending feedback. On acknowledgement:

1. Cancel older detail and ordinary/infinite list reads.
2. Recheck identity scope, reconcile detail revisions and update loaded list metadata.
3. Preserve unrelated rows and existing cursors/page parameters until refresh. Search
   membership changes are reconciled without truncating loaded rows or duplicating IDs.
4. Start targeted list/history/appearance refresh without waiting for it to settle.

Title saves do not refresh recording overview. Refresh failures remain query state
and cannot turn an acknowledged command into an uncertain mutation.

Replay is distinct: historical receipts are not published into query caches. The
durable command coordinator verifies the current row, then reconciles that snapshot
into query and local state. Newer revisions and tombstones take precedence even
when list refresh is blocked. Newer drafts and exact pending payloads remain intact.

`src/config/query.ts` owns the initial client defaults: 30-second freshness,
five-minute garbage collection, one eligible read retry, 30-note pages and 600 ms
title autosave debounce. These are typed build-time policy, not runtime environment
settings; remaining recording/recovery/provider literals are still follow-on work.

## RPC cutover

The client and server share `RPC_BASE_PATH` from `src/config/api.ts`. RPC now uses
`/api/<procedure>` through `src/app/api/[procedure]/route.ts`. The old
`/api/trpc/<procedure>` route is removed, with no alias. Deploy client/server together;
already-open older clients must reload, retaining their durable pending commands.

Static auth/session/health routes, signed callbacks/media and nested binary upload
routes remain at their existing HTTP boundaries. Real transport tests retain origin,
method, authentication, size and batch limits.

Legacy REST domain handlers remain temporarily: browser fixtures still translate RPC
to those mocks, and direct REST/server tests still exercise them. Their shared notes
list output also omits transcript. Removal requires migrating those consumers/tests
to the supported RPC boundary, then deleting the redundant domain handlers in a
bounded follow-up. This slice does not claim complete REST retirement.

## Verification

- Node 24.22.3 and Bun 1.4.0; initial seven-target typecheck passed. The rebuilt app
  and affected database/browser-test targets also pass after the replay fix.
- 43 initial focused state/query/recovery tests passed; the replay fix adds one
  query regression, and all 27 affected notes-query/store/hydration cases pass.
- 21 real PostgreSQL repository tests passed against a new isolated local database,
  including large-transcript list omission and detail/save/receipt preservation.
  The temporary database server was stopped after the suite.
- 12 auth/RPC tests passed, including actual serialized list/detail output checks.
- Initial built-Worker browser run: 20/20 passed for access, query lifecycle and
  workspace journeys. These include exact retry, newer typing, title-save feedback
  with a held list refresh, navigation/reload, search and deletion.
- Replay fix: independent source re-review reports the finding resolved with no
  new blockers. The rebuilt Worker passes all 31 affected browser cases, including
  replay/tombstone recovery with held refresh, capture lifecycle and responsive shell
  journeys at 1440, 390 and 820 pixels. Together with the four unchanged access cases
  from the initial run, this covers 35 distinct browser cases.
- The lint fix → Prettier → lint cycle is stable across all 11 files in the initial
  quality-rule rollout. Final zero-warning ESLint, repository Prettier, affected
  auth-test typecheck and diff whitespace checks pass.

The payload fixture with 490,000 characters of transcript serialized at **490,300
bytes before / 284 bytes after** for one list item. This is a fixture measurement,
not a hosted latency benchmark. Held-refetch tests establish removal of that wait
from acknowledgement; client/network/auth/database p50/p95 remain unmeasured.

Browser fixtures establish client behavior; separate RPC and isolated database tests
establish those boundaries. They do not establish authenticated hosted acceptance,
real speech/model-provider behavior or Paper visual parity.

## People/profile slice

`src/contracts/people.ts` owns person contracts, explicitly reexported by the
workspace facade. Lists replace full `description` with `descriptionPreview`,
bounded to 160 Unicode code points in SQL and client projection. Full detail,
save commands and historical receipts retain the complete description. Profiles
uses previews only in list rows; the speaker picker shares the same list query.

People pagination retains UUID-ascending ordering and literal prefix search. New
cursors bind the exact search string; old hashless cursors are rejected with
`invalid_cursor`, so existing clients must restart pagination after this cutover.

`src/stores/people.ts` owns person draft creation, selection, updates, acknowledged
baselines and command preparation. The coordinator still owns shared delivery,
recovery and identity transitions. Profile fields remain editable during a pending
save: newer generations survive acknowledgement and exact retry. Pending deletion
and conflict-resolution reads lock edits. Saving remains an explicit user action.

`src/queries/people.ts` owns generated list options, save/delete mutations and
revision-aware detail/list reconciliation before detached background invalidation.
Cache updates preserve UUID ordering, existing rows and cursors. Unseen UUIDs beyond
a partial loaded range wait for their future page rather than appearing out of order.
People changes refresh materialized transcript names and person history through the
existing dependency rules. `queryPolicy.peoplePageSize` owns the shared page size.

Replay receipts are withheld until the coordinator verifies current state. Newer
revisions/tombstones win in both query and draft reconciliation. Profiles immediately
recognizes cached tombstones and removes unavailable rows, even with refresh blocked.
Readability/import-boundary enforcement now includes the people domain modules.
Inline speaker creation's separate correction coordinator also marks retries as
replays and verifies current profile state before updating caches or local baselines.

### People verification

- Seven-target typecheck, zero-warning ESLint and repository formatting pass.
- 43 focused people-contract/query, store, hydration, recovery and invalidation tests
  pass, including exact retry, full-description retention, newer typing, UUID/search
  pagination, stale reads, tombstones and outgoing identity cancellation.
- 23 repository tests pass against isolated PostgreSQL, including Unicode preview
  consistency, full detail/receipt preservation and search-bound people cursors.
  The temporary server was stopped afterward.
- 13 auth/RPC tests pass, including serialized preview/full-detail boundaries.
- Worker build passes. Built-Worker browser verification passes 22 cases across
  profile query lifecycle, workspace, speaker correction and appearance playback;
  one opt-in Markdown-export demo case is skipped. New cases hold background reads
  open while verifying acknowledgement, newer typing, replay tombstones and deletion.
  After the review fixes, the rebuilt Worker passes all seven affected profile/inline
  speaker browser cases, including the new inline-replay regression (23 distinct
  passing browser cases across both runs; the demo remains skipped).
- The lint fix → format → lint cycle is stable across six people modules/adapters.
- Independent review found secondary inline-creation replay and conflict-discard
  races. Both are fixed and re-reviewed without remaining blockers. The two new
  discard regressions failed before the fix; all 30 affected store/hydration cases
  pass afterward. The modification skill records both verified lessons.

These are local results. Hosted latency and real-provider acceptance remain separate.

## Correction/Undo slice

`src/queries/transcript-corrections.ts` owns transcript query options, mutation
reconciliation and pure pending projections. The scope-keyed correction hook owns
durable local intent, hydration and recovery. Readability enforcement includes it.
Assignment and selected-range dialogs close once exact intent is persisted, with
pending feedback on the transcript. Undo is available only after acknowledgement;
its pending projection requires a known complete local before/after mapping.
Loaded targets alone receive previews; unseen bulk targets are not fabricated.

Definite rejection drops the pending projection while retaining exact intent and
rejection disposition for Review speech, including after remount. Uncertain outcomes
retain the original command, guest payload and split IDs for retry. Conflict review
locks changes until its read succeeds. Ordinary query refresh never clears recovery.

Mutations now return `{ receipt, current: { items, removed, complete } }` through
both RPC and the temporary REST boundary. Receipts/history remain immutable.
Inside the existing authorized run transaction, the repository reads current exact
IDs from the receipt's before/after union. Metadata preflight and a response byte
budget bound the read; oversized projections return the acknowledgement with
`complete: false`. No migration or receipt rewrite is required.

`complete` covers those exact IDs, not descendants introduced by later commands.
Required public `orderKey` preserves binary lineage ordering independently of edited
audio times. Reconciliation cancels old reads, guards rows and removals by revisions,
retains pages/cursors, deduplicates overlapping seams and rejects older overlapping
lineages. Targeted refresh reconstructs later descendants and pagination coverage.
Mutation acknowledgement never waits for that refresh. Consumers must move to the
new response envelope together with the client/server deployment.

Assignment Undo previews preserve intervening text-only changes: an attribution
token does not establish the freshness of cached text. Source IDs and underlying
split/Undo mappings remain intact; passage grouping is still a read-time projection.

### Correction verification

- Seven-target typecheck passed; subsequent Worker builds check the integrated app.
- 21 isolated PostgreSQL tests and 11 auth/transport tests passed. Coverage includes
  current replay snapshots, nested split/Undo, unchanged historical receipts,
  oversized-result fallback and actual serialized mutation output. The isolated
  PostgreSQL server was stopped afterward.
- 15 query/projection tests passed, including blocked-refetch acknowledgement, stale
  reads, identity switches, revision-bearing removals, page seams, nested lineage
  and reused ordering keys. Four passage/range unit tests also passed.
- Independent review found the rejected-remount issue; main integration review
  found nested-lineage overlap. Both have focused regressions. Re-review also caught
  recovery errors hidden by generic conflict text; that is fixed and covered by a
  storage-failure browser case. Final independent review reports no remaining blockers.
- Built-Worker verification covers 14 distinct passing browser cases across correction,
  appearance playback and processing integration; one opt-in Markdown demo is skipped.
  Initial failures exposed assertions that treated immediate previews as acknowledgement,
  a closing-dialog duplicate locator and a fixture lacking valid source order. After
  correcting those test assumptions, all five affected cases passed on rerun; the demo
  reaches its expected export-feature skip. Desktop/mobile selection screenshots were
  inspected; controls and speaker choices fit both viewports.
- Worker build, zero-warning repository ESLint and subsequent affected lint/type checks
  pass. Scoped Prettier and `git diff --check` pass. Full formatting flagged concurrent
  `src/components/landing/LandingPage.tsx` work, which this slice did not edit. One build
  attempt encountered a missing `.next/required-server-files.json`; subsequent builds
  succeeded. Worker preview teardown still logs the known Wrangler warnings/error.

These checks distinguish mocked browser behavior, real transport serialization and
isolated database transactions. They do not establish hosted/provider acceptance or
representative p50/p95 latency. These results precede the integrated release below.

## Integrated quality and landing release

The user authorized release of the remaining quality and landing changes after
CI production delivery was activated. The release branch starts at main `de338ca`,
retaining its verified deployment command and Linux upload-test fixes. It includes
the three quality slices, scoped engineering guidance and the landing redesign.

The landing now shows recording/transcript and speaker-profile examples plus an
explicitly planned follow-up demo. Sign-in, session-error recovery and focus
restoration remain implemented. Motion responds to live reduced-motion preference
changes; responsive and replay behavior have browser coverage.

Release verification so far:

- Independent domain/RPC/state and landing/CSS reviews found no release blockers.
- All seven TypeScript targets, zero-warning ESLint and repository formatting passed.
- 15 auth/RPC tests and 68 focused state/query/contract tests passed locally.
- Full isolated PostgreSQL, Worker build/packaging and built-Worker browser checks
  run in CI before merge. Production delivery remains pending those gates.

Deploy client/server together. Already-open older clients must reload after the
`/api` cutover, preserving their durable pending commands. Old people-list cursors
must restart pagination. No schema migration is introduced by this release.

## Remaining 02b work

- Extend conventions/DTO reduction to recordings and transcripts; complete
  local-store ownership decomposition and application/persistence domain boundaries.
- Extend recoverable optimistic mutations to remaining note deletion.
- Measure representative desktop/mobile feedback and authenticated network/auth/DB
  latency; verify live Logfire ingestion.
- Complete typed server/runtime policy and legacy REST retirement.
- Inspect fragmented passage examples and agree canonical projection semantics before
  implementing the bounded backfill. No passage migration or production data write
  was performed here.
- Summary/Ask runtime/context/memory/tool decisions still need agreement before
  creating the separate agent-workflow worktree. Workers AI remains the inference choice.
