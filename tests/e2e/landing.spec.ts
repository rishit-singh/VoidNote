import { expect, test } from "./workspace-fixture";

test("landing opens email sign-in, restores focus, and enters the authenticated workspace", async ({
  page,
  workspace,
}) => {
  const session = workspace.session;
  workspace.session = null;
  await page.route("**/api/auth/sign-in", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Every conversation builds reusable context." }),
  ).toBeVisible();
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
  await expect(
    page.getByRole("heading", { name: "Every conversation builds reusable context." }),
  ).toHaveCount(0);
});

test("landing demo fits mobile and respects reduced motion", async ({
  page,
  workspace,
}, testInfo) => {
  workspace.session = null;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Every conversation builds reusable context." }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  for (const width of [320, 375, 390, 430, 640, 768]) {
    await page.setViewportSize({ width, height: 812 });
    // Page scrollWidth alone misses text clipped by the demo cards or landing wrapper.
    const clippedText = await page.locator(".vn-landing").evaluate((landing) => {
      const walker = document.createTreeWalker(landing, NodeFilter.SHOW_TEXT);
      const clipped: string[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1)) {
            clipped.push(node.textContent.trim());
          }
        }
      }
      return clipped;
    });
    expect(clippedText, `text fits at ${width}px`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width <= 430) {
      await page.screenshot({ path: testInfo.outputPath(`landing-${width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page
      .locator(".vn-demo-passage")
      .first()
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
  await expect(page.locator(".vn-demo-passage").first()).toHaveCSS("opacity", "1");
  await expect(page.locator(".vn-demo-passage").first()).toHaveCSS("transform", "none");
  await page.getByRole("link", { name: "Jamie ↗" }).click();
  await expect(page).toHaveURL(/#profiles$/);
  await page.getByRole("button", { name: "Replay demo" }).click();
  await page.locator(".vn-followup-question").scrollIntoViewIfNeeded();
  await expect(page.locator(".vn-followup-question")).toHaveCSS("opacity", "1");
  await expect(page.locator(".vn-followup-question")).toHaveCSS("transform", "none");
  await page.screenshot({ path: testInfo.outputPath("landing-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.screenshot({ path: testInfo.outputPath("landing-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  expect(
    await page.getByRole("dialog").evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
});

test("demo replay animates and settles immediately when reduced motion is enabled", async ({
  page,
  workspace,
}) => {
  workspace.session = null;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const replay = page.getByRole("button", { name: "Replay demo" });
  await replay.click();
  const passage = page.locator(".vn-demo-passage").first();
  await expect
    .poll(() => passage.evaluate((element) => Number(getComputedStyle(element).opacity)))
    .toBeLessThan(0.99);
  await expect(replay).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(passage).toHaveCSS("opacity", "1");
  await expect(passage).toHaveCSS("transform", "none");
  await replay.click();
  // Observe the full reveal window: a single assertion can pass before Motion starts.
  const minimumOpacity = await passage.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        const deadline = performance.now() + 900;
        let minimum = 1;
        const sample = () => {
          minimum = Math.min(minimum, Number(getComputedStyle(element).opacity));
          if (performance.now() >= deadline) {
            resolve(minimum);
          } else {
            requestAnimationFrame(sample);
          }
        };
        sample();
      }),
  );
  expect(minimumOpacity).toBe(1);
  await expect(replay).toBeFocused();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await replay.click();
  await expect
    .poll(() => passage.evaluate((element) => Number(getComputedStyle(element).opacity)))
    .toBeLessThan(0.99);
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
