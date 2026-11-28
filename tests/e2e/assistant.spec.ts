import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page, WebSocketRoute } from "@playwright/test";
import { z } from "zod";

import {
  assistantArtifactListItemSchema,
  assistantOutputLeaseSchema,
  assistantOutputScopeSchema,
  assistantHistoryInputSchema,
  assistantScopeSchema,
  openAssistantThreadSchema,
  sendAssistantTurnSchema,
  type AssistantArtifact,
  type AssistantMessage,
  type AssistantThread,
  type AssistantTurn,
} from "../../src/contracts/assistant";
import {
  conversationSummarySchema,
  conversationSummaryScopeSchema,
  type ConversationSummary,
} from "../../src/contracts/conversation-summaries";
import {
  expect,
  test,
  timestamp,
  userId,
  workspaceId,
  type WorkspaceFixture,
} from "./workspace-fixture";

/** Mocked client recovery/UI acceptance only; no model or live provider is contacted. */
async function assistantFixture(page: Page, workspace: WorkspaceFixture) {
  const note = workspace.seedNote({ title: "Assistant acceptance" });
  const state = {
    thread: null as AssistantThread | null,
    turn: null as AssistantTurn | null,
    messages: [] as AssistantMessage[],
    earlierMessages: [] as AssistantMessage[],
    artifacts: [] as AssistantArtifact[],
    commands: [] as z.infer<typeof sendAssistantTurnSchema>[],
    opens: [] as z.infer<typeof openAssistantThreadSchema>[],
    artifactReads: 0,
    loseNextResponse: false,
    enabled: true,
    outputEnabled: false,
    outputLeases: [] as { scope: z.infer<typeof assistantOutputScopeSchema>; ticket: string }[],
    conversationSummary: null as ConversationSummary | null,
    conversationSummaryReads: 0,
    mutationProcedures: [] as string[],
  };
  await page.route("**/api/assistant.*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const raw: unknown =
      request.method() === "GET"
        ? JSON.parse(url.searchParams.get("input") ?? "{}")
        : request.postDataJSON();
    expect(assistantScopeSchema.parse(raw).workspaceId).toBe(workspaceId);
    const ok = (data: unknown) => route.fulfill({ json: { result: { data } } });
    const owner = workspace.session?.user.id === userId;
    if (request.method() === "POST") state.mutationProcedures.push(url.pathname);
    switch (url.pathname) {
      case "/api/assistant.conversationSummary": {
        expect(request.method()).toBe("GET");
        expect(url.searchParams.has("batch")).toBe(false);
        const input = conversationSummaryScopeSchema.parse(raw);
        expect(input).toEqual({ workspaceId, threadId: state.thread?.id });
        expect(owner).toBe(true);
        state.conversationSummaryReads++;
        return ok(conversationSummarySchema.nullable().parse(state.conversationSummary));
      }
      case "/api/assistant.outputLease": {
        expect(request.method()).toBe("POST");
        const scope = assistantOutputScopeSchema.parse(raw);
        if (!state.outputEnabled) {
          return route.fulfill({
            status: 501,
            json: {
              error: {
                message: "Provisional output is disabled in this fixture.",
                code: -32603,
                data: { code: "NOT_IMPLEMENTED", httpStatus: 501 },
              },
            },
          });
        }
        expect(owner).toBe(true);
        expect(scope.threadId).toBe(state.thread?.id);
        expect(scope.turnId).toBe(state.turn?.id);
        expect(["queued", "running"]).toContain(state.turn?.status);
        const lease = assistantOutputLeaseSchema.parse({
          ticket: randomBytes(32).toString("hex"),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        });
        state.outputLeases.push({ scope, ticket: lease.ticket });
        return ok(lease);
      }
      case "/api/assistant.availability":
        assistantScopeSchema.strict().parse(raw);
        return ok({
          enabled: state.enabled,
          reason: state.enabled ? null : "Assistant isn’t enabled for this workspace.",
        });
      case "/api/assistant.threads":
        assistantScopeSchema.extend({ noteId: z.uuid().optional() }).strict().parse(raw);
        return ok(owner && state.thread ? [state.thread] : []);
      case "/api/assistant.open": {
        const input = openAssistantThreadSchema.strict().parse(raw);
        expect(owner).toBe(true);
        state.opens.push(input);
        if (state.thread) expect(input.threadId).toBe(state.thread.id);
        else
          state.thread = {
            id: input.threadId,
            noteId: input.noteId,
            title: "Assistant acceptance",
            createdAt: timestamp,
            updatedAt: timestamp,
          };
        return ok(state.thread);
      }
      case "/api/assistant.history": {
        // TanStack's infinite adapter supplies direction; the public object schema
        // strips it, while the mock rejects other accidental transport additions.
        const input = assistantHistoryInputSchema
          .extend({
            direction: z.enum(["forward", "backward"]).optional(),
          })
          .strict()
          .parse(raw);
        expect(input.threadId).toBe(state.thread?.id);
        expect(owner).toBe(true);
        return ok({
          thread: state.thread,
          messages: input.cursor ? state.earlierMessages : state.messages,
          activeTurn:
            state.turn && ["queued", "running"].includes(state.turn.status) ? state.turn : null,
          latestTurn: state.turn,
          nextCursor: !input.cursor && state.earlierMessages.length ? "earlier-messages" : null,
        });
      }
      case "/api/assistant.send": {
        const input = sendAssistantTurnSchema.strict().parse(raw);
        expect(owner).toBe(true);
        expect(input.threadId).toBe(state.thread?.id);
        state.commands.push(input);
        if (!state.turn) {
          state.turn = {
            id: input.turnId,
            threadId: input.threadId,
            status: "queued",
            error: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          state.messages.push({
            id: randomUUID(),
            threadId: input.threadId,
            turnId: input.turnId,
            role: "user",
            text: input.text,
            tools: [],
            sources: [],
            createdAt: timestamp,
          });
        } else expect(input.turnId).toBe(state.turn.id);
        if (state.loseNextResponse) {
          state.loseNextResponse = false;
          return route.abort("failed");
        }
        return ok(state.turn);
      }
      case "/api/assistant.cancel": {
        const input = assistantScopeSchema.extend({ turnId: z.uuid() }).strict().parse(raw);
        expect(input.turnId).toBe(state.turn?.id);
        state.turn = { ...state.turn!, status: "cancelled" };
        return ok(state.turn);
      }
      case "/api/assistant.artifacts":
        assistantScopeSchema.extend({ noteId: z.uuid().optional() }).strict().parse(raw);
        return ok(
          owner
            ? state.artifacts.map((artifact) => assistantArtifactListItemSchema.parse(artifact))
            : [],
        );
      case "/api/assistant.artifact": {
        const input = assistantScopeSchema.extend({ id: z.uuid() }).strict().parse(raw);
        expect(owner).toBe(true);
        state.artifactReads++;
        return ok(state.artifacts.find((artifact) => artifact.id === input.id));
      }
      default:
        return route.abort("failed");
    }
  });
  const open = async () => {
    await page.goto(`/notes/${note.id}`);
    const panel = page.getByRole("region", { name: "Assistant", exact: true });
    if (!(await panel.isVisible())) {
      await page.getByRole("button", { name: "Ask", exact: true }).click();
    }
    await expect(panel).toBeVisible();
    return panel;
  };
  const finish = () => {
    state.turn = { ...state.turn!, status: "succeeded" };
    const source = {
      kind: "note" as const,
      id: note.id,
      label: "Assistant acceptance",
      revision: 1,
    };
    const artifact: AssistantArtifact = {
      id: randomUUID(),
      kind: "file",
      noteId: note.id,
      name: "Follow-up.md",
      mediaType: "text/markdown",
      content: "# Follow-up\n\nConfirm the Friday release.",
      sources: [source],
      revision: 1,
      createdAt: timestamp,
    };
    state.artifacts.push(artifact);
    state.messages.push({
      id: randomUUID(),
      threadId: state.thread!.id,
      turnId: state.turn.id,
      role: "assistant",
      text: [
        "## Release update",
        "",
        "The team chose Friday. I saved the requested follow-up.",
        "",
        "- Confirm the release",
        "",
        "| Day | Status |",
        "| --- | --- |",
        "| Friday | Ready |",
        "",
        "```text",
        "release-approved",
        "```",
        "",
        "[Unsafe](javascript:alert(1))",
        "",
        "<img src=x onerror=alert(1)>",
      ].join("\n"),
      sources: [source],
      tools: [
        {
          id: randomUUID(),
          name: "artifact_create",
          status: "succeeded",
          summary: "Saved Follow-up.md.",
          sources: [{ kind: "artifact", id: artifact.id, label: artifact.name }],
        },
      ],
      createdAt: "2026-11-13T12:00:01.000Z",
    });
  };
  return { state, note, open, finish };
}

