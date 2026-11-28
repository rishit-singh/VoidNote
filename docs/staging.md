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
Paid inference remains disabled until model, rates and allowance are configured.

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

Application migrations, application deployment and hosted acceptance are still
pending. Secret provisioning created a placeholder Worker; the target URL is not
yet evidence of a deployed application.

## Acceptance

A passing `/api/health` check establishes Worker reachability only. Hosted
acceptance must additionally exercise authentication, scoped database reads and
writes, research dispatch and completion, source reuse, cancellation, activity
delivery and telemetry. Real-provider quality and usage accounting are separate
from mocked browser and model tests.

The current local Playwright configuration starts a production-configured local
preview. It is not a hosted staging acceptance suite.
