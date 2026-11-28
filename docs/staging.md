# Development, staging and production

## Environment ownership

| Environment | Purpose                                                    | Data                                                                       |
| ----------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| Development | Local application development and isolated automated tests | Local data and disposable test databases                                   |
| Staging     | Hosted integration and real-provider acceptance            | Separate Supabase project, Hyperdrive, queue, bucket and runtime instances |
| Production  | Live application                                           | Existing production data                                                   |

Staging acceptance applies to a specific commit. Production promotion must use
that accepted code with production configuration and compatible migrations.
Staging test data must not replace production data.

## Staging delivery

`.github/workflows/staging.yml` runs for pushes to `staging/**` branches and
manual dispatches. New workflows become manually dispatchable once available
on the default branch; the staging branch push trigger supports initial delivery.

The workflow checks the selected commit, builds with `build:worker:staging`,
validates packaging, applies migrations to the staging database, deploys the
checked output, and records the commit, Worker version and health result.
Production delivery remains in `.github/workflows/ci.yml`.

The GitHub `staging` environment needs:

- `STAGING_DATABASE_URL` secret: a migration-capable connection to staging only.
- `STAGING_APP_URL` variable: the hosted staging URL.
- Cloudflare deployment credentials, inherited from repository secrets.

The Worker needs separate staging auth settings and secrets, a staging
Hyperdrive, and the bindings declared under `env.staging` in `wrangler.jsonc`.
Assistant and direct research inference are enabled for the synthetic acceptance
workspace with approved rates and allowances; see [admin operations](admin.md).

## Provisioning status

Created during setup:

- GitHub environment: `staging`.
- Queue: `voidnote-events-staging`.
- Private R2 bucket: `voidnote-recordings-staging`.
- Target URL variable: `https://voidnote-staging.rsrishitsingh.workers.dev`.
- Supabase project: `VoidNote-staging` (`csmrsgywdosnrcfmnmuj`).
- Auth site URL and `/auth/callback` redirect set to the staging hostname.
- Hyperdrive: `voidnote-staging` (`4e8f9846dda24e7ba951182735b25587`),
  with query caching disabled.
- GitHub staging database secret and Worker auth/recording capability secrets.

Application migrations through `0020` and deployment succeeded in
[CI run 46116957015](https://github.com/rishit-singh/VoidNote/actions/runs/46116957015).

- Deployed commit: `9cb2842`, CI run `46120515148`.
- Cloudflare version: `3add548d-ec7f-4bad-852b-5ae31fa69abb`.
- Hosted homepage and health endpoint return HTTP 200.
- Unauthenticated session requests return HTTP 401.
- Chromium renders the landing page and sign-in dialog.

Authenticated HTTP checks passed Supabase login, SSR session bootstrap, workspace
overview, note create/read/list/delete, legacy research listing and disabled
research admission. General research listing returned HTTP 500 because its route
forwarded workspace scope inside a strict filter DTO. The fix and a real-router
regression test passed the 49-test auth suite and have been deployed; hosted
reverification passed at 2026-11-28 06:37:33 UTC. Authenticated listing returns
HTTP 200 for all/active/finished and note-scoped filters. Unknown fields and
invalid statuses return HTTP 400. Session bootstrap remains HTTP 200, and
disabled research admission remains HTTP 409. Thread-scoped listing was not
exercised in this hosted check.

Google OAuth is not
configured for this separate Supabase project. The later `9cb2842` deployment
enabled assistant and direct research with $1/$3 allowances respectively from
the user's $5 total approval. The earlier HTTP 409 evidence above predates this
enablement. Discovery remains disabled without an application Firecrawl key;
$1 is reserved but unallocated. Logfire staging-only secrets are configured;
the secret update produced Worker version `7cf9565e-3afc-4125-b069-01507ba5b45a`
from application commit `9cb2842`. In `rishit-singh/dev`, synthetic trace
`8598bc875dc8ae32ab4bfd5d260f359f` and hosted health trace
`684a34bc8c9cb7ebbc9a01dd0905afaa` were confirmed with service `voidnote` and
environment `staging`.

Real browser authentication and note creation passed. The first paid assistant
research request failed acceptance: turn `04176cba-c7c9-4929-a149-23bb101dae43`
completed, but research dispatch returned uncertain and no research run was
persisted. The browser timed out awaiting a research task. Root-cause diagnosis
is in progress; report quality/reuse/recovery acceptance remains outstanding.
Deployment and health telemetry do not establish full research acceptance.

## Acceptance

A passing `/api/health` check establishes Worker reachability only. Hosted
acceptance must additionally exercise authentication, scoped database reads and
writes, research dispatch and completion, source reuse, cancellation, activity
delivery and telemetry. Real-provider quality and usage accounting are separate
from mocked browser and model tests.

The current local Playwright configuration starts a production-configured local
preview. It is not a hosted staging acceptance suite.