test("Ask opens beside the desktop note and keeps its draft in the mobile panel", async ({
  page,
  workspace,
}) => {
  workspace.seedNote({ title: "George Hotz × Lex Fridman — a long interview note title" });
  const { state, open } = await assistantFixture(page, workspace);
  await page.setViewportSize({ width: 1440, height: 900 });
  const panel = await open();
  await expect(page.getByRole("complementary", { name: "Primary navigation" })).toHaveCSS(
    "width",
    "224px",
  );
  await expect(page.getByRole("dialog", { name: "Ask", exact: true })).toHaveCount(0);
  await panel.getByRole("textbox", { name: "Message Assistant" }).fill("Keep this question.");
  await panel.getByRole("button", { name: "Close Ask", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ask", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(panel.getByRole("textbox", { name: "Message Assistant" })).toHaveValue(
    "Keep this question.",
  );
  const composer = panel.getByRole("textbox", { name: "Message Assistant" });
  await composer.focus();
  await composer.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(5, 9, "backward"));

  await page.setViewportSize({ width: 390, height: 844 });
  const mobilePanel = page.getByRole("dialog", { name: "Ask", exact: true });
  await expect(mobilePanel).toBeVisible();
  await expect(mobilePanel.getByRole("textbox", { name: "Message Assistant" })).toHaveValue(
    "Keep this question.",
  );
  await expect(composer).toBeFocused();
  await expect
    .poll(() =>
      composer.evaluate((node: HTMLTextAreaElement) => ({
        start: node.selectionStart,
        end: node.selectionEnd,
        direction: node.selectionDirection,
      })),
    )
    .toEqual({ start: 5, end: 9, direction: "backward" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("dialog", { name: "Ask", exact: true })).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect
    .poll(() =>
      composer.evaluate((node: HTMLTextAreaElement) => ({
        start: node.selectionStart,
        end: node.selectionEnd,
        direction: node.selectionDirection,
      })),
    )
    .toEqual({ start: 5, end: 9, direction: "backward" });
  await expect(composer).toHaveValue("Keep this question.");

  // A responsive transition must not focus the composer when another control
  // was focused, even though the same saved draft is restored.
  await panel.getByRole("button", { name: "Close Ask", exact: true }).focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(mobilePanel).toBeVisible();
  await expect(composer).not.toBeFocused();
  await mobilePanel.getByRole("button", { name: "Close", exact: true }).focus();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("dialog", { name: "Ask", exact: true })).toHaveCount(0);
  await expect(composer).not.toBeFocused();
  await panel.getByRole("button", { name: "Close Ask", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ask", exact: true })).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await mobilePanel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ask", exact: true })).toBeFocused();
  expect(state.commands).toHaveLength(0);
});

