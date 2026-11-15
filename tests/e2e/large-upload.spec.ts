import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { expect, test, timestamp, workspaceId } from "./workspace-fixture";
import {
  recordingInputSchema,
  processingRequestSchema,
  type RemoteRecording,
} from "../../src/contracts/recording-processing";

test("320 MiB audio resumes acknowledged parts after a lost response and reload", async ({
  page,
  workspace,
}) => {
  test.setTimeout(240_000);
  const size = 320 * 1024 * 1024;
  const file = test.info().outputPath("large-conversation.wav");
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(size - 8, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(192000, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(size - 44, 40);
  const handle = await open(file, "w");
  try {
    await handle.write(header);
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  const digest = hash.digest("hex");
  const note = workspace.seedNote({ title: "Large recording" });
  const root = `/api/workspaces/${workspaceId}/notes/${note.id}`;
  let recording: RemoteRecording | null = null;
  const parts = new Map<number, { index: number; sha256: string }>();
  const attempts = new Map<number, number>();
  let submissions = 0;
  await page.route(`**${root}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(root.length);
    if (path === "/recordings" && request.method() === "GET") {
      await route.fulfill({ json: { recordings: recording ? [recording] : [], runs: [] } });
    } else if (path === "/recordings" && request.method() === "POST") {
      const input = recordingInputSchema.parse(request.postDataJSON());
      expect(input.bytes).toBe(size);
      expect(input.sha256).toBe(digest);
      if (recording) expect(input.id).toBe(recording.id);
      recording ??= {
        ...input,
        workspaceId,
        noteId: note.id,
        status: "upload_pending",
        createdAt: timestamp,
      };
      await route.fulfill({ json: recording });
    } else if (/\/upload$/.test(path) && request.method() === "GET") {
      await route.fulfill({ json: { ready: false, parts: [...parts.values()] } });
    } else if (/\/upload\/\d+$/.test(path) && request.method() === "PUT") {
      const index = Number(path.split("/").at(-1));
      const body = request.postDataBuffer()!;
      expect(body.length).toBe(8 * 1024 * 1024);
      expect(request.headers()["x-content-sha256"]).toBe(
        createHash("sha256").update(body).digest("hex"),
      );
      attempts.set(index, (attempts.get(index) ?? 0) + 1);
      const part = { index, sha256: request.headers()["x-content-sha256"]! };
      parts.set(index, part);
      if (index === 0 && attempts.get(0) === 1) await route.abort("connectionreset");
      else await route.fulfill({ json: part });
    } else if (/\/upload$/.test(path) && request.method() === "POST" && recording) {
      expect(parts.size).toBe(40);
      recording.status = "ready";
      await route.fulfill({ json: recording });
    } else if (path === "/processing") {
      submissions++;
      const input = processingRequestSchema.parse(request.postDataJSON());
      await route.fulfill({
        json: {
          ...input,
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
  await page.getByLabel("Upload audio", { exact: true }).setInputFiles(file);
  // Finalization briefly shows a ready-to-process alert before upload starts.
  // Wait for the stored part and the injected transport failure before reloading.
  await expect.poll(() => parts.size, { timeout: 30_000 }).toBe(1);
  await expect(
    page.getByRole("region", { name: "Transcript", exact: true }).getByRole("alert"),
  ).toContainText("Failed to fetch", { timeout: 30_000 });
  await page.reload();
  await expect.poll(() => submissions, { timeout: 180_000 }).toBe(1);
  expect(attempts.size).toBe(40);
  expect(attempts.get(0)).toBe(1);
  await expect(page.getByRole("button", { name: "Record", exact: true })).toHaveCount(0);
});
