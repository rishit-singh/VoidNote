# Local production-composition acceptance

Authorized fresh allowance: **$2 total** on
`@cf/deepseek-ai/deepseek-v4.1-flash-1017`: chat $1, research $0.50, summary $0.50.
Only the coordinating operator starts inference and supplies credentials.

## Setup (operator)

1. Create **only** `voidnote_platform_acceptance_20261125` in the local Postgres
   instance at `127.0.0.1:54322` (local user/password `postgres`).
   Keep historical ledgers in the other databases untouched.
2. From the repository root, using Node 24 and Bun:

   ```sh
   bun tests/proofs/platform/seed.ts
   ```

   The script uses the exact dedicated connection string from the request. It
   applies the existing migrations without dropping schemas. It exclusively
   creates `.wrangler/platform-acceptance/manifest.json` before DB writes, then
   seeds all records in one transaction under a serialization lock. Reruns return
   the same manifest and do not refill budgets or rewrite the seed. Keep this
   manifest and database together; never delete either to recover uncertain calls.
   It refuses another seed's populated workspace. No provider calls occur here.

3. Create the ignored, local-only `tests/proofs/platform/.dev.vars` yourself.
   `PROOF_MANIFEST` is the **single-line JSON** contents of the fixed manifest,
   wrapped in single quotes. Set these values from that same file:

   ```dotenv
   PROOF_TOKEN=<operator-generated-random-secret-at-least-32-characters>
   PROOF_MANIFEST='<compact manifest JSON>'
   ASSISTANT_BUDGET_ID=<budgets.chat>
   ASSISTANT_RATE_VERSION_ID=<rateVersionId>
   RESEARCH_BUDGET_ID=<budgets.research>
   RESEARCH_RATE_VERSION_ID=<rateVersionId>
   SUMMARY_BUDGET_ID=<budgets.legacySummary>
   ASSISTANT_ENABLED=true
   RESEARCH_ENABLED=true
   SUMMARY_ENABLED=true
   ```

   All three model variables are already pinned in `wrangler.jsonc`.
   Do not place credentials in the manifest or checked-in configuration.
   Provide Workers AI authorization through your existing local Wrangler login
   or private process environment. Ensure the chosen account supports this paid model.

4. Launch from repository root with Node 24 selected:

   ```sh
   bun x wrangler dev --config tests/proofs/platform/wrangler.jsonc --ip 127.0.0.1 --port 8797 --persist-to .wrangler/platform-acceptance/state
   ```

   This is local development with **only AI remote**; R2, Durable Objects and
   Workflows are local. Keep the persisted runtime state across restarts. Do not
   use `--remote` or deploy this proof. Local Hyperdrive points only at the
   dedicated DB. All HTTP routes require loopback hostname and constant-time
   `PROOF_TOKEN` header authentication. There is no automatic scheduled trigger.

## API

The operator can run one explicit case with
`bun tests/proofs/platform/run.ts greeting` (also `contact`, `note`, `file`,
`remember`, `revise`, `recall`, `history`, `summary`, or `research`).
Corrected cases have separate names: `note-corrected`, `revise-corrected`,
`recall-corrected`, `summary-v7`, and the separately approved `summary-v7-low`.
`summary-v7-low-usage` is the separate one-call settlement verification case.
`research-retry` reads the original saved batch/generation and persists one exact
retry command before submitting it through the production retry fence.
Each case saves its exact command before submission under the ignored
`.wrangler/platform-acceptance/evidence/` directory. Rerunning a case reuses that
command. Inspect persisted results for semantic quality; a successful status is
not a semantic pass. This runner invokes paid inference within the seeded caps.

Send `Content-Type: application/json` and `PROOF_TOKEN: <local secret>` to
`http://127.0.0.1:8797`. Request bodies are bounded at 32 KiB. Keep exact command
IDs and JSON payloads for any uncertain retry; a new ID means new authorized work.

- `POST /chat`: `{"turnId":"<explicit UUID>","text":"Summarize the pilot decision and outstanding work using the note. Cite evidence."}`
  Pins the configured assistant policy via the authorized repository and starts
  the production AssistantAgent. `GET /chat?turnId=<UUID>` returns durable turn
  status, saved thread history and shared-ledger accounting metadata.
