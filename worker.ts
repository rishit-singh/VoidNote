import handler from "./.open-next/worker.js";
import { instrumentWorker } from "./src/telemetry/worker";
import { traceOperation } from "./src/telemetry/operations";
import { dispatchRecordingOutbox } from "./recording-workflow";
import { dispatchSummaryOutbox } from "./src/ai/summary";
import { dispatchAssistantOutbox } from "./src/ai/assistant-runtime";
import { reconcileResearch } from "./src/ai/research";
import { reconcileResearchRuns } from "./src/ai/research/runs";
import { dispatchAssistantArtifacts } from "./src/ai/assistant-artifacts";
import { assistantOutputResponse } from "./src/ai/assistant-output";
import { reconcileConversationSummaries } from "./src/ai/conversation-summaries";
import { consumeEventDelivery, dispatchApplicationEvents } from "./src/events";
import { activityOutputResponse } from "./src/events/activity-output";
export { ActivityHub } from "./src/events/activity-hub";
export { RecordingProcessingWorkflow } from "./recording-workflow";
export { SummaryAgent, SummaryWorkflow } from "./src/ai/summary";
export { AssistantAgent } from "./src/ai/assistant-runtime";
export { ResearchAgent } from "./src/ai/research/agent-runtime";
export { ResearchWorkflow } from "./src/ai/research/workflow";
export { ResearchRunWorkflow } from "./src/ai/research/runs/workflow";
export { ConversationSummaryWorkflow } from "./src/ai/conversation-summaries";

// Generated JS inference varies before/after builds; use OpenNext's public
// Worker contract rather than its generated catch-all internal return types.
const applicationHandler: ExportedHandler<CloudflareEnv> = handler;

// One Workers-native telemetry provider wraps the actual OpenNext request
// lifecycle. Next's Node development server deliberately does not register it.
export default instrumentWorker<CloudflareEnv>({
  ...applicationHandler,
  async fetch(request, env, ctx) {
    return traceOperation("worker.fetch", async () => {
      if (new URL(request.url).pathname === "/api/activity/output") {
        return activityOutputResponse(request, env);
      }
      if (new URL(request.url).pathname === "/api/assistant/output") {
        return assistantOutputResponse(request, env, ctx);
      }

      if (!applicationHandler.fetch) {
        return new Response("Application handler unavailable.", { status: 503 });
      }

      return applicationHandler.fetch(request, env, ctx);
    });
  },
  async scheduled(_event, env) {
    await traceOperation("worker.scheduled", () =>
      Promise.all([
        dispatchApplicationEvents(env),
        dispatchRecordingOutbox(env),
        dispatchSummaryOutbox(env),
        dispatchAssistantOutbox(env),
        reconcileResearch(env),
        reconcileResearchRuns(env),
        dispatchAssistantArtifacts(env),
        reconcileConversationSummaries(env),
      ]),
    );
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await traceOperation("worker.queue.delivery", () =>
          consumeEventDelivery(env, message.body),
        );
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
});
