import "server-only";

import { requirePrincipal } from "@/auth/server";
import type { Principal } from "@/contracts/workspace";

/** One context per HTTP request, shared by all procedures in its batch. */
export function createTRPCContext(
  request: Request,
  authenticate: () => Promise<Principal> = requirePrincipal,
) {
  let principal: Promise<Principal> | undefined;
  return {
    request,
    getPrincipal: () => (principal ??= Promise.resolve().then(authenticate)),
  };
}

export type TRPCContext = ReturnType<typeof createTRPCContext>;
