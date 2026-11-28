import assert from "node:assert/strict";
import test from "node:test";

import { readConnectorPolicy, isConnectorAvailable } from "../../src/config/connectors.ts";
import { createComposioClient } from "../../src/connectors/composio/rest.ts";

void test("connector stays disabled and unavailable without explicit configuration", () => {
  const policy = readConnectorPolicy({});
  assert.equal(policy.enabled, false);
  assert.equal(isConnectorAvailable(policy), false);
  assert.equal(
    isConnectorAvailable(
      readConnectorPolicy({
        COMPOSIO_ENABLED: "true",
        COMPOSIO_API_KEY: "test",
        COMPOSIO_SLACK_AUTH_CONFIG_ID: "auth",
        COMPOSIO_SLACK_TOOL_VERSION: "latest",
        COMPOSIO_SERVICE_BUDGET_ID: "00000000-0000-4000-8000-000000000001",
        COMPOSIO_OPERATION_UNIT_BOUND: "1",
      }),
    ),
    false,
  );
  const configured = readConnectorPolicy({
    COMPOSIO_ENABLED: "true",
    COMPOSIO_API_KEY: "test",
    COMPOSIO_SLACK_AUTH_CONFIG_ID: "auth",
    COMPOSIO_SLACK_TOOL_VERSION: "20261125_00",
    COMPOSIO_SERVICE_BUDGET_ID: "00000000-0000-4000-8000-000000000001",
    COMPOSIO_OPERATION_UNIT_BOUND: "1",
  });
  assert.equal(isConnectorAvailable(configured), true);
});

void test("link adapter sends only server-provided OAuth fields and hides secret header", async () => {
  let captured: Request | undefined;
  const client = createComposioClient({
    apiKey: "do-not-log",
    toolVersion: "slack-tool-version-fixture",
    fetch: (input, init) => {
      captured = new Request(input, init);
      return Promise.resolve(
        Response.json({
          connected_account_id: "ca_123",
          redirect_url: "https://connect.example/abc",
          expires_at: "2026-11-25T12:00:00.000Z",
        }),
      );
    },
  });
  const result = await client.createSlackLink({
    userId: "opaque-user",
    authConfigId: "ac_123",
    callbackUrl: "https://app.example/connect/slack/callback",
  });

  assert.equal(result.connectedAccountId, "ca_123");
  assert.equal(captured?.url, "https://backend.composio.dev/api/v3.1/connected_accounts/link");
  assert.equal(captured?.headers.get("x-api-key"), "do-not-log");
  assert.deepEqual(await captured?.json(), {
    auth_config_id: "ac_123",
    user_id: "opaque-user",
    callback_url: "https://app.example/connect/slack/callback",
    alias: "VoidNote Slack",
  });
});

void test("message adapter is fixed to Slack and a bounded markdown payload", async () => {
  let captured: Request | undefined;
  const client = createComposioClient({
    apiKey: "secret",
    toolVersion: "slack-tool-version-fixture",
    fetch: (input, init) => {
      captured = new Request(input, init);
      return Promise.resolve(
        Response.json({
          successful: true,
          log_id: "log_1",
          data: { ts: "123.456", channel: "C123" },
        }),
      );
    },
  });
  const result = await client.executeSlackMessage({
    userId: "opaque-user",
    connectedAccountId: "server-selected-account",
    channelId: "C123",
    text: "Saved brief",
  });

  assert.equal(result.successful, true);
  assert.equal(result.requestId, "log_1");
  assert.equal(
    captured?.url,
    "https://backend.composio.dev/api/v3.1/tools/execute/SLACK_SEND_MESSAGE",
  );
  assert.deepEqual(await captured?.json(), {
    user_id: "opaque-user",
    connected_account_id: "server-selected-account",
    version: "slack-tool-version-fixture",
    arguments: { channel: "C123", markdown_text: "Saved brief" },
  });
});

void test("provider error bodies are not propagated", async () => {
  const client = createComposioClient({
    apiKey: "secret",
    toolVersion: "slack-tool-version-fixture",
    fetch: () => Promise.resolve(new Response("private body", { status: 403 })),
  });
  await assert.rejects(
    client.createSlackLink({
      userId: "opaque-user",
      authConfigId: "ac_123",
      callbackUrl: "https://app.example/callback",
    }),
    /Composio request failed \(403\)/,
  );
});
