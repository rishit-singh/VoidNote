import handler from "./.open-next/worker.js";
import { instrumentWorker } from "./src/telemetry/worker";
import { dispatchRecordingOutbox } from "./recording-workflow";
export { RecordingProcessingWorkflow } from "./recording-workflow";

// One Workers-native telemetry provider wraps the actual OpenNext request
// lifecycle. Next's Node development server deliberately does not register it.
export default instrumentWorker<CloudflareEnv>({
  ...handler,
  async scheduled(_event, env) {
    await dispatchRecordingOutbox(env);
  },
});
