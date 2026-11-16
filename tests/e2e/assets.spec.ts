import { expect, test } from "./workspace-fixture";

test("browser icons are declared and served by the built Worker", async ({
  page,
  request,
  workspace,
}) => {
  workspace.session = null;
  await page.goto("/");
  const icons = page.locator('link[rel="icon"], link[rel="apple-touch-icon"]');
  await expect(icons).toHaveCount(3);
  for (const icon of await icons.all()) {
    const href = await icon.getAttribute("href");
    expect(href).toMatch(/^\/assets\/brand\//);
    const response = await request.get(href!);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toMatch(/^image\//);
  }
  // Browsers also request this conventional path without consulting metadata.
  const fallback = await request.get("/favicon.ico");
  expect(fallback.ok()).toBe(true);
  expect((await fallback.body()).subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
  const legacy = await request.get("/logo.svg");
  expect(legacy.ok()).toBe(true);
  expect(legacy.headers()["content-type"]).toContain("image/svg+xml");
});
