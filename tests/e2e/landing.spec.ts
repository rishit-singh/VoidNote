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

for (const provider of ["google"] as const) {
  const label = "Google";

  test(`landing starts ${label} sign-in and locks competing methods during redirect`, async ({
    page,
    workspace,
  }) => {
    workspace.session = null;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: unknown[] = [];
    const authorizeUrl = `https://auth.example.test/auth/v1/authorize?provider=${provider}`;
    await page.route("https://auth.example.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "Provider handoff" }),
    );
    await page.route("**/api/auth/sign-in", async (route) => {
      requests.push(route.request().postDataJSON());
      await held;
      await route.fulfill({ json: { url: authorizeUrl } });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Get started", exact: true }).click();
    await page.getByRole("button", { name: `Continue with ${label}` }).click();
    await expect(page.getByRole("button", { name: `Connecting to ${label}…` })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Send sign-in link", exact: true }),
    ).toBeDisabled();
    await expect(page.getByLabel("Email address")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeVisible();
    release();
    await expect(page).toHaveURL(authorizeUrl);
    expect(requests).toEqual([{ provider }]);

    await page.goBack();
    if (!(await page.getByRole("dialog").isVisible())) {
      await page.getByRole("button", { name: "Get started", exact: true }).click();
    }
    await expect(page.getByRole("button", { name: `Continue with ${label}` })).toBeEnabled();
    await page.getByRole("button", { name: `Continue with ${label}` }).click();
    await expect(page).toHaveURL(authorizeUrl);
    expect(requests).toEqual([{ provider }, { provider }]);
  });
}

test("provider initiation failure restores sign-in methods and preserves the email draft", async ({
  page,
  workspace,
}) => {
  workspace.session = null;
  await page.route("**/api/auth/sign-in", (route) =>
    route.fulfill({ status: 503, json: { error: "auth_unavailable" } }),
  );
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await page.getByLabel("Email address").fill("listener@example.test");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.getByRole("alert")).toContainText("Unable to start sign-in");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toHaveCount(0);
  await expect(page.getByLabel("Email address")).toHaveValue("listener@example.test");
  await expect(page.getByRole("button", { name: "Send sign-in link", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
