import { personAppearancesSchema } from "@/contracts/transcript-corrections";
import { WorkspaceError } from "@/contracts/workspace";
import { transcriptCorrectionResponse } from "@/server/transcript-correction-api";

type Context = { params: Promise<{ workspaceId: string; collection: string; id: string }> };
export async function GET(request: Request, context: Context) {
  const { workspaceId, collection, id } = await context.params;
  return transcriptCorrectionResponse(request, workspaceId, async (repo, principal) => {
    if (collection !== "people")
      throw new WorkspaceError("not_found", "Collection is unavailable.");
    return personAppearancesSchema.parse(
      await repo.appearances(
        principal,
        workspaceId,
        id,
        new URL(request.url).searchParams.get("cursor") ?? undefined,
      ),
    );
  });
}
