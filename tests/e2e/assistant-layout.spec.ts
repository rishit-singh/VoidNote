import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";

import {
  assistantHistoryInputSchema,
  assistantScopeSchema,
  type AssistantMessage,
  type AssistantThread,
} from "../../src/contracts/assistant";
import { conversationSummaryScopeSchema } from "../../src/contracts/conversation-summaries";
import { expect, test, timestamp, workspaceId, type WorkspaceFixture } from "./workspace-fixture";

/** Saved-history layout acceptance, with no inference or mutation requests. */
async function layoutFixture(page: Page, workspace: WorkspaceFixture) {
  const note = workspace.seedNote({ title: "Long conversation layout" });
  const thread: AssistantThread = {
    id: randomUUID(),
    noteId: note.id,
    title: "Layout acceptance",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const longUrl = `https://example.test/${"long-path-segment".repeat(40)}`;
  const columns = Array.from({ length: 24 }, (_, index) => `Column ${index + 1}`);
  const message: AssistantMessage = {
    id: randomUUID(),
    threadId: thread.id,
    turnId: randomUUID(),
    role: "assistant",
    text: [
      "## A detailed answer",
      ...Array.from(
        { length: 20 },
        (_, index) =>
          `Detail ${index + 1}. ${"A useful explanation with enough prose to read and scroll. ".repeat(5)}`,
      ),
      longUrl,
      "```text",
      `local-code-scroll-${"abcdefghij".repeat(100)}`,
      "```",
      [
        `| ${columns.join(" | ")} |`,
        `| ${columns.map(() => "---").join(" | ")} |`,
        `| ${columns.map(() => "Evidence").join(" | ")} |`,
      ].join("\n"),
      "End of detailed answer.",
    ].join("\n\n"),
    tools: [
      ...Array.from({ length: 12 }, (_, index) => ({
        id: randomUUID(),
        name: "notes_get",
        status: "succeeded" as const,
        summary: `Read source note ${index + 1}.`,
        sources: [],
      })),
      {
        id: randomUUID(),
        name: "research_dispatch",
        status: "uncertain",
        summary: "Research acceptance needs confirmation.",
        sources: [],
      },
    ],
    sources: [{ kind: "note", id: note.id, label: "Original note", revision: 1 }],
    createdAt: timestamp,
  };
  await page.route("**/api/assistant.*", async (route) => {
    const request = route.request();
    expect(request.method()).toBe("GET");
    const url = new URL(request.url());
    const raw: unknown = JSON.parse(url.searchParams.get("input") ?? "{}");
    expect(assistantScopeSchema.parse(raw).workspaceId).toBe(workspaceId);
    const ok = (data: unknown) => route.fulfill({ json: { result: { data } } });
    switch (url.pathname) {
      case "/api/assistant.availability":
        assistantScopeSchema.strict().parse(raw);
        return ok({ enabled: true, reason: null });
      case "/api/assistant.threads":
      case "/api/assistant.artifacts":
        assistantScopeSchema.extend({ noteId: z.uuid().optional() }).strict().parse(raw);
        return ok(url.pathname.endsWith(".threads") ? [thread] : []);
      case "/api/assistant.history":
        expect(
          assistantHistoryInputSchema
            .extend({ direction: z.enum(["forward", "backward"]).optional() })
            .strict()
            .parse(raw).threadId,
        ).toBe(thread.id);
        return ok({
          thread,
          messages: [message],
          activeTurn: null,
          latestTurn: null,
          nextCursor: null,
        });
      case "/api/assistant.conversationSummary":
        expect(conversationSummaryScopeSchema.parse(raw).threadId).toBe(thread.id);
        return ok(null);
      default:
        throw new Error(`Unexpected layout request: ${url.pathname}`);
    }
  });
  await page.goto(`/notes/${note.id}`);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const panel = page.getByRole("region", { name: "Assistant", exact: true });
  await expect(panel.getByText("End of detailed answer.", { exact: true })).toBeAttached();
  return { panel, longUrl };
}

async function expectBounded(panel: Locator, page: Page) {
  // Measure stable layout, not two different frames of the dialog's entrance.
  await panel.evaluate(async (node) => {
    const animations = node.closest('[role="dialog"]')?.getAnimations() ?? [];
    await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
  });
  const viewport = panel.locator("[data-radix-scroll-area-viewport]");
  const composer = panel.getByRole("textbox", { name: "Message Assistant" });
  await expect(composer).toBeInViewport({ ratio: 1 });
  await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeInViewport({
    ratio: 1,
  });
  const bounds = await viewport.evaluate((node) => ({
    width: node.clientWidth,
    scrollWidth: node.scrollWidth,
    height: node.clientHeight,
    scrollHeight: node.scrollHeight,
  }));
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.height).toBeGreaterThan(150);
  expect(bounds.scrollHeight).toBeGreaterThan(bounds.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    page.viewportSize()!.width,
  );
  const before = await composer.boundingBox();
  await viewport.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(panel.getByRole("heading", { name: "A detailed answer" })).toBeInViewport();
  expect((await composer.boundingBox())!.y).toBe(before!.y);
  return viewport;
}

async function expectHitTarget(control: Locator) {
  await expect
    .poll(() =>
      control.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return !!hit && node.contains(hit);
      }),
    )
    .toBe(true);
}

