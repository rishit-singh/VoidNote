import { expect, test, workspaceId } from "./workspace-fixture";

test("mobile notifications preserve focus, avoid bottom controls, and support keyboard dismissal", async ({
  page,
  workspace,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const person = workspace.seedPerson();
  const note = workspace.seedNote({ title: "Mobile toast placement" });
  await page.goto(`/profiles/${person.id}`);

  let releaseSave!: () => void;
  const saveHeld = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let saving = false;
  await page.route(`**/api/workspaces/${workspaceId}/people`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    saving = true;
    await saveHeld;
    await route.fallback();
  });

  try {
    await page.getByLabel("Display name", { exact: true }).fill("Mobile profile save");
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect.poll(() => saving).toBe(true);

    // Complete an explicit save on the next route, where both bottom surfaces exist.
    const navigation = page.getByRole("navigation", { name: "Mobile workspace navigation" });
    await navigation.getByRole("link", { name: "Home", exact: true }).click();
    await page.getByRole("link", { name: /Mobile toast placement/ }).click();
    const title = page.getByLabel("Title", { exact: true });
    const recorder = page.getByRole("region", { name: "Audio recorder", exact: true });
    await expect(title).toHaveValue(note.title);
    await expect(recorder).toBeVisible();
    await title.focus();
    releaseSave();

    const notifications = page.getByRole("region", { name: /^Notifications\b/ });
    const notification = notifications
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Profile saved" });
    await expect(notifications).toHaveAttribute("aria-live", "polite");
    await expect(notification).toBeVisible();
    // Hover pauses Sonner's dismissal timer without moving keyboard focus.
    await notification.hover();
    await expect(title).toBeFocused();

    const bounds = await notification.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) throw new Error("The mobile notification has no visible bounds.");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    for (const controls of [navigation, recorder]) {
      await expect(controls).toBeVisible();
      const controlsBounds = await controls.boundingBox();
      expect(controlsBounds).not.toBeNull();
      if (!controlsBounds) throw new Error("Essential mobile controls have no visible bounds.");
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(controlsBounds.y);
    }

    await page.keyboard.press("Alt+t");
    await expect(notifications.getByRole("list")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(notification).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      notification.getByRole("button", { name: "Dismiss notification", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(notification).toHaveCount(0);
  } finally {
    releaseSave();
  }
});

test("profile save toast waits for acknowledgement, not list refresh, and survives navigation", async ({
  page,
  workspace,
}) => {
  const person = workspace.seedPerson();
  await page.goto(`/profiles/${person.id}`);
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(person.displayName);
  let releaseSave!: () => void;
  let releaseRefresh!: () => void;
  const saveHeld = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const refreshHeld = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let saving = false;
  await page.route(`**/api/workspaces/${workspaceId}/people`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    saving = true;
    await saveHeld;
    await route.fallback();
  });
  await page.route(`**/api/workspaces/${workspaceId}/people?*`, async (route) => {
    await refreshHeld;
    await route.fallback();
  });
  try {
    await page.getByLabel("Display name", { exact: true }).fill("Acknowledged profile");
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect.poll(() => saving).toBe(true);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    releaseSave();
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Profile saved" });
    await expect(toast).toBeVisible();
    await page.getByRole("link", { name: "Home", exact: true }).first().click();
    await expect(page).toHaveURL("/");
    await expect(toast).toBeVisible();
    await page.getByRole("button", { name: "Dismiss notification", exact: true }).click();
    await expect(toast).toHaveCount(0);
  } finally {
    releaseSave();
    releaseRefresh();
  }
});

test("lost profile response retains inline retry and only announces success after exact retry", async ({
  page,
  workspace,
}) => {
  const person = workspace.seedPerson();
  await page.goto(`/profiles/${person.id}`);
  workspace.nextMutation = "lost-response";
  await page.getByLabel("Display name", { exact: true }).fill("Recoverable profile");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry pending change" })).toBeVisible();
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toBeVisible();
  await expect(page.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0);
  const command = workspace.mutations[0]!.command;
  await page.getByRole("button", { name: "Retry pending change" }).click();
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Profile saved" }),
  ).toBeVisible();
  expect(workspace.mutations[1]!.command).toEqual(command);
});

test("verified sign-out clears notifications from the outgoing account", async ({
  page,
  workspace,
}) => {
  const person = workspace.seedPerson();
  await page.goto(`/profiles/${person.id}`);
  await page.getByLabel("Display name", { exact: true }).fill("Saved before sign-out");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Profile saved" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check sign-in", exact: true })).toBeVisible();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("note deletion announces acknowledgement after navigation even while list refresh waits", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote();
  await page.goto(`/notes/${note.id}`);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(note.title);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/workspaces/${workspaceId}/notes?*`, async (route) => {
    await held;
    await route.fallback();
  });
  try {
    await page.getByRole("button", { name: "Note actions" }).click();
    await page.getByRole("menuitem", { name: "Delete note" }).click();
    await expect(page).toHaveURL("/");
    await expect(
      page.locator("[data-sonner-toast]").filter({ hasText: "Note deleted" }),
    ).toBeVisible();
    expect(workspace.notes.get(note.id)?.deletedAt).toBeTruthy();
  } finally {
    release();
  }
});

for (const response of ["tombstone", "404"] as const) {
  test(`use latest removes a remotely deleted note after ${response} without a false error toast`, async ({
    page,
    workspace,
  }) => {
    const note = workspace.seedNote();
    await page.goto(`/notes/${note.id}`);
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(note.title);
    workspace.nextMutation = "conflict";
    await page.getByLabel("Title", { exact: true }).fill("Conflicting local title");
    await expect(page.getByRole("button", { name: "Use latest", exact: true })).toBeVisible();
    if (response === "tombstone") {
      workspace.notes.set(note.id, {
        ...note,
        revision: note.revision + 1,
        deletedAt: new Date().toISOString(),
      });
    } else {
      workspace.notes.delete(note.id);
    }

    await page.getByRole("button", { name: "Use latest", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(
      page
        .locator('[data-sonner-toast][data-type="info"]')
        .filter({ hasText: "Deleted note removed" }),
    ).toBeVisible();
    await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
    await expect(page.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0);
  });
}

test("start over keeps the original and opens an untitled draft without speculative success", async ({
  page,
  workspace,
}) => {
  const original = workspace.seedNote({ title: "Keep this recording note" });
  await page.goto(`/notes/${original.id}`);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(original.title);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saving = false;
  await page.route(`**/api/workspaces/${workspaceId}/notes`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    saving = true;
    await held;
    await route.fallback();
  });
  try {
    await page.getByRole("button", { name: "Note actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Duplicate", exact: true })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Start over in a new note" }).click();
    await expect(page).not.toHaveURL(`/notes/${original.id}`);
    await expect.poll(() => saving).toBe(true);
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("");
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    expect(workspace.notes.get(original.id)).toEqual(original);
  } finally {
    release();
  }
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});
