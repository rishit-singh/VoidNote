import { z } from "zod";

import { AuthError, getAuthConfig, requireSameOrigin } from "@/auth/config";
import { authFailure, authResponseHeaders } from "@/auth/http";
import { createAuthClient } from "@/auth/server";

const signInSchema = z.union([
  z.object({ email: z.string().trim().max(254).pipe(z.email()) }).strict(),
  z.object({ provider: z.enum(["google", "github"]) }).strict(),
]);

export async function POST(request: Request) {
  try {
    const config = getAuthConfig();
    requireSameOrigin(request, config.appOrigin);
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
      throw new AuthError("invalid_request", "Send an email address or provider as JSON.", 400);
    }
    // Bound the body before parsing, including requests without Content-Length.
    const reader = request.body?.getReader();
    if (!reader) throw new AuthError("invalid_request", "Choose a valid sign-in method.", 400);
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          throw new AuthError("invalid_request", "Request is too large.", 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new AuthError("invalid_request", "Choose a valid sign-in method.", 400);
    }
    const parsed = signInSchema.safeParse(input);
    if (!parsed.success) {
      throw new AuthError("invalid_request", "Choose a valid sign-in method.", 400);
    }

    const client = await createAuthClient();
    const redirectTo = new URL("/auth/callback", config.appOrigin).href;

    if ("provider" in parsed.data) {
      const { data, error } = await client.auth.signInWithOAuth({
        provider: parsed.data.provider,
        options: { redirectTo, skipBrowserRedirect: true },
      });

      if (error || !data.url) {
        throw new AuthError("auth_unavailable", "Unable to start sign-in. Try again shortly.", 503);
      }

      return Response.json({ url: data.url }, { headers: authResponseHeaders });
    }

    const { error } = await client.auth.signInWithOtp({
      email: parsed.data.email,
      options: { emailRedirectTo: redirectTo },
    });
    if (error)
      throw new AuthError(
        "auth_unavailable",
        "Unable to send a sign-in link. Try again shortly.",
        503,
      );
    return Response.json({ ok: true }, { headers: authResponseHeaders });
  } catch (error) {
    return authFailure(error);
  }
}
