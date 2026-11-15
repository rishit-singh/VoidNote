import "server-only";
import { requirePrincipal } from "../auth/server";
import { idSchema, type Principal } from "../contracts/workspace";
import { withDatabase } from "../db/client";
import { createTranscriptCorrectionRepository } from "../db/transcript-correction-repository";
import { apiResponse, requireSameOrigin } from "./api";

export function transcriptCorrectionResponse(
  request: Request,
  workspaceId: string,
  work: (
    repository: ReturnType<typeof createTranscriptCorrectionRepository>,
    principal: Principal,
  ) => Promise<unknown>,
) {
  return apiResponse(async () => {
    if (request.method !== "GET") requireSameOrigin(request);
    const principal = await requirePrincipal();
    idSchema.parse(workspaceId);
    return withDatabase((db) => work(createTranscriptCorrectionRepository(db), principal));
  });
}

export type CorrectionRouteContext = {
  params: Promise<{ workspaceId: string; noteId: string; runId: string }>;
};
