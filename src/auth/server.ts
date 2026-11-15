import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Principal } from "@/contracts/workspace";
import { AUTH_COOKIE_NAME, AuthError, getAuthConfig } from "./config";

export { AuthError } from "./config";

/** Route handlers only: refreshes must be allowed to write response cookies.
 * Callers must send Cache-Control: private, no-store, including on errors.
 */
export async function createAuthClient() {
  const config = getAuthConfig();
  const cookieStore = await cookies();
  return createServerClient(config.supabaseUrl, config.publishableKey, {
    cookieOptions: {
      name: AUTH_COOKIE_NAME,
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure: config.appOrigin.startsWith("https:"),
    },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (values) => {
        // Do not swallow write failures: no proxy exists to refresh for us.
        for (const { name, value, options } of values) cookieStore.set(name, value, options);
      },
    },
  });
}

export async function getPrincipal(): Promise<Principal | null> {
  const client = await createAuthClient();
  try {
    // getSession() reads untrusted cookies; only the verified user is our principal.
    const { data, error } = await client.auth.getUser();
    if (error) {
      if (error.name === "AuthRetryableFetchError" || (error.status && error.status >= 500)) {
        throw new AuthError("auth_unavailable", "Sign-in is temporarily unavailable.", 503);
      }
      return null;
    }
    if (!data.user || data.user.is_anonymous) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("auth_unavailable", "Sign-in is temporarily unavailable.", 503);
  }
}

export async function requirePrincipal(): Promise<Principal> {
  const principal = await getPrincipal();
  if (!principal) throw new AuthError("unauthorized", "Sign in to continue.", 401);
  return principal;
}

/** Clear this app's cookies even when the upstream sign-out service is unavailable. */
export async function clearAuthCookies() {
  const cookieStore = await cookies();
  for (const { name } of cookieStore.getAll()) {
    if (
      name === AUTH_COOKIE_NAME ||
      name.startsWith(`${AUTH_COOKIE_NAME}.`) ||
      name.startsWith(`${AUTH_COOKIE_NAME}-`)
    ) {
      cookieStore.set(name, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax" });
    }
  }
}
