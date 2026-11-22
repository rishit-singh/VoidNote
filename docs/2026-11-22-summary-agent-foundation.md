# Summary agent foundation

This is the bounded agent-runtime proof on `feat/agent-workflows`, based on release
`c016c51`. It implements the first summary pipeline; the Summary UI, historical
retrieval, agenda, long-input synthesis, memory and Ask remain later slices.

## Ownership and execution

- `src/contracts/analysis` owns request, job, evidence and result contracts.
- `src/db/analysis` owns durable acceptance, source checks, cancellation, context
  preparation, result versions and publication.
- `src/ai/context` owns snapshot shape, integrity and citation validation.
- `src/ai/runtime` owns the versioned policy pinned on acceptance.
- `src/ai/summary` owns the isolated Think agent, ThinkWorkflow, dispatch and
  snapshot/publication services.
- `src/server/analysis.ts` and the `summaries` tRPC router adapt authenticated
  requests to these operations.

Postgres owns jobs and published results. The job's undispatched row is its outbox.
One DO and one Workflow belong to each logical job; a new command creates a new
generation attempt. Exact retries retain the original command, source and policy.
DO SQLite stores runtime admission/submission state. Private R2 objects hold
immutable, checksum-addressed context snapshots.

The request returns after database acceptance. A background RPC accelerates
dispatch; the scheduled Worker revisits queued and running jobs, including
acknowledged executions whose terminal database write failed. Attempt timestamps
rotate the bounded scan even when checks fail; they are distinct from successful
Workflow acknowledgement. Reconciliation never restarts inference. No Agent HTTP router
is exposed. The internal namespace must stay out of any future general-purpose
Agent router.

## Evidence and publication

Migration `0007_analysis_foundation.sql` adds jobs, saved results and a transcript
generation. Existing succeeded runs start at generation 1. Provider publication
and each committed correction/split/Undo advance it once; receipt replay and lazy
materialization do not.
Migrations `0008_analysis_reconciliation.sql` and
`0009_analysis_dispatch_fairness.sql` add the indexed, fair active-job scan.
Analysis operations take a note-scoped advisory lock and a shared note lock before
the run lock, preserving version allocation without deadlocking provider replay.

Context contains the entire accepted current transcript and batched authored
profiles. It preserves utterance/segment identity, text/attribution revisions,
speaker assignments and seconds-based audio bounds. Input beyond the pinned
budget is rejected, never silently truncated. Agenda and related-history fields
are explicitly absent in this proof.

The model returns evidence handles and exact quotes. Server validation resolves
them against the snapshot. Publication checks current access, deletion,
cancellation, source generation, note revision and profile revisions under
transactional locks. A completed result can later become stale; that does not
erase its immutable historical evidence. Citation validity is not proof of
semantic correctness or summary quality.

## Runtime limits and recovery

The proof pins Think `0.24.0`, Agents `0.34.0`, Computer `0.10.0` and AI SDK
`7.0.173`. `just-bash` is required by the runtime import graph even though this
agent exposes no bash/workspace tools to the model.

The default policy permits 64,000 UTF-8 context bytes, 1,000 passages, 128,000
output bytes and 8,192 output tokens. One model step is allowed, with no AI SDK
request retries and no automatic Think continuation after interruption. Model
execution has a 120-second timeout; the Workflow prompt wait has 180 seconds.
These are proof budgets, not selected product policies.

`activeTools: []` disables model-accessible built-ins; Think injects its structured
final-answer tool afterward. ThinkWorkflow must start through the originating
agent's `runWorkflow()`. Stable Workflow IDs require create-or-reconcile handling:
SDK creation itself is not an idempotent create-or-get.

Cancellation is persisted first, then runtime submission cancellation is
best-effort. Publication remains fenced even if a provider cannot stop promptly.
An interrupted or invalid model response requires a new explicit command, rather
than silently repeating inference under the same job.

## Activation and remaining work

All application Wrangler environments default to `SUMMARY_ENABLED=false` and an
empty `SUMMARY_MODEL`. The subsequent user-authorized DeepSeek live proof is
recorded in [its evidence](experiments/summary-proof-2026-11-22/README.md):
two summaries saved, one interrupted attempt safely failed, and reload/replay
preserved the original result. Its separate opt-in harness uses local storage and
live Workers AI. Product enablement still requires quality acceptance and hosted
environment verification. Normal CI uses deterministic models.

Outstanding product work includes full-input chunked synthesis, authorized
historical retrieval, agenda contracts, citation UI, quality evaluation, profile
reconciliation, overlap audio investigation and thread-scoped Ask.

## Verification

- Full database/unit suite: 210 passed before final review fixes; the affected
  checks then passed across 19 repository, 6 evidence and 4 dispatch tests,
  including deterministic recording-replay concurrency, active-job reconciliation
  and an 11-job failed-check starvation regression.
- Auth/transport suite: 28 passed, including durable acceptance, disabled-policy
  replay, cancellation and authorized historical evidence.
- Worker suite: 11 passed, including five production SummaryAgent/Workflow tests
  against real Think in workerd, with mocked model and persistence boundaries.
  They cover duplicate starts, invalid output, raw RPC initialization,
  cancel-before-start and terminal-write outage reconciliation.
- Outage tests use an injected non-retryable persistence failure to avoid long
  backoff, and explicitly invoke the recovery hook. They do not establish actual
  retry exhaustion or DO eviction behavior.
- Six built-Worker health/access smoke tests passed. Missing local auth/provider
  secrets intentionally exercise fail-closed access; authenticated Summary UI and
  hosted acceptance were not exercised.
- OpenNext build and Wrangler dry-run passed with application inference disabled.
  Live Workers AI calls occurred only in the later, separately authorized harness.
- All seven TypeScript projects, zero-warning ESLint and repository formatting
  passed. Independent review closed its lock-order, terminal-write recovery and
  scan-starvation findings. The verified recovery lessons were added to the
  canonical `change-with-confidence` skill and its changelog.

The user subsequently authorized committing and pushing the checked feature
branch. No production migrations or deployments were performed.
