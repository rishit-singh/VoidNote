import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  recordingInputSchema,
  type RemoteRecording,
} from "../../src/contracts/recording-processing";
import type { LocalRecordingSession } from "../../src/lib/recording-schemas";
import { expect, test, timestamp, workspaceId } from "./workspace-fixture";

// Native capture needs a worker-scoped launch option; fault tests replace its API.
test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

async function installMicrophone(page: Page, denied = false, holdSession = false) {
  await page.addInitScript(
    ({ denied, holdSession }) => {
      let failStorage = false;
      let abortManifest = false;
      let holdingSession = holdSession;
      let startedCount = 0;
      Object.defineProperty(window, "releaseCaptureSession", {
        value: () => {
          holdingSession = false;
        },
      });
      Object.defineProperty(window, "captureStartedCount", { get: () => startedCount });
      // Native method intentionally retains its call-site receiver below.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const add = IDBObjectStore.prototype.add;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        const value: unknown = args[0];
        if (
          abortManifest &&
          this.name === "sessions" &&
          value &&
          typeof value === "object" &&
          Reflect.get(value, "chunkCount") > 0
        ) {
          this.transaction.abort();
          throw new DOMException("Test manifest commit aborted", "AbortError");
        }
        const request = put.apply(this, args);
        if (
          holdingSession &&
          this.name === "sessions" &&
          value &&
          typeof value === "object" &&
          Reflect.get(value, "status") === "recording"
        ) {
          Reflect.set(window, "captureSessionWritePending", true);
          const get = this.get.bind(this);
          const id: unknown = Reflect.get(value, "id");
          if (typeof id === "string")
            request.addEventListener("success", () => {
              // Keep this actual transaction open until the test clicks Cancel.
              const keepAlive = () => {
                if (holdingSession) get(id).addEventListener("success", keepAlive);
              };
              keepAlive();
            });
        }
        return request;
      };
      Object.defineProperty(window, "abortCaptureManifest", {
        value: () => {
          abortManifest = true;
        },
      });
      IDBObjectStore.prototype.add = function (...args) {
        if (failStorage && this.name === "chunks")
          throw new DOMException("Test disk full", "QuotaExceededError");
        return add.apply(this, args);
      };
      Object.defineProperty(window, "failCaptureStorage", {
        value: () => {
          failStorage = true;
        },
      });
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        value: () => {
          if (denied)
            return Promise.reject(
              new DOMException("Microphone permission denied", "NotAllowedError"),
            );
          const context = new AudioContext();
          const destination = context.createMediaStreamDestination();
          return Promise.resolve(destination.stream);
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
        private timer = 0;
        start() {
          startedCount++;
          this.state = "recording";
          this.timer = window.setInterval(() => {
            if (this.state === "recording") this.requestData();
          }, 40);
        }
        requestData() {
          const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType });
          this.ondataavailable?.(new BlobEvent("dataavailable", { data: blob }));
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
          window.clearInterval(this.timer);
          queueMicrotask(() => {
            this.requestData();
            this.onstop?.();
          });
        }
      }
      window.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder;
    },
    { denied, holdSession },
  );
}

async function manifests(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("voidnote-recordings", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to read local recordings"));
    });
    try {
      return await new Promise<LocalRecordingSession[]>((resolve, reject) => {
        const request = db.transaction("sessions").objectStore("sessions").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Unable to read manifest"));
      });
    } finally {
      db.close();
    }
  });
}

