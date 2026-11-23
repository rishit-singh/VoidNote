---
name: change-with-confidence
description: Modify, debug or refactor existing application code while preserving behavior, ownership, public contracts and recovery. Use for substantive changes to existing code, from a focused bug fix to a cross-layer refactor. Includes evidence-led verification and maintenance of reusable engineering guidance after verified lessons.
---

# Change with confidence

Follow this workflow when changing existing code. Scale the work to the actual
change: a small fix needs a small investigation and focused verification, not an
architecture rewrite. For cross-layer module or ownership work, also load
`domain-first-stack`; it owns the structural conventions. Project instructions
and current user decisions take precedence over these reusable defaults.

## 1. Establish the change contract

- Read current instructions, relevant implementation notes, source and callers.
  Check working-tree changes and preserve user work. Historical plans are evidence
  of earlier intent, not proof of current behavior.
- State the intended outcome, affected owners and acceptance criteria briefly.
  Identify whether this is behavior-preserving refactoring or an intentional behavior
  change; make intentional API/UX/data changes explicit.
- Trace the actual path from user action through transport, authorization, services,
  persistence and back to UI when those layers are affected. Find all callers before
  changing a shared contract, including tests, background jobs and deployed clients.
- Identify invariants at risk: identity, authorization, revisions, command receipts,
  durable local work, source lineage, deletion guards and resource lifetime.
- Investigate independently answerable details. Ask only when a missing product or
  architecture decision materially changes the implementation. Respect Plan mode;
  implementation, commits, deployment and production data writes have distinct scope.

## 2. Make a coherent, bounded change

- Fix the root cause at its owning boundary. Keep unrelated cleanup out of the slice.
  Use the project's libraries and established abstractions before adding another.
- Prefer domain → responsibility organization, cohesive single files or explicit
  multi-file public entry points. Separate responsibilities when ownership/lifecycle
  requires it; avoid mechanical file splitting, pass-through wrappers and generic
  helpers without real shared consumers.
- Keep transport handlers thin, application operations explicit and persistence
  scoped. Public inputs/outputs serve consumers rather than mirroring database rows
  or provider payloads. Retain required identity and concurrency tokens.
- Give identifiers meaningful domain names and units. Use braces, readable multiline
  objects/types, grouped imports and spacing between logical stages. Avoid nested
  conditionals or compact expressions that conceal ordering and side effects.
- Centralize policy in typed configuration with validated defaults, bounds and
  visibility; keep protocol/domain invariants as named constants. Preserve settings
  pinned to existing durable work when defaults change.
- Keep migrations additive to applied history. For API/storage cutovers, define
  supported consumers and a bounded transition/removal plan. Update callers together;
  avoid leaving two indefinite authoritative implementations.
- For substantive cross-layer work, prove one vertical slice before expanding.
  Delegate only when authorized, with disjoint ownership and explicit contracts.
  Main integrates shared files, dependencies and checks unless assigned otherwise.

## 3. Preserve state, recovery and interaction quality

Use the relevant checks, rather than mechanically adding state machinery everywhere:

- **Remote state:** query/cache layer owns records, pagination, status and freshness.
  Local stores own drafts, exact pending commands, preferences and runtime resources;
  components own temporary interactions. Avoid fetch effects, mirrored server stores
  and request-counter refs where the established query runtime owns cancellation.
  Verify invalidation during the initial pending read as well as cached refreshes:
  a library may reuse a data-less in-flight request and publish its stale result.
  Cancel conflicting reads before refreshing, with scope checks across async gaps.
- **Scope changes:** cancel outgoing reads, reject late completions and isolate the
  next account/workspace without erasing recoverable outgoing work. Keep server
  revisions distinct from local draft generations.
- **Hydration:** declare owner/schema/status/merge/reset rules; deduplicate bootstrap
  per verified scope. Failed hydration is not empty success. Recovery/refresh cannot
  overwrite newer drafts or recording manifests. Bound validation and concurrency.
  When merging server-assigned defaults into newer drafts, value equality alone
  cannot prove a field was untouched: users can edit and then clear it back.
  Retain field-specific edit evidence across pending commands and recovery when
  distinguishing that intent matters; verify direct acknowledgement and reload/retry.
- **Commands:** persist exact intent before sending when uncertain outcomes require
  recovery. Retry the same ID/payload. A timeout does not prove rejection; preserve
  pending work until reconciled. Keep transactions, receipts and deletion checks.
  A replayed receipt is historical evidence, not current state: verify its current
  projection before updating either local drafts or query caches. A later tombstone
  or revision must win even when background refresh fails.
  Audit secondary callers and composite operations too: a separate retry coordinator
  must carry replay semantics across every command it owns.
