# Recording initialization precision

## Report and evidence

After the Safari duration fix shipped in `d2af761`, a fresh untitled note still
reported “Recording ID already identifies different audio.” The user reported that
renaming before recording avoided the failure.

Read-only production inspection found:

- A Safari 18.3.1 `recordings.initialize` request returned 409 on Cloudflare version
  `a77035bc-db18-4faa-90f5-47b1e8bbfe83`.
- Its note existed at revision 1 with an empty title, but had no recording row.
- The database connection's `extra_float_digits` was `0`. Selecting
  `16.136417233560092::double precision` returned `16.1364172335601`.

The rejected request body was not logged, so the exact submitted duration is
unavailable. An isolated real-PostgreSQL test with the observed formatting setting
reproduced the same exception on the **first** initialization of fresh audio.
The insert and subsequent equality check share a transaction; rejection rolls
the insert back.

Recording identity is a fresh UUID, independent of title. Client inspection found
that both untitled and renamed notes must be acknowledged before microphone access.
Renaming changes save timing, but no causal title-to-duration dependency was found.
The reported rename correlation remains unconfirmed; the reproduced precision
failure can affect either title state.

## Correction

`src/db/recording-repository.ts` now sets `extra_float_digits = 3` locally at the
start of each existing recording transaction. PostgreSQL returns round-trip-safe
floating-point values, preserving strict initialization equality without a
tolerance, changing IDs, or rewriting pinned commands.

The same boundary covers initialization, overview-based legacy recovery,
acknowledgments, recording access and processing execution. It adds one SQL
statement per transaction. It changes no schema or stored audio.

This must be transaction-local: [Hyperdrive's pooling documentation](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/#pooling-mode)
states that connections reset when returned to the pool. A connection-startup or
standalone session setting is insufficient.

## Verification

- The new real-PostgreSQL regression failed before the correction with the exact
  reported error; all nine recording-repository cases pass afterward.
- The precision case uses production driver options (`prepare: true`,
  `fetch_types: false`) on one connection with rounded output as its default.
  It verifies first initialization, exact retry, overview, direct access and first/
  repeated acknowledgment for untitled and renamed notes. Actual hash, size, MIME
  and duration changes remain conflicts. The setting resets on commit and rollback.
- All 194 database/unit cases passed on a dedicated empty local test database.
  After strengthening the single-connection regression, the affected nine cases
  passed again.
- All nine recording-lifecycle browser cases pass against the rebuilt Worker.
  New untitled/renamed cases hold note creation, verify microphone access waits for
  acknowledgment, then capture, finalize, upload and request processing. They
  compare actual uploaded bytes with the pinned manifest's hash and size.
  Browser transport is mocked; the real database regression is separate evidence.
- Worker build, application/database-test/E2E type checks, scoped lint and formatting
  passed. Independent review found no blocking source issues.

Production delivery is authorized through the checked `main` CI workflow. Its
production-delivery artifact records the released commit, Cloudflare version and
health-smoke result. Production inspection during diagnosis was read-only.
Hosted recording acceptance and physical iPhone verification remain outstanding.