test("capture survives navigation, pauses, resumes, drains final audio and reloads", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Capture owner" });
  await installMicrophone(page);
  await page.goto(`/notes/${note.id}`);
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause recording", exact: true })).toBeVisible();
  await expect.poll(async () => (await manifests(page))[0]?.chunkCount ?? 0).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const signOut = page.getByRole("alertdialog", { name: "Recording in progress" });
  await expect(signOut).toBeVisible();
  expect(workspace.signOutCount).toBe(0);
  const chunksBeforeDismiss = (await manifests(page))[0]!.chunkCount;
  await expect
    .poll(async () => (await manifests(page))[0]?.chunkCount ?? 0)
    .toBeGreaterThan(chunksBeforeDismiss);
  await signOut.getByRole("button", { name: "Back", exact: true }).click();
  await expect(signOut).toHaveCount(0);
  expect(workspace.signOutCount).toBe(0);
  await expect(page.getByRole("button", { name: "Pause recording", exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Pause recording", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume recording", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume recording", exact: true }).click();
  await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  await expect.poll(async () => (await manifests(page))[0]?.status).toBe("finalized");
  const [manifest] = await manifests(page);
  expect(manifest?.noteId).toBe(note.id);
  expect(manifest?.byteCount).toBe((manifest?.chunkCount ?? 0) * 4);
  await page.goto(`/notes/${note.id}`);
  await expect(page.getByRole("link", { name: "Download audio", exact: true })).toHaveAttribute(
    "href",
    /^blob:/,
  );
});

test("cancelling a pending session commit never waits for an unstarted recorder", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote();
  await installMicrophone(page, false, true);
  await page.goto(`/notes/${note.id}`);
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, "captureSessionWritePending") as boolean | undefined),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => {
    const release = Reflect.get(window, "releaseCaptureSession") as () => void;
    release();
  });
  await expect.poll(async () => (await manifests(page))[0]?.status).toBe("failed");
  expect(await page.evaluate(() => Reflect.get(window, "captureStartedCount") as number)).toBe(0);
  await expect(page.getByRole("button", { name: "Record", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop recording", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await manifests(page)).filter((session) => session.status === "finalized").length,
    )
    .toBe(1);
});

test("denied microphone preserves the note transcript and persisted uploaded audio", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ transcript: "Keep these words" });
  await installMicrophone(page, true);
  await page.goto(`/notes/${note.id}`);
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Audio needs attention" })).toContainText(
    "Microphone permission denied",
  );
  await page.getByLabel("Upload audio", { exact: true }).setInputFiles({
    name: "original.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from([9, 8, 7, 6]),
  });
  const download = page.getByRole("link", { name: "Download audio", exact: true });
  await expect(download).toHaveAttribute("href", /^blob:/);
  const original = await download.getAttribute("href");
  await expect(page.getByRole("button", { name: "Record", exact: true })).toHaveCount(0);
  await expect(download).toHaveAttribute("href", original!);
  expect(await manifests(page)).toHaveLength(1);
  expect(workspace.notes.get(note.id)?.transcript).toBe("Keep these words");
  await page.reload();
  await expect(download).toHaveAttribute("href", /^blob:/);
  const bytes = await download.evaluate(async (link) => [
    ...new Uint8Array(await (await fetch(link.getAttribute("href")!)).arrayBuffer()),
  ]);
  expect(bytes).toEqual([9, 8, 7, 6]);
});

test("storage failure cannot mark a capture ready", async ({ page, workspace }) => {
  const note = workspace.seedNote();
  await installMicrophone(page);
  await page.goto(`/notes/${note.id}`);
  await page.evaluate(() => {
    const fail = Reflect.get(window, "failCaptureStorage") as () => void;
    fail();
  });
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Audio needs attention" })).toContainText(
    "Test disk full",
  );
  await expect.poll(async () => (await manifests(page))[0]?.status).toBe("failed");
  expect((await manifests(page))[0]?.chunkCount).toBe(0);
  await expect(page.getByRole("link", { name: "Download audio", exact: true })).toHaveCount(0);
});

