# CI-owned production delivery

Normal delivery is PR → checks → merge to main → CI deployment. The existing
Next/Workers application was previously deployed from `feat/next-bun-foundation`,
while main still contained the older Vite prototype. This integration brings that
committed production foundation and the CI delivery workflow onto main.

The merge preserves both histories and retains main's independent Python experiment
as documented historical tooling. Superseded mock-authentication, local-blob note
components, browser inference integrations and prototype `src/pages` routes are
retired in favor of the already deployed application. Current dependencies, UI
tokens, capture ownership and logo artwork remain the production baseline.

## Release path

- Pull requests run formatting, lint, type, Worker/auth/database and built-Worker
  browser checks. Superseded PR jobs are cancelled.
- A successful push to main verifies that its SHA is still the remote main head,
  then deploys the same checked OpenNext output using locked Wrangler.
- Main runs use `queue: max` with no in-progress cancellation. Up to 100 runs can
  wait without an older rerun replacing the newest pending release. Stale commits
  skip deployment. Manual workflow dispatch runs checks in a separate lane.
- Wrangler tags the version with the commit SHA. Its structured NDJSON result
  supplies the Cloudflare version ID.
- `/api/health` checks HTTP availability and JSON status/request identity. Actions
  summaries and 30-day artifacts retain commit/version and deployment/smoke outcomes.
  Failures after an attempted release retain evidence, except cancellation/timeouts
  can prevent the final upload. A failed probe does not automatically roll back.

Health checks do not establish authenticated database/provider acceptance or prove
every edge has converged. Database migrations remain explicitly coordinated.
Manual local deployment is an authorized recovery exception.

## Credentials

On 2026-11-15, the user supplied credentials through the ignored local `.env`.
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` were configured as repository
Actions secrets and confirmed through secret-name/update metadata. Build/test steps
do not receive these deployment credentials. Existing Worker application secrets
are retained; local environment files are not copied into CI.

## Pre-merge verification

- Current GitHub workflow schema validation passed, including `queue: max`.
- Actionlint 1.7.12 passed with its unsupported `concurrency.queue` diagnostic
  excluded; the key was separately verified against current GitHub documentation
  and SchemaStore. No other diagnostics were suppressed.
- Six offline scenarios exercised actual workflow shell blocks with stubbed network
  and deployment commands: success, superseded main, missing credentials, deployment
  failure, HTTP smoke failure and invalid health JSON.
- Scoped formatting and diff checks passed. Independent review caught and resolved
  default-queue pending-release displacement; re-review found no remaining blockers.

The PR and subsequent main-push Actions runs provide hosted integration and delivery
evidence. Local simulations alone do not establish a successful production release.