for (const width of [1440, 390]) {
  test(`Ask follows latest replies without moving readers of older history at ${width}px`, async ({
    page,
    workspace,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await assistantFixture(page, workspace);
    const threadId = randomUUID();
    f.state.thread = {
      id: threadId,
      noteId: f.note.id,
      title: "Scrolling conversation",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const makeMessage = (text: string): AssistantMessage => ({
      id: randomUUID(),
      threadId,
      turnId: randomUUID(),
      role: "assistant",
      text,
      tools: [],
      sources: [],
      createdAt: timestamp,
    });
    f.state.messages = Array.from({ length: 12 }, (_, index) =>
      makeMessage(`Recent message ${index + 1}.\n\nDetails from the conversation.`),
    );
    f.state.earlierMessages = Array.from({ length: 6 }, (_, index) =>
      makeMessage(`Earlier message ${index + 1}.\n\nEarlier conversation details.`),
    );
    f.state.turn = {
      id: randomUUID(),
      threadId,
      status: "running",
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    f.state.outputEnabled = true;
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/api\/assistant\/output\?/, (socket) => {
      sockets.push(socket);
    });
    const panel = await f.open();
    const viewport = panel
      .getByRole("region", { name: "Conversation messages", exact: true })
      .locator("[data-radix-scroll-area-viewport]");
    await expect(viewport).toHaveCSS("overflow-anchor", "none");
    const bottomGap = () =>
      viewport.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
    const afterLayout = () =>
      viewport.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    await expect(panel.getByText("Recent message 12.", { exact: true })).toBeAttached();
    await expect.poll(bottomGap).toBeLessThanOrEqual(1);
    await expect(panel.getByText("Recent message 12.", { exact: true })).toBeInViewport();
    await expect.poll(() => sockets.length).toBe(1);
    const sendSnapshot = (text: string) =>
      sockets[0]!.send(
        JSON.stringify({
          type: "snapshot",
          turnId: f.state.turn!.id,
          text,
        }),
      );
    const draft = panel.getByRole("article", {
      name: "Draft response — not yet saved",
      exact: true,
    });
    const firstText = `${"Streaming response line.\n\n".repeat(25)}First streamed ending.`;
    sendSnapshot(firstText);
    await expect(draft).toContainText("First streamed ending.");
    await expect.poll(bottomGap).toBeLessThanOrEqual(1);
    await expect(draft.getByText("First streamed ending.", { exact: true })).toBeInViewport();

    await viewport.evaluate((node) => {
      node.scrollTop = node.scrollHeight - node.clientHeight - 200;
      node.dispatchEvent(new Event("scroll"));
    });
    const readingPosition = await viewport.evaluate((node) => node.scrollTop);
    sendSnapshot(
      `${firstText}\n\n${"Additional response line.\n\n".repeat(10)}Second streamed ending.`,
    );
    await expect(draft).toContainText("Second streamed ending.");
    await afterLayout();
    await expect
      .poll(async () =>
        Math.abs((await viewport.evaluate((node) => node.scrollTop)) - readingPosition),
      )
      .toBeLessThanOrEqual(1);
    expect(await bottomGap()).toBeGreaterThan(200);

    await viewport.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll"));
    });
    const firstMessage = panel
      .getByRole("article")
      .filter({ hasText: "Recent message 1." })
      .first();
    const anchorOffset = async () => {
      const [messageBox, viewportBox] = await Promise.all([
        firstMessage.boundingBox(),
        viewport.boundingBox(),
      ]);
      return messageBox!.y - viewportBox!.y;
    };
    const beforePrepend = await anchorOffset();
    await panel.getByRole("button", { name: "Load earlier messages", exact: true }).click();
    await expect(panel.getByText("Earlier message 1.", { exact: true })).toBeAttached();
    await afterLayout();
    await expect
      .poll(async () => Math.abs((await anchorOffset()) - beforePrepend))
      .toBeLessThanOrEqual(1);

    await viewport.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event("scroll"));
    });
    // Force the browser ordering that previously lost follow mode: a queued
    // scroll notification at the same scrollTop after the text grows, before
    // ResizeObserver can follow the new bottom.
    await draft.evaluate((node) => {
      const scrollViewport = node.closest("[data-radix-scroll-area-viewport]")!;
      const observer = new MutationObserver(() => {
        observer.disconnect();
        scrollViewport.dispatchEvent(new Event("scroll"));
      });
      observer.observe(node, { childList: true, characterData: true, subtree: true });
    });
    sendSnapshot(`${firstText}\n\n${"Final response line.\n\n".repeat(20)}Final streamed ending.`);
    await expect(draft).toContainText("Final streamed ending.");
    await expect.poll(bottomGap).toBeLessThanOrEqual(1);
    f.finish();
    await expect(draft).toBeHidden();
    await expect(
      panel.getByText("The team chose Friday. I saved the requested follow-up.", { exact: true }),
    ).toBeAttached();
    await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  });
}

