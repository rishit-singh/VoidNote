import type { Route } from "@playwright/test";
import { z } from "zod";

import {
  assistantHistoryInputSchema,
  assistantScopeSchema,
  type AssistantThread,
} from "../../src/contracts/assistant";
import {
  researchRunDetailSchema,
  researchRunListInputSchema,
} from "../../src/contracts/research/runs";
import { expect, test, timestamp, workspaceId } from "./workspace-fixture";

const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sourceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const questionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const inputSchema = z.object({ workspaceId: z.uuid(), runId: z.uuid() }).strict();

function run(status: "running" | "completed" | "cancelled" = "completed") {
  const report =
    status === "completed"
      ? {
          version: "research-report-v1" as const,
          answer: "The team announced the new public program in November.",
          quality: "answered" as const,
          findings: [
            {
              id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
              questionId,
              question: "When was the program announced?",
              outcome: "supported" as const,
              statement: "The announcement was made in November.",
              classification: "direct-evidence" as const,
              explanation: "The source explicitly dates the announcement.",
              citations: [
                {
                  sourceId,
                  url: "https://example.test/announcement",
                  excerpt: "We announced the new public program in November.",
                  startOffset: 0,
                  endOffset: 54,
                  retrievedAt: timestamp,
                },
              ],
            },
          ],
          gaps: ["The exact day was not established."],
        }
      : null;

  return researchRunDetailSchema.parse({
    id: runId,
    workspaceId,
    noteId: null,
    personId: null,
    question: "When did the organization announce its public program?",
    status,
    stage: status === "running" ? "analyzing" : "finished",
    report,
    quality: report?.quality ?? null,
    findings: report?.findings ?? [],
    gaps: report?.gaps ?? [],
    error: null,
    createdAt: timestamp,
    updatedAt: status === "running" ? timestamp : "2026-11-14T12:00:00.000Z",
  });
}

test("research run detail shows report evidence and accepts an ordinary stop request", async ({
  page,
}) => {
  let current = researchRunDetailSchema.parse({
    ...run("completed"),
    status: "running",
    stage: "analyzing",
  });
  let releaseCancellation!: () => void;
  const cancellationPending = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  const calls: { procedure: string; input: unknown }[] = [];

  await page.route("**/api/researchRuns.*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const raw: unknown =
      request.method() === "GET"
        ? JSON.parse(url.searchParams.get("input") ?? "{}")
        : request.postDataJSON();
    calls.push({ procedure: url.pathname, input: raw });

    if (url.pathname === "/api/researchRuns.get") {
      expect(request.method()).toBe("GET");
      expect(inputSchema.parse(raw)).toEqual({ workspaceId, runId });
      return route.fulfill({ json: { result: { data: current } } });
    }

    if (url.pathname === "/api/researchRuns.cancel") {
      expect(request.method()).toBe("POST");
      expect(inputSchema.parse(raw)).toEqual({ workspaceId, runId });
      await cancellationPending;
      // Model a completion that committed before the cancellation response arrived.
      current = run("completed");
      return route.fulfill({ json: { result: { data: current } } });
    }

    throw new Error(`Unexpected research run procedure: ${url.pathname}`);
  });

  await page.goto(`/research/${runId}`);
  await expect(page.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
  await expect(
    page.getByText("The team announced the new public program in November."),
  ).toBeVisible();
  await expect(page.getByText("We announced the new public program in November.")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "https://example.test/announcement" }),
  ).toHaveAttribute("href", "https://example.test/announcement");
  await expect(page.getByText("The exact day was not established.")).toBeVisible();

  await page.getByRole("button", { name: "Stop research" }).click();
  const stoppingButton = page.getByRole("button", { name: "Stopping…" });
  await expect(stoppingButton).toBeVisible();
  await expect(stoppingButton).toBeDisabled();
  await expect(page.getByText("Researching", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Result quality: Answered")).toHaveCount(0);
  expect(calls.map((call) => call.procedure)).toContain("/api/researchRuns.cancel");

  releaseCancellation();
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Result quality: Answered")).toBeVisible();
  await expect(page.getByText("Direct evidence", { exact: true })).toBeVisible();
  await expect(page.getByText("Retrieved 2026-11-13")).toBeVisible();
  await expect(page.getByText(runId, { exact: true })).toHaveCount(0);
});

