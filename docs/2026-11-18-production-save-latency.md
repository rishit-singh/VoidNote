# Production save latency baseline

Measured on `https://voidnote.app` on November 18, 2026 local time
(November 19, approximately 04:09–04:12 UTC), after release `2467c12`.
Working branch: `perf/production-latency` in the persistent
`~/src/worktrees/VoidNote-perf` checkout.

## Browser measurements

Used two newly created, empty test notes in an authenticated production session.
Recorded input events, DOM status changes, fetch start/response headers and long
tasks in the browser. These are a small diagnostic sample, not latency percentiles.

| Sequential rename  | Last input → fetch | Fetch → response headers | Last input → Saved |
| ------------------ | -----------------: | -----------------------: | -----------------: |
| First              |             606 ms |                 1,320 ms |           1,937 ms |
| Second             |             608 ms |                 1,430 ms |           2,049 ms |
| SQL-counter sample |             606 ms |                 1,466 ms |           2,081 ms |

Title DOM updates followed input by roughly 1–6 ms during the first rename.
No long tasks were observed in the instrumented sequential-save interval.
DOM acknowledgement followed response headers by approximately 9–12 ms.
The background list refresh did not hold acknowledgement open.

For the concurrency probe, native input events were scheduled in two tabs for
different notes. Both dispatched at the same millisecond. Mutation requests
started 1 ms apart and returned HTTP 200 after 1,246 ms and 1,304 ms respectively.
Both showed Saved. This sample does not show workspace-wide serialization.

## Production SQL execution counters

Read `extensions.pg_stat_statements` with a read-only database connection before
and after the third sequential rename. Each of the six mutation statement
counters increased by exactly one. Verified these query IDs were unique in the
baseline; other roles can share query IDs, so transaction-control counters were
excluded. Global counters are not request-correlated traces.

| Statement                                            | Execution-time delta |
| ---------------------------------------------------- | -------------------: |
| Membership/workspace authorization with shared locks |             3.186 ms |
| Insert unique command claim                          |             4.774 ms |
| Revision-conditional note update                     |             0.851 ms |
| Complete command receipt                             |             0.418 ms |
| Insert domain event                                  |             3.842 ms |
| Insert outbox entry                                  |             4.682 ms |
| **Total**                                            |        **17.754 ms** |

The two accompanying list reads consumed 0.120 ms combined; their membership
checks consumed 0.104 ms combined. These reads include cross-tab invalidation.

Cumulative statistics reset on November 14. Historical shared authorization
queries include a 710.888 ms maximum; that is not evidence of a lock wait in the
measured rename. No Supabase advisor results were available in this session.

## Conclusion and next measurement

The measured delay is dominated by time outside the six statements' PostgreSQL
execution, plus the configured 600 ms debounce. The statement counters do not
measure authentication, connection setup, protocol round trips, transaction
commit, connection teardown, or browser-to-Worker latency. Do not attribute the
remaining time to a specific one of those stages yet.

`src/auth/server.ts` calls Supabase `getUser()` for verified authentication.
`src/db/client.ts` opens a request-scoped Postgres.js client through Hyperdrive
and awaits `client.end()` before returning. `src/telemetry/worker.ts` exports only
health-check spans, so existing Logfire tracing cannot break down note saves.

Next: add bounded, payload-free timings for authentication, database operation,
commit/connection teardown and total handler time, then measure the same rename
path. Preserve verified authentication and command/revision guarantees. Use that
breakdown before changing placement, SQL round trips, or connection handling.

No application code, schema, or deployment changed during this baseline.
