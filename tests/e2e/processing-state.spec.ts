import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  processingRequestSchema,
  processingRunSchema,
  recordingInputSchema,
  recordingOverviewSchema,
  recordingSchema,
  type ProcessingRun,
  type RemoteRecording,
} from "../../src/contracts/recording-processing";
import { correctedTranscriptPageSchema } from "../../src/contracts/transcript-corrections";
import { expect, test, timestamp, workspaceId, type WorkspaceFixture } from "./workspace-fixture";

function audioFixture() {
  const bytes = Buffer.alloc(44 + 8000 * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

// Real built-Worker UI with mocked transport, not provider/database acceptance.
async function processingFixture(page: Page, workspace: WorkspaceFixture) {
  const note = workspace.seedNote({ title: "Processing status" });
  const root = `/api/workspaces/${workspaceId}/notes/${note.id}`;
  const bytes = audioFixture();
  const turnId = randomUUID();
  const state = {
    recording: null as RemoteRecording | null,
    run: null as ProcessingRun | null,
    overviewGate: null as Promise<void> | null,
    gateAfterStart: false,
    heldReads: 0,
    failedReads: 0,
    failReads: false,
    hideRun: false,
    loseStartResponse: false,
    startStatus: "running" as ProcessingRun["status"],
    starts: [] as Array<{ id: string; recordingId: string }>,
    retries: [] as string[],
  };
  await page.route(`**${root}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(root.length);
    if (path === "/recordings" && request.method() === "GET") {
      // Capture at request time so a held response cannot silently adopt newer state.
      const overview = recordingOverviewSchema.parse({
        recordings: state.recording ? [state.recording] : [],
        runs: state.run && !state.hideRun ? [state.run] : [],
      });
      const failRead = state.failReads;
      if (state.overviewGate && (!state.gateAfterStart || state.starts.length > 0)) {
        state.heldReads++;
        await state.overviewGate;
      }
      if (failRead) {
        state.failedReads++;
        return route.fulfill({
          status: 503,
          json: { error: "Status service is temporarily unavailable.", code: "unavailable" },
        });
      }
      return route.fulfill({ json: overview });
    }
    if (path === "/recordings" && request.method() === "POST") {
      const input = recordingInputSchema.parse(request.postDataJSON());
      state.recording = recordingSchema.parse({
        ...input,
        workspaceId,
        noteId: note.id,
        status: state.recording?.status ?? "upload_pending",
        createdAt: timestamp,
      });
      return route.fulfill({ json: state.recording });
    }
    if (state.recording && path === `/recordings/${state.recording.id}/audio`) {
      if (request.method() === "PUT") {
        expect(request.postDataBuffer()).toEqual(bytes);
        state.recording.status = "ready";
        return route.fulfill({ json: state.recording });
      }
      return route.fulfill({ contentType: "audio/wav", body: bytes });
    }
    if (path === "/processing" && request.method() === "POST") {
      const input = processingRequestSchema.parse(request.postDataJSON());
      expect(input.recordingId).toBe(state.recording?.id);
      state.starts.push(input);
      state.run = processingRunSchema.parse({
        ...input,
        workspaceId,
        noteId: note.id,
        status: state.startStatus,
        providerJobId: "fixture-job",
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (state.loseStartResponse) return route.abort("failed");
      return route.fulfill({ json: state.run });
    }
    if (state.run && path === `/processing/${state.run.id}/retry`) {
      expect(request.method()).toBe("POST");
      state.retries.push(state.run.id);
      return route.fulfill({ json: { ok: true } });
    }
    if (state.run && path === `/processing/${state.run.id}/corrections`) {
      expect(request.method()).toBe("GET");
      return route.fulfill({
        json: correctedTranscriptPageSchema.parse({
          items: [
            {
              id: turnId,
              runId: state.run.id,
              recordingId: state.run.recordingId,
              sequence: 0,
              startSeconds: 0,
              endSeconds: 1,
              speakerLabel: "SPEAKER_00",
              text: "The final transcript is ready.",
              sourceUtteranceId: turnId,
              orderKey: "",
              parentId: null,
              revision: 0,
              attributionRevision: 0,
              assignment: { kind: "unassigned" },
              assignmentSource: "unassigned",
              personName: null,
              reviewState: "unreviewed",
              providerScore: null,
              sampleSuitability: "not_evaluated",
              originalText: "The final transcript is ready.",
              originalStartSeconds: 0,
              originalEndSeconds: 1,
            },
          ],
          nextCursor: null,
        }),
      });
    }
    return route.fallback();
  });
  const panel = page.getByRole("region", { name: "Transcript content", exact: true });
  const open = async () => {
    await page.goto(`/notes/${note.id}`);
    await expect(
      panel.getByText("Your transcript will appear here after recording."),
    ).toBeVisible();
  };
  const upload = () =>
    page.getByLabel("Upload audio", { exact: true }).setInputFiles({
      name: "status.wav",
      mimeType: "audio/wav",
      buffer: bytes,
    });
  return { state, note, panel, open, upload };
}

test("acknowledged submission stays in progress while its overview read is delayed", async ({
  page,
  workspace,
}) => {
  const f = await processingFixture(page, workspace);
  await f.open();
  let release!: () => void;
  // Import first checks for existing audio in prepareOwner. Holding that read
  // would prevent the upload itself, rather than exercise post-acknowledgment UI.
  f.state.gateAfterStart = true;
  f.state.overviewGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await f.upload();
    await expect.poll(() => f.state.starts.length).toBe(1);
    expect(f.state.recording?.status).toBe("ready");
    await expect.poll(() => f.state.heldReads).toBeGreaterThan(0);
    await expect(f.panel.getByRole("status")).toHaveText(/Transcribing|Transcription requested/);
    await expect(f.panel.getByRole("button", { name: /^Retry/ })).toHaveCount(0);
    await expect(f.panel.getByRole("alert")).toHaveCount(0);
  } finally {
    f.state.overviewGate = null;
    release();
  }
  await expect(f.panel.getByRole("status")).toHaveText("Transcribing…");
  expect(f.state.starts).toHaveLength(1);
  expect(f.state.retries).toEqual([]);
});

test("failed status refresh retains processing and Retry status only reads", async ({
  page,
  workspace,
}) => {
  const f = await processingFixture(page, workspace);
  await f.open();
  await f.upload();
  await expect(f.panel.getByRole("status")).toHaveText("Transcribing…");
  f.state.failReads = true;
  const retry = f.panel.getByRole("button", { name: "Retry status", exact: true });
  await expect(retry).toBeVisible({ timeout: 15_000 });
  expect(f.state.failedReads).toBeGreaterThan(0);
  await expect(f.panel.getByRole("status")).toHaveText("Transcribing…");
  await expect(f.panel.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  f.state.failReads = false;
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(f.panel.getByRole("status")).toHaveText("Transcribing…");
  expect(f.state.starts).toHaveLength(1);
  expect(f.state.retries).toEqual([]);
});

test("retry acknowledgment waits for a failed run to actually restart", async ({
  page,
  workspace,
}) => {
  const f = await processingFixture(page, workspace);
  f.state.startStatus = "failed";
  await f.open();
  await f.upload();
  const retry = f.panel.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeEnabled();
  await expect(f.panel).toContainText("Transcription needs attention.");
  let release!: () => void;
  f.state.overviewGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await retry.click();
    await expect.poll(() => f.state.retries.length).toBe(1);
    await expect.poll(() => f.state.heldReads).toBeGreaterThan(0);
    expect(f.state.run?.status).toBe("failed");
    await expect(f.panel.getByRole("status")).toHaveText("Waiting for transcription to restart…");
    await expect(retry).toHaveCount(0);
    await expect(f.panel.getByText("Transcribing…", { exact: true })).toHaveCount(0);
    if (!f.state.run) throw new Error("Expected the failed processing run.");
    f.state.run.status = "running";
    f.state.run.updatedAt = "2026-11-13T12:00:01.000Z";
    const oldResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        `/api/workspaces/${workspaceId}/notes/${f.note.id}/recordings`,
    );
    f.state.overviewGate = null;
    release();
    const staleOverview = recordingOverviewSchema.parse(await (await oldResponse).json());
    expect(staleOverview.runs[0]?.status).toBe("failed");
    await expect(f.panel.getByRole("status")).toHaveText("Waiting for transcription to restart…");
    // The next shell poll, not the dispatch acknowledgment or stale failed read,
    // supplies the evidence that transcription really restarted.
    await expect(f.panel.getByRole("status")).toHaveText("Transcribing…");
  } finally {
    f.state.overviewGate = null;
    release();
  }
  expect(f.state.starts).toHaveLength(1);
  expect(f.state.retries).toEqual([f.state.run?.id]);
});

test("ready remote audio without a prior submission can start transcription", async ({
  page,
  workspace,
}) => {
  const f = await processingFixture(page, workspace);
  const recordingId = randomUUID();
  f.state.recording = recordingSchema.parse({
    id: recordingId,
    workspaceId,
    noteId: f.note.id,
    sha256: "a".repeat(64),
    bytes: audioFixture().length,
    mimeType: "audio/wav",
    durationSeconds: 1,
    status: "ready",
    createdAt: timestamp,
  });
  await page.goto(`/notes/${f.note.id}`);
  await expect(f.panel.getByRole("status")).toHaveText("Transcription has not started.");
  expect(f.state.starts).toEqual([]);
  await f.panel.getByRole("button", { name: "Transcribe audio", exact: true }).click();
  await expect(f.panel.getByRole("status")).toHaveText("Transcribing…");
  expect(f.state.starts).toEqual([{ id: recordingId, recordingId }]);
  expect(f.state.retries).toEqual([]);
});

test("final transcript wins over an earlier lost submission response", async ({
  page,
  workspace,
}) => {
  const f = await processingFixture(page, workspace);
  f.state.loseStartResponse = true;
  f.state.startStatus = "succeeded";
  await f.open();
  await f.upload();
  await expect(f.panel.getByText("The final transcript is ready.", { exact: true })).toBeVisible();
  await expect(f.panel.getByRole("alert")).toHaveCount(0);
  await expect(f.panel.getByRole("button", { name: /^Retry/ })).toHaveCount(0);
  expect(f.state.starts).toHaveLength(1);
  expect(f.state.retries).toEqual([]);
});

test("an uncertain submission keeps saved audio and retries the exact start command", async ({
  page,
  workspace,
}) => {
  const f = await processingFixture(page, workspace);
  f.state.loseStartResponse = true;
  f.state.hideRun = true;
  await f.open();
  await f.upload();
  const retry = f.panel.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeEnabled();
  await expect(f.panel).toContainText("Transcription status is not confirmed.");
  await expect(f.panel).toContainText("Your audio is saved.");
  expect(f.state.starts).toHaveLength(1);
  const command = f.state.starts[0];
  f.state.loseStartResponse = false;
  f.state.hideRun = false;
  await retry.click();
  await expect(f.panel.getByRole("status")).toHaveText("Transcribing…");
  expect(f.state.starts).toEqual([command, command]);
  expect(f.state.retries).toEqual([]);
});

test("submitted local audio with no run after reload offers a status check, not a new submission", async ({
  page,
  workspace,
}) => {
  const f = await processingFixture(page, workspace);
  await f.open();
  await f.upload();
  await expect(f.panel.getByRole("status")).toHaveText("Transcribing…");
  // Submission has completed before reloading; only the remote run projection is missing.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("voidnote-recordings", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error("Unable to open recordings"));
        });
        try {
          return await new Promise<unknown>((resolve, reject) => {
            const request = db.transaction("sessions").objectStore("sessions").getAll();
            request.onsuccess = () => {
              const sessions = request.result as Array<{ processing?: string }>;
              resolve(sessions[0]?.processing);
            };
            request.onerror = () => reject(request.error ?? new Error("Unable to read recordings"));
          });
        } finally {
          db.close();
        }
      }),
    )
    .toBe("submitted");
  f.state.hideRun = true;
  await page.reload();
  const retry = f.panel.getByRole("button", { name: "Retry status", exact: true });
  await expect(retry).toBeVisible();
  await expect(f.panel).toContainText("Your audio is saved.");
  await expect(f.panel.getByText("Transcribing…", { exact: true })).toHaveCount(0);
  await expect(f.panel.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  f.state.hideRun = false;
  await retry.click();
  await expect(f.panel.getByRole("status")).toHaveText("Transcribing…");
  expect(f.state.starts).toHaveLength(1);
  expect(f.state.retries).toEqual([]);
});

test("blocked transcription never claims to be transcribing", async ({ page, workspace }) => {
  const f = await processingFixture(page, workspace);
  f.state.startStatus = "blocked";
  await f.open();
  await f.upload();
  await expect(f.panel).toContainText("Transcription is unavailable.");
  await expect(f.panel.getByText("Transcribing…", { exact: true })).toHaveCount(0);
});
