import { randomUUID } from "node:crypto";
import { expect, test, timestamp, workspaceId } from "./workspace-fixture";
import { correctedTurnSchema } from "../../src/contracts/transcript-corrections";

test("an appearance bookmark cannot select audio from a note outside the active workspace", async ({
  page,
  workspace,
}) => {
  const foreign = workspace.seedNote({ workspaceId: randomUUID(), title: "Another workspace" });
  await page.route(
    (url) => url.pathname === `/api/workspaces/${workspaceId}/notes/${foreign.id}`,
    (route) => {
      expect(route.request().method()).toBe("GET");
      return route.fulfill({
        status: 404,
        json: { error: "Record not found.", code: "not_found" },
      });
    },
  );
  await page.goto(`/notes/${foreign.id}?recordingId=${randomUUID()}&at=8`);
  await expect(page.getByText("Note not found", { exact: true })).toBeVisible();
  await expect(page.getByTestId("persistent-audio")).not.toHaveAttribute("src");
  expect(workspace.requests.some((path) => path.endsWith("/audio"))).toBe(false);
});

test("a profile appearance opens its recording and timestamp in the persistent player", async ({
  page,
  workspace,
}) => {
  const person = workspace.seedPerson({ displayName: "Maya" });
  const note = workspace.seedNote({ title: "Two conversation takes" });
  const root = `/api/workspaces/${workspaceId}/notes/${note.id}`;
  const audio = Buffer.alloc(44 + 12 * 8000 * 2);
  audio.write("RIFF");
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24);
  audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  const recordings = [0, 1].map(() => ({
    id: randomUUID(),
    workspaceId,
    noteId: note.id,
    sha256: "a".repeat(64),
    bytes: audio.length,
    mimeType: "audio/wav",
    durationSeconds: 12,
    status: "ready",
    createdAt: timestamp,
  }));
  const runs = recordings.map((recording) => ({
    id: randomUUID(),
    workspaceId,
    noteId: note.id,
    recordingId: recording.id,
    status: "succeeded",
    providerJobId: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  const turns = runs.map((run, index) => {
    const id = randomUUID();
    const text = index ? "The second take has the correct evidence." : "This is a different take.";
    return correctedTurnSchema.parse({
      id,
      runId: run.id,
      recordingId: run.recordingId,
      sequence: 0,
      startSeconds: 8,
      endSeconds: 11,
      speakerLabel: "SPEAKER_00",
      text,
      sourceUtteranceId: id,
      parentId: null,
      revision: 1,
      attributionRevision: 1,
      assignment: { kind: "person", personId: person.id },
      assignmentSource: "manual",
      personName: person.displayName,
      reviewState: "confirmed",
      providerScore: null,
      sampleSuitability: "not_evaluated",
      originalText: text,
      originalStartSeconds: 8,
      originalEndSeconds: 11,
    });
  });
  const target = turns[1]!;
  await page.route(
    `**/api/workspaces/${workspaceId}/people/${person.id}/appearances*`,
    async (route) => {
      await route.fulfill({
        json: {
          items: [
            {
              noteId: note.id,
              noteTitle: note.title,
              recordingId: target.recordingId,
              runId: target.runId,
              utteranceId: target.id,
              startSeconds: target.startSeconds,
              endSeconds: target.endSeconds,
              text: target.text,
            },
          ],
          nextCursor: null,
        },
      });
    },
  );
  await page.route(`**${root}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(root.length);
    if (path === "/recordings") return route.fulfill({ json: { recordings, runs } });
    const turn = turns.find(
      (item) =>
        path === `/processing/${item.runId}/corrections` ||
        path === `/processing/${item.runId}/transcript`,
    );
    if (turn) return route.fulfill({ json: { items: [turn], nextCursor: null } });
    if (path.endsWith("/audio")) {
      const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
      return route.fulfill({
        status: range ? 206 : 200,
        contentType: "audio/wav",
        body: audio.subarray(start, end + 1),
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          ...(range ? { "Content-Range": `bytes ${start}-${end}/${audio.length}` } : {}),
        },
      });
    }
    return route.fallback();
  });
  await page.goto(`/profiles/${person.id}`);
  await page.locator(`a[href*="recordingId=${target.recordingId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`recordingId=${target.recordingId}`));
  await expect(page.getByText(target.text, { exact: true })).toBeVisible();
  const player = page.getByTestId("persistent-audio");
  await expect(player).toHaveAttribute(
    "src",
    new RegExp(`/recordings/${target.recordingId}/audio$`),
  );
  await expect
    .poll(() => player.evaluate((element: HTMLAudioElement) => Math.abs(element.currentTime - 8)))
    .toBeLessThan(0.15);
  await expect(page.locator("audio")).toHaveCount(1);
  expect(await player.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
});
