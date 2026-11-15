import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { build } from "esbuild";
import type { CookieOptions } from "@supabase/ssr";

type AuthModule = typeof import("../../src/auth/server.ts") & {
  signIn: typeof import("../../src/app/api/auth/sign-in/route.ts").POST;
  signOut: typeof import("../../src/app/api/auth/sign-out/route.ts").POST;
  callback: typeof import("../../src/app/auth/callback/route.ts").GET;
};

const appOrigin = "https://voidnote.test";
const supabaseOrigin = "https://auth.example.test";
const user = {
  id: "d0512bb8-a3a6-4114-a12e-113c17035db6",
  email: "person@example.test",
  aud: "authenticated",
  role: "authenticated",
  created_at: "2026-01-01T00:00:00.000Z",
};
const configuredEnv = {
  SUPABASE_URL: supabaseOrigin,
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_auth_test",
  APP_URL: appOrigin,
};
const envKeys = Object.keys(configuredEnv);
const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const jar = new Map<string, string>();
const writes: { name: string; value: string; options: CookieOptions }[] = [];
const requests: Request[] = [];
let respond: (request: Request) => Response | Promise<Response>;
let auth: AuthModule;

const cookieStore = {
  getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  set(name: string, value: string, options: CookieOptions) {
    writes.push({ name, value, options });
    if (options.maxAge === 0) jar.delete(name);
    else jar.set(name, value);
  },
};