test("research result keeps its last saved report visible when a refresh fails", async ({
  page,
}) => {
  const detail = run("completed");
  let readsUnavailable = false;
  await page.route("**/api/researchRuns.*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== "/api/researchRuns.get") {
      throw new Error(`Unexpected research run procedure: ${url.pathname}`);
    }

    expect(request.method()).toBe("GET");
    expect(inputSchema.parse(JSON.parse(url.searchParams.get("input") ?? "{}"))).toEqual({
      workspaceId,
      runId,
    });
    if (readsUnavailable) {
      return route.fulfill({
        status: 503,
        json: {
          error: {
            message: "Research is temporarily unavailable.",
            code: -32603,
            data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 503 },
          },
        },
      });
    }

    return route.fulfill({ json: { result: { data: detail } } });
  });

  await page.goto(`/research/${runId}`);
  await expect(
    page.getByText("The team announced the new public program in November."),
  ).toBeVisible();
  readsUnavailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("Showing the last saved research")).toBeVisible();
  await expect(
    page.getByText("The team announced the new public program in November."),
  ).toBeVisible();
  readsUnavailable = false;
  await page.getByRole("button", { name: "Retry loading" }).click();
  await expect(page.getByText("Showing the last saved research")).toHaveCount(0);
});

test("an existing assistant thread links its research task to the saved report", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Research task links" });
  const thread: AssistantThread = {
    id: "99999999-9999-4999-8999-999999999999",
    noteId: note.id,
    title: note.title,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const task = researchRunDetailSchema.parse({ ...run("running"), noteId: note.id });
  const assistantScope = assistantScopeSchema.extend({ noteId: z.uuid().optional() }).strict();
  const ok = (route: Route, data: unknown) => route.fulfill({ json: { result: { data } } });

  await page.route("**/api/assistant.*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const raw: unknown =
      request.method() === "GET"
        ? JSON.parse(url.searchParams.get("input") ?? "{}")
        : request.postDataJSON();

    if (url.pathname === "/api/assistant.availability") {
      expect(request.method()).toBe("GET");
      expect(assistantScopeSchema.strict().parse(raw)).toEqual({ workspaceId });
      return ok(route, { enabled: true, reason: null });
    }
    if (url.pathname === "/api/assistant.threads") {
      expect(request.method()).toBe("GET");
      expect(assistantScope.parse(raw)).toEqual({ workspaceId, noteId: note.id });
      return ok(route, [thread]);
    }
    if (url.pathname === "/api/assistant.history") {
      const input = assistantHistoryInputSchema
        .extend({ direction: z.enum(["forward", "backward"]).optional() })
        .strict()
        .parse(raw);
      expect(input.workspaceId).toBe(workspaceId);
      expect(input.threadId).toBe(thread.id);
      return ok(route, {
        thread,
        messages: [],
        activeTurn: null,
        latestTurn: null,
        nextCursor: null,
      });
    }
    if (url.pathname === "/api/assistant.conversationSummary") {
      expect(request.method()).toBe("GET");
      return ok(route, null);
    }
    if (url.pathname === "/api/assistant.artifacts") {
      expect(request.method()).toBe("GET");
      return ok(route, []);
    }

    throw new Error(`Unexpected assistant procedure: ${url.pathname}`);
  });

  let listCalls = 0;
  await page.route("**/api/researchRuns.list?*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expect(request.method()).toBe("GET");
    const input = z
      .object({ workspaceId: z.uuid() })
      .extend(researchRunListInputSchema.shape)
      .strict()
      .parse(JSON.parse(url.searchParams.get("input") ?? "{}"));
    expect(input).toEqual({
      workspaceId,
      noteId: note.id,
      threadId: thread.id,
      status: "all",
      limit: 6,
    });
    listCalls++;
    return ok(route, [task]);
  });

  await page.goto(`/notes/${note.id}`);
  const assistant = page.getByRole("region", { name: "Assistant", exact: true });
  if (!(await assistant.isVisible())) {
    await page.getByRole("button", { name: "Ask", exact: true }).click();
  }
  await expect(assistant.getByRole("heading", { name: "Research tasks" })).toBeVisible();
  const reportLink = assistant.getByRole("link", {
    name: /When did the organization announce its public program/,
  });
  await expect(reportLink).toHaveAttribute("href", `/research/${runId}`);
  expect(listCalls).toBeGreaterThan(0);
  await expect(page.getByText(runId, { exact: true })).toHaveCount(0);
});
