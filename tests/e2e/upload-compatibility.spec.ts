import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test as base, expect, timestamp, workspaceId } from "./workspace-fixture";
import type { LocalRecordingSession } from "../../src/lib/recording-schemas";
import {
  recordingInputSchema,
  type RemoteRecording,
} from "../../src/contracts/recording-processing";

// WebKit's ephemeral contexts cannot store ANY Blob in IDB (WebKit bug 156347).
// A fresh persistent profile exercises normal Safari without masking codec failures.
type UploadReceiver = {
  url: string;
  bodies: Buffer[];
  respond: (response: ServerResponse) => void;
};
const test = base.extend<{ uploadReceiver: UploadReceiver }>({
  uploadReceiver: async ({ baseURL }, runTest) => {
    if (!baseURL) throw new Error("Upload tests require the built Worker preview.");
    const receiver: UploadReceiver = {
      url: "",
      bodies: [],
      respond: (response) => {
        response.writeHead(500).end();
      },
    };
    // WebKit's interception protocol omits Blob bodies. Receive the actual bytes
    // over HTTP rather than treating postDataBuffer() === null as an empty upload.
    const server = createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", new URL(baseURL).origin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "content-type");
      if (request.method === "OPTIONS") {
        response.writeHead(204).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        receiver.bodies.push(Buffer.concat(chunks));
        receiver.respond(response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    receiver.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/audio`;
    try {
      await runTest(receiver);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  context: async ({ browser, browserName, playwright, baseURL, contextOptions }, runTest, info) => {
    if (!baseURL) throw new Error("Upload tests require the built Worker preview.");
    const profile = info.outputPath("safari-profile");
    const options = { ...contextOptions, baseURL, serviceWorkers: "block" as const };
    const context =
      browserName === "webkit"
        ? await playwright.webkit.launchPersistentContext(profile, options)
        : await browser.newContext(options);
    try {
      await runTest(context);
    } finally {
      await context.close();
      if (browserName === "webkit") await rm(profile, { recursive: true, force: true });
    }
  },
});

for (const failure of ["initialize", "legacy-initialize", "upload", "committed-upload"] as const) {
  test(`supported audio resumes a lost ${failure} response with exact metadata after decoder changes`, async ({
    page,
    workspace,
    uploadReceiver,
  }) => {
    const bytes = await readFile(new URL("../fixtures/audio/tone.ogg", import.meta.url));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const note = workspace.seedNote({ title: "Safari upload" });
    const root = `/api/workspaces/${workspaceId}/notes/${note.id}`;
    let recording: RemoteRecording | undefined;
    let uploads = 0;
    let initializations = 0;
    let submissions = 0;
    uploadReceiver.respond = (response) => {
      uploads += 1;
      if (!recording) {
        response.writeHead(500).end();
        return;
      }
      if ((failure === "upload" || failure === "committed-upload") && uploads === 1) {
        if (failure === "committed-upload") recording.status = "ready";
        response.destroy();
      } else {
        recording.status = "ready";
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(recording));
      }
    };
    await page.route(`**${root}/**`, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.slice(root.length);
      if (path === "/recordings" && request.method() === "GET") {
        await route.fulfill({ json: { recordings: recording ? [recording] : [], runs: [] } });
      } else if (path === "/recordings" && request.method() === "POST") {
        const input = recordingInputSchema.parse(request.postDataJSON());
        expect(input.durationSeconds).toBeCloseTo(2, 2);
        expect(input.mimeType).toBe("audio/ogg");
        expect(input.sha256).toBe(digest);
        expect(input.bytes).toBe(bytes.length);
        if (recording)
          expect(input).toEqual(
            recordingInputSchema.parse({
              id: recording.id,
              sha256: recording.sha256,
              bytes: recording.bytes,
              durationSeconds: recording.durationSeconds,
              mimeType: recording.mimeType,
            }),
          );
        recording ??= {
          ...input,
          workspaceId,
          noteId: note.id,
          status: "upload_pending",
          createdAt: timestamp,
        };
        initializations += 1;
        if (
          (failure === "initialize" || failure === "legacy-initialize") &&
          initializations === 1
        ) {
          await route.abort("connectionreset");
          return;
        }
        await route.fulfill({ json: recording });
      } else if (
        recording &&
        path === `/recordings/${recording.id}/audio` &&
        request.method() === "PUT"
      ) {
        await route.continue({ url: uploadReceiver.url });
      } else if (path === "/processing" && request.method() === "POST" && recording) {
        expect(request.postDataJSON()).toEqual({ id: recording.id, recordingId: recording.id });
        submissions += 1;
        await route.fulfill({
          json: {
            id: recording.id,
            recordingId: recording.id,
            workspaceId,
            noteId: note.id,
            status: "queued",
            providerJobId: null,
            error: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        });
      } else await route.fallback();
    });
    await page.goto(`/notes/${note.id}`);
    await page.getByLabel("Upload audio", { exact: true }).setInputFiles({
      name: "tone.ogg",
      mimeType: "audio/ogg",
      buffer: bytes,
    });
    await expect.poll(() => initializations).toBe(1);
    await expect(
      page.getByRole("region", { name: "Transcript", exact: true }).getByRole("alert"),
    ).toBeVisible();
    expect(submissions).toBe(0);
    expect(uploads).toBe(failure.endsWith("upload") ? 1 : 0);
    if (failure === "legacy-initialize") {
      // Simulate an older deployed client, which never persisted its command.
      await page.evaluate(async (noteId) => {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("voidnote-recordings");
          request.onerror = () =>
            reject(request.error ?? new Error("Could not open audio storage"));
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("sessions", "readwrite");
            const records = tx.objectStore("sessions").getAll();
            records.onsuccess = () => {
              const session = (records.result as LocalRecordingSession[]).find(
                (item) => item.noteId === noteId,
              );
              if (!session) {
                tx.abort();
                return;
              }
              delete session.initialization;
              tx.objectStore("sessions").put(session);
            };
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onabort = () => {
              db.close();
              reject(tx.error ?? new Error("Could not update audio storage"));
            };
          };
        });
      }, note.id);
    }
    // Real decoding is exercised above. After reload emulate a now-available
    // decoder reporting a different duration; the durable command must win.
    await page.addInitScript(() => {
      const NativeAudio = window.Audio;
      window.Audio = class extends NativeAudio {
        constructor() {
          super();
          Object.defineProperty(this, "duration", { get: () => 2.125 });
          this.addEventListener("error", () => this.dispatchEvent(new Event("loadedmetadata")));
        }
      };
    });
    await page.reload();
    await expect.poll(() => submissions).toBe(1);
    expect(initializations).toBe(2);
    expect(uploads).toBe(failure === "upload" ? 2 : 1);
    for (const body of uploadReceiver.bodies) expect(body).toEqual(bytes);
  });
}

test("unreadable audio stays recoverable and is never submitted with invented duration", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Invalid audio" });
  await page.goto(`/notes/${note.id}`);
  await page.getByLabel("Upload audio", { exact: true }).setInputFiles({
    name: "broken.ogg",
    mimeType: "audio/ogg",
    buffer: Buffer.from("not an audio container"),
  });
  await expect(
    page.getByRole("region", { name: "Transcript", exact: true }).getByRole("alert"),
  ).toContainText("Could not read this audio's duration.");
  expect(
    workspace.rpcRequests.filter((call) => call.procedure === "recordings.initialize"),
  ).toHaveLength(0);
  await expect(page.getByRole("link", { name: "Download audio", exact: true })).toBeVisible();
});

test("headerless WebM uploads, plays and reloads without extreme duration seeks", async ({
  page,
  workspace,
  uploadReceiver,
}) => {
  const bytes = await readFile(new URL("../fixtures/audio/headerless.webm", import.meta.url));
  const note = workspace.seedNote({ title: "Headerless WebM" });
  const root = `/api/workspaces/${workspaceId}/notes/${note.id}`;
  let recording: RemoteRecording | undefined;
  let submissions = 0;
  await page.addInitScript(() => {
    const currentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!;
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      ...currentTime,
      set(value: number) {
        if (value > 7200) {
          document.documentElement.dataset.extremeAudioSeek = String(value);
          throw new Error("Out-of-range duration seek");
        }
        currentTime.set!.call(this, value);
      },
    });
  });
  uploadReceiver.respond = (response) => {
    if (!recording) {
      response.writeHead(500).end();
      return;
    }
    recording.status = "ready";
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(recording));
  };
  await page.route(`**${root}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(root.length);
    if (path === "/recordings" && request.method() === "GET") {
      await route.fulfill({ json: { recordings: recording ? [recording] : [], runs: [] } });
    } else if (path === "/recordings" && request.method() === "POST") {
      const input = recordingInputSchema.parse(request.postDataJSON());
      expect(input.durationSeconds).toBeGreaterThan(14.9);
      expect(input.durationSeconds).toBeLessThan(15.1);
      recording = {
        ...input,
        workspaceId,
        noteId: note.id,
        status: "upload_pending",
        createdAt: timestamp,
      };
      await route.fulfill({ json: recording });
    } else if (path.endsWith("/audio") && request.method() === "PUT") {
      await route.continue({ url: uploadReceiver.url });
    } else if (path === "/processing" && request.method() === "POST" && recording) {
      submissions += 1;
      await route.fulfill({
        json: {
          id: recording.id,
          recordingId: recording.id,
          workspaceId,
          noteId: note.id,
          status: "queued",
          providerJobId: null,
          error: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      });
    } else await route.fallback();
  });
  await page.goto(`/notes/${note.id}`);
  await page.getByLabel("Upload audio", { exact: true }).setInputFiles({
    name: "headerless.webm",
    mimeType: "audio/webm",
    buffer: bytes,
  });
  await expect.poll(() => submissions).toBe(1);
  expect(uploadReceiver.bodies).toEqual([bytes]);
  const audio = page.getByTestId("persistent-audio");
  const seek = page.getByRole("slider", { name: "Seek audio", exact: true });
  await expect(seek).toBeEnabled();
  await seek.focus();
  await seek.press("Home");
  for (let index = 0; index < 20; index++) await seek.press("ArrowRight");
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(1.5);
  await page.getByRole("button", { name: "Play audio", exact: true }).click();
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true);
  await expect(page.locator("html")).not.toHaveAttribute("data-extreme-audio-seek");
  await page.reload();
  await expect(page.getByRole("button", { name: "Play audio", exact: true })).toBeEnabled();
  await expect(seek).toBeEnabled();
  await expect(page.locator("html")).not.toHaveAttribute("data-extreme-audio-seek");
  await expect(page.getByRole("alert").filter({ hasText: "Playback needs attention" })).toHaveCount(
    0,
  );
});
