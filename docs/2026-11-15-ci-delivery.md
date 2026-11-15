# CI-owned production delivery

CI delivery is published in [PR #5](https://github.com/rishit-singh/VoidNote/pull/5)
on `ci/production-delivery`. The integration branch reconciles main's divergent
prototype history with committed production foundation `7b3e653`; newer uncommitted
quality slices and concurrent landing work remain in the original worktree.
PR checks passed in run `43703732190`. PR #5 merged on 2026-11-15 at 10:26 UTC as
`143abb04ab037444fe5f37e186f10f88401b9fba`. Main-push run `43704065288` passed all
checks but failed before production upload. Follow-up PR #6 pins the deployment
command to `wrangler.jsonc` and merged as `de338cafa5e11a7d2ae983673e0c6a4404272db9`.
Its main run `43705043964` initially passed every check but Cloudflare denied service
access. After the user corrected the token, attempt 2 passed all checks, deployed
production version `cce2268b-c3c8-48e2-8a5e-971afa86f9b8` and passed the health smoke
test. CI-owned production delivery is active.

## Release path

- Pull requests run the existing formatting, lint, type, Worker/auth/database and
  built-Worker browser checks. Superseded PR jobs are cancelled.
- A push to `main` runs those checks, verifies that its SHA is still the remote
  main head, and deploys using the same checked OpenNext output and locked Wrangler.
- Main workflows use `queue: max` and do not cancel an in-progress release. The
  queue holds up to 100 pending runs. An older rerun cannot replace the latest
  pending release; stale commits skip deployment. Manual dispatch is checks-only
  and has a separate concurrency lane.
- Wrangler tags the version with the commit SHA. Its structured NDJSON output
  supplies the Cloudflare version ID rather than parsing terminal prose.
- The HTTP health probe checks successful JSON with `status: ok` and a request ID.
  The Actions summary and retained artifact record commit/version and deployment/
  smoke outcomes, including failures after a release attempt. Cancelled/timed-out
  runs may stop before evidence upload. A failed probe does not roll back automatically.

This is availability evidence, not authenticated database/provider acceptance or
proof that every edge has converged on the new version. Database migrations remain
an explicitly coordinated operation. Manual local deployment is a recovery exception.

## Credentials and activation

Initial GitHub checks found no repository Actions secrets or variables and no
environments. On 2026-11-15, the user supplied deployment credentials in the ignored
local `.env`; `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` were then configured
as repository Actions secrets. Secret-name/update metadata confirmed both entries;
the original token was active and the account ID matched the connected Cloudflare
account, but service access returned HTTP 403. The user supplied a corrected token;
a read-only service lookup succeeded, the Actions secret was updated, and the
subsequent CI deployment exercised its permissions successfully.

The user authorized merge and CI delivery. The Worker retains its existing application
secrets; build and test steps do not receive the deployment credentials.

## Local verification

- Current GitHub workflow JSON schema validation passed, including `queue: max`.
- Actionlint 1.7.12 passed with only its unsupported `concurrency.queue` diagnostic
  excluded. That key was independently verified against current GitHub documentation
  and SchemaStore; no other actionlint errors were suppressed.
- Six offline scenarios executed the actual workflow shell blocks with deployment
  and network commands stubbed: success, superseded main, missing credentials,
  deployment failure, HTTP smoke failure and invalid health JSON. Gates, recorded
  version IDs and failed-outcome evidence were checked.
- Scoped Prettier and `git diff --check` passed.
- Independent review caught pending-release displacement by older reruns/manual
  checks in GitHub's default single-pending queue. The explicit queued main lane and
  separate dispatch lane resolve that finding; re-review found no remaining blockers.

References: [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
[Cloudflare Actions setup](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/),
[Wrangler structured output](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/).

## Hosted integration

The first PR run passed formatting, lint and type checks, then exposed an Ubuntu
Miniflare/Undici `EPIPE` when the large-upload test returned an exact-replay response
without consuming the test request body. Commit `fe52524` drains unused fixture
transport bytes without buffering a whole part. Upload/replay/checksum assertions and
application runtime code are unchanged. Independent review found no behavior blockers.
The second run stopped at typed lint because extracting the transform into a variable
lost its contextual byte type. Commit `084d468` explicitly types the transform as
`Uint8Array`; focused ESLint, Worker-test TypeScript, formatting and diff checks pass
locally. Run `43690805618` confirmed these fixes on Linux and passed Worker,
PostgreSQL and auth tests plus production build/packaging. Its browser suite passed
56 cases, skipped one optional demo, and failed the large-upload case by matching a
temporary ready-to-process alert before upload began. Trace evidence identified the
timing race. Commit `5705c30` waits for the stored first part and injected network
error before reloading; checksum, part-count and no-reupload assertions remain.
Focused lint, browser-test types and formatting passed. Hosted PR run `43703732190`
passed the full check sequence, including the large-upload browser recovery case.

## Main deployment command correction

Run `43704065288` passed all checks, then Wrangler automatically delegated deployment
to OpenNext. That CLI handoff split the quoted release message into separate arguments
and failed before upload. PR #6 (`50ac0c6`) explicitly selects `wrangler.jsonc`, which
the locked Wrangler 4.162.0 implementation confirms bypasses framework delegation.
Workflow YAML parsing, shell syntax for all 15 run steps, scoped formatting and diff
checks pass. PR run `43704575478` passed and PR #6 merged. Main run `43705043964`
passed all checks and reached Cloudflare directly, confirming the command correction.
Cloudflare then rejected the service lookup with HTTP 403, "No access to the specified
service." No Worker upload occurred; delivery evidence was retained and health smoke
was skipped.

Read-only diagnostics confirmed the original token was active, the configured account
matched the connected account, and the same service request failed locally. The token
listed zero accessible accounts and could not inspect its own policy. The corrected
token resolved this blocker. No token values were printed.

## Successful production delivery

- Run: https://github.com/rishit-singh/VoidNote/actions/runs/43705043964 (attempt 2).
- Commit: `de338cafa5e11a7d2ae983673e0c6a4404272db9`.
- Cloudflare version: `cce2268b-c3c8-48e2-8a5e-971afa86f9b8`.
- All checks, deployment and health smoke passed.
- Downloaded delivery artifact `result.json` confirms both outcomes as `success`;
  `health.json` contains `status: ok` and request ID
  `20713b75-3396-4cc8-b72b-edd257b74a85`.
- Production: https://voidnote-production.rsrishitsingh.workers.dev.

This release contains the committed foundation and CI changes. Newer local quality
slices and concurrent landing work require their own delivery. Authenticated and
real-provider hosted acceptance remain separate outstanding checks.