test("desktop Ask bounds long prose, URLs and tools, expands reversibly without losing draft or scroll", async ({
  page,
  workspace,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { panel, longUrl } = await layoutFixture(page, workspace);
  const viewport = await expectBounded(panel, page);
  const composer = panel.getByRole("textbox", { name: "Message Assistant" });
  await composer.fill("Keep my draft while resizing.");
  const originalWidth = (await panel.boundingBox())!.width;
  await panel.getByRole("button", { name: "Expand Ask", exact: true }).click();
  await expectHitTarget(page.getByRole("button", { name: "Note actions", exact: true }));
  expect((await panel.boundingBox())!.width).toBeGreaterThan(originalWidth + 80);
  expect(
    (await page.getByRole("region", { name: "Note content", exact: true }).boundingBox())!.width,
  ).toBeGreaterThanOrEqual(280);
  await expect(composer).toHaveValue("Keep my draft while resizing.");
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBe(0);
  await panel.getByRole("button", { name: "Restore Ask width", exact: true }).click();
  expect((await panel.boundingBox())!.width).toBeCloseTo(originalWidth, 0);
  await expect(panel.getByRole("link", { name: longUrl, exact: true })).toHaveCSS(
    "overflow-wrap",
    "anywhere",
  );
  const pre = panel.locator("pre");
  expect(await pre.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await pre.evaluate((node) => {
    node.scrollLeft = 200;
  });
  expect(await pre.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  const tableWrapper = panel.locator("table").locator("..");
  expect(await tableWrapper.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await expect(tableWrapper).toHaveCSS("overflow-x", "auto");
  const activity = panel.locator("summary").filter({ hasText: "Tool activity (13)" });
  await activity.scrollIntoViewIfNeeded();
  await expect(
    panel.getByText("Research acceptance needs confirmation.", { exact: false }).first(),
  ).toBeVisible();
  await expect(panel.getByText("Read source note 1.", { exact: true })).toBeHidden();
  await activity.click();
  await panel.locator("summary").filter({ hasText: "Read note" }).first().click();
  await expect(panel.getByText("Read source note 1.", { exact: true })).toBeVisible();
  await expect(composer).toBeInViewport({ ratio: 1 });
  await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeInViewport({
    ratio: 1,
  });
});

test("mobile Ask keeps composer visible with long history and restores trigger focus", async ({
  page,
  workspace,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { panel } = await layoutFixture(page, workspace);
  const viewport = await expectBounded(panel, page);
  const composer = panel.getByRole("textbox", { name: "Message Assistant" });
  await composer.fill("Mobile draft");
  await viewport.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await panel.locator("summary").filter({ hasText: "Tool activity (13)" }).click();
  await expect(composer).toBeInViewport({ ratio: 1 });
  // A reduced layout viewport approximates keyboard pressure, not a real
  // mobile keyboard or visualViewport acceptance test.
  await page.setViewportSize({ width: 390, height: 480 });
  await expect(composer).toBeInViewport({ ratio: 1 });
  await expectHitTarget(composer);
  await expectHitTarget(panel.getByRole("button", { name: "Send", exact: true }));
  await page
    .getByRole("dialog", { name: "Ask", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Ask", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(composer).toHaveValue("Mobile draft");
  await expect(composer).toBeInViewport({ ratio: 1 });
  expect(workspace.mutations).toHaveLength(0);
});

test("Ask retains its reading anchor and follow preference across expansion and responsive hosts", async ({
  page,
  workspace,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { panel } = await layoutFixture(page, workspace);
  const viewport = panel.locator("[data-radix-scroll-area-viewport]");
  const paragraph = panel.locator("p").filter({ hasText: /^Detail 10\./ });
  await paragraph.evaluate((node) => {
    const scroller = node.closest<HTMLElement>("[data-radix-scroll-area-viewport]")!;
    scroller.scrollTop +=
      node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 20;
    scroller.dispatchEvent(new Event("scroll"));
  });
  const offset = () =>
    paragraph.evaluate(
      (node) =>
        node.getBoundingClientRect().top -
        node.closest("[data-radix-scroll-area-viewport]")!.getBoundingClientRect().top,
    );
  await expect.poll(offset).toBeCloseTo(-20, 0);
  await panel.getByRole("button", { name: "Expand Ask", exact: true }).click();
  await expect.poll(offset).toBeCloseTo(-20, 0);
  await panel.getByRole("button", { name: "Restore Ask width", exact: true }).click();
  await expect.poll(offset).toBeCloseTo(-20, 0);
  for (const width of [390, 1440, 1100, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(offset).toBeCloseTo(-20, 0);
    expect(
      await viewport.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
    ).toBeGreaterThan(200);
  }
  await viewport.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll"));
  });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        viewport.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
      )
      .toBeLessThanOrEqual(1);
  }
});

test("desktop Ask Send stays hit-testable above the active recording dock", async ({
  page,
  workspace,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: () => {
        const audio = new AudioContext();
        return Promise.resolve(audio.createMediaStreamDestination().stream);
      },
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const { panel } = await layoutFixture(page, workspace);
  const dock = page.getByRole("region", { name: "Audio recorder", exact: true });
  await dock.getByRole("button", { name: "Record", exact: true }).click();
  await expect(dock.getByRole("button", { name: "Stop recording", exact: true })).toBeVisible();
  const composer = panel.getByRole("textbox", { name: "Message Assistant" });
  await composer.fill("A question while recording");
  const send = panel.getByRole("button", { name: "Send", exact: true });
  for (const height of [900, 650]) {
    await page.setViewportSize({ width: 1440, height });
    await expectHitTarget(send);
    await expectHitTarget(composer);
    const [sendBox, dockBox] = await Promise.all([send.boundingBox(), dock.boundingBox()]);
    expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(dockBox!.y);
  }
});
