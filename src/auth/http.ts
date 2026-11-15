import "server-only";

import { AuthError } from "./config";

export const authResponseHeaders = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
  Expires: "0",
  "Referrer-Policy": "no-referrer",
};

export function authFailure(error: unknown) {
  if (error instanceof AuthError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status, headers: authResponseHeaders },
    );
  }
  return Response.json(
    { error: "auth_unavailable", message: "Sign-in is temporarily unavailable. Try again." },
    { status: 503, headers: authResponseHeaders },
  );
}