test.describe("new-note real capture with mocked upload/processing transport", () => {
  for (const title of ["", "Renamed before recording"]) {
    test(`${title ? "renamed" : "untitled"} note waits for creation and submits captured audio`, async ({
      page,
      workspace,
    }) => {
      let noteId = "";
      const acknowledgedAtMicrophone: boolean[] = [];
      await page.exposeFunction("observeMicrophoneRequest", () => {
        acknowledgedAtMicrophone.push(workspace.notes.has(noteId));
      });
      await page.addInitScript(() => {
        const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const observe = Reflect.get(window, "observeMicrophoneRequest") as () => Promise<void>;
          await observe();
          return getUserMedia(constraints);
        };
      });

      let releaseCreate!: () => void;
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      let creating = false;
      await page.route(`**/api/workspaces/${workspaceId}/notes`, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        creating = true;
        await createGate;
        await route.fallback();
      });

      // Native getUserMedia, MediaRecorder, IndexedDB and duration parsing run here.
      // Only the server transport is mocked; database/provider acceptance is separate.
      let recording: RemoteRecording | undefined;
      let uploaded: Buffer | null = null;
      let submissions = 0;
      try {
        await page.goto("/");
        await page.getByRole("button", { name: "New note", exact: true }).first().click();
        await expect(page).toHaveURL(/\/notes\/[^/]+$/);
        noteId = page.url().split("/notes/")[1]!;
        const root = `/api/workspaces/${workspaceId}/notes/${noteId}`;
        await page.route(`**${root}/**`, async (route) => {
          const request = route.request();
          const path = new URL(request.url()).pathname.slice(root.length);
          if (path === "/recordings" && request.method() === "GET") {
            await route.fulfill({ json: { recordings: recording ? [recording] : [], runs: [] } });
          } else if (path === "/recordings" && request.method() === "POST") {
            const input = recordingInputSchema.parse(request.postDataJSON());
            recording = {
              ...input,
              workspaceId,
              noteId,
              status: "upload_pending",
              createdAt: timestamp,
            };
            await route.fulfill({ json: recording });
          } else if (
            recording &&
            path === `/recordings/${recording.id}/audio` &&
            request.method() === "PUT"
          ) {
            uploaded = request.postDataBuffer();
            recording.status = "ready";
            await route.fulfill({ json: recording });
          } else if (recording && path === "/processing" && request.method() === "POST") {
            expect(uploaded).not.toBeNull();
            expect(request.postDataJSON()).toEqual({ id: recording.id, recordingId: recording.id });
            submissions++;
            await route.fulfill({
              json: {
                id: recording.id,
                recordingId: recording.id,
                workspaceId,
                noteId,
                status: "queued",
                providerJobId: null,
                error: null,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            });
          } else await route.fallback();
        });
        if (title) await page.getByLabel("Title", { exact: true }).fill(title);
        await page.getByRole("button", { name: "Record", exact: true }).click();
        await expect.poll(() => creating).toBe(true);
        await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
        expect(workspace.notes.has(noteId)).toBe(false);
        expect(acknowledgedAtMicrophone).toEqual([]);
        expect(await manifests(page)).toEqual([]);
      } finally {
        releaseCreate();
      }

      await expect(page.getByRole("button", { name: "Stop recording", exact: true })).toBeVisible();
      expect(acknowledgedAtMicrophone).toEqual([true]);
      await expect
        .poll(() => workspace.notes.get(noteId)?.title)
        .toBe(title || "Untitled note (1)");
      await expect.poll(async () => (await manifests(page))[0]?.chunkCount ?? 0).toBeGreaterThan(0);
      const [started] = await manifests(page);
      expect(started?.noteId).toBe(noteId);
      expect(started?.id).not.toBe(noteId);
      await page.getByRole("button", { name: "Stop recording", exact: true }).click();
      await expect.poll(() => submissions).toBe(1);
      await expect.poll(async () => (await manifests(page))[0]?.processing).toBe("submitted");

      const [finished] = await manifests(page);
      const input = recordingInputSchema.parse(finished?.initialization);
      expect(input.id).toBe(started!.id);
      expect(recording).toMatchObject(input);
      expect(finished).toMatchObject({ noteId, status: "finalized", byteCount: input.bytes });
      expect(uploaded!.length).toBe(input.bytes);
      expect(createHash("sha256").update(uploaded!).digest("hex")).toBe(input.sha256);
    });
  }
});

