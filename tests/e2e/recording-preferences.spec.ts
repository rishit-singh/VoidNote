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

test("live text can explicitly restart after recognition ends without restarting audio capture", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Speech recognition" });
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
