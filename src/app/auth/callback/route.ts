import { getAuthConfig } from "@/auth/config";
import { authFailure, authResponseHeaders } from "@/auth/http";
import { createAuthClient } from "@/auth/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const config = getAuthConfig();
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    let authenticated = false;
    if (code && code.length <= 2048 && !url.searchParams.has("error")) {
      try {
        const client = await createAuthClient();
        const { error } = await client.auth.exchangeCodeForSession(code);
        authenticated = !error;
      } catch {
        // Codes, tokens and upstream messages never reach the error URL or response.
      }
    }
    // Fixed destinations on the configured origin; never trust Host, next or redirectTo.
    return new Response(null, {
      status: 303,
      headers: {
        ...authResponseHeaders,
        Location: new URL(authenticated ? "/" : "/auth/error", config.appOrigin).href,
      },
    });
  } catch (error) {
    return authFailure(error);
  }
}