- **Optimism:** show immediate pending feedback without claiming acknowledgement.
  Cancel conflicting reads, update only affected records/pages and reconcile results.
  Background refetch must not hold successful interaction completion open. Roll back
  only the rejected contribution, preserving newer edits and concurrent successes.
  Define Undo before acknowledgement and incomplete/bulk target behavior explicitly.
  Persist definite rejection alongside recoverable intent so remounting cannot revive
  a rejected preview. Paged patches need stable ordering, version-bearing removals
  and explicit coverage: touched IDs do not necessarily include later descendants.
  Reject overlapping stale lineage even when its ancestor is absent from loaded pages.
  A destructive discard applies to the draft generation the user chose to discard;
  preserve subsequent edits or lock editing while that discard is being resolved.
- **Resources:** keep capture/upload ownership independent of navigation; bind
  playback to its intended source. Preserve bounded-memory streaming and durable
  chunks. Refs are appropriate for DOM/audio handles, not mirrored remote records.
- **Derived data:** preserve immutable source identities, versions and correction/
  Undo mappings. Projections/backfills share one transformation, check source revisions
  before publication and support scoped dry-run, bounded resume and idempotent replay.
- **Performance:** measure feedback, local persistence, network, auth, database and
  refetch separately. Compare payload size/query count and representative timings.
  Add memoization for measured expensive work; use narrow subscriptions and structural
  sharing. Route renames and a passing build are not evidence of reduced latency.
- **AI changes:** follow approved runtime/context/memory/tool/output decisions and
  current platform guidance. Enforce permissions in services/tools; persist versioned
  outputs and provenance. Keep unknown external outcomes recoverable.

## 4. Verify the changed behavior

- Inspect the final diff for accidental deletions, stale imports/callers, leaked
  internal DTO fields and unnecessary dependencies or unrelated formatting churn.
- Run the appropriate existing focused checks first. Add regression coverage when
  it proves a meaningful failure mode or contract; do not mirror implementation or
  create tests merely for reversible low-impact edits.
- Prioritize applicable races: stale read after mutation, late hydration, lost
  response after commit, exact retry, concurrent edit/Undo, infinite-query invalidation,
  pagination seams, account switching and interrupted upload/replay.
- For exact command comparisons, verify the real database/driver round trip with
  representative fractional values and production serialization settings. Mocked
  transport that echoes inputs cannot establish persistence equality; pooled
  connection settings must be verified across both commit and rollback.
- Run affected type/lint/format/build checks. For tooling changes verify the
  fix → format → lint cycle is stable. For UI, exercise the actual built application,
  pending/error/recovery states and relevant desktop/mobile interactions.
- Use isolated test data. Distinguish mocked UI, real handlers/database, real providers,
  hosted acceptance and deployment evidence. Verify telemetry export separately from
  instrumentation and keep sensitive payloads out of logs.
- After focused fixes, repeat affected checks. Broaden only for unresolved integration
  concerns; do not repeatedly rerun full suites without a new reason.

## 5. Close the loop and maintain the guidance

- Report what changed, meaningful verification, unresolved work and delivery status.
  Update authorized implementation notes/plans to actual evidence.
- At the end of a substantive change, review whether a verified failure, recurring
  review finding, approved convention or framework change warrants a skill update.
  Review again before a major refactor or dependency/runtime upgrade. This is an
  event-driven review, not a background scheduler or mandatory edit after every task.
- Put each rule in its owning document: reusable change workflow here; structural
  conventions in `domain-first-stack`; product invariants in project instructions;
  current status/decisions in plans and implementation notes. Link rather than copy.
- For a justified update, record the evidence, generalizable lesson, applicability
  and verification method. Amend the existing rule; remove or explicitly supersede
  obsolete guidance. Keep tentative findings labeled until verified. Do not turn a
  one-off workaround into a universal rule or weaken a rule simply to pass a check.
- Maintain a short dated [change log](CHANGELOG.md). Record material rule changes
  and their reason, not task transcripts, private data or every code edit.
- Edit only the canonical skill location allowed in the current mode/scope. Once
  installed, the project skill is canonical; the plan draft becomes a handoff record.
  Report proposed out-of-scope guidance changes rather than silently changing global
  rules or unrelated skills. Validate links/frontmatter and discovery after activation.
