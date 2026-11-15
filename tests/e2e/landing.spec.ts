import { expect, test } from "./workspace-fixture";

test("landing opens email sign-in, restores focus, and enters the authenticated workspace", async ({
  page,
  workspace,
}) => {
  const session = workspace.session;
  workspace.session = null;
  await page.route("**/api/auth/sign-in", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Stay in the conversation." })).toBeVisible();
  const start = page.getByRole("button", { name: "Get started", exact: true });
  await start.click();
  await page.getByLabel("Email address").fill("listener@example.test");
  await page.getByRole("button", { name: "Send sign-in link", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");
  await page.keyboard.press("Escape");
  await expect(start).toBeFocused();
  await start.click();
  workspace.session = session;
  await page.getByRole("button", { name: "Already opened your link? Check sign-in" }).click();
  await expect(page.getByRole("heading", { name: "Notes", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stay in the conversation." })).toHaveCount(0);
});

test("landing demo fits mobile and respects reduced motion", async ({
  page,
  workspace,
}, testInfo) => {
  workspace.session = null;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Stay in the conversation." })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page
      .locator(".vn-demo-passage")
      .first()
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
  await page.getByRole("button", { name: "Assign to Jamie" }).click();
  await expect(page.locator(".vn-correction-action")).toContainText("Jamie");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".vn-correction-action > span")).toHaveText("Alex");
  await page.getByRole("button", { name: "Replay demo" }).click();
  await page.screenshot({ path: testInfo.outputPath("landing-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.screenshot({ path: testInfo.outputPath("landing-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  expect(
    await page.getByRole("dialog").evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
});

test("landing keeps session errors visible and allows retry", async ({ page, workspace }) => {
  workspace.session = null;
  await page.route("**/api/session", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.goto("/");
  const retry = page.getByRole("button", { name: "Retry connection" });
  await expect(retry).toBeVisible();
  await page.unroute("**/api/session");
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Get started", exact: true })).toBeVisible();
});
