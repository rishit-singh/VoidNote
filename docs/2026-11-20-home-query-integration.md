# Home overview and query lifecycle integration

Implemented on `perf/production-latency`, based on deployed `2467c12`.
The November 20 checkpoint below records pre-release verification. Commit and CI
delivery were authorized on November 21; the main-push CI delivery artifact records
the eventual release commit, Cloudflare version and health result. The timing baseline remains
in [November 18 measurements](2026-11-18-production-save-latency.md).

## Implemented

- Imperative note/person/correction mutation observers reset on success and failure,
  releasing their completed mutation subscriptions for normal garbage collection.
- Note deletion reconciles a versioned tombstone and clears dependent media/transcript
  queries before completing. Background list refresh no longer delays acknowledgement.
- Conflict resolution reconciles ordinary and include-deleted Query caches before
  completing, retaining newer revisions, draft generations and account-epoch guards.
- Home reads `workspace.overview` through the existing authenticated tRPC runtime.
  The repository uses its existing authorized read transaction, aggregate SQL and
  a three-row recent query. Totals cover all live notes/profiles; audio counts and
  duration cover ready, nondeleted recordings with live parent notes. Recent rows
  sort by recording creation descending, then recording ID ascending.
- Overview freshness uses shared query policy. Note, person and recording changes
  invalidate only the scoped aggregate and existing domain dependencies. Review
  reproduced a stale initial-read race: invalidation alone reused a data-less
  pending read. The fix cancels it, checks scope again and refreshes independently
  of mutation acknowledgement. Its late response cannot replace the fresh result.
- Home retains search, pagination and draft overlays. Workspace totals stay separate
  from loaded pages and unsaved drafts. The responsive layout uses existing semantic
  colors, IBM Plex Mono, shadcn primitives, aligned trailing-action slots, and truthful
  pending/error/retry states. Recent recordings link to their owning notes.

## Verification

Node 24 and Bun 1.4.0; real PostgreSQL used a newly created isolated local test DB.

- Seven TypeScript targets passed. After the final race/transport additions, affected
  DB/auth targets and the application build passed again.
- Repository formatting passed. Repository lint found one new blank-line issue;
  that was fixed, and affected lint checks passed. No dependencies/lockfile changed.
- Initial database/unit run: 182 passed and one new fixture failed because a raw
  SQL timestamp parameter used `Date` rather than an ISO string. The fixture was
  corrected; all 28 repository cases passed on rerun. A subsequent 50-case focused
  query/store/invalidation run passed, including the new initial-read race case.
- 23 Node auth/tRPC tests passed, including overview authentication, private no-store
  responses, repository scoping and stripping non-contract output fields.
- Built-Worker Chromium run: 55 passed, one opt-in Markdown export demo skipped.
  Covered Home, shell at 1440/820/390 px, note/profile recovery, deletion/reload,
  correction/Undo, uncertain exact replay, capture navigation, account scope and
  playback ownership. These tests use controlled service/media fixtures.
- Rebuilt after the race fix: 21 affected Home/query/profile/recording cases passed.
- Desktop and mobile Home screenshots reviewed: consistent spacing, readable type,
  aligned actions, no horizontal overflow, long titles truncate; recent activity
  stacks below Notes on mobile. Screenshots are local Playwright artifacts.
- Independent review found the initial-read race and confirmed its correction;
  no remaining substantive findings in the reviewed slice. The verified lesson
  was added to the canonical change-with-confidence skill and its changelog.

Preview serves the actual OpenNext Worker on port 8788. Wrangler emits missing-secret
and scheduled-trigger warnings, then an exit message during Playwright shutdown;
Playwright reports successful runs. This is fixture-based browser evidence, not
proof of production credentials, live processing or provider availability.

## Reconciled delivery and remaining work

The parent/02b plans now include PRs #9–#11, verified migration 0006, authenticated
rename measurements and this local slice. The separate agent-design plan includes
an updated handoff without selecting an unapproved runtime.

1. CI delivery (authorized November 21), followed by authenticated hosted acceptance.
2. Real recording → transcription → correction → Undo → reload with representative
   speakers; physical microphone interruption/removal and email-delivery acceptance.
3. Payload-free save-stage telemetry for auth, database/connection/protocol, commit
   and teardown. Existing SQL counters cannot attribute the remaining request time.
4. Remaining recording/transcript DTO/configuration cleanup and legacy REST cutover;
   canonical passage/backfill semantics still need agreement.
5. Summary/Ask runtime/context/memory/tool/output decisions, then implementation in
   the separate Workers AI worktree/session. No agent runtime was bootstrapped here.

Production migration 0000's historical checksum discrepancy remains untouched.
