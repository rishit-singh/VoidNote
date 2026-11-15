import "server-only";

import { type AnyTRPCRouter, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { resolveResponse } from "@trpc/server/http";

import { RPC_BASE_PATH } from "@/config/api";

import { createTRPCContext, type TRPCContext } from "./context";

export const MAX_TRPC_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_TRPC_BATCH_SIZE = 10;
const MAX_URL_LENGTH = 64 * 1024;
const privateHeaders = { "cache-control": "private, no-store" };

async function boundedRequest(request: Request): Promise<Request> {
  if (request.url.length > MAX_URL_LENGTH) {
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Request URL is too large." });
  }

  if (!request.body) {
    return request;
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_TRPC_BODY_BYTES) {
    await request.body.cancel();
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Request is too large." });
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      size += value.byteLength;
      if (size > MAX_TRPC_BODY_BYTES) {
        await reader.cancel();
        throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Request is too large." });
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

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  });
}

/** The fetch adapter has a batch limit but no body limit, so bound bytes before parsing. */
export async function handleTRPCRequest(
  request: Request,
  router: AnyTRPCRouter,
  context: (request: Request) => TRPCContext = createTRPCContext,
) {
  try {
    const req = await boundedRequest(request);

    return await fetchRequestHandler({
      endpoint: RPC_BASE_PATH,
      req,
      router,
      maxBatchSize: MAX_TRPC_BATCH_SIZE,
      createContext: () => context(req),
      responseMeta: () => ({ headers: privateHeaders }),
    });
  } catch (cause) {
    const error =
      cause instanceof TRPCError
        ? cause
        : new TRPCError({ code: "BAD_REQUEST", message: "Could not read request.", cause });

    // Use the router's formatter even for transport rejections. No input parsing
    // or authentication is needed to report an oversized request.
    return resolveResponse({
      req: new Request(new URL(RPC_BASE_PATH, request.url)),
      path: "",
      router,
      error,
      createContext: () => Promise.resolve(context(request)),
      responseMeta: () => ({ headers: privateHeaders }),
    });
  }
}
