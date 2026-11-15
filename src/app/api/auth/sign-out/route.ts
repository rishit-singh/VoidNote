import { getAuthConfig, requireSameOrigin } from "@/auth/config";
import { authFailure, authResponseHeaders } from "@/auth/http";
import { clearAuthCookies, createAuthClient } from "@/auth/server";

export async function POST(request: Request) {
  try {
    const config = getAuthConfig();
    requireSameOrigin(request, config.appOrigin);
    try {
      const client = await createAuthClient();
      await client.auth.signOut({ scope: "local" });
    } catch {
      // Local sign-out still succeeds during an upstream outage.
    } finally {
      await clearAuthCookies();
    }
    return Response.json({ ok: true }, { headers: authResponseHeaders });
  } catch (error) {
    return authFailure(error);
  }
}
