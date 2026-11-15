import { TRPCClientError } from "@trpc/client";
import { z } from "zod";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly currentRevision?: number,
    public readonly affectedTargets: string[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const rpcErrorData = z.object({
  httpStatus: z.number().optional(),
  domainCode: z.string().nullish(),
  currentRevision: z.number().nullish(),
  affectedTargets: z.array(z.string()).nullish(),
});

export function asApiError(error: unknown): Error {
  if (error instanceof TRPCClientError) {
    const data = rpcErrorData.safeParse(error.data);
    if (data.success)
      return new ApiError(
        error.message,
        data.data.httpStatus ?? 500,
        data.data.domainCode ?? undefined,
        data.data.currentRevision ?? undefined,
        data.data.affectedTargets ?? [],
      );
  }
  return error instanceof Error ? error : new Error("The request could not be completed.");
}

export async function rpcCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw asApiError(error);
  }
}
