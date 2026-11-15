# Scoped query and recovery foundation

This refactor follows the recording-first UI and was pushed in commit `730d97e`
on `feat/next-bun-foundation`. It was deployed to production on 2026-11-14 as
`e56ca62f-77ac-4bd6-97df-7c60b25af362`, replacing
`46c2f778-a3e8-4517-9682-8be950aa5117`.

## State ownership

- Typed tRPC procedures reuse the authorized workspace, recording and correction
  repositories. Authentication is deduplicated within each RPC request; database
  connections retain their existing per-operation lifetime. Transport bounds and
  same-origin mutation checks apply before repository work.
- TanStack Query owns note/person lists and detail reads, appearances, transcript
  pagination, and recording overview. One browser runtime belongs to a verified
  user/workspace/epoch. Scope changes cancel outgoing reads, clear the old cache
  and remount observers. Runtime instances are not shared between server renders.
- Stores retain unsaved drafts, exact pending commands, acknowledged edit/ownership
  baselines, preferences and runtime media state. Store list-fetch methods and
  mirrored list loading/cursor/search state have been removed.
- Recovery has separate idle/loading/ready/error status and a retry action. It
  deduplicates hydration, validates at most four recovered records concurrently,
  preserves newer edits/manifests and rejects stale scope completions.
- Authoritative detail denials revoke ownership while retaining drafts and pending
  commands. Only newer successful reads restore availability; tombstones and old
  account epochs cannot be revived by cached detail data.

## Reads, mutations and invalidation

Generated options/keys provide scoped pagination and cancellation. Ordinary reads
are fresh for 30 seconds; overview reads for 15 seconds. Explicit recovery/conflict
reads bypass freshness. Mutation retries remain exact durable commands rather
than automatic Query retries.

Save responses cancel older detail reads and preserve a newer cached revision.
Targeted invalidation covers lists, detail, appearances and history dependencies;
title saves do not refresh recording overview. Cross-tab messages contain scoped
invalidation notices, never authoritative records.

Recording consumers share one overview query. Only the persistent shell polls
active processing. Accepted retry commands retain a scoped observation marker for
up to 60 seconds, covering a restart that is not yet visible in the database.
Unknown provider submissions are not relabeled as queued or blindly resubmitted.

Binary uploads/audio, authentication transport and signed provider callbacks keep
their HTTP boundaries. Resumable upload ownership and durable IndexedDB chunks
remain in the recording lifecycle.

## Verification and remaining work

Production delivery passed a fresh Node 24 Worker build and deployment dry run.
The deployed homepage, JavaScript asset and health endpoint return HTTP 200;
the unauthenticated RPC session endpoint returns HTTP 401. Markdown export remains
enabled at build time. These smoke checks do not establish authenticated hosted
recording/correction acceptance.

Initial integration checks passed all seven TypeScript targets, zero-warning
ESLint, 32 focused recovery/query tests and 11 auth/RPC tests. The Worker built
successfully. The first browser run passed 45 of 55 cases, including 320 MiB
upload/resume, capture across navigation, playback ownership and real bundled RPC
auth/origin rejection.

That run exposed a paginated-cache invalidation defect: tRPC ordinary and infinite
query filters have different keys. Invalidation now covers both, with a focused
regression for dependent caches, unrelated recordings and retired-scope notices.
Fixture selectors, query-string matching and async retry assertions were corrected.
After those fixes and unavailable-detail reconciliation, the final Worker rebuild
and all 36 affected browser cases passed. The other 19 cases passed in the initial
run, giving coverage of all 55 state-refactor cases across initial/focused runs.
The focused recovery/query suite now passes 36 tests; affected app, database-test
and browser-test TypeScript targets and zero-warning ESLint passed again.

Concurrent landing-page work appeared during verification. Two optional-prop type
errors were minimally corrected to restore the build. The latest repository-wide
format check flags that work's `LandingPage.tsx` and `landing.spec.ts`; its ongoing
design work is separate from this state-refactor acceptance.

Browser fixtures translate RPC calls to existing REST mocks to exercise client
lifecycle behavior. Separate auth/RPC tests exercise the actual server transport,
request isolation and error metadata. Mocked browser results do not establish
hosted tRPC or real-provider acceptance.

Legacy REST domain endpoints remain during migration. The unused history UI still
has a compatibility projection over query-backed reads. Server query
prefetch/dehydration is not implemented. Real multi-speaker/device acceptance,
Summary/Ask, real email delivery and live Logfire ingestion remain separate work.

`AGENTS.md` documents state boundaries and bounded reconciler/implementer/reviewer
delegation. The delivery roadmap now places state verification before recording/
correction acceptance, Summary, Ask and release acceptance.
