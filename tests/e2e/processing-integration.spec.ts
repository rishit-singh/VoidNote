import { randomUUID } from "node:crypto";
import { expect, test, timestamp, workspaceId } from "./workspace-fixture";
import { correctedTranscriptPageSchema } from "../../src/contracts/transcript-corrections";
import {
  recordingInputSchema,
  processingRequestSchema,
  recordingOverviewSchema,
  transcriptPageSchema,
  type RemoteRecording,
  type ProcessingRun,
} from "../../src/contracts/recording-processing";

function audioFixture() {
  const bytes = Buffer.alloc(44 + 12 * 8000 * 2);
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

test("upload, reloadable processing and timestamp playback share one persistent player", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({
    title: "Processing journey",
    transcript: "Keep my manual corrections.",
  });
  const root = `/api/workspaces/${workspaceId}/notes/${note.id}`;
  const other = workspace.seedNote({ title: "Another conversation" });
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  let uploadStarted = false;
  const bytes = audioFixture();
  const utteranceId = randomUUID();
  let recording: RemoteRecording | null = null;
  let run: ProcessingRun | null = null;
  const completeProcessing = () => {
    if (!run) throw new Error("No processing request was received.");
    run.status = "succeeded";
  };
  let submissions = 0;
  let remoteReads = 0;
  await page.route(`**${root}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(root.length);
    if (path === "/recordings" && request.method() === "GET") {
      await route.fulfill({
        json: recordingOverviewSchema.parse({
          recordings: recording ? [recording] : [],
          runs: run ? [run] : [],
        }),
      });
    } else if (path === "/recordings" && request.method() === "POST") {
      recording = {
        ...recordingInputSchema.parse(request.postDataJSON()),
        workspaceId,
        noteId: note.id,
        status: "upload_pending",
        createdAt: timestamp,
      };
      await route.fulfill({ json: recording });
    } else if (
      recording &&
      path === `/recordings/${recording.id}/audio` &&
      request.method() === "PUT"
    ) {
      expect(request.postDataBuffer()).toEqual(bytes);
      uploadStarted = true;
      await uploadGate;
      recording.status = "ready";
      await route.fulfill({ json: recording });
    } else if (
      recording &&
      path === `/recordings/${recording.id}/audio` &&
      request.method() === "GET"
    ) {
      remoteReads++;
      const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      await route.fulfill({
        status: range ? 206 : 200,
        contentType: "audio/wav",
        body: bytes.subarray(start, end + 1),
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          ...(range ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}),
        },
      });
    } else if (path === "/processing" && request.method() === "POST") {
      submissions++;
      const input = processingRequestSchema.parse(request.postDataJSON());
      expect(input.recordingId).toBe(recording?.id);
      run = {
        ...input,
        workspaceId,
        noteId: note.id,
        status: "running",
        providerJobId: "fixture-job",
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await route.fulfill({ json: run });
    } else if (
      run &&
      (path === `/processing/${run.id}/transcript` || path === `/processing/${run.id}/corrections`)
    ) {
      await route.fulfill({
        json: (path.endsWith("/corrections")
          ? correctedTranscriptPageSchema
          : transcriptPageSchema
        ).parse({
          items: [
            {
              id: utteranceId,
              runId: run.id,
              recordingId: run.recordingId,
              sequence: 0,
              startSeconds: 4,
              endSeconds: 8,
              speakerLabel: "SPEAKER_00",
              text: "Review the project tomorrow.",
              sourceUtteranceId: utteranceId,
              parentId: null,
              revision: 0,
              attributionRevision: 0,
              assignment: { kind: "unassigned" },
              assignmentSource: "unassigned",
              personName: null,
              reviewState: "unreviewed",
              providerScore: null,
              sampleSuitability: "not_evaluated",
              originalText: "Review the project tomorrow.",
              originalStartSeconds: 4,
              originalEndSeconds: 8,
            },
          ],
          nextCursor: null,
        }),
      });
    } else {
      await route.fallback();
    }
  });
  await page.goto(`/notes/${note.id}`);
  await page
    .getByLabel("Upload audio", { exact: true })
    .setInputFiles({ name: "conversation.wav", mimeType: "audio/wav", buffer: bytes });
  await expect(page.getByRole("button", { name: "Play audio", exact: true })).toBeEnabled();
  await expect.poll(() => uploadStarted).toBe(true);
  await page
    .getByRole("complementary")
    .getByRole("link", { name: other.title, exact: true })
    .click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(other.title);
  await expect(page.getByRole("button", { name: "Play audio", exact: true })).toHaveCount(0);
  releaseUpload();
  await expect.poll(() => submissions).toBe(1);
  await page
    .getByRole("complementary")
    .getByRole("link", { name: note.title, exact: true })
    .click();
  await expect(page.getByRole("status").filter({ hasText: "Transcribing" })).toBeVisible();
  expect(run).not.toBeNull();
  // Model durable completion while the browser is disconnected; provider/repository
  // behavior is verified separately, not simulated by this transport fixture.
  completeProcessing();
  await page.reload();
  await expect(page.getByText("Review the project tomorrow.", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Transcript", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Play at 0:04", exact: true }).click();
  const audio = page.getByTestId("persistent-audio");
  await expect(page.locator("audio")).toHaveCount(1);
  await expect(audio).toHaveAttribute("src", /\/recordings\/[^/]+\/audio$/);
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThanOrEqual(4);
  await expect.poll(() => remoteReads).toBeGreaterThan(0);
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Pause playback", exact: true })).toHaveCount(0);
  await expect
    .poll(() =>
      audio.evaluate((element: HTMLAudioElement) => element.paused && !element.getAttribute("src")),
    )
    .toBe(true);
  expect(submissions).toBe(1);
});
