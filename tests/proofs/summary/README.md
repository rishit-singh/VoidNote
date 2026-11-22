# Opt-in live summary proof

This harness runs the production summary Agent, Workflow, context services and
repositories against isolated **local PostgreSQL, workerd and R2**, with **live
Workers AI inference**. It is never run by the CI test glob and is not a deployment
configuration. It bypasses Supabase login with a fixed synthetic principal; normal
transport authentication is covered by the separate auth tests.

The fixture contains ten invented passages and three invented people. No audio
upload/transcription or acoustic validation is claimed.

## Explicit execution

1. Obtain approval for the model, paid-attempt count and estimated budget.
2. Create an empty local database named `voidnote_summary_proof_test`. Supply its
   connection through `SUMMARY_PROOF_DATABASE_URL`; the seed rejects other names,
   remote hosts and nonempty databases.
3. Run `bun tests/proofs/summary/seed.ts`.
4. Generate a random `PROOF_TOKEN` in the ignored `.dev.vars` alongside this file.
   Keep credentials out of command arguments and captured output.
5. Set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` to the same local
   database. Miniflare requires a password component even with local trust auth.
6. Start the opt-in runtime:

   ```sh
   bunx wrangler dev --config tests/proofs/summary/wrangler.jsonc \
     --ip 127.0.0.1 --port 8794 --persist-to .wrangler/summary-proof-state
   ```

7. Run one explicitly chosen attempt: `bun tests/proofs/summary/run.ts 1`.
   Attempts `2` and `3` use the proof-only concise/grounding supplement. The runner
   never advances attempts automatically.
8. Stop/restart the runtime with the same persisted state, then verify a completed
   result with `bun tests/proofs/summary/run.ts 1 --verify-reload`.
9. Stop the runtime after the approved proof. Preserve the database, local state
   and `.wrangler/summary-proof-evidence/` receipts when outcomes are uncertain.

Only three fixed job IDs are accepted. Each uses production single-turn admission,
zero model request retries and no automatic interrupted-turn continuation. The
runner reserves $0.0398304 per attempt from a conservative 100,000 input-token
ceiling and 8,192 output-token cap at the checked model rates. That is an estimate,
not a provider-side billing limit. Unknown usage consumes the reservation.

Do not erase state or reseed as a retry: that would discard the paid-attempt ledger.
The local development server needs a lifetime longer than the experiment; a tool
timeout can interrupt inference. Use the exact same attempt ID to reconcile.

## Interpretation

- `onStepEnd` stores actual provider-reported usage and timings in DO SQLite.
- Missing metrics mean unknown usage, never zero expense.
- The installed provider does not expose reasoning-token detail; it stays `null`.
- The proof requests `reasoning_effort: none` through provider options.
- `instructions.ts` is an experimental supplement, not a promoted production
  prompt. The saved base provenance remains `summary-v1`; the experiment identity
  is recorded separately in the proof metrics.
- Structural/quote validation cannot establish semantic entailment or quality.

Recorded outcome: [November 22 evidence](../../../docs/experiments/summary-proof-2026-11-22/README.md).
