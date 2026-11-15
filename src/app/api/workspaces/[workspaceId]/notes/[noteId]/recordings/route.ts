import { recordingInputSchema, recordingOverviewSchema } from "@/contracts/recording-processing";
import { recordingResponse } from "@/server/recording-api";
import { readJson } from "@/server/api";
type Context = { params: Promise<{ workspaceId: string; noteId: string }> };
export async function GET(request: Request, context: Context) {
  const { workspaceId, noteId } = await context.params;
  return recordingResponse(request, workspaceId, noteId, async (repo, principal) =>
    recordingOverviewSchema.parse(await repo.overview(principal, workspaceId, noteId)),
  );
}
export async function POST(request: Request, context: Context) {
  const { workspaceId, noteId } = await context.params;
  return recordingResponse(request, workspaceId, noteId, async (repo, principal) =>
    repo.initialize(principal, workspaceId, noteId, await readJson(request, recordingInputSchema)),
  );
}
