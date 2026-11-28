import { randomUUID } from "node:crypto";
import { z } from "zod";

import { assistantArtifactListItemSchema } from "../../src/contracts/assistant";
import {
  connectorStatusSchema,
  shareBriefInputSchema,
  shareBriefResultSchema,
  type ConnectorStatus,
} from "../../src/contracts/connectors";
import { expect, test, timestamp, workspaceId } from "./workspace-fixture";

const scopeSchema = z.object({ workspaceId: z.uuid() }).strict();
const artifactScopeSchema = z
  .object({ workspaceId: z.uuid(), noteId: z.uuid().optional() })
  .strict();

function inputFromRequest(request: { method(): string; postDataJSON(): unknown; url(): string }) {
  const url = new URL(request.url());
  const raw: unknown =
    request.method() === "GET"
      ? JSON.parse(url.searchParams.get("input") ?? "null")
      : request.postDataJSON();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Expected an object connector RPC input.");
  }
  const record = raw as Record<string, unknown>;
  return record.json && typeof record.json === "object"
    ? (record.json as Record<string, unknown>)
    : record;
}

function connectorStatus(overrides: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return connectorStatusSchema.parse({
    enabled: false,
    configured: false,
    provider: "slack",
    connection: "unavailable",
    budgetConfigured: false,
    receipts: [],
    linkReceipts: [],
    ...overrides,
  });
}

async function mockConnectorSettings(
  page: import("@playwright/test").Page,
  initialStatus: ConnectorStatus,
) {
  const brief = assistantArtifactListItemSchema.parse({
    id: randomUUID(),
    kind: "file",
    noteId: null,
    name: "Launch brief",
    mediaType: "text/markdown",
    sources: [],
    revision: 1,
    createdAt: timestamp,
  });
  const state = {
    status: initialStatus,
    brief,
    shareInputs: [] as z.infer<typeof shareBriefInputSchema>[],
    providerSends: 0,
    loseFirstShareResponse: false,
  };

  await page.route("**/api/assistant.artifacts?*", async (route) => {
    const request = route.request();
    expect(request.method()).toBe("GET");
    const input = artifactScopeSchema.parse(inputFromRequest(request));
    expect(input).toEqual({ workspaceId });
    await route.fulfill({
      json: { result: { data: [assistantArtifactListItemSchema.parse(state.brief)] } },
    });
  });

  await page.route("**/api/connectors.*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const procedure = url.pathname.slice("/api/".length);
    if (procedure === "connectors.slackStatus") {
      expect(request.method()).toBe("GET");
      const input = scopeSchema.parse(inputFromRequest(request));
      expect(input).toEqual({ workspaceId });
      await route.fulfill({
        json: { result: { data: connectorStatusSchema.parse(state.status) } },
      });
      return;
    }
    if (procedure === "connectors.shareBrief") {
      expect(request.method()).toBe("POST");
      const input = shareBriefInputSchema.parse(inputFromRequest(request));
      expect(input.workspaceId).toBe(workspaceId);
      state.shareInputs.push(input);
      if (state.shareInputs.length === 1) {
        state.providerSends += 1;
        const receipt = connectorStatusSchema.parse(state.status).receipts;
        state.status = connectorStatusSchema.parse({
          ...state.status,
          receipts: [
            {
              operationId: input.operationId,
              briefId: input.briefId,
              channelId: input.channelId,
              status: "sent",
              providerRequestId: "provider-request-1",
              remoteMessageId: "1712345678.1234",
              messageUrl: "https://example.test/slack/message",
              usageStatus: "unreported",
              createdAt: timestamp,
            },
            ...receipt,
          ].slice(0, 10),
        });
        if (state.loseFirstShareResponse) {
          state.loseFirstShareResponse = false;
          await route.abort("connectionreset");
          return;
        }
      } else {
        expect(input).toEqual(state.shareInputs[0]);
      }
      await route.fulfill({
        json: {
          result: {
            data: shareBriefResultSchema.parse({
              operationId: input.operationId,
              status: "sent",
              providerRequestId: "provider-request-1",
              remoteMessageId: "1712345678.1234",
              messageUrl: "https://example.test/slack/message",
              usageStatus: "unreported",
            }),
          },
        },
      });
      return;
    }
    throw new Error(`Unexpected connector procedure: ${request.method()} ${url.pathname}`);
  });

  return state;
}

test("Settings explains disabled Slack without loading briefs or offering connection", async ({
  page,
}, testInfo) => {
  const state = await mockConnectorSettings(page, connectorStatus());
  await page.goto("/settings");

  const slack = page.getByRole("region", { name: "Slack", exact: true });
  await expect(slack).toBeVisible();
  await expect(slack.getByText("Slack sharing is not configured.", { exact: true })).toBeVisible();
  await expect(slack.getByRole("button", { name: /Connect Slack/ })).toHaveCount(0);
  expect(state.shareInputs).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("settings-desktop.png"), fullPage: true });
  await testInfo.attach("Settings desktop", {
    path: testInfo.outputPath("settings-desktop.png"),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(slack).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("settings-mobile.png"), fullPage: true });
  await testInfo.attach("Settings mobile", {
    path: testInfo.outputPath("settings-mobile.png"),
    contentType: "image/png",
  });
  await slack.scrollIntoViewIfNeeded();
  await testInfo.attach("Settings mobile Slack section", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("share retries the exact durable command after a lost response and reload", async ({
  page,
}) => {
  const state = await mockConnectorSettings(
    page,
    connectorStatus({
      enabled: true,
      configured: true,
      connection: "connected",
      budgetConfigured: true,
    }),
  );
  state.loseFirstShareResponse = true;
  await page.goto("/settings");

  const slack = page.getByRole("region", { name: "Slack", exact: true });
  await expect(slack.getByRole("combobox", { name: "Saved brief" })).toBeVisible();
  await slack.getByRole("combobox", { name: "Saved brief" }).selectOption(state.brief.id);
  await slack.getByRole("textbox", { name: "Slack channel ID" }).fill("C012ABC");

  const lostResponse = page.waitForEvent(
    "requestfailed",
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/connectors.shareBrief",
  );
  await slack.getByRole("button", { name: "Share saved brief", exact: true }).click();
  await lostResponse;
  await expect(slack.getByRole("button", { name: "Check existing share" })).toBeEnabled();
  expect(state.providerSends).toBe(1);
  expect(state.shareInputs).toHaveLength(1);

  await page.reload();
  const restoredSlack = page.getByRole("region", { name: "Slack", exact: true });
  const checkShare = restoredSlack.getByRole("button", { name: "Check existing share" });
  await expect(checkShare).toBeEnabled();
  await expect(restoredSlack.getByRole("textbox", { name: "Slack channel ID" })).toHaveValue(
    "C012ABC",
  );
  await checkShare.click();

  await expect(restoredSlack.getByRole("status")).toHaveText(
    "Brief shared in Slack. Provider usage was not reported; the budget hold remains.",
  );
  expect(state.shareInputs).toHaveLength(2);
  expect(state.shareInputs[1]).toEqual(state.shareInputs[0]);
  expect(state.providerSends).toBe(1);
});
