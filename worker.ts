import handler from "./.open-next/worker.js";
import { instrumentWorker } from "./src/telemetry/worker";
import { dispatchRecordingOutbox } from "./recording-workflow";
import { dispatchSummaryOutbox } from "./src/ai/summary";
export { RecordingProcessingWorkflow } from "./recording-workflow";
export { SummaryAgent, SummaryWorkflow } from "./src/ai/summary";

// One Workers-native telemetry provider wraps the actual OpenNext request
// lifecycle. Next's Node development server deliberately does not register it.
export default instrumentWorker<CloudflareEnv>({
  ...handler,
  async scheduled(_event, env) {
    await Promise.all([dispatchRecordingOutbox(env), dispatchSummaryOutbox(env)]);
  },
});
