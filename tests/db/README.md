# PostgreSQL integration tests

Run against a **dedicated, empty PostgreSQL database** whose name contains a
`test` segment (for example `voidnote_test`):

```sh
TEST_DATABASE_URL=postgresql://voidnote_test:voidnote_test@127.0.0.1:55432/voidnote_test bun test tests/db
bunx --no-install tsc --project tsconfig.db-tests.json --noEmit
```

The suite fails if `TEST_DATABASE_URL` is missing, the database is unreachable,
or it contains application tables. It never falls back to `DATABASE_URL`.
The role must be able to apply migrations and create test trigger functions.

The fixture takes an advisory lock, applies the real `drizzle/` migrations,
uses fresh workspace identities per test, and removes its tables at teardown.
An interrupted run may require recreating the dedicated database before rerunning.
Tests use `node:test` and `node:assert/strict` through Bun's test runner, so no
additional Bun type package is required.

Coverage includes transaction rollback through real PostgreSQL failure triggers,
command receipts, concurrent retries and conflicting revisions, workspace and
membership isolation, composite foreign keys, tombstones, retained history,
bounded keyset pagination, literal title/person-prefix search, and preservation
of unused legacy columns without exposing them in note DTOs.

Correction tests additionally cover manual unknown/person assignments, frozen
targets, boundary revisions, immutable provider evidence, split lineage, safe undo,
sample invalidation, late publication, and atomic history/outbox rollback. Pure
reprocessing fixtures test future mapping policy without exposing a rerun API.

The recovery/store tests do not use a database and can run independently:

```sh
bun test tests/db/note-store.test.ts tests/db/workspace-recovery.test.ts
```

They cover scoped draft and exact-command persistence, checkpoint-before-request,
storage failures, auth expiry, authorization denial, confirmed logout/discard,
deep-link hydration, and deleted-row quarantine.