test("a saved derived conversation summary retains its range and sources after reload without sending or remembering", async ({
  page,
  workspace,
}) => {
  const f = await assistantFixture(page, workspace);
  const person = workspace.seedPerson({ displayName: "Maya" });
  const threadId = randomUUID();
  f.state.thread = {
    id: threadId,
    noteId: f.note.id,
    title: "Saved conversation",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const turnIds = Array.from({ length: 10 }, () => randomUUID());
  f.state.messages = Array.from({ length: 20 }, (_, index) => ({
    id: randomUUID(),
    threadId,
    turnId: turnIds[Math.floor(index / 2)]!,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Saved conversation message ${index + 1}.`,
    sources: [],
    tools: [],
    createdAt: timestamp,
  }));
  const summaryText = "The conversation covered the Friday launch and its outstanding checks.";
  f.state.conversationSummary = conversationSummarySchema.parse({
    id: randomUUID(),
    threadId,
    status: "succeeded",
    fromSequence: 1,
    throughSequence: 20,
    messageCount: 20,
    text: summaryText,
    sources: [
      { kind: "message", id: f.state.messages[0]!.id, label: "Opening launch question" },
      { kind: "note", id: f.note.id, label: "Launch decision source", revision: 1 },
      { kind: "person", id: person.id, label: "Maya’s profile", revision: 1 },
    ],
    error: null,
    createdAt: timestamp,
    completedAt: "2026-11-13T12:06:00.000Z",
  });

  for (let visit = 0; visit < 2; visit++) {
    const panel = await f.open();
    const summary = panel.getByRole("region", { name: "Conversation summary", exact: true });
    await expect(summary).toBeVisible();
    await expect(summary.locator("details").first()).not.toHaveAttribute("open");
    await expect(summary.getByText("20 earlier messages", { exact: true })).toBeVisible();
    await expect(summary.getByText(summaryText, { exact: true })).toBeHidden();
    await summary.locator("summary").first().click();
    await expect(summary.getByText(summaryText, { exact: true })).toBeVisible();
    await expect(
      summary.getByText("A recap of earlier messages in this conversation.", {
        exact: true,
      }),
    ).toBeVisible();
    await summary.locator("summary").filter({ hasText: "Sources (3)" }).click();
    await expect(summary.getByText("Opening launch question", { exact: true })).toBeVisible();
    await expect(summary.getByRole("link", { name: "Launch decision source" })).toHaveAttribute(
      "href",
      `/notes/${f.note.id}`,
    );
    await expect(
      summary.getByRole("link", { name: "Maya’s profile", exact: true }),
    ).toHaveAttribute("href", `/profiles/${person.id}`);
    await expect(summary.locator("time")).toHaveAttribute("datetime", "2026-11-13T12:06:00.000Z");
    await expect(
      panel.getByRole("article", { name: "Assistant response", exact: true }),
    ).toHaveCount(10);
    await expect(
      panel
        .getByRole("article", { name: "Assistant response", exact: true })
        .filter({ hasText: summaryText }),
    ).toHaveCount(0);
  }

  expect(f.state.conversationSummaryReads).toBeGreaterThanOrEqual(2);
  expect(f.state.messages).toHaveLength(20);
  expect(f.state.commands).toHaveLength(0);
  expect(f.state.opens).toHaveLength(0);
  expect(f.state.mutationProcedures).toEqual([]);
  expect(workspace.mutations).toHaveLength(0);
});

test("Assistant opens without sending, shows saved tools/sources, and downloads authorized artifact detail", async ({
  page,
  workspace,
}) => {
  const { state, open, finish } = await assistantFixture(page, workspace);
  const panel = await open();
  expect(state.commands).toHaveLength(0);
  expect(state.opens).toHaveLength(0);
  expect(state.conversationSummaryReads).toBe(0);
  await expect(
    panel.getByRole("region", { name: "Conversation summary", exact: true }),
  ).toBeHidden();
  await panel
    .getByRole("textbox", { name: "Message Assistant" })
    .fill("What did we decide? Save a follow-up.");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel.getByText("Queued", { exact: true })).toBeVisible();
  await expect.poll(() => state.conversationSummaryReads).toBeGreaterThan(0);
  await expect(
    panel.getByRole("region", { name: "Conversation summary", exact: true }),
  ).toBeHidden();
  await expect(panel.getByText("Completed", { exact: true })).toBeHidden();
  finish();
  await expect(panel.getByRole("heading", { name: "Release update", exact: true })).toBeVisible();
  await expect(
    panel.getByText("The team chose Friday. I saved the requested follow-up.", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("list").getByText("Confirm the release")).toBeVisible();
  await expect(panel.getByRole("table").getByText("Friday")).toBeVisible();
  await expect(panel.getByText("release-approved", { exact: true })).toBeVisible();
  await expect(panel.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(panel.locator("img[src=x]")).toHaveCount(0);
  await panel.locator("summary").filter({ hasText: "Tool activity (1)" }).click();
  await panel.locator("summary").filter({ hasText: "Create item" }).click();
  await expect(panel.getByText("Saved Follow-up.md.", { exact: true })).toBeVisible();
  await panel.locator("summary").filter({ hasText: "Created items" }).click();
  await panel.getByRole("button", { name: "Follow-up.md", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Follow-up.md", exact: true });
  await expect(preview.getByText("# Follow-up", { exact: false })).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await preview.getByRole("button", { name: "Download", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("Follow-up.md");
  expect(await readFile(await download.path(), "utf8")).toContain("Confirm the Friday release.");
  expect(state.artifactReads).toBeGreaterThanOrEqual(2);
  await open();
  expect(state.commands).toHaveLength(1);
  expect(state.opens).toHaveLength(1);
});

test("reload replays an uncertain turn exactly and preserves newer typing; Stop survives reopening", async ({
  page,
  workspace,
}) => {
  const { state, open } = await assistantFixture(page, workspace);
  state.loseNextResponse = true;
  let panel = await open();
  await panel
    .getByRole("textbox", { name: "Message Assistant" })
    .fill("Find the release decision.");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Retry message" })).toBeVisible();
  await panel.getByRole("textbox", { name: "Message Assistant" }).fill("Keep this next question.");
  expect(state.commands).toHaveLength(1);
  panel = await open();
  await expect.poll(() => state.commands.length).toBe(2);
  expect(state.commands[1]).toEqual(state.commands[0]);
  expect(state.opens[1]).toEqual(state.opens[0]);
  await expect(panel.getByRole("textbox", { name: "Message Assistant" })).toHaveValue(
    "Keep this next question.",
  );
  await panel.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => state.turn?.status).toBe("cancelled");
  panel = await open();
  await expect(panel.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
  expect(state.commands).toHaveLength(2);
});

test("another account cannot see or replay outgoing pending messages and drafts", async ({
  page,
  workspace,
}) => {
  const { state, open } = await assistantFixture(page, workspace);
  state.loseNextResponse = true;
  let panel = await open();
  await panel.getByRole("textbox", { name: "Message Assistant" }).fill("Private pending question");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Retry message" })).toBeVisible();
  await panel.getByRole("textbox", { name: "Message Assistant" }).fill("Private newer draft");
  const ownerSession = workspace.session!;
  workspace.session = { ...ownerSession, user: { id: randomUUID(), email: "other@example.test" } };
  panel = await open();
  await expect(panel.getByRole("textbox", { name: "Message Assistant" })).toHaveValue("");
  await expect(panel.getByText("Private pending question", { exact: true })).toBeHidden();
  expect(state.commands).toHaveLength(1);
  workspace.session = ownerSession;
  panel = await open();
  await expect.poll(() => state.commands.length).toBe(2);
  expect(state.commands[1]).toEqual(state.commands[0]);
  await expect(panel.getByRole("textbox", { name: "Message Assistant" })).toHaveValue(
    "Private newer draft",
  );
});

test("a persisted interrupted turn remains visible after reopening", async ({
  page,
  workspace,
}) => {
  const { state, open } = await assistantFixture(page, workspace);
  let panel = await open();
  await panel
    .getByRole("textbox", { name: "Message Assistant" })
    .fill("Check the release decision.");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.turn?.status).toBe("queued");
  state.turn = {
    ...state.turn!,
    status: "interrupted",
    error: "The run was interrupted. Please send a new message.",
  };
  panel = await open();
  await expect(panel.getByText("Interrupted", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("The run was interrupted. Please send a new message.", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
  expect(state.commands).toHaveLength(1);
});

test("provisional output replaces snapshots and reconnects read-only, then yields to saved SQL history", async ({
  page,
  workspace,
}) => {
  const f = await assistantFixture(page, workspace);
  f.state.outputEnabled = true;
  const sockets: WebSocketRoute[] = [];
  const closed = new Set<WebSocketRoute>();
  const sentMessages: (string | Buffer)[] = [];
  await page.routeWebSocket(/\/api\/assistant\/output\?/, (socket) => {
    const url = new URL(socket.url());
    const lease = f.state.outputLeases.at(-1)!;
    expect(Object.fromEntries(url.searchParams)).toEqual(lease.scope);
    expect(socket.protocols()).toEqual(["voidnote-output-v1", lease.ticket]);
    socket.onMessage((message) => {
      sentMessages.push(message);
    });
    socket.onClose(() => {
      closed.add(socket);
    });
    sockets.push(socket);
  });
  const panel = await f.open();
  expect(f.state.outputLeases).toHaveLength(0);
  expect(sockets).toHaveLength(0);
  await panel.getByRole("textbox", { name: "Message Assistant" }).fill("What was decided?");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sockets.length).toBe(1);
  const draft = panel.getByRole("article", { name: "Draft response — not yet saved", exact: true });
  sockets[0]!.send(
    JSON.stringify({ type: "snapshot", turnId: f.state.turn!.id, text: "First provisional text" }),
  );
  await expect(draft.getByText("First provisional text", { exact: true })).toBeVisible();
  sockets[0]!.send(
    JSON.stringify({
      type: "snapshot",
      turnId: f.state.turn!.id,
      text: "## Replacement provisional text\n\n**Streamed safely.**",
    }),
  );
  await expect(
    draft.getByRole("heading", { name: "Replacement provisional text", exact: true }),
  ).toBeVisible();
  await expect(draft.getByText("Streamed safely.", { exact: true })).toBeVisible();
  await expect(draft.getByText("First provisional text", { exact: true })).toBeHidden();
  expect(f.state.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
  await sockets[0]!.close({ code: 1000 });
  await expect(draft).toBeHidden();
  await expect.poll(() => sockets.length).toBe(2);
  expect(f.state.outputLeases).toHaveLength(2);
  expect(f.state.outputLeases[1]!.ticket).not.toBe(f.state.outputLeases[0]!.ticket);
  sockets[1]!.send(
    JSON.stringify({
      type: "snapshot",
      turnId: f.state.turn!.id,
      text: "Renewed provisional text",
    }),
  );
  await expect(draft.getByText("Renewed provisional text", { exact: true })).toBeVisible();
  sockets[1]!.send(
    JSON.stringify({ type: "terminal", turnId: f.state.turn!.id, status: "succeeded" }),
  );
  await expect.poll(() => closed.has(sockets[1]!)).toBe(true);
  await expect(draft).toBeVisible();
  await expect(panel.getByText("Completed", { exact: true })).toBeHidden();
  expect(f.state.turn?.status).toBe("queued");
  expect(f.state.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
  f.finish();
  await expect(
    panel.getByText("The team chose Friday. I saved the requested follow-up."),
  ).toBeVisible();
  await expect(draft).toBeHidden();
  expect(f.state.commands).toHaveLength(1);
  expect(f.state.opens).toHaveLength(1);
  expect(sentMessages).toHaveLength(0);
  expect(f.state.outputLeases).toHaveLength(2);
});

test("Stop clears provisional output and closes its read-only socket", async ({
  page,
  workspace,
}) => {
  const f = await assistantFixture(page, workspace);
  f.state.outputEnabled = true;
  const sockets: WebSocketRoute[] = [];
  let closed = false;
  await page.routeWebSocket(/\/api\/assistant\/output\?/, (socket) => {
    sockets.push(socket);
    socket.onClose(() => {
      closed = true;
    });
  });
  const panel = await f.open();
  await panel.getByRole("textbox", { name: "Message Assistant" }).fill("Check the decision.");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sockets.length).toBe(1);
  sockets[0]!.send(
    JSON.stringify({
      type: "snapshot",
      turnId: f.state.turn!.id,
      text: "This is still provisional",
    }),
  );
  const draft = panel.getByRole("article", { name: "Draft response — not yet saved", exact: true });
  await expect(draft).toBeVisible();
  await panel.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(draft).toBeHidden();
  await expect.poll(() => closed).toBe(true);
  await expect.poll(() => f.state.turn?.status).toBe("cancelled");
  expect(f.state.commands).toHaveLength(1);
  expect(f.state.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
});
