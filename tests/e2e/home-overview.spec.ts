import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { expect, test, timestamp } from "./workspace-fixture";

function metric(overview: Locator, label: string) {
  return overview
    .getByRole("term")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator("..")
    .getByRole("definition");
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

test("desktop totals stay independent of note pagination and search", async ({
  page,
  workspace,
}) => {
  const first = workspace.seedNote({ title: "Alpha conversation" });
  const second = workspace.seedNote({ title: "Beta conversation" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/workspaces/*/overview", (route) =>
    route.fulfill({
      json: {
        notes: 157,
        profiles: 19,
        recordings: 84,
        recordedSeconds: 9387,
        recentRecordings: [
          {
            id: randomUUID(),
            noteId: first.id,
            title: first.title,
            durationSeconds: 125,
            createdAt: timestamp,
          },
        ],
      },
    }),
  );
  await page.route("**/api/workspaces/*/notes?*", (route) => {
    const query = new URL(route.request().url()).searchParams;
    const filtered = query.get("q");
    const nextPage = query.has("cursor");
    return route.fulfill({
      json: {
        items: filtered ? [second] : nextPage ? [second] : [first],
        nextCursor: filtered || nextPage ? null : "second-page",
      },
    });
  });
  await page.goto("/");
  const overview = page.getByRole("region", { name: "Workspace overview", exact: true });
  const notes = page.getByRole("list", { name: "Notes", exact: true });
  await expect(metric(overview, "Notes")).toHaveText("157");
  await expect(metric(overview, "Recordings")).toHaveText("84");
  await expect(metric(overview, "Recorded time")).toHaveText("2h 36m 27s");
  await expect(notes.getByRole("link")).toHaveCount(1);
  await page.getByRole("button", { name: "Load more notes" }).click();
  await expect(notes.getByRole("link")).toHaveCount(2);
  await expect(metric(overview, "Notes")).toHaveText("157");
  await page.getByRole("searchbox", { name: "Search notes" }).fill("Beta");
  await expect(notes.getByRole("link")).toHaveCount(1);
  await expect(notes.getByRole("link")).toContainText(second.title);
  await expect(metric(overview, "Notes")).toHaveText("157");
  const notesBox = await page.getByRole("region", { name: "Notes", exact: true }).boundingBox();
  const recentBox = await page.getByRole("region", { name: "Recently recorded" }).boundingBox();
  expect(recentBox!.x).toBeGreaterThan(notesBox!.x + notesBox!.width);
  await expectNoOverflow(page);
  await page.screenshot({ path: test.info().outputPath("home-desktop.png"), fullPage: true });
});

test("mobile recent recordings are bounded, fit long titles and open their note", async ({
  page,
  workspace,
}) => {
  const notes = Array.from({ length: 4 }, (_, index) =>
    workspace.seedNote({
      title: `Recording ${index + 1} — ${"A long conversation title ".repeat(8)}`,
    }),
  );
  const deleted = workspace.seedNote({ title: "Deleted recording", deletedAt: timestamp });
  workspace.overviewRecordings = [...notes, deleted].map((note) => ({
    id: randomUUID(),
    noteId: note.id,
    title: note.title,
    durationSeconds: 65,
    createdAt: timestamp,
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const overview = page.getByRole("region", { name: "Workspace overview", exact: true });
  await expect(metric(overview, "Notes")).toHaveText("4");
  await expect(metric(overview, "Recordings")).toHaveText("4");
  await expect(metric(overview, "Recorded time")).toHaveText("4m 20s");
  const recent = page.getByRole("list", { name: "Recent recordings", exact: true });
  await expect(recent.getByRole("link")).toHaveCount(3);
  await expect(recent).not.toContainText(deleted.title);
  const notesBox = await page.getByRole("region", { name: "Notes", exact: true }).boundingBox();
  const recentBox = await page.getByRole("region", { name: "Recently recorded" }).boundingBox();
  expect(recentBox!.y).toBeGreaterThan(notesBox!.y + notesBox!.height);
  await expectNoOverflow(page);
  await page.screenshot({ path: test.info().outputPath("home-mobile.png"), fullPage: true });
  await page.getByRole("region", { name: "Home content", exact: true }).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(
    await page
      .getByRole("main", { name: "Notes", exact: true })
      .evaluate((element) => element.scrollTop),
  ).toBe(0);
  const lastRecording = await recent.getByRole("link").last().boundingBox();
  const mobileNavigation = await page
    .getByRole("navigation", { name: "Mobile workspace navigation" })
    .boundingBox();
  expect(lastRecording!.y + lastRecording!.height).toBeLessThanOrEqual(mobileNavigation!.y);
  await page.screenshot({ path: test.info().outputPath("home-mobile-recent.png"), fullPage: true });
  await recent.getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`/notes/${notes[0]!.id}$`));
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(notes[0]!.title);
});

test("pending overview does not show zero totals or block notes", async ({ page, workspace }) => {
  const note = workspace.seedNote({ title: "Available while loading" });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/workspaces/*/overview", async (route) => {
    await held;
    await route.fallback();
  });
  try {
    await page.goto("/");
    const overview = page.getByRole("region", { name: "Workspace overview", exact: true });
    await expect(overview.getByRole("status")).toHaveText("Loading overview");
    await expect(metric(overview, "Notes")).toHaveText("");
    await expect(page.getByText("No recordings yet", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: "Notes", exact: true }).getByRole("link"),
    ).toContainText(note.title);
    await expect(page.getByRole("button", { name: "New note", exact: true })).toBeEnabled();
  } finally {
    release();
  }
  await expect(
    metric(page.getByRole("region", { name: "Workspace overview" }), "Notes"),
  ).toHaveText("1");
});

test("overview failure keeps search and note navigation available without false totals", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Still accessible" });
  workspace.seedNote({ title: "Another note" });
  await page.route("**/api/workspaces/*/overview", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Overview temporarily unavailable." },
    }),
  );
  await page.goto("/");
  const overview = page.getByRole("region", { name: "Workspace overview", exact: true });
  await expect(overview.getByRole("alert")).toContainText("Overview unavailable.");
  await expect(overview.getByRole("definition")).toHaveCount(0);
  await expect(overview.getByRole("button", { name: "Retry overview" })).toBeEnabled();
  await expect(page.getByText("No recordings yet", { exact: true })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search notes" }).fill("Still");
  const notes = page.getByRole("list", { name: "Notes", exact: true });
  await expect(notes.getByRole("link")).toHaveCount(1);
  await notes.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/notes/${note.id}$`));
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(note.title);
});
