import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { workflowParamsSchema, type ProcessingParams } from "./src/contracts/recording-processing";
import { withRecordingDatabase } from "./src/server/recording-database";
import { ProviderRequestError, pyannote, boundedJSON } from "./src/server/pyannote";
import { signedRecordingURL } from "./src/server/recording-capability";
import { WorkspaceError } from "./src/contracts/workspace";

export async function dispatchRecordingOutbox(env: CloudflareEnv) {
  const pending = await withRecordingDatabase(env.HYPERDRIVE.connectionString, (repo) =>
    repo.pendingDispatch(),
  );
  if (!pending.length) return;
  const result = await env.PROCESS_RECORDING.createBatch({
    instances: pending.map((params) => ({ id: params.runId, params })),
  });
  const accepted = new Set(result.created.map((instance) => instance.id));
  for (const error of result.errors) if (error.code === 10405 && error.id) accepted.add(error.id);
  for (const item of pending)
    if (accepted.has(item.runId))
      await withRecordingDatabase(env.HYPERDRIVE.connectionString, (repo) =>
        repo.dispatched(item.workspaceId, item.runId),
      );
}

export class RecordingProcessingWorkflow extends WorkflowEntrypoint<
  CloudflareEnv,
  ProcessingParams
> {
  async run(event: WorkflowEvent<ProcessingParams>, step: WorkflowStep) {
    const { workspaceId, runId } = workflowParamsSchema.parse(event.payload);
    const database = <T>(work: Parameters<typeof withRecordingDatabase<T>>[1]) =>
      withRecordingDatabase(this.env.HYPERDRIVE.connectionString, work);
    try {
      const submission = await step.do(
        "submit once",
        { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
        async () => {
          // This database marker survives an isolate/step crash before we know the
          // job ID. A repeated execution never repeats the paid POST.
          const state = await database((repo) => repo.claimSubmission(workspaceId, runId));
          if (state.run.status === "succeeded") return "succeeded";
          if (!state.submit) {
            if (state.run.providerJobId) return "submitted";
            if (state.run.status === "failed" || state.run.status === "blocked") return "failed";
            await database((repo) =>
              repo.status(
                workspaceId,
                runId,
                "submission_unknown",
                "Awaiting a provider callback. The paid request will not be repeated.",
              ),
            );
            return "submission_unknown";
          }
          const path = `/api/recording-media/${workspaceId}/${state.recording.noteId}/${state.recording.id}`;
          const audioUrl = signedRecordingURL(
            this.env.APP_URL,
            path,
            this.env.RECORDING_CAPABILITY_SECRET,
            60 * 60,
          );
          const callback = signedRecordingURL(
            this.env.APP_URL,
            `/api/processing-callback/${workspaceId}/${runId}`,
            this.env.RECORDING_CAPABILITY_SECRET,
            24 * 60 * 60,
          );
          try {
            const result = await pyannote(this.env.PYANNOTE_API_KEY).submit(audioUrl, callback);
            await database((repo) => repo.bindJob(workspaceId, runId, result.jobId));
            return "submitted";
          } catch (error) {
            const status =
              error instanceof ProviderRequestError && !error.ambiguous
                ? "failed"
                : "submission_unknown";
            await database((repo) =>
              repo.status(
                workspaceId,
                runId,
                status,
                status === "failed"
                  ? "Provider rejected the request. Source audio is retained."
                  : "Submission outcome is unknown. Awaiting the provider callback; no automatic resubmission.",
              ),
            );
            return status;
          }
        },
      );
      if (submission === "failed" || submission === "succeeded") return { status: submission };
      for (let attempt = 0; attempt < 360; attempt++) {
        const result = await step.do(
          `observe ${attempt}`,
          {
            retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
            timeout: "2 minutes",
          },
          async () => {
            const state = await database((repo) => repo.execution(workspaceId, runId));
            if (state.run.status === "succeeded") return "succeeded";
            if (!state.run.providerJobId) return "submission_unknown";
            const provider = pyannote(this.env.PYANNOTE_API_KEY);
            const result = await provider.getState(state.run.providerJobId);
            if (result.status === "failed" || result.status === "canceled") {
              await database((repo) =>
                repo.status(
                  workspaceId,
                  runId,
                  "failed",
                  "Provider job failed or was canceled. Source audio is retained.",
                ),
              );
              return "failed";
            }
            if (result.status !== "succeeded") {
              await database((repo) => repo.status(workspaceId, runId, "running"));
              return "running";
            }
            const rawKey = `${workspaceId}/processing/${runId}/provider-result.json`;
            await this.env.RECORDING_ARTIFACTS.put(rawKey, result.raw, {
              httpMetadata: { contentType: "application/json" },
            });
            // Only an R2 reference leaves the step, not the potentially large result.
            return rawKey;
          },
        );
        if (result === "failed" || result === "succeeded") return { status: result };
        if (result !== "running" && result !== "submission_unknown") {
          await step.do("publish transcript", async () => {
            const state = await database((repo) => repo.execution(workspaceId, runId));
            if (!state.run.providerJobId) throw new Error("Provider job identity is missing.");
            const object = await this.env.RECORDING_ARTIFACTS.get(result);
            if (!object) throw new Error("Stored provider output is unavailable.");
            const raw = await boundedJSON(new Response(object.body));
            const turns = pyannote(this.env.PYANNOTE_API_KEY).getResult(
              raw.data,
              state.run.providerJobId,
            );
            await database((repo) => repo.publish(workspaceId, runId, result, turns));
          });
          return { status: "succeeded" };
        }
        await step.sleep(`wait ${attempt}`, "30 seconds");
      }
      await step.do("record polling deadline", async () => {
        const state = await database((repo) => repo.execution(workspaceId, runId));
        await database((repo) =>
          repo.status(
            workspaceId,
            runId,
            state.run.providerJobId ? "failed" : "submission_unknown",
            "Processing observation reached its deadline. Retry status to resume; audio remains saved.",
          ),
        );
      });
      return { status: "deadline" };
    } catch (error) {
      await step.do("record failure", async () => {
        if (
          error instanceof WorkspaceError &&
          (error.code === "forbidden" || error.code === "not_found")
        ) {
          await database((repo) =>
            repo.status(
              workspaceId,
              runId,
              "blocked",
              "The recording, note, or submitting account is no longer authorized.",
            ),
          );
          return;
        }
        const state = await database((repo) => repo.execution(workspaceId, runId));
        const status = state.run.providerJobId
          ? "failed"
          : state.run.status === "queued"
            ? "queued"
            : "submission_unknown";
        await database((repo) =>
          repo.status(
            workspaceId,
            runId,
            status,
            "Processing was interrupted. Retry status safely; the paid submission is never repeated.",
          ),
        );
      });
      throw new Error("Recording processing could not complete.");
    }
  }
}
