import "server-only";

import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { AuthError } from "@/auth/server";
import { WorkspaceError } from "@/contracts/workspace";
import type { TRPCContext } from "./context";
import { notifyApplicationEvents } from "@/server/activity";
import { traceOperation } from "@/telemetry/operations";

function domainError(error: unknown): TRPCError {
  const cause = error instanceof TRPCError ? error.cause : error;
  if (cause instanceof WorkspaceError) {
    const code = {
      forbidden: "FORBIDDEN",
      not_found: "NOT_FOUND",
      conflict: "CONFLICT",
      command_reused: "CONFLICT",
      invalid_cursor: "BAD_REQUEST",
      service_unavailable: "SERVICE_UNAVAILABLE",
    } as const;
    return new TRPCError({ code: code[cause.code], message: cause.message, cause });
  }
  if (cause instanceof AuthError) {
    const code =
      cause.status === 401
        ? "UNAUTHORIZED"
        : cause.status === 403
          ? "FORBIDDEN"
          : cause.status === 503
            ? "SERVICE_UNAVAILABLE"
            : "BAD_REQUEST";
    return new TRPCError({ code, message: cause.message, cause });
  }
  if (error instanceof TRPCError) return error;
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: error });
}

const t = initTRPC.context<TRPCContext>().create({
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    const domain = cause instanceof WorkspaceError || cause instanceof AuthError;
    return {
      ...shape,
      message:
        error.code === "INTERNAL_SERVER_ERROR"
          ? "The request could not be completed. Please retry."
          : cause instanceof z.ZodError
            ? "Invalid request fields."
            : shape.message,
      data: {
        code: shape.data.code,
        httpStatus: shape.data.httpStatus,
        path: shape.data.path,
        domainCode: domain
          ? cause.code
          : error.code === "INTERNAL_SERVER_ERROR"
            ? "internal_error"
            : "invalid_request",
        currentRevision: cause instanceof WorkspaceError ? cause.currentRevision : undefined,
        affectedTargets: cause instanceof WorkspaceError ? cause.affectedTargets : undefined,
      },
    };
  },
});

export const router = t.router;
export const authenticatedProcedure = t.procedure.use(({ ctx, type, path, next }) =>
  traceOperation(`trpc.${path}`, async () => {
    try {
      if (type === "mutation") {
        const origin = ctx.request.headers.get("origin");
        if (
          (origin && origin !== new URL(ctx.request.url).origin) ||
          ctx.request.headers.get("sec-fetch-site") === "cross-site"
        ) {
          throw new AuthError("forbidden", "Cross-origin writes are not allowed.", 403);
        }
      }
      const principal = await ctx.getPrincipal();
      const result = await next({ ctx: { principal } });
      if (!result.ok) throw result.error;
      if (type === "mutation" && !path.startsWith("activity.")) notifyApplicationEvents();
      return result;
    } catch (error) {
      throw domainError(error);
    }
  }),
);