- `POST /summary`: `{"commandId":"<explicit UUID>"}`. Uses the seeded meeting,
  production summary-v7 policy, SummaryAgent and SummaryWorkflow. The earlier
  V5/V6 acceptance commands/results remain preserved as failed historical cases.
  Optional `reasoningEffort` accepts `none` (default) or `low`; selecting low is
  authorized only for the bounded follow-up test, not a product-default change.
  `GET /summary?jobId=<returned job.id>` returns status, saved result and the
  separate legacy-summary ledger.
- `POST /research`: body below (workspace is fixed by the proof):

  ```json
  {
    "requestId": "<explicit UUID>",
    "people": [
      {
        "personId": "<manifest Simon Willison contact UUID>",
        "expectedProfileRevision": 1,
        "expectedContactRevision": 1,
        "requestedFacts": [
          {
            "key": "framework",
            "question": "Which web framework does this biography say he co-created?"
          }
        ],
        "sourceUrls": ["https://simonwillison.net/about/"]
      }
    ]
  }
  ```

  `GET /research?batchId=<returned batch.id>` returns persisted per-fact findings,
  citations, progress and the research ledger. The operator must confirm source
  identity and current profile/contact revisions before submitting.

- `POST /research/retry`: `{requestId,batchId,personId,expectedGeneration}`.
  Uses the production repository's exact retry receipt and generation checks.
  Preserve the original failed request/result; do not replace its source input.

- `POST /reconcile`: calls only `dispatchAssistantArtifacts`, exercising private
  local-R2 publication/cleanup for already-created files. Returns only
  `{published,deferred}` counts. It never submits chat, summary or research work.

GET requests do not dispatch inference. Accounting responses contain no authentication tokens,
credentials or raw prompts; their receipt lists cover the **whole dedicated
feature budget**, not just the requested turn, and are capped at 100 rows.
Durable content/history is returned separately for semantic inspection.

## What is seeded and what acceptance must establish

The fixture has a synthetic Mira Chen contact with organization, role and a
placeholder link, plus real public guest Simon Willison with
`https://simonwillison.net/about/`. Simon has no authored organization/role claims
and is not attributed any synthetic dialogue. There is one note-scoped
conversation and three normalized utterances
published through the production recording repository and attributed through the
correction repository. It does not transcribe audio or call a transcription provider.

Expected meeting evidence: five-volunteer Maple pilot agreed; Mira sends invitations
November 27, 2026; the second speaker reviews permissions before customers are invited; customer
launch date and support owner remain undecided. Model results must preserve those
uncertainties and cite saved utterances.

The seeded `example.org` link is **not evidence about the synthetic person**.
For Simon, ask only which web framework the biography says he co-created; the
source must actually support the answer and exact citation. The live retry
retrieved the biography and saved its supporting excerpt. Using synthetic identities should produce
unknown/unsupported findings, never invented matches. Retrieval uses the
production public-IP-pinned TLS adapter; Cloudflare-proxied or IPv6-only sources
may fail visibly. Do not substitute a mock/fetch bypass to claim live acceptance.

Rates were verified on 2026-11-25 at
<https://developers.cloudflare.com/workers-ai/models/deepseek-v4.1-flash-1017/>:
$0.30/M input, $1.20/M output. Shared immutable rates store 300,000 and 1,200,000
micro-USD per million tokens. Cached input is conservatively priced as ordinary input.
Chat and research get fresh approved budgets of 1,000,000 and 500,000 micro-USD.
Summary gets a separate 500,000 micro-USD legacy budget with a conservative
full-window reservation computed from production policy (324,404 micro-USD at
the current one-step/8,192-output-token policy); request-usage-v1 may admit a
smaller bounded request. Unknown usage stays held, never reset or replayed.

Record saved outputs, citations, exact operation IDs, terminal statuses, raw usage
receipts and settled/held totals separately. Successful transport alone does not
establish semantic correctness. Live results and remaining gates are recorded in
[`docs/experiments/platform-acceptance-2026-11-25/README.md`](../../../docs/experiments/platform-acceptance-2026-11-25/README.md).
