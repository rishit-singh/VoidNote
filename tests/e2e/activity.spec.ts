import { randomUUID } from "node:crypto";
import type { WebSocketRoute } from "@playwright/test";

import {
  ACTIVITY_PROTOCOL,
  activityChangesInputSchema,
  activityChangesSchema,
  activityItemSchema,
  activityPageInputSchema,
  activityPageSchema,
  activitySubscriptionSchema,
  activityScopeSchema,
  type ActivityItem,
} from "../../src/contracts/activity";
import { test, expect, timestamp, userId, workspaceId } from "./workspace-fixture";

const otherWorkspaceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const otherUserId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function activityItem(sequence: string, type: ActivityItem["type"]): ActivityItem {
  return activityItemSchema.parse({
    id: randomUUID(),
    sequence,
    type,
    title:
      type === "summary.published"
        ? "Summary ready"
        : type === "research.completed"
          ? "Research ready"
          : "Transcript ready",
    href: `/notes/${randomUUID()}`,
    executor: type === "note.changed" ? "user" : "workflow",
    createdAt: timestamp,
    readAt: null,
    noteId: randomUUID(),
    personId: null,
  });
}

function inputFromRequest(request: { method(): string; postDataJSON(): unknown; url(): string }) {
  const url = new URL(request.url());
  const raw: unknown =
    request.method() === "GET"
      ? JSON.parse(url.searchParams.get("input") ?? "null")
      : request.postDataJSON();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Expected an object activity RPC input.");
  }

  const record = raw as Record<string, unknown>;
  return record.json && typeof record.json === "object"
    ? (record.json as Record<string, unknown>)
    : record;
}

