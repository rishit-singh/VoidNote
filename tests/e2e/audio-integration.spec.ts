import type { Page } from "@playwright/test";
import { expect, test } from "./workspace-fixture";

// Real Chromium getUserMedia + MediaRecorder + audio decoder. No recorder stub.
test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});

function wav(seconds = 12) {
  const rate = 8000;
  const dataLength = seconds * rate * 2;
  const bytes = Buffer.alloc(44 + dataLength);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + dataLength, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataLength, 40);
  for (let index = 0; index < seconds * rate; index++)
    bytes.writeInt16LE(
      Math.round(Math.sin((index * 2 * Math.PI * 220) / rate) * 1000),
      44 + index * 2,
    );
  return bytes;
}

async function upload(page: Page) {
  const bytes = wav();
  await page
    .getByLabel("Upload audio", { exact: true })
    .setInputFiles({ name: "voice.wav", mimeType: "audio/wav", buffer: bytes });
  await expect(page.getByRole("button", { name: "Play audio", exact: true })).toBeEnabled();
  return bytes;
}

async function savedChunks(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("voidnote-recordings", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to inspect local audio"));
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = db.transaction("chunks").objectStore("chunks").count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Unable to count saved chunks"));
      });
    } finally {
      db.close();
    }
  });
}

test("real microphone capture stops into one player that unloads on unrelated routes", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Persistent capture" });
  await page.goto(`/notes/${note.id}`);
  await expect(page.locator("audio")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Record", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop recording", exact: true })).toBeVisible();
  await expect.poll(() => savedChunks(page)).toBeGreaterThanOrEqual(6);
  await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  await expect(page.getByRole("button", { name: "Play audio", exact: true })).toBeEnabled();
  const audio = page.getByTestId("persistent-audio");
  await expect
    .poll(() =>
      audio.evaluate(
        (element: HTMLAudioElement) => Number.isFinite(element.duration) && element.duration > 0,
      ),
    )
    .toBe(true);
  await expect(page.getByRole("slider", { name: "Seek audio", exact: true })).toBeEnabled();
  await audio.evaluate((element) => {
    element.setAttribute("data-integration-owner", "original");
  });
  await page.getByRole("button", { name: "Play audio", exact: true }).click();
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(0.1);
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await expect(audio).toHaveAttribute("data-integration-owner", "original");
  await expect(page.locator("audio")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Pause playback", exact: true })).toHaveCount(0);
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.paused && !el.getAttribute("src")))
    .toBe(true);
  await page
    .getByRole("complementary")
    .getByRole("link", { name: note.title, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/notes/${note.id}$`));
  await expect(audio).toHaveAttribute("data-integration-owner", "original");
  await expect(page.getByRole("button", { name: "Play audio", exact: true })).toBeEnabled();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
});

test("uploaded audio reloads from IndexedDB, seeks, and plays without another player", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Local upload" });
  await page.goto(`/notes/${note.id}`);
  const bytes = await upload(page);
  await page.reload();
  await expect(page.locator("audio")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Play audio", exact: true })).toBeEnabled();
  const audio = page.getByTestId("persistent-audio");
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.duration)).toBe(12);
  const seek = page.getByRole("slider", { name: "Seek audio", exact: true });
  await expect(seek).toBeEnabled();
  await seek.focus();
  await seek.press("Home");
  for (let index = 0; index < 20; index++) await seek.press("ArrowRight");
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(1.5);
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeLessThan(2.5);
  const download = page.getByRole("link", { name: "Download audio", exact: true });
  const size = await download.evaluate(
    async (link) => (await (await fetch(link.getAttribute("href")!)).arrayBuffer()).byteLength,
  );
  expect(size).toBe(bytes.length);
  await page.getByRole("button", { name: "Play audio", exact: true }).click();
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true);
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("link", { name: "Home", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Pause playback", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator("audio")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Play audio", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pause playback", exact: true })).toHaveCount(0);
});

test("sign-out unloads playing audio and revokes its player URL", async ({ page, workspace }) => {
  const note = workspace.seedNote();
  await page.goto(`/notes/${note.id}`);
  await upload(page);
  await page.getByRole("button", { name: "Play audio", exact: true }).click();
  const audio = page.getByTestId("persistent-audio");
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true);
  const oldUrl = await audio.getAttribute("src");
  // Retain the actual DOM node so unmounting it cannot hide a still-playing resource.
  await audio.evaluate((element) => Reflect.set(window, "oldIntegrationAudio", element));
  await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
  await page.getByRole("button", { name: "Discard and sign out", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const element = Reflect.get(window, "oldIntegrationAudio") as HTMLAudioElement;
        return element.paused && !element.getAttribute("src");
      }),
    )
    .toBe(true);
  await expect(page.getByRole("link", { name: "Download audio", exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(async (url) => {
      try {
        await fetch(url!);
        return false;
      } catch {
        return true;
      }
    }, oldUrl),
  ).toBe(true);
});

test("a rejected browser play request is visible and never shown as playing", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote();
  await page.goto(`/notes/${note.id}`);
  await upload(page);
  await page.evaluate(() => {
    HTMLMediaElement.prototype.play = () =>
      Promise.reject(new DOMException("Playback blocked for test", "NotAllowedError"));
  });
  await page.getByRole("button", { name: "Play audio", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Playback needs attention" }),
  ).toContainText("Playback blocked for test");
  await expect(page.getByRole("button", { name: "Pause playback", exact: true })).toHaveCount(0);
});

test("deleting the owner note stops and unloads its persistent playback", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote();
  await page.goto(`/notes/${note.id}`);
  await upload(page);
  await page.getByRole("button", { name: "Play audio", exact: true }).click();
  const audio = page.getByTestId("persistent-audio");
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true);
  await page.getByRole("button", { name: "Note actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete note", exact: true }).click();
  await expect
    .poll(() =>
      audio.evaluate((element: HTMLAudioElement) => element.paused && !element.getAttribute("src")),
    )
    .toBe(true);
  await expect(page.getByRole("link", { name: "Download audio", exact: true })).toHaveCount(0);
});