function post(path: string, body: unknown = {}, origin: string | null = appOrigin) {
  return new Request(`${appOrigin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin === null ? {} : { Origin: origin }) },
    body: JSON.stringify(body),
  });
}

function session() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  // Deliberately unsigned: only the intercepted Auth server may vouch for identity.
  const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, exp: expiresAt })}.forged`;
  return {
    access_token: token,
    refresh_token: "test-refresh-token",
    expires_at: expiresAt,
    expires_in: 3600,
    token_type: "bearer",
    user,
  };
}

function seedUntrustedSession() {
  jar.set(
    "voidnote-auth",
    `base64-${Buffer.from(JSON.stringify(session())).toString("base64url")}`,
  );
}

function assertPrivate(response: Response) {
  assert.match(response.headers.get("cache-control") ?? "", /private/);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
}

void describe("Supabase SSR auth boundary", { concurrency: false }, () => {
  before(async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    // Bundle application aliases only. Both Supabase packages are real dependencies.
    // Next's request-scoped cookies and server-only marker are the integration boundary.
    const result = await build({
      stdin: {
        resolveDir: root,
        contents: `
          export * from './src/auth/server';
          export { POST as signIn } from './src/app/api/auth/sign-in/route';
          export { POST as signOut } from './src/app/api/auth/sign-out/route';
          export { GET as callback } from './src/app/auth/callback/route';
        `,
      },
      tsconfig: `${root}tsconfig.json`,
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      packages: "external",
    });
    const output = result.outputFiles[0];
    assert.ok(output);
    const bundledModule: { exports: unknown } = { exports: {} };
    const require = createRequire(import.meta.url);
    const load = (name: string): unknown => {
      if (name === "server-only") return {};
      if (name === "next/headers") return { cookies: () => Promise.resolve(cookieStore) };
      return require(name) as unknown;
    };
    const evaluate = compileFunction(output.text, ["module", "exports", "require"]) as (
      module: { exports: unknown },
      exports: unknown,
      require: (name: string) => unknown,
    ) => void;
    evaluate(bundledModule, bundledModule.exports, load);
    auth = bundledModule.exports as AuthModule;
  });

  beforeEach(() => {
    Object.assign(process.env, configuredEnv);
    jar.clear();
    writes.length = 0;
    requests.length = 0;
    respond = () => {
      throw new Error("Unexpected upstream request");
    };
    // Never fall through to real networking, even for an unexpected URL.
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(new URL(request.url).origin, supabaseOrigin);
      requests.push(request);
      return respond(request);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  void it("verifies the cookie identity, rejects forged sessions, and distinguishes transport outages", async (context) => {
    seedUntrustedSession();
    respond = (request) => {
      assert.equal(new URL(request.url).pathname, "/auth/v1/user");
      assert.equal(request.method, "GET");
      assert.match(request.headers.get("authorization") ?? "", /^Bearer .+\.forged$/);
      return Response.json({ message: "Invalid JWT", code: "bad_jwt" }, { status: 401 });
    };
    await assert.rejects(
      auth.requirePrincipal(),
      (error: unknown) =>
        error instanceof auth.AuthError && error.status === 401 && error.code === "unauthorized",
    );
    assert.equal(requests.length, 1, "identity must be checked with the Auth server");

    seedUntrustedSession();
    respond = () => Response.json({ ...user, email: "verified@example.test" });
    assert.deepEqual(await auth.requirePrincipal(), {
      id: user.id,
      email: "verified@example.test",
    });
    assert.equal(
      requests.length,
      2,
      "principal comes from a fresh verified user, not cookie user data",
    );

    const savedCookies = [...jar];
    respond = () => {
      throw new TypeError("fetch failed: private upstream detail");
    };
    // The actual SDK logs transport exceptions before returning AuthRetryableFetchError.
    context.mock.method(console, "error", () => {});
    await assert.rejects(auth.requirePrincipal(), (error: unknown) => {
      assert.ok(error instanceof auth.AuthError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "auth_unavailable");
      assert.equal(error.message, "Sign-in is temporarily unavailable.");
      return true;
    });
    assert.equal(requests.length, 3);
    assert.deepEqual([...jar], savedCookies, "a temporary outage must not discard the session");
  });

  void it("fails closed when any required configuration is missing, even with session cookies", async () => {
    seedUntrustedSession();
    for (const key of envKeys) {
      const value = process.env[key];
      delete process.env[key];
      await assert.rejects(
        auth.requirePrincipal(),
        (error: unknown) =>
          error instanceof auth.AuthError &&
          error.status === 503 &&
          error.code === "auth_not_configured",
      );
      const response = await auth.signIn(post("/api/auth/sign-in", { email: user.email }));
      assert.equal(response.status, 503);
      assertPrivate(response);
      assert.deepEqual(await response.json(), {
        error: "auth_not_configured",
        message: "Sign-in is not configured yet.",
      });
      if (value !== undefined) process.env[key] = value;
    }
    assert.equal(requests.length, 0);
    assert.equal(writes.length, 0);
  });

  void it("requires same-origin sign-in, persists PKCE cookies, and ignores callback redirect inputs", async () => {
    for (const origin of ["https://evil.test", "null", null]) {
      const response = await auth.signIn(post("/api/auth/sign-in", { email: user.email }, origin));
      assert.equal(response.status, 403);
      assertPrivate(response);
    }
    assert.equal(requests.length, 0);
    assert.equal(writes.length, 0);

    respond = async (request) => {
      const url = new URL(request.url);
      assert.equal(url.pathname, "/auth/v1/otp");
      assert.equal(request.method, "POST");
      assert.equal(url.searchParams.get("redirect_to"), `${appOrigin}/auth/callback`);
      const body = (await request.json()) as Record<string, unknown>;
      assert.equal(body.email, user.email);
      assert.equal(body.code_challenge_method, "s256");
      assert.equal(typeof body.code_challenge, "string");
      assert.ok(body.code_challenge);
      return Response.json({});
    };
    const sent = await auth.signIn(post("/api/auth/sign-in", { email: user.email }));
    assert.equal(sent.status, 200);
    assertPrivate(sent);
    assert.ok([...jar.keys()].some((name) => name.includes("code-verifier")));

    respond = async (request) => {
      const url = new URL(request.url);
      assert.equal(url.pathname, "/auth/v1/token");
      assert.equal(url.searchParams.get("grant_type"), "pkce");
      const body = (await request.json()) as Record<string, unknown>;
      assert.equal(body.auth_code, "valid-code");
      assert.ok(body.code_verifier, "exchange must use the persisted verifier cookie");
      return Response.json(session());
    };
    const callback = await auth.callback(
      new Request(
        "https://poisoned-host.test/auth/callback?code=valid-code&next=https://evil.test&redirectTo=//evil.test",
      ),
    );
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), `${appOrigin}/`);
    assertPrivate(callback);
    assert.ok(jar.has("voidnote-auth"));
    assert.ok(
      writes.every(
        ({ options }) => options.httpOnly && options.secure && options.sameSite === "lax",
      ),
    );

    const failed = await auth.callback(
      new Request(
        "https://poisoned-host.test/auth/callback?error=upstream-secret&next=//evil.test",
      ),
    );
    assert.equal(failed.headers.get("location"), `${appOrigin}/auth/error`);
    assert.equal(await failed.text(), "");
    assert.equal(requests.length, 2);
  });

  void it("clears local auth cookies after upstream sign-out failure but rejects cross-origin sign-out", async () => {
    seedUntrustedSession();
    jar.set("voidnote-auth-code-verifier", "test-verifier");
    jar.set("unrelated-cookie", "keep");
    const rejected = await auth.signOut(post("/api/auth/sign-out", {}, "https://evil.test"));
    assert.equal(rejected.status, 403);
    assert.ok(jar.has("voidnote-auth"));
    assert.equal(requests.length, 0);

    respond = () => Response.json({ message: "upstream-secret" }, { status: 503 });
    const response = await auth.signOut(post("/api/auth/sign-out"));
    assert.equal(response.status, 200);
    assertPrivate(response);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(requests.length, 1, "exercise an actual upstream sign-out failure");
    const upstream = requests[0];
    assert.ok(upstream);
    // Assert outside fetch: sign-out intentionally catches upstream exceptions.
    assert.equal(upstream.method, "POST");
    assert.equal(new URL(upstream.url).pathname, "/auth/v1/logout");
    assert.equal(new URL(upstream.url).searchParams.get("scope"), "local");
    assert.deepEqual([...jar], [["unrelated-cookie", "keep"]]);
    assert.ok(writes.some(({ name, options }) => name === "voidnote-auth" && options.maxAge === 0));
    assert.ok(
      writes.some(
        ({ name, options }) => name === "voidnote-auth-code-verifier" && options.maxAge === 0,
      ),
    );
  });
});
