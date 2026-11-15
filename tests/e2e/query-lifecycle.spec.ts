import type { Page } from "@playwright/test";
import { expect, test, workspaceId, type WorkspaceFixture } from "./workspace-fixture";

// Client-cache regressions using the test-only RPC-to-REST transport bridge.
// These counts are logical RPC calls, including page.route overrides; they are
// not evidence of production tRPC/DB behavior (covered by backend tests).
function calls(workspace: WorkspaceFixture, procedure: string, id?: string) {
  return workspace.rpcRequests.filter(
    (call) =>
      call.procedure === procedure &&
      (id === undefined || call.input.id === id || call.input.noteId === id),
  );
}

async function expectEmptyNoteReady(page: Page, title: string) {
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(title);
  await expect(page.locator("button").filter({ hasText: /^Upload audio$/ })).toBeEnabled();
  await expect(
    page.getByText("Your transcript will appear here after recording.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("persistent-audio")).toHaveCount(1);
}

test("note audio, actions, transcript and persistent player share one overview request", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "One shared recording query" });
  let release!: () => void;
  const pendingOverview = new Promise<void>((resolve) => {
    release = resolve;
  });
  let overviewReads = 0;
  await page.route(
    `**/api/workspaces/${workspaceId}/notes/${note.id}/recordings`,
    async (route) => {
      expect(route.request().method()).toBe("GET");
      overviewReads++;
      await pendingOverview;
      await route.fulfill({ json: { recordings: [], runs: [] } });
    },
  );
  try {
    await page.goto(`/notes/${note.id}`);
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(note.title);
    await expect(page.getByRole("button", { name: "Note actions", exact: true })).toBeVisible();
    await expect(page.locator("button").filter({ hasText: /^Upload audio$/ })).toBeDisabled();
    await expect(page.getByLabel("Loading transcript", { exact: true })).toBeVisible();
    await expect(page.getByTestId("persistent-audio")).toHaveCount(1);
    await expect.poll(() => overviewReads).toBe(1);
    // All three note consumers plus shell polling and the player are mounted
    // while the same request is deliberately still in flight.
    expect(calls(workspace, "recordings.overview", note.id)).toHaveLength(1);
  } finally {
    release();
  }
  await expectEmptyNoteReady(page, note.title);
  expect(overviewReads).toBe(1);
  expect(calls(workspace, "recordings.overview", note.id)).toHaveLength(1);
});

test("title autosave updates the note without refetching its recording overview", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Before autosave" });
  await page.goto(`/notes/${note.id}`);
  await expectEmptyNoteReady(page, note.title);
  expect(calls(workspace, "recordings.overview", note.id)).toHaveLength(1);
  await page.getByLabel("Title", { exact: true }).fill("After autosave");
  await expect.poll(() => workspace.notes.get(note.id)?.title).toBe("After autosave");
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
  await expect(
    page.getByRole("complementary").getByRole("link", { name: "After autosave", exact: true }),
  ).toBeVisible();
  expect(calls(workspace, "notes.save")).toHaveLength(1);
  expect(calls(workspace, "recordings.overview", note.id)).toHaveLength(1);
  expect(workspace.rpcRequests.filter((call) => call.procedure.startsWith("people."))).toEqual([]);
});

test("client-side return navigation reuses fresh note detail and overview caches", async ({
  page,
  workspace,
}) => {
  const first = workspace.seedNote({ title: "Cached first note" });
  const second = workspace.seedNote({ title: "Cached second note" });
  // Keep Date.now fixed while real timers run, so this tests a fresh cache even
  // on a slow CI machine rather than accidentally crossing the 15s stale time.
  await page.clock.setFixedTime(new Date("2026-11-14T12:00:00.000Z"));
  await page.goto(`/notes/${first.id}`);
  await expectEmptyNoteReady(page, first.title);
  expect(calls(workspace, "notes.get", first.id)).toHaveLength(1);
  expect(calls(workspace, "recordings.overview", first.id)).toHaveLength(1);

  const sidebar = page.getByRole("complementary");
  await sidebar.getByRole("link", { name: second.title, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/notes/${second.id}$`));
  await expectEmptyNoteReady(page, second.title);
  expect(calls(workspace, "notes.get", second.id)).toHaveLength(1);
  expect(calls(workspace, "recordings.overview", second.id)).toHaveLength(1);

  await sidebar.getByRole("link", { name: first.title, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/notes/${first.id}$`));
  await expectEmptyNoteReady(page, first.title);
  expect(calls(workspace, "notes.get", first.id)).toHaveLength(1);
  expect(calls(workspace, "recordings.overview", first.id)).toHaveLength(1);
});

test("acknowledged title stays visible while the list refresh is held open", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({
    title: "Before delayed refresh",
    transcript: "Keep this text",
  });
  await page.goto(`/notes/${note.id}`);
  await expectEmptyNoteReady(page, note.title);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshing = false;
  await page.route(`**/api/workspaces/${workspaceId}/notes?*`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    refreshing = true;
    await held;
    await route.fallback();
  });
  try {
    await page.getByLabel("Title", { exact: true }).fill("Acknowledged without refresh");
    await expect.poll(() => refreshing).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
    await expect(
      page
        .getByRole("complementary")
        .getByRole("link", { name: "Acknowledged without refresh", exact: true }),
    ).toBeVisible();
    expect(workspace.notes.get(note.id)?.transcript).toBe("Keep this text");
    await page.getByLabel("Title", { exact: true }).fill("Newer typing survives");
    await expect.poll(() => workspace.notes.get(note.id)?.title).toBe("Newer typing survives");
    await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
  } finally {
    release();
  }
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Newer typing survives");
});

test("opening a note loads sidebar notes without eagerly fetching unrelated people", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Focused note" });
  const unrelated = workspace.seedNote({ title: "Sidebar-only note" });
  workspace.seedPerson({ displayName: "Unopened profile" });
  await page.goto(`/notes/${note.id}`);
  await expectEmptyNoteReady(page, note.title);
  await expect(
    page.getByRole("complementary").getByRole("link", { name: unrelated.title, exact: true }),
  ).toBeVisible();
  expect(calls(workspace, "notes.list").length).toBeGreaterThan(0);
  expect(calls(workspace, "notes.get", unrelated.id)).toHaveLength(0);
  expect(calls(workspace, "recordings.overview", unrelated.id)).toHaveLength(0);
  expect(workspace.rpcRequests.filter((call) => call.procedure.startsWith("people."))).toEqual([]);
});

test("replayed save cannot restore a deleted note while list refresh is blocked", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Deleted after uncertain save" });
  await page.goto(`/notes/${note.id}`);
  await expectEmptyNoteReady(page, note.title);
  workspace.nextMutation = "lost-response";
  await page.getByLabel("Title", { exact: true }).fill("Original committed title");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  const command = workspace.mutations[0]!.command;
  const committed = workspace.notes.get(note.id)!;
  workspace.notes.set(note.id, {
    ...committed,
    revision: committed.revision + 1,
    deletedAt: new Date().toISOString(),
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/workspaces/${workspaceId}/notes?*`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await held;
    await route.fallback();
  });
  try {
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByText("Note not found", { exact: true })).toBeVisible();
    await expect(page.locator(`a[href="/notes/${note.id}"]`)).toHaveCount(0);
    expect(workspace.mutations[1]!.command).toEqual(command);
  } finally {
    release();
  }
});
