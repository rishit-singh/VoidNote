import type { Page } from "@playwright/test";
import { expect, test, userId, workspaceId } from "./workspace-fixture";

const preferenceStorageKey = "voidnote-recording-preferences-v1";

test("recording preference hydration validates stored data and defaults safely", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    if (sessionStorage.getItem("preferences-seeded")) return;
    sessionStorage.setItem("preferences-seeded", "true");
    localStorage.setItem(
      key,
      JSON.stringify({
        state: { byOwner: { malformed: { deviceId: 12, liveText: "yes" } } },
        version: 0,
      }),
    );
  }, preferenceStorageKey);
  await page.goto("/settings");
  await expect(page.getByRole("status").filter({ hasText: /invalid|reset/i })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Browser live text" })).not.toBeChecked();
  const waveform = page.getByRole("switch", { name: "Microphone waveform" });
  await expect(waveform).toBeChecked();
  await waveform.click();
  await expect(page.getByRole("status").filter({ hasText: "saved on this device" })).toBeVisible();
  await page.reload();
  await expect(waveform).not.toBeChecked();
  await page.getByRole("button", { name: "Reset recording preferences" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Using browser defaults" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Microphone waveform" })).toBeChecked();
  await expect(page.getByRole("status").filter({ hasText: /invalid|reset/i })).toHaveCount(0);
});

test("recording preference read failures are visible", async ({ page }) => {
  await page.addInitScript((key) => {
    const original = localStorage.getItem.bind(localStorage);
    Storage.prototype.getItem = function (name) {
      if (name === key) throw new DOMException("Storage unavailable", "SecurityError");
      return original(name);
    };
  }, preferenceStorageKey);
  await page.goto("/settings");
  await expect(page.getByRole("status").filter({ hasText: "could not be read" })).toBeVisible();
});

test("preference controls persist their actual values and report storage failures", async ({
  page,
}) => {
  await page.addInitScript(() => {
    class SpeechRecognitionMock {
      start() {}
      abort() {}
    }
    Object.defineProperty(window, "SpeechRecognition", { value: SpeechRecognitionMock });
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", {
      value: () =>
        Promise.resolve([{ kind: "audioinput", deviceId: "device-42", label: "Test microphone" }]),
    });
  });
  await page.goto("/settings");
  const liveText = page.getByRole("switch", { name: "Browser live text" });
  const waveform = page.getByRole("switch", { name: "Microphone waveform" });
  await page.getByRole("combobox", { name: "Microphone" }).click();
  await page.getByRole("option", { name: "Test microphone" }).click();
  await liveText.click();
  await waveform.click();
  await expect(liveText).toBeChecked();
  await expect(waveform).not.toBeChecked();
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const data = JSON.parse(localStorage.getItem(key) ?? "{}") as unknown as {
          state?: {
            byOwner?: Record<string, { deviceId?: string; liveText?: boolean; waveform?: boolean }>;
          };
        };
        const owner = Object.values(data.state?.byOwner ?? {})[0] as
          { deviceId?: string; liveText?: boolean; waveform?: boolean } | undefined;
        return owner && [owner.deviceId, owner.liveText, owner.waveform];
      }, preferenceStorageKey),
    )
    .toEqual(["device-42", true, false]);

  await page.evaluate((key) => {
    const original = localStorage.setItem.bind(localStorage);
    let failWrites = true;
    Object.defineProperty(window, "failPreferenceWrites", {
      value: (fail: boolean) => {
        failWrites = fail;
      },
    });
    Storage.prototype.setItem = function (name, value) {
      if (name === key && failWrites)
        throw new DOMException("Storage disabled", "QuotaExceededError");
      return original(name, value);
    };
  }, preferenceStorageKey);
  await waveform.click();
  await expect(page.getByRole("status").filter({ hasText: "could not be saved" })).toBeVisible();
  await page.evaluate(() =>
    (window as Window & { failPreferenceWrites?: (fail: boolean) => void }).failPreferenceWrites?.(
      false,
    ),
  );
  await waveform.click();
  await expect(page.getByRole("status").filter({ hasText: "saved on this device" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Microphone waveform" })).not.toBeChecked();
  await expect(page.getByRole("status").filter({ hasText: "could not be saved" })).toHaveCount(0);
});

async function installLiveCapture(page: Page) {
  await page.addInitScript(
    ({ key, ownerKey }) => {
      class FakeRecognition {
        static instances: FakeRecognition[] = [];
        onstart: (() => void) | null = null;
        onend: (() => void) | null = null;
        onerror: ((event: { error: string }) => void) | null = null;
        onresult:
          | ((event: {
              resultIndex: number;
              results: Array<{ isFinal: boolean; 0: { transcript: string } }>;
            }) => void)
          | null = null;
        continuous = false;
        interimResults = false;
        start() {
          FakeRecognition.instances.push(this);
          this.onstart?.();
        }
        abort() {
          this.onend?.();
        }
      }
      Object.defineProperty(window, "SpeechRecognition", { value: FakeRecognition });
      Object.defineProperty(window, "endFakeRecognition", {
        value: () => FakeRecognition.instances.at(-1)?.onend?.(),
      });
      Object.defineProperty(window, "emitFakeSpeech", {
        value: (text: string) =>
          FakeRecognition.instances.at(-1)?.onresult?.({
            resultIndex: 0,
            results: [{ isFinal: true, 0: { transcript: text } }],
          }),
      });
      Object.defineProperty(window, "recognitionInstanceCount", {
        get: () => FakeRecognition.instances.length,
      });
      const prior = localStorage.getItem(key);
      const data = (prior
        ? JSON.parse(prior)
        : { state: { byOwner: {} }, version: 0 }) as unknown as {
        state: {
          byOwner: Record<string, { deviceId: string; liveText: boolean; waveform: boolean }>;
        };
      };
      data.state.byOwner[ownerKey] = { deviceId: "selected-mic", liveText: true, waveform: true };
      localStorage.setItem(key, JSON.stringify(data));
      let startedCount = 0;
      let constraints: MediaStreamConstraints | undefined;
      Object.defineProperty(window, "captureStartedCount", { get: () => startedCount });
      Object.defineProperty(window, "captureAudioConstraints", { get: () => constraints?.audio });
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        value: (options: MediaStreamConstraints) => {
          constraints = options;
          return Promise.resolve(new AudioContext().createMediaStreamDestination().stream);
        },
      });
      class FakeRecorder extends EventTarget {
        static isTypeSupported() {
          return true;
        }
        state: RecordingState = "inactive";
        mimeType = "audio/wav";
        ondataavailable: ((event: BlobEvent) => void) | null = null;
        onstop: (() => void) | null = null;
        onpause: (() => void) | null = null;
        onresume: (() => void) | null = null;
        start() {
          startedCount += 1;
          this.state = "recording";
        }
        requestData() {
          this.ondataavailable?.(
            new BlobEvent("dataavailable", {
              data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType }),
            }),
          );
        }
        pause() {
          this.state = "paused";
          this.onpause?.();
        }
        resume() {
          this.state = "recording";
          this.onresume?.();
        }
        stop() {
          this.state = "inactive";
          this.requestData();
          queueMicrotask(() => this.onstop?.());
        }
      }
      window.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder;
    },
    { key: preferenceStorageKey, ownerKey: `${userId}:${workspaceId}` },
  );
}