test("activity inbox catches up on live wakeups without replaying history and persists read state", async ({
  page,
}) => {
  const events = [activityItem("1", "summary.published"), activityItem("2", "research.completed")];
  const calls: Array<{ procedure: string; input: Record<string, unknown> }> = [];
  const tickets: string[] = [];
  const sockets: WebSocketRoute[] = [];
  const closedSockets = new Set<WebSocketRoute>();
  let readCalls = 0;

  await page.route("**/api/activity.*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const procedure = url.pathname.slice("/api/".length);
    const input = inputFromRequest(request);
    calls.push({ procedure, input });

    if (procedure === "activity.list" && request.method() === "GET") {
      const parsed = activityPageInputSchema.parse(input);
      expect(parsed.workspaceId).toBe(workspaceId);
      const ordered = events
        .filter(
          (item) => parsed.before === undefined || BigInt(item.sequence) < BigInt(parsed.before),
        )
        .sort((left, right) => Number(right.sequence) - Number(left.sequence));
      const result = activityPageSchema.parse({
        items: ordered.slice(0, parsed.limit),
        nextCursor: null,
        unreadCount: events.filter((item) => item.readAt === null).length,
      });
      await route.fulfill({ json: { result: { data: result } } });
      return;
    }

    if (procedure === "activity.changes" && request.method() === "GET") {
      const parsed = activityChangesInputSchema.parse(input);
      expect(parsed.workspaceId).toBe(workspaceId);
      const changed = events
        .filter((item) => BigInt(item.sequence) > BigInt(parsed.after))
        .sort((left, right) => Number(left.sequence) - Number(right.sequence));
      const page = changed.slice(0, 50);
      const result = activityChangesSchema.parse({
        items: page,
        cursor: page.at(-1)?.sequence ?? parsed.after,
        hasMore: changed.length > page.length,
      });
      await route.fulfill({ json: { result: { data: result } } });
      return;
    }

    if (procedure === "activity.subscribe" && request.method() === "POST") {
      const parsed = activityScopeSchema.parse(input);
      expect(parsed.workspaceId).toBe(workspaceId);
      const ticket = (tickets.length + 1).toString(16).padStart(64, "0");
      tickets.push(ticket);
      const result = activitySubscriptionSchema.parse({
        workspaceId,
        userId,
        ticket,
        expiresAt: Date.now() + 20_000,
      });
      await route.fulfill({ json: { result: { data: result } } });
      return;
    }

    if (procedure === "activity.markRead" && request.method() === "POST") {
      const parsed = activityScopeSchema.extend({ id: activityItemSchema.shape.id }).parse(input);
      expect(parsed.workspaceId).toBe(workspaceId);
      readCalls += 1;
      const item = events.find((candidate) => candidate.id === parsed.id);
      if (item && item.readAt === null) item.readAt = new Date().toISOString();
      await route.fulfill({ json: { result: { data: { acknowledged: true } } } });
      return;
    }

    throw new Error(`Unexpected activity RPC: ${request.method()} ${url.pathname}`);
  });

  await page.routeWebSocket(/\/api\/activity\/output\?/, (socket) => {
    const url = new URL(socket.url());
    expect(Object.fromEntries(url.searchParams)).toEqual({ workspaceId, userId });
    expect(socket.protocols()).toEqual([ACTIVITY_PROTOCOL, tickets.at(-1)]);
    socket.onClose(() => closedSockets.add(socket));
    sockets.push(socket);
  });

  await page.goto("/");
  const activityButton = page.getByRole("button", { name: /Activity/ });
  await expect(activityButton).toBeVisible();
  await expect.poll(() => sockets.length).toBe(1);
  await expect
    .poll(() =>
      calls.some((call) => call.procedure === "activity.changes" && call.input.after === "2"),
    )
    .toBe(true);
  await expect(page.getByText("Summary ready", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Research ready", { exact: true })).toHaveCount(0);

  const completion = activityItem("3", "summary.published");
  events.push(completion);
  sockets[0]!.send('{"type":"changed"}');
  sockets[0]!.send('{"type":"changed"}');
  await expect(page.getByText("Summary ready", { exact: true })).toBeVisible();
  await expect(page.getByText("Summary ready", { exact: true })).toHaveCount(1);

  await activityButton.click();
  const dialog = page.getByRole("dialog", { name: "Activity" });
  const completionRow = dialog
    .getByRole("listitem")
    .filter({ has: page.locator(`a[href="${completion.href}"]`) });
  await expect(completionRow).toBeVisible();
  await completionRow.getByRole("button", { name: "Mark read" }).click();
  await expect(completionRow.getByRole("button", { name: "Mark read" })).toHaveCount(0);
  await expect.poll(() => readCalls).toBe(1);
  await expect(page.locator('button[aria-label^="Activity"]')).toHaveAttribute(
    "aria-label",
    "Activity, 2 unread",
  );
  expect(calls.filter((call) => call.procedure === "activity.subscribe")).toHaveLength(1);

  await sockets[0]!.close({ code: 1000 });
  await expect.poll(() => sockets.length).toBe(2);
  expect(tickets[1]).not.toBe(tickets[0]);
  await expect(dialog.getByRole("link", { name: "Summary ready", exact: true })).toHaveCount(2);
  await expect.poll(() => closedSockets.has(sockets[0]!)).toBe(true);
});

test("activity reconnect obtains a fresh lease after the authenticated scope changes", async ({
  page,
  workspace,
}) => {
  const tickets: string[] = [];
  const sockets: Array<{ route: WebSocketRoute; scope: string }> = [];
  const closedScopes = new Set<string>();

  await page.route("**/api/activity.*", async (route) => {
    const request = route.request();
    const procedure = new URL(request.url()).pathname.slice("/api/".length);
    const input = inputFromRequest(request);
    if (procedure === "activity.list" && request.method() === "GET") {
      const parsed = activityPageInputSchema.parse(input);
      await route.fulfill({
        json: {
          result: {
            data: activityPageSchema.parse({
              items: [],
              nextCursor: null,
              unreadCount: 0,
            }),
          },
        },
      });
      expect(parsed.workspaceId).toBe(workspace.session?.workspace.id);
      return;
    }
    if (procedure === "activity.changes" && request.method() === "GET") {
      const parsed = activityChangesInputSchema.parse(input);
      await route.fulfill({
        json: {
          result: {
            data: activityChangesSchema.parse({
              items: [],
              cursor: parsed.after,
              hasMore: false,
            }),
          },
        },
      });
      expect(parsed.workspaceId).toBe(workspace.session?.workspace.id);
      return;
    }
    if (procedure === "activity.subscribe" && request.method() === "POST") {
      const parsed = activityScopeSchema.parse(input);
      expect(parsed.workspaceId).toBe(workspace.session?.workspace.id);
      const ticket = (tickets.length + 10).toString(16).padStart(64, "0");
      tickets.push(ticket);
      await route.fulfill({
        json: {
          result: {
            data: activitySubscriptionSchema.parse({
              workspaceId: workspace.session!.workspace.id,
              userId: workspace.session!.user.id,
              ticket,
              expiresAt: Date.now() + 20_000,
            }),
          },
        },
      });
      return;
    }

    throw new Error(`Unexpected activity RPC: ${request.method()} ${procedure}`);
  });

  await page.routeWebSocket(/\/api\/activity\/output\?/, (socket) => {
    const url = new URL(socket.url());
    const scope = `${url.searchParams.get("workspaceId")}:${url.searchParams.get("userId")}`;
    expect(socket.protocols()).toEqual([ACTIVITY_PROTOCOL, tickets.at(-1)]);
    sockets.push({ route: socket, scope });
    socket.onClose(() => closedScopes.add(scope));
  });

  await page.goto("/");
  await expect.poll(() => sockets.length).toBe(1);
  expect(sockets[0]?.scope).toBe(`${workspaceId}:${userId}`);

  workspace.session = {
    user: { id: otherUserId, email: "second@example.test" },
    workspace: { id: otherWorkspaceId, name: "Second workspace" },
  };
  await page.reload();
  await expect.poll(() => sockets.length).toBe(2);
  expect(sockets[1]?.scope).toBe(`${otherWorkspaceId}:${otherUserId}`);
  expect(tickets[1]).not.toBe(tickets[0]);
  await expect.poll(() => closedScopes.has(`${workspaceId}:${userId}`)).toBe(true);
});