test("a second tab cannot take over an active microphone", async ({ page, context, workspace }) => {
  const note = workspace.seedNote();
  await installMicrophone(page);
  await page.goto(`/notes/${note.id}`);
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop recording", exact: true })).toBeVisible();
  const other = await context.newPage();
  await installMicrophone(other);
  await other.goto(`/notes/${note.id}`);
  await other.getByRole("button", { name: "Recover audio", exact: true }).click();
  await expect(other.getByRole("alert").filter({ hasText: "Audio needs attention" })).toContainText(
    "Another tab is capturing audio",
  );
  expect(await manifests(other)).toHaveLength(1);
  await expect.poll(async () => (await manifests(page))[0]?.chunkCount ?? 0).toBeGreaterThan(0);
  const next = workspace.seedNote({ title: "Another recording" });
  await other.goto(`/notes/${next.id}`);
  await other.getByRole("button", { name: "Record", exact: true }).click();
  await expect(other.getByRole("alert").filter({ hasText: "Audio needs attention" })).toContainText(
    "Another tab is capturing audio",
  );
  await expect(page.getByRole("button", { name: "Stop recording", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  await expect.poll(async () => (await manifests(page))[0]?.status).toBe("finalized");
  await other.getByRole("button", { name: "Record", exact: true }).click();
  await expect(other.getByRole("button", { name: "Stop recording", exact: true })).toBeVisible();
  await other.getByRole("button", { name: "Stop recording", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await manifests(other)).filter((session) => session.status === "finalized").length,
    )
    .toBe(2);
});

test("capture stays pinned when another note is selected and Home search evicts its list model", async ({
  page,
  workspace,
}) => {
  const owner = workspace.seedNote({ title: "Capture owner" });
  const selected = workspace.seedNote({ title: "Search match" });
  await installMicrophone(page);
  await page.goto(`/notes/${owner.id}`);
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect.poll(async () => (await manifests(page))[0]?.chunkCount ?? 0).toBeGreaterThan(0);
  await page
    .getByRole("complementary", { name: "Primary navigation", exact: true })
    .getByRole("link", { name: selected.title, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/notes/${selected.id}$`));
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("link", { name: "Home", exact: true })
    .click();
  const searched = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get("q") === "Search match",
  );
  await page.getByRole("searchbox", { name: "Search notes", exact: true }).fill("Search match");
  await searched;
  await expect(page.getByRole("button", { name: "Pause recording", exact: true })).toBeVisible();
  const previousChunks = (await manifests(page))[0]?.chunkCount ?? 0;
  await expect
    .poll(async () => (await manifests(page))[0]?.chunkCount ?? 0)
    .toBeGreaterThan(previousChunks);
  await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  await expect.poll(async () => (await manifests(page))[0]?.status).toBe("finalized");
  expect((await manifests(page))[0]?.noteId).toBe(owner.id);
  await page.goto(`/notes/${owner.id}`);
  await expect(page.getByRole("link", { name: "Download audio", exact: true })).toHaveAttribute(
    "href",
    /^blob:/,
  );
});

test("aborting a manifest write also rolls back its chunk", async ({ page, workspace }) => {
  const note = workspace.seedNote();
  await installMicrophone(page);
  await page.goto(`/notes/${note.id}`);
  await page.evaluate(() => {
    const abort = Reflect.get(window, "abortCaptureManifest") as () => void;
    abort();
  });
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Audio needs attention" })).toContainText(
    "Test manifest commit aborted",
  );
  await expect.poll(async () => (await manifests(page))[0]?.status).toBe("failed");
  expect((await manifests(page))[0]?.chunkCount).toBe(0);
  const chunkCount = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("voidnote-recordings", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to inspect rollback"));
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = db.transaction("chunks").objectStore("chunks").count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Unable to count chunks"));
      });
    } finally {
      db.close();
    }
  });
  expect(chunkCount).toBe(0);
});
