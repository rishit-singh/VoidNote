import type { Locator, Page } from "@playwright/test";
import { test, expect, workspaceId } from "./workspace-fixture";

test.use({ reducedMotion: "reduce" });

async function top(locator: Locator) {
  return locator.evaluate((element) => element.getBoundingClientRect().top);
}

async function expectContained(page: Page) {
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const bounds = await page.locator("#main-content").boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

test("a populated desktop sidebar keeps account actions reachable in a short viewport", async ({
  page,
  workspace,
}) => {
  await page.setViewportSize({ width: 1440, height: 560 });
  for (let index = 0; index < 5; index++) {
    workspace.seedNote({ title: `Sidebar note ${index}` });
  }
  await page.goto("/settings");
  const sidebar = page.getByRole("complementary", { name: "Primary navigation" });
  await expect(sidebar.getByRole("link", { name: /Sidebar note/ })).toHaveCount(5);
  const signOut = sidebar.getByRole("button", { name: "Sign out", exact: true });
  await signOut.scrollIntoViewIfNeeded();
  const bounds = await signOut.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(560);
  expect(await sidebar.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expectContained(page);
});

for (const status of [404, 500]) {
  test(`profile loading and ${status} fallbacks show back links only without the desktop list`, async ({
    page,
    workspace,
  }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    const person = workspace.seedPerson({ displayName: "Unavailable layout profile" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detailRequests = 0;
    // The fixture adapts people.get to its legacy HTTP boundary before fetch.
    // Intercept that boundary so the seeded list entry cannot resolve the detail.
    await page.route(
      (url) => url.pathname === `/api/workspaces/${workspaceId}/people/${person.id}`,
      async (route) => {
        detailRequests++;
        await gate;
        await route.fulfill({
          status,
          json: {
            error: "Layout profile request failed.",
            code: status === 404 ? "not_found" : "internal_error",
          },
        });
      },
    );
    try {
      await page.goto(`/profiles/${person.id}`);
      await expect.poll(() => detailRequests).toBeGreaterThan(0);
      await expect(page.getByText("Loading profile…", { exact: true })).toBeVisible();
      const back = page.getByRole("link", { name: "Back to profiles", exact: true });
      await expect(back).toBeHidden();
      await page.setViewportSize({ width: 390, height: 700 });
      await expect(back).toBeVisible();
      release();
      await expect(
        page.getByText(status === 404 ? "Profile not found" : "Layout profile request failed.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(back).toBeVisible();
      await page.setViewportSize({ width: 1440, height: 700 });
      await expect(back).toBeHidden();
    } finally {
      release();
    }
  });
}

for (const width of [1440, 390]) {
  test(`profile picker and close control fit a short viewport at ${width}px`, async ({
    page,
    workspace,
  }) => {
    await page.setViewportSize({ width, height: 360 });
    for (let index = 0; index < 25; index++) {
      workspace.seedPerson({ displayName: `Picker profile ${index}` });
    }
    await page.goto("/my-profile");
    await page.getByRole("button", { name: "Use an existing profile", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: "Picker profile 0", exact: true }),
    ).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(360);
    await dialog
      .getByRole("button", { name: "Picker profile 9", exact: true })
      .scrollIntoViewIfNeeded();
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    const closeBounds = await close.boundingBox();
    expect(closeBounds!.y).toBeGreaterThanOrEqual(bounds!.y);
    expect(closeBounds!.y + closeBounds!.height).toBeLessThanOrEqual(360);
    await close.click();
    await expect(dialog).toBeHidden();
    await expectContained(page);
  });
}

for (const width of [1440, 390]) {
  test(`Home keeps heading and search attached while notes scroll at ${width}px`, async ({
    page,
    workspace,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    for (let index = 0; index < 30; index++) {
      workspace.seedNote({ title: `Layout note ${index}` });
    }
    await page.goto("/");
    const heading = page.getByRole("heading", { name: "Home", exact: true });
    const search = page.getByRole("searchbox", { name: "Search notes" });
    await expect(search).toBeVisible();
    const headingTop = await top(heading);
    const firstNote = page.getByRole("list", { name: "Notes", exact: true }).locator("li").first();
    const noteTop = await top(firstNote);
    await page.locator("#main-content").evaluate((element) => {
      element.scrollTop = 450;
    });
    await expect.poll(() => top(heading)).toBeCloseTo(headingTop, 0);
    expect(await top(firstNote)).toBeLessThan(noteTop - 300);
    const searchTop = await top(search);
    expect(searchTop).toBeGreaterThan(headingTop);
    await page.locator("#main-content").evaluate((element) => {
      element.scrollTop += 100;
    });
    await expect.poll(() => top(search)).toBeCloseTo(searchTop, 0);
    await expectContained(page);
  });

  test(`Settings retains its page and section headers at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 560 });
    await page.goto("/settings");
    const heading = page.getByRole("heading", { name: "Settings", exact: true });
    await expect(heading).toBeVisible();
    const headingTop = await top(heading);
    const sectionHeading = page.getByRole("heading", { name: "Recording", exact: true });
    await page.locator("#main-content").evaluate((element) => {
      element.scrollTop = 110;
    });
    await expect.poll(() => top(heading)).toBeCloseTo(headingTop, 0);
    expect(await top(sectionHeading)).toBeGreaterThan(headingTop);
    const sectionTop = await top(sectionHeading);
    await page.locator("#main-content").evaluate((element) => {
      element.scrollTop += 20;
    });
    await expect.poll(() => top(sectionHeading)).toBeCloseTo(sectionTop, 0);
    await expectContained(page);
  });

  test(`Profile controls stay attached with the correct scroll owner at ${width}px`, async ({
    page,
    workspace,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    const person = workspace.seedPerson({ displayName: "Layout profile" });
    for (let index = 0; index < 30; index++) {
      workspace.seedPerson({ displayName: `Other profile ${index}` });
    }
    await page.goto(`/profiles/${person.id}`);
    const name = page.getByRole("textbox", { name: "Display name", exact: true });
    await expect(name).toHaveValue("Layout profile");
    const heading = page.getByRole("heading", { name: "Profiles", exact: true });
    const headingTop = await top(heading);
    const back = page.getByRole("link", { name: "← Profiles", exact: true });
    const content = page.locator("[data-profile-content]");
    const profileHeading = content.getByRole("heading", { name: "Layout profile", exact: true });
    const controls = content.locator(":scope > div").first();
    const mainTop = await top(page.locator("#main-content"));
    const headerHeight = width > 760 ? 104 : 90;
    await expect(controls).toHaveCSS("position", "sticky");
    await expect(controls).toHaveCSS("top", width > 1100 ? "0px" : `${headerHeight}px`);
    const controlsTop = mainTop + headerHeight;
    await expect.poll(() => top(controls)).toBeCloseTo(controlsTop, 1);
    const controlsPadding = await controls.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingTop),
    );
    if (width > 1100) {
      await expect(back).toBeHidden();
      const list = page.getByRole("complementary", { name: "Profiles", exact: true });
      const search = page.getByRole("searchbox", { name: "Search profiles" });
      const searchTop = await top(search);
      await list.evaluate((element) => {
        element.scrollTop = 300;
      });
      expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(200);
      await expect.poll(() => top(search)).toBeCloseTo(searchTop, 0);
      expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
      await content.evaluate((element) => {
        element.scrollTop = 300;
      });
      expect(await content.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
      expect(await page.locator("#main-content").evaluate((element) => element.scrollTop)).toBe(0);
      await expect.poll(() => top(controls)).toBeCloseTo(controlsTop, 1);
      await expect.poll(() => top(profileHeading)).toBeCloseTo(controlsTop + controlsPadding, 1);
    } else {
      await expect(back).toBeVisible();
      await page.locator("#main-content").evaluate((element) => {
        element.scrollTop = 300;
      });
      expect(
        await page.locator("#main-content").evaluate((element) => element.scrollTop),
      ).toBeGreaterThan(100);
      expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
      await expect.poll(() => top(controls)).toBeCloseTo(controlsTop, 1);
      await expect.poll(() => top(profileHeading)).toBeCloseTo(controlsTop + controlsPadding, 1);
      const nav = await page
        .getByRole("navigation", { name: "Mobile workspace navigation" })
        .boundingBox();
      expect(nav!.y + nav!.height).toBeLessThanOrEqual(700);
    }
    await expect.poll(() => top(heading)).toBeCloseTo(headingTop, 0);
    await expectContained(page);
  });

  test(`My profile keeps one scrolling surface below its header at ${width}px`, async ({
    page,
    workspace,
  }) => {
    await page.setViewportSize({ width, height: 560 });
    const person = workspace.seedPerson({ displayName: "My layout profile" });
    workspace.selfPersonId = person.id;
    await page.goto("/my-profile");
    await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue(
      person.displayName,
    );
    const heading = page.getByRole("heading", { name: "My profile", exact: true });
    const headingTop = await top(heading);
    const main = page.locator("#main-content");
    await main.evaluate((element) => {
      element.scrollTop = 350;
    });
    expect(await main.evaluate((element) => element.scrollTop)).toBeGreaterThan(200);
    await expect.poll(() => top(heading)).toBeCloseTo(headingTop, 0);
    expect(
      await page.locator("[data-profile-content]").evaluate((element) => element.scrollTop),
    ).toBe(0);
    await expectContained(page);
  });
}