async function emitSpeech(page: Page, text: string) {
  await page.evaluate((text) => {
    const emit = Reflect.get(window, "emitFakeSpeech") as (text: string) => void;
    emit(text);
  }, text);
}

async function captureManifests(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("voidnote-recordings", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to read recordings"));
    });
    try {
      return await new Promise<
        Array<{ id: string; noteId: string; status: string; chunkCount: number; byteCount: number }>
      >((resolve, reject) => {
        const request = db.transaction("sessions").objectStore("sessions").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Unable to read manifests"));
      });
    } finally {
      db.close();
    }
  });
}

test("live speech stays a scoped preview while titles autosave and audio keeps its owner", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Recording owner", transcript: "Legacy saved text" });
  const other = workspace.seedNote({ title: "Other note" });
  await installLiveCapture(page);
  await page.goto(`/notes/${note.id}`);
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause recording", exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "recognitionInstanceCount") as number))
    .toBe(1);
  const [started] = await captureManifests(page);
  expect(started?.noteId).toBe(note.id);

  await emitSpeech(page, "First provisional words");
  const transcript = page.getByRole("region", { name: "Transcript", exact: true });
  await expect(transcript.getByText("Live preview", { exact: true })).toBeVisible();
  await expect(transcript.getByText("First provisional words", { exact: true })).toBeVisible();
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let saveStarted = false;
  await page.route(`**/api/workspaces/${workspaceId}/notes`, async (route) => {
    if (route.request().method() === "POST" && !saveStarted) {
      saveStarted = true;
      await saveGate;
    }
    await route.fallback();
  });
  try {
    await page.getByLabel("Title", { exact: true }).fill("Renamed during capture");
    await expect.poll(() => saveStarted).toBe(true);
    await emitSpeech(page, "More provisional words while rename is pending");
    await page.getByLabel("Title", { exact: true }).fill("Final recording title");
  } finally {
    releaseSave();
  }
  await expect.poll(() => workspace.notes.get(note.id)?.title).toBe("Final recording title");
  const saves = workspace.mutations.length;
  await emitSpeech(page, "Speech after the last rename");
  // Observe beyond the title debounce: speech alone must not create another save.
  await page.waitForTimeout(900);
  expect(workspace.mutations).toHaveLength(saves);
  expect(workspace.notes.get(note.id)?.transcript).toBe("Legacy saved text");
  for (const { command } of workspace.mutations) {
    expect(command.id).toBe(note.id);
    expect(JSON.stringify(command.content)).not.toContain("provisional");
    expect(JSON.stringify(command.content)).not.toContain("Speech after");
  }
  await expect(page.getByText("This note changed elsewhere.", { exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await page.locator(`a[href="/notes/${other.id}"]`).first().click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(other.title);
  await emitSpeech(page, "Words while viewing another note");
  await expect(page.getByText("Live preview", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Words while viewing another note", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await page.locator(`a[href="/notes/${note.id}"]`).first().click();
  await expect(transcript).toContainText("Words while viewing another note");
  await page.getByRole("button", { name: "Pause recording", exact: true }).click();
  await expect.poll(async () => (await captureManifests(page))[0]?.chunkCount).toBe(1);
  await page.getByRole("button", { name: "Resume recording", exact: true }).click();
  await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  await expect.poll(async () => (await captureManifests(page))[0]?.status).toBe("finalized");
  const [finished] = await captureManifests(page);
  expect(finished).toMatchObject({
    id: started!.id,
    noteId: note.id,
    chunkCount: 2,
    byteCount: 8,
  });
  expect(await page.evaluate(() => Reflect.get(window, "captureStartedCount") as number)).toBe(1);
  expect(workspace.notes.get(other.id)?.transcript).toBe("");
  await page.reload();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Final recording title");
  await expect(page.getByText("Live preview", { exact: true })).toHaveCount(0);
  expect(workspace.notes.get(note.id)?.transcript).toBe("Legacy saved text");
});

test("live speech during Use latest cannot retain or resave a discarded title", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Original title" });
  await installLiveCapture(page);
  await page.goto(`/notes/${note.id}`);
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "recognitionInstanceCount") as number))
    .toBe(1);
  const latest = workspace.seedNote({ ...note, title: "Latest server title", revision: 2 });
  await page.getByLabel("Title", { exact: true }).fill("Discard this title");
  await expect(page.getByText("This note changed elsewhere.", { exact: true })).toBeVisible();
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let readStarted = false;
  await page.route(`**/api/workspaces/${workspaceId}/notes/${note.id}?*`, async (route) => {
    if (new URL(route.request().url()).searchParams.get("includeDeleted") !== "true") {
      await route.fallback();
      return;
    }
    readStarted = true;
    await readGate;
    await route.fulfill({ json: latest });
  });
  try {
    await page.getByRole("button", { name: "Use latest", exact: true }).click();
    await expect.poll(() => readStarted).toBe(true);
    await emitSpeech(page, "Speech during conflict resolution");
    await expect(
      page.getByText("Speech during conflict resolution", { exact: true }),
    ).toBeVisible();
    releaseRead();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(latest.title);
    await emitSpeech(page, "Speech after conflict resolution");
    // A preview update must not restart the title autosave debounce.
    await page.waitForTimeout(900);
    expect(workspace.mutations).toHaveLength(1);
    expect(workspace.notes.get(note.id)).toEqual(latest);
    await expect(page.getByText("This note changed elsewhere.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pause recording", exact: true })).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, "captureStartedCount") as number)).toBe(1);
    await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  } finally {
    releaseRead();
  }
});

test("live text can explicitly restart after recognition ends without restarting audio capture", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Speech recognition" });
  await installLiveCapture(page);
  await page.goto(`/notes/${note.id}`);
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause recording" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { captureAudioConstraints?: unknown }).captureAudioConstraints,
      ),
    )
    .toEqual({ deviceId: { exact: "selected-mic" } });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { recognitionInstanceCount?: number }).recognitionInstanceCount ?? 0,
      ),
    )
    .toBe(1);
  await page.evaluate(() =>
    (window as Window & { endFakeRecognition?: () => void }).endFakeRecognition?.(),
  );
  await expect(page.getByText(/Live preview paused/i)).toBeVisible();
  await page.getByRole("button", { name: "Retry live text" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { recognitionInstanceCount?: number }).recognitionInstanceCount ?? 0,
      ),
    )
    .toBe(2);
  await expect(page.getByRole("button", { name: "Pause recording" })).toBeVisible();
  await page.getByRole("button", { name: "Stop recording" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { captureStartedCount?: number }).captureStartedCount ?? 0,
      ),
    )
    .toBe(1);
});
