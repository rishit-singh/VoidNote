import "server-only";

export class AuthError extends Error {
  constructor(
    public readonly code:
      "unauthorized" | "auth_not_configured" | "auth_unavailable" | "forbidden" | "invalid_request",
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export const AUTH_COOKIE_NAME = "voidnote-auth";

export function getAuthConfig() {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  const appUrl = process.env.APP_URL?.trim();
  const missing = () => new AuthError("auth_not_configured", "Sign-in is not configured yet.", 503);
  if (!supabaseUrl || !publishableKey || !appUrl) throw missing();

  try {
    const app = new URL(appUrl);
    const supabase = new URL(supabaseUrl);
    for (const url of [app, supabase]) {
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw missing();
      if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw missing();
      }
    }
    return { supabaseUrl: supabase.origin, publishableKey, appOrigin: app.origin };
  } catch {
    throw missing();
  }
}

export function requireSameOrigin(request: Request, appOrigin: string) {
  // Fail closed for absent/null Origin too; these endpoints are browser POSTs.
  if (
    request.headers.get("origin") !== appOrigin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new AuthError("forbidden", "Request not allowed.", 403);
  }
}
