import { WorkspaceError } from "@/contracts/workspace";
import { recordingResponse, recordingEnvironment } from "@/server/recording-api";
type Context = { params: Promise<{ workspaceId: string; noteId: string; runId: string }> };
export async function POST(request: Request, context: Context) {
  const { workspaceId, noteId, runId } = await context.params;
  return recordingResponse(request, workspaceId, noteId, async (repo, principal) => {
    const { runs } = await repo.overview(principal, workspaceId, noteId);
    const run = runs.find((item) => item.id === runId);
    if (!run) throw new WorkspaceError("not_found", "Run not found.");
    const binding = recordingEnvironment().PROCESS_RECORDING;
    const result = await binding.createBatch({
      instances: [{ id: run.id, params: { workspaceId, runId } }],
    });
    if (result.errors.some((error) => error.code === 10405)) {
      const instance = await binding.get(runId);
      const state = await instance.status();
      if (
        state.status === "errored" ||
        state.status === "terminated" ||
        (state.status === "complete" && run.status !== "succeeded")
      )
        await instance.restart();
    } else if (!result.created.length) {
      throw new Error("Processing recovery could not be started. Please retry.");
    }
    return { ok: true };
  });
}
