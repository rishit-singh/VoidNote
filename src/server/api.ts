import "server-only";

import { z } from "zod";
import { AuthError, requirePrincipal } from "@/auth/server";
import { idSchema, WorkspaceError, type Principal } from "@/contracts/workspace";
import { withDatabase } from "@/db/client";
import { createWorkspaceRepository } from "@/db/repository";

class RequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (
    (origin && origin !== new URL(request.url).origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new RequestError(403, "Cross-origin writes are not allowed.");
  }
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    throw new RequestError(415, "Expected application/json.");
  }
  const maxBytes = 2 * 1024 * 1024;
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "A JSON body is required.");
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestError(413, "Request is too large.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new RequestError(400, "Invalid JSON.");
  }
  return schema.parse(body);
}

export async function apiResponse(work: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await work(), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    let status = 500;
    let code = "internal_error";
    let message = "The request could not be completed. Please retry.";
    let currentRevision: number | undefined;
    let affectedTargets: string[] | undefined;
    if (error instanceof AuthError) {
      status = error.status;
      code = error.code;
      message = error.message;
    } else if (error instanceof WorkspaceError) {
      status = {
        forbidden: 403,
        not_found: 404,
        conflict: 409,
        command_reused: 409,
        invalid_cursor: 400,
      }[error.code];
      code = error.code;
      message = error.message;
      currentRevision = error.currentRevision;
      affectedTargets = error.affectedTargets;
    } else if (error instanceof z.ZodError) {
      status = 400;
      code = "invalid_request";
      message = "Invalid request fields.";
    } else if (error instanceof RequestError) {
      status = error.status;
      code = "invalid_request";
      message = error.message;
    }
    return Response.json(
      {
        error: message,
        code,
        ...(currentRevision === undefined ? {} : { currentRevision }),
        ...(affectedTargets === undefined ? {} : { affectedTargets }),
      },
      { status, headers: { "cache-control": "private, no-store" } },
    );
  }
}

export function workspaceResponse(
  request: Request,
  workspaceId: string,
  work: (
    repository: ReturnType<typeof createWorkspaceRepository>,
    principal: Principal,
    workspaceId: string,
  ) => Promise<unknown>,
) {
  return apiResponse(async () => {
    if (request.method !== "GET") requireSameOrigin(request);
    const principal = await requirePrincipal();
    idSchema.parse(workspaceId);
    return withDatabase((db) => work(createWorkspaceRepository(db), principal, workspaceId));
  });
}
