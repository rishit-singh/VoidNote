import { expect, test, workspaceId } from "./workspace-fixture";

test("profile acknowledgement preserves full content and newer typing while refresh waits", async ({
  page,
  workspace,
}) => {
  const description = "Full description beyond the list preview. ".repeat(80);
  const person = workspace.seedPerson({ displayName: "Before", description });
  await page.goto(`/profiles/${person.id}`);
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(description);

  let releaseSave!: () => void;
  let releaseRefresh!: () => void;
  const saveHeld = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const refreshHeld = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let saving = false;
  let refreshing = false;
  await page.route(`**/api/workspaces/${workspaceId}/people`, async (route) => {
    if (route.request().method() !== "POST" || saving) return route.fallback();
    saving = true;
    await saveHeld;
    await route.fallback();
  });
  await page.route(`**/api/workspaces/${workspaceId}/people?*`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    refreshing = true;
    await refreshHeld;
    await route.fallback();
  });
  try {
    await page.getByLabel("Display name", { exact: true }).fill("Acknowledged name");
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect.poll(() => saving).toBe(true);
    await expect(
      page.getByRole("status").filter({ hasText: /^Request in progress$/ }),
    ).toBeVisible();
    await page.getByLabel("Display name", { exact: true }).fill("Newer draft");
    releaseSave();
    await expect.poll(() => refreshing).toBe(true);
    await expect(page.getByRole("button", { name: "Save profile", exact: true })).toBeEnabled();
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue("Newer draft");
    expect(workspace.people.get(person.id)?.displayName).toBe("Acknowledged name");
    expect(workspace.people.get(person.id)?.description).toBe(description);
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
    await expect(
      page
        .getByRole("complementary", { name: "Profiles", exact: true })
        .getByRole("link")
        .filter({ hasText: "Newer draft" }),
    ).toBeVisible();
    expect(workspace.people.get(person.id)?.description).toBe(description);
    expect(workspace.mutations[1]!.command.expectedRevision).toBe(2);
  } finally {
    releaseSave();
    releaseRefresh();
  }
});

test("replayed profile receipt cannot restore a later deletion with refresh blocked", async ({
  page,
  workspace,
}) => {
  const person = workspace.seedPerson({ displayName: "Before deletion" });
  await page.goto(`/profiles/${person.id}`);
  workspace.nextMutation = "lost-response";
  await page.getByLabel("Display name", { exact: true }).fill("Committed name");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry pending change" })).toBeVisible();
  const command = workspace.mutations[0]!.command;
  const committed = workspace.people.get(person.id)!;
  workspace.people.set(person.id, {
    ...committed,
    revision: committed.revision + 1,
    deletedAt: new Date().toISOString(),
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/workspaces/${workspaceId}/people?*`, async (route) => {
    await held;
    await route.fallback();
  });
  try {
    await page.getByRole("button", { name: "Retry pending change" }).click();
    await expect(page.getByText("Profile not found", { exact: true })).toBeVisible();
    await expect(page.locator(`a[href="/profiles/${person.id}"]`)).toHaveCount(0);
    expect(workspace.mutations[1]!.command).toEqual(command);
  } finally {
    release();
  }
});

test("profile deletion leaves the list immediately after acknowledgement", async ({
  page,
  workspace,
}) => {
  const person = workspace.seedPerson({ displayName: "Delete without refresh" });
  await page.goto(`/profiles/${person.id}`);
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(person.displayName);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/workspaces/${workspaceId}/people?*`, async (route) => {
    await held;
    await route.fallback();
  });
  try {
    await page.getByRole("button", { name: "Delete profile", exact: true }).click();
    await expect(page.getByText("Profile not found", { exact: true })).toBeVisible();
    await expect(page.locator(`a[href="/profiles/${person.id}"]`)).toHaveCount(0);
  } finally {
    release();
  }
});
