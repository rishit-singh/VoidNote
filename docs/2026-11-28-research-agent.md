# Research agent: native execution and acceptance

## Current status

Deployed to isolated staging as `a27b9e0` through CI `46165903871`
(Worker version `9d86464a-f20c-4fed-99fd-06663151ccc4`).
Real-provider acceptance remains incomplete.
The approved November 28 replan replaces the fixed research pipeline for new
agent-version runs. Existing Workflow runs keep their pinned execution owner.

```text
Assistant / API → accepted Postgres run → per-run Think ResearchAgent
                                               ↕
                                  lookup / read / search / retrieve
                                               ↓
                                   findings → validated publication
                                               ↓
                                report + activity + operation receipt
```

## Owners and contracts

- `src/ai/research/agent/` owns the native Think tool loop and submission identity.
- `agent-services.ts` reads live authority and admits each model request.
- `agent-evidence.ts` connects scoped evidence tools to repositories and providers.
- `agent-runtime.ts` preserves raw inference usage across settlement failures.
- `src/contracts/research/agent.ts` defines the model-facing tools.
- `src/db/research/agent-operations.ts` fences external operations and retains
  uncertain outcomes. Completed receipt scans rotate unsuccessful settlement.
- `src/db/research/agent-publication.ts` atomically saves final findings, report,
  activity event and publication receipt.

The model chooses queries, source reads, follow-up investigation and conclusions.
Draft findings are revisable observations stored in operation receipts; they do
not lock the final question rows. Publication requires every admitted question to
be represented. An `answered` report requires cited supported findings and no gaps.
Exact excerpts are validated; this does not establish semantic correctness.

Source metadata preserves requested and final URLs. Bounded evidence pages expose
offsets and continuation. Supplied-source restrictions apply to saved evidence,
reads and citations as well as new retrieval. Historical eligibility currently
requires a known publication date at or before the requested `asOf`; unknown dates
are returned as gaps, not silently used as historical proof.

## Recovery and policy

Stable run IDs select both the DO instance and Think submission. Lost acceptance
responses inspect that submission rather than creating another investigation.
Uncertain paid operations cannot be reclaimed as fresh calls. Model usage has a
DO-local pending receipt before Postgres settlement; cancellation does not discard
late provider receipts.

A transient publication failure retains the exact proposed report for a local
publication retry without inference. Findings, completion event and receipt share
one transaction; a failed transaction cannot leave half a publication.

`researchRunPolicySchema` pins `executionVersion`, model/search/tool limits and
existing source/context limits. Missing execution version means `workflow-v1`;
`research-agent-v2` is an explicit admission choice. Activation uses
`RESEARCH_AGENT_ENABLED`. Production promotion is separate from staging delivery.

## Verification evidence

- Native Workerd/Think tests use a mocked Workers AI protocol: adaptive tool
  selection, exact submission inspection, cancellation, citation repair, and
  publication acknowledgement recovery. They are not live research acceptance.
- Isolated local Postgres checks cover receipt fencing, late settlement, rotating
  settlement scans, atomic publication rollback/replay and the real service path
  from draft findings to a cited final report.
- Provider adapters and tool validators have focused scope, pagination, temporal
  eligibility and citation checks.

## Remaining acceptance

The first hosted browser attempt dispatched a native run but failed before
research inference. Persisted Think logs identified strict scope parsing rejecting
the admission-only `requestId` and `inputTokenBound` fields. The service boundary
now explicitly selects run identity; its isolated Postgres regression exercises
real inference admission, budget reservation and rejection of repeated submission.
This correction deployed as `f3285f4` through CI `46167369863`, Worker version
`c50bf641-c6fc-43f3-8cca-29202eb4b5cd`. The repeated hosted browser journey
showed the task and executed eight real model steps, but failed without a report.
All five NASA retrieval attempts emitted `source_http_framing_invalid` in Logfire.
Two publication attempts were rejected because final reports require explained
`insufficient-evidence` findings rather than `failed` findings. The service hid
that validation message behind generic citation feedback. The local repair
preserves bounded validator feedback; eight native tests and two real Postgres
service tests pass, including repair and publication without retrieved evidence.
The new Postgres fixture initially requested unsupported discovery; correcting it
to a supplied but unretrieved URL made it match this failure scenario.
Safe framing diagnostics now expose the exact parser rejection branch; hosted
retrieval is still unresolved. This is not successful research acceptance. At this point settled
spend was $0.103064 assistant plus $0.014916 research, with no outstanding holds.

The originating conversation also hid the task because it additionally filtered
by the run's optional note association. The task list now uses conversation scope
alone; its browser regression covers a run without a note association.
At this failed attempt, recorded assistant spend was $0.091005, research spend
was zero and no inference holds remained.

Real hosted browser delegation, model-directed follow-up, verified claims and
citations, reload, evidence reuse, cancellation, notifications, traces and usage
must all be demonstrated. Prior hosted NASA retrieval failed at the HTTP-response
stage; local retrieval success does not resolve that hosted failure.

Firecrawl search uses the existing service-budget ledger. The application key is
installed in staging and authenticated against the read-only credit-usage endpoint
(99,244 credits remaining at setup). A 200-credit allowance is provisioned using
the reserved $1, conservatively valued at $0.005 per credit from the highest
published self-serve pay-as-you-go rate. Search costs 2 credits per ten results;
the existing per-operation reservation remains 7 credits. No credits were bought.
Staging discovery activation is configured locally, pending CI delivery.
Sources: https://www.firecrawl.dev/pricing and
https://docs.firecrawl.dev/features/search (checked November 28, 2026).
Firecrawl scrape retrieval is not implemented.
Direct retrieval is the current page adapter. New testing remains within the
user's existing $5 authorization, not an expanded allowance.
