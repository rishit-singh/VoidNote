import { expect, test } from "./workspace-fixture";

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 820, height: 900 },
]) {
  test(`workspace navigation and new note at ${viewport.width}px`, async ({ page, workspace }) => {
    workspace.seedNote({
      title: "Product sync",
      transcript: "Review the next iteration with the team.",
    });
    workspace.seedNote({
      title: "Research conversation",
      transcript: "Capture feedback and questions.",
    });
    workspace.seedPerson({ displayName: "Alex Rivera", description: "Product designer" });
    await page.setViewportSize(viewport);
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle("VoidNote");
    await expect(page.getByRole("list", { name: "Notes", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("home.png"), fullPage: true });
    await expect(page.getByRole("button", { name: "New note", exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "New note", exact: true }).click();
    await expect(page.getByLabel("Title", { exact: true })).toBeEditable();
    await expect(page.getByRole("textbox", { name: "Transcript", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Note actions", exact: true })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("new-note.png"), fullPage: true });
    await expect(page.getByRole("button", { name: "Record", exact: true })).toBeInViewport();
    await page.getByRole("button", { name: "Note actions", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Note actions", exact: true })).toBeInViewport();
    await page.getByRole("link", { name: "Settings", exact: true }).first().click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("settings.png"), fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.goBack();
    await expect(page.getByLabel("Title", { exact: true })).toBeEditable();
    await page.getByRole("link", { name: "Profiles", exact: true }).first().click();
    await expect(page).toHaveURL(/\/profiles$/);
    await page.getByRole("link", { name: /Alex Rivera/ }).click();
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue("Alex Rivera");
    expect(
      (await page.getByLabel("Description", { exact: true }).boundingBox())?.width,
    ).toBeGreaterThan(300);
    await page.screenshot({ path: test.info().outputPath("profile.png"), fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test("direct links restore server notes without incidental generation", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({
    title: "Garden plans",
    transcript: "Discuss the garden layout on Monday.",
  });
  await page.goto(`/notes/${note.id}`);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(note.title);
  await page.reload();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(note.title);
  expect(workspace.mutations).toEqual([]);
  expect(workspace.requests.some((request) => request.includes("/api/chat"))).toBe(false);
});

test("Home initializes once and search does not replace recent navigation", async ({
  page,
  workspace,
}) => {
  const first = workspace.seedNote({ title: "Alpha conversation" });
  const second = workspace.seedNote({ title: "Beta conversation" });
  await page.goto("/");
  await expect(
    page.getByRole("list", { name: "Notes", exact: true }).getByRole("link"),
  ).toHaveCount(2);
  expect(workspace.requests.filter((request) => /^GET .*\/notes\?/.test(request))).toHaveLength(1);
  expect(workspace.requests.filter((request) => /^GET .*\/people\?/.test(request))).toHaveLength(0);
  await page.getByRole("searchbox", { name: "Search notes" }).fill("Alpha");
  await expect
    .poll(() => workspace.requests.some((request) => request.includes("q=Alpha")))
    .toBe(true);
  await page.getByRole("list", { name: "Notes", exact: true }).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/notes/${first.id}$`));
  await expect(
    page
      .getByRole("complementary", { name: "Primary navigation" })
      .getByRole("link", { name: second.title }),
  ).toBeVisible();
});

test("missing deep link can retry in place when the record becomes available", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote();
  workspace.notes.delete(note.id);
  await page.goto(`/notes/${note.id}`);
  await expect(page.getByText("Note not found", { exact: true })).toBeVisible();
  workspace.notes.set(note.id, note);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(note.title);
  expect(workspace.requests.filter((request) => request === "GET /api/session")).toHaveLength(1);
});
