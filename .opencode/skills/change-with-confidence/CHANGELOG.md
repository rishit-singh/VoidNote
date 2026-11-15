# Guidance changes

## 2026-11-14 — Project activation

- Installed the agreed modification/refactoring workflow and companion structural
  skill in `.opencode/skills/`; these project copies are now canonical.
- Basis: the full-stack quality discussion and reconciled 02b plan. Verification
  on the first notes/title implementation slice is tracked in implementation notes.

## 2026-11-14 — Replayed receipts and query caches

- Independent review reproduced a deleted note reappearing in cached lists when an
  old save receipt was applied before current-row verification. Draft-only recovery
  tests had mocked away the query reconciliation layer.
- Added the rule that replay verification covers both query and local state, with
  tombstones/newer revisions taking precedence. Applies to idempotent command systems
  whose receipts retain historical results.
- Verification: `tests/db/note-query.test.ts` exercises actual RPC client/query
  reconciliation with blocked refresh; `tests/e2e/query-lifecycle.spec.ts` exercises
  store → transport fixture → query → UI recovery. Execution results live in the
  slice's implementation notes.

For future material changes, add a dated entry with the changed rule, evidence
reference, applicability and verification. Keep this log concise.

## 2026-11-14 — Composite retries and discard generations

- People/profile review found inline speaker creation used a second retry coordinator
  that did not mark historical save receipts as replayed. Extended the replay rule
  to secondary callers and composite operations; the regression is covered in
  `tests/e2e/transcript-corrections.spec.ts` with list refresh blocked.
- Allowing typing during pending saves also exposed destructive conflict-discard
  reads to later edits. The people store/UI now lock that resolution phase; deferred
  tombstone/404 regressions in `tests/db/note-store.test.ts` failed before the fix.
  Added generation-scoped discard guidance for interfaces supporting concurrent edits.

## 2026-11-14 — Correction recovery and partial lineage

- Correction review found a rejected local overlay revived on reload because only
  its command was persisted. Added durable rejection-disposition guidance; the
  reload regression lives in `tests/e2e/transcript-corrections.spec.ts`.
- A delayed split/Undo response could overlap newer nested descendants when the
  ancestor was absent from loaded pages. Added explicit patch coverage, ordering
  and lineage guidance. `tests/db/transcript-correction-query.test.ts` verifies
  revision-bearing removals, nested lineage and reused ordering keys; repository
  tests distinguish immutable receipts from fresh bounded exact-ID snapshots.
