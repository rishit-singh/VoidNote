# Google and GitHub sign-in

Implementation is on `feat/oauth-sign-in`, updated onto released main `825113b`.
Google is enabled in Supabase (verified 2026-11-16); real-provider acceptance is
pending. The user authorized a Google-first release and live test. GitHub remains
disabled and its button is hidden. Apple is deferred until an Apple Developer
account is available. Email sign-in remains supported.

## Application boundary

- `POST /api/auth/sign-in` accepts either `{ email }` or `{ provider }`, where the
  only accepted providers are `google` and `github`. Mixed inputs, extra redirect
  fields and unknown providers are rejected. Existing same-origin, JSON-body size
  limits and private/no-store responses apply to both methods.
- OAuth initiation uses the existing server Supabase client to persist its PKCE
  verifier in HTTP-only cookies. The response contains the Supabase authorization
  URL; the browser navigates there. It does not own a separate Supabase session.
- Both methods pin their return URL to configured `APP_URL` + `/auth/callback`.
  The callback exchanges the code and redirects only to `/` or `/auth/error`.
  Provider cancellation and failures use generic text; provider messages and tokens
  are not copied into the error page.
- The shared sign-in component exposes Google and email in both landing and
  workspace entry points. Competing methods are disabled during initiation, with
  retryable feedback on request failure. The landing dialog cannot be dismissed
  during initiation. Unmounted requests are aborted and cannot navigate later;
  restored pages clear provider handoff state on persisted `pageshow` events.

## Provider setup

Provider credentials belong in Supabase Auth, not browser code or Worker secrets.
The local environment inspection found Supabase configuration but no Google/GitHub
OAuth credential variables. The latest read-only Supabase settings check reports
Google and email enabled, GitHub disabled.

### Google

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) in
   the Google Cloud project that will own VoidNote.
2. Configure branding, support/developer contact and the intended audience. While
   the app is in testing, add the Google accounts that will perform acceptance as
   test users. Public use requires the appropriate publishing/verification steps
   shown in that project's console.
3. Create an OAuth client of type **Web application**. Set its authorized redirect
   URI to the Supabase callback below. This server redirect flow does not require
   Google's One Tap or browser SDK.
4. Save the client ID and secret in Supabase's Google provider settings and enable
   it. Keep default identity scopes; no Google API access is needed by VoidNote.

### GitHub

1. [Register an OAuth App](https://github.com/settings/applications/new) under the
   intended user/organization owner.
2. Name it **VoidNote**. Set Homepage URL to
   `https://voidnote.app` and Authorization callback
   URL to the Supabase callback below.
3. Generate a client secret. Save the client ID and secret in Supabase's GitHub
   provider settings and enable it. No repository access is requested by this app.

### Redirects

Use this provider callback for **both** Google and GitHub:

```text
https://rbacdtsvrogopijybsep.supabase.co/auth/v1/callback
```

In [Supabase Auth URL configuration](https://supabase.com/dashboard/project/rbacdtsvrogopijybsep/auth/url-configuration),
set Site URL to `https://voidnote.app` and permit
this exact application return URL:

```text
https://voidnote.app/auth/callback
```

For real local-provider testing, add the exact local `/auth/callback` URL and set
local `APP_URL` to that same browser origin. `localhost` and `127.0.0.1` are distinct
origins; begin and finish sign-in in the same browser. Automated browser fixtures
use mocked authorization responses and do not require provider secrets.

## Acceptance and delivery

Release Google first through the normal checked PR/main CI delivery process.
GitHub's route support and auth-boundary tests remain ready for later activation;
its button stays hidden until provider setup is complete.

A pre-release probe on 2026-11-16 showed same-origin auth on `voidnote.app` returning
403 while the Workers host accepted the origin and returned the expected 400 for
an empty input. Production `APP_URL` still named the Workers host. This release
sets it to `https://voidnote.app`, which owns the callback and session cookies.

Verify each real provider: successful consent/code exchange, cancellation, reload,
verified session and logout. Also test an existing email account with the same
verified email and GitHub accounts with private email; confirm the original
workspace identity is retained where Supabase links identities. Do not infer
account-linking behavior from matching display names or mocked tests.

The auth-boundary tests use the actual Supabase SDK with intercepted HTTP and
request-scoped cookie adapters. Browser coverage exercises UI handoff and errors
with mocked provider responses. Neither establishes production provider setup or
real account-linking acceptance.

Initial local verification: 22 auth/RPC tests, all seven TypeScript targets,
repository formatting and zero-warning ESLint passed. Independent review identified
Back-cache and dialog-dismissal ownership issues; the lifecycle handling above
addresses them. Browser tests cover pending dialog locking and Back/retry.

The earlier disk/browser-access blockers are resolved. The integrated Google-first
Worker build, all seven TypeScript targets, zero-warning ESLint, formatting,
22 auth/RPC tests and all six built-Worker landing browser tests passed. Independent
release review found no source-level blockers. Browser provider handoff is mocked;
Back coverage permits either BFCache restoration or full reload. Authenticated
Google acceptance remains pending a real account login after CI delivery.

The canonical domain change deliberately rejects Workers-host auth POSTs. Existing
Workers-host cookies do not transfer; users sign in again on `voidnote.app`. The
CI Workers-host health smoke remains valid but does not prove canonical-domain auth.
