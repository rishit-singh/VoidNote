import { z } from "zod";

const connectorPolicySchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string().trim().min(1).optional(),
  slackAuthConfigId: z.string().trim().min(1).optional(),
  slackToolVersion: z
    .string()
    .trim()
    .regex(/^\d{8}_\d{2}$/)
    .optional(),
  serviceBudgetId: z.string().trim().min(1).optional(),
  operationUnitBound: z.number().int().min(1).max(100).optional(),
  timeoutMs: z.number().int().min(1000).max(30_000).default(15_000),
});

export type ConnectorPolicy = z.infer<typeof connectorPolicySchema>;

export type ConnectorEnvironment = {
  APP_URL?: string;
  COMPOSIO_ENABLED?: string;
  COMPOSIO_API_KEY?: string;
  COMPOSIO_SLACK_AUTH_CONFIG_ID?: string;
  COMPOSIO_SLACK_TOOL_VERSION?: string;
  COMPOSIO_SERVICE_BUDGET_ID?: string;
  COMPOSIO_OPERATION_UNIT_BOUND?: string;
};

export function readConnectorPolicy(env: ConnectorEnvironment): ConnectorPolicy {
  const result = connectorPolicySchema.safeParse({
    enabled: env.COMPOSIO_ENABLED === "true",
    apiKey: env.COMPOSIO_API_KEY,
    slackAuthConfigId: env.COMPOSIO_SLACK_AUTH_CONFIG_ID,
    slackToolVersion: env.COMPOSIO_SLACK_TOOL_VERSION,
    serviceBudgetId: env.COMPOSIO_SERVICE_BUDGET_ID,
    operationUnitBound: env.COMPOSIO_OPERATION_UNIT_BOUND
      ? Number(env.COMPOSIO_OPERATION_UNIT_BOUND)
      : undefined,
  });

  if (!result.success) {
    return connectorPolicySchema.parse({});
  }

  return result.data;
}

export function isConnectorAvailable(policy: ConnectorPolicy): boolean {
  return (
    policy.enabled &&
    Boolean(policy.apiKey) &&
    Boolean(policy.slackAuthConfigId) &&
    Boolean(policy.slackToolVersion && policy.slackToolVersion !== "latest") &&
    Boolean(policy.serviceBudgetId) &&
    Boolean(policy.operationUnitBound)
  );
}
