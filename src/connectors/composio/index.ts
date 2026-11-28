import type { ConnectorPolicy } from "../../config/connectors";
import { createComposioClient } from "./rest";

export function createConnectorClient(policy: ConnectorPolicy) {
  if (!policy.apiKey || !policy.slackToolVersion) {
    throw new Error("Composio REST configuration is incomplete.");
  }
  return createComposioClient({
    apiKey: policy.apiKey,
    toolVersion: policy.slackToolVersion,
    timeoutMs: policy.timeoutMs,
  });
}

export { SLACK_SEND_MESSAGE_TOOL } from "./rest";
export { ComposioHttpError } from "./rest";
export type { ComposioClient } from "./rest";
