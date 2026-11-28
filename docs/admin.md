# Inference administration

`scripts/admin.ts` is a small read/provisioning tool for the current assistant and
research accounting tables. It does not implement credits or replace usage
receipts. Existing inference receipts and Firecrawl operation receipts remain the
usage record.

## Inspect

The target and workspace are always explicit. Local uses the loopback Supabase
database; staging reads `STAGING_DATABASE_URL` from the environment and verifies
its hostname is the staging project's database host. It never accepts a database
URL as a command-line argument and has no production target.

```sh
bun scripts/admin.ts status --target local --workspace <workspace-uuid>
STAGING_DATABASE_URL=... bun scripts/admin.ts status --target staging --workspace <workspace-uuid>
```

Status reports the named workspace, registered inference rates, its assistant /
research inference allowances and its Firecrawl service-unit allowances. It does
not return secrets. This inspects database records only; Worker environment
readiness is not checked by this command.

## Provision approved records

Create a private JSON manifest with stable IDs, model, provider, rates and limits.
The rate and assistant/research allowances are required; there are no dollar defaults. Monetary values
are integer **micro-USD**, and token prices are micro-USD per million tokens.
Research discovery allowance is integer Firecrawl units. Obtain approval for the
exact values before provisioning.

```json
{
  "version": 1,
  "workspaceId": "<workspace-uuid>",
  "model": "@cf/provider/model",
  "rate": {
    "id": "<rate-uuid>",
    "provider": "workers-ai",
    "inputMicroUsdPerMillionTokens": 0,
    "outputMicroUsdPerMillionTokens": 0
  },
  "assistant": { "id": "<assistant-allowance-uuid>", "limitMicroUsd": 0 },
  "research": { "id": "<research-allowance-uuid>", "limitMicroUsd": 0 },
  "researchSearchUnitBound": 7
}
```

Replace all illustrative zero values with explicitly approved values. The
assistant and research IDs must differ. `researchSearchUnitBound` is required and
must be an integer of at least 7, matching the current application policy's
maximum-result search plus full-page retrieval bound. To authorize external
discovery, optionally add `"firecrawl": { "id": "<firecrawl-allowance-uuid>",
"limitUnits": 7 }` (with an approved total at least as large as the per-operation
bound). Without it, configuration output keeps research discovery disabled and
supports supplied-URL research only. The manifest rate provider is fixed to
`workers-ai`; stored USD currency is checked on replay.

Keep the manifest out of source control if it contains operationally sensitive IDs. First
review the default dry run, then opt into writes with `--apply`:

```sh
bun scripts/admin.ts configure --target local --workspace <workspace-uuid> --manifest ./admin-manifest.json
STAGING_DATABASE_URL=... bun scripts/admin.ts configure --target staging --workspace <workspace-uuid> --manifest ./admin-manifest.json
```

Append `--apply` only after reviewing the exact target, IDs and limits. Provisioning
is transactional and create-only: reruns accept only matching existing records.
It will not change rate terms, increase an allowance, reset usage, or revive a
revoked allowance. Use new approved stable IDs for separately authorized records;
never delete historical ledgers to make room. The script does not run migrations.
The target database must already have the current inference and service-budget
schema.

## App environment values

After provisioning, supply non-secret values through the existing Worker
environment configuration:

```dotenv
ASSISTANT_ENABLED=true
ASSISTANT_MODEL=<manifest model>
ASSISTANT_BUDGET_ID=<assistant allowance id>
ASSISTANT_RATE_VERSION_ID=<rate id>

RESEARCH_ENABLED=true
RESEARCH_MODEL=<manifest model>
RESEARCH_BUDGET_ID=<research allowance id>
RESEARCH_RATE_VERSION_ID=<rate id>
RESEARCH_DISCOVERY_ENABLED=<true only when a Firecrawl allowance is present>
RESEARCH_SEARCH_UNIT_BOUND=<manifest researchSearchUnitBound>
```

When discovery is enabled, also set `RESEARCH_SERVICE_BUDGET_ID` to the manifest's
Firecrawl allowance ID and store `FIRECRAWL_API_KEY` via the existing secret
mechanism. Keep provider credentials out of manifests, CLI arguments and output.
Inference allowance limits are application admission/accounting limits, not
provider-side spending caps or invoices. Missing or incomplete provider usage
retains an uncertain hold; do not manually clear it.

Future credits work should replace ad hoc hard budget gates without discarding
these durable usage receipts or treating reserved capacity as measured billing.

## Staging allocation — November 28, 2026

The user approved $5 total for staging testing. The admin command provisioned
$1 assistant and $3 research inference allowances for the synthetic acceptance
workspace `094563d2-f5ad-4a0f-ad8e-c9a9a5d4f533`. The remaining $1 is reserved for
discovery, not yet provisioned: the application Firecrawl credential is missing.
No provider subscription or credit purchase was made.

The pinned Workers AI model is `@cf/deepseek-ai/deepseek-v4.1-flash-1017`, using
uncached input pricing of $0.30 and output pricing of $1.20 per million tokens
([official pricing](https://developers.cloudflare.com/workers-ai/models/deepseek-v4.1-flash-1017/)).
Applying the manifest succeeded; this proves provisioning, not model execution
or full research acceptance. These allowances apply only to the acceptance
workspace, not automatically to every staging user.
