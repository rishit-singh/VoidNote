import type { RecordingSessionMeta } from "../../src/lib/types";
import { expect, test, timestamp, userId, workspaceId } from "./workspace-fixture";

// A tiny valid PCM file lets the browser expose real recovered audio without a microphone.
function wav(sample: number): number[] {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    bytes.set(new TextEncoder().encode(value), offset);
  text(0, "RIFF");
  view.setUint32(4, 40, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, 4, true);
  view.setInt16(44, sample, true);
  view.setInt16(46, -sample, true);
  return [...bytes];
}

test("recording recovery uses only owned audio and never resurrects absent or deleted notes", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Known server note" });
  const deleted = workspace.seedNote({ title: "Deleted server note", deletedAt: timestamp });
  const missingId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const foreignUser = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const foreignWorkspace = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const ownAudio = wav(100);
  const makeSession = (
    id: string,
    sample: number,
    changes: Partial<RecordingSessionMeta> = {},
  ) => ({
    session: {
      id,
      noteId: note.id,
      userId,
      workspaceId,
      status: "recoverable",
      mimeType: "audio/wav",
      chunkCount: 1,
      createdAt: timestamp,
      updatedAt: "2026-11-13T13:00:00.000Z",
      ...changes,
    } satisfies RecordingSessionMeta,
    bytes: wav(sample),
  });
  const unscoped = makeSession("unscoped", 400);
  const { userId: _userId, workspaceId: _workspaceId, ...legacySession } = unscoped.session;
  void _userId;
  void _workspaceId;
  const recordings = [
    makeSession("own", 100, { updatedAt: timestamp }),
    makeSession("foreign-user", 200, { userId: foreignUser }),
    makeSession("foreign-workspace", 300, { workspaceId: foreignWorkspace }),
    { session: legacySession, bytes: unscoped.bytes },
    makeSession("deleted-note", 500, { noteId: deleted.id }),
    makeSession("missing-note", 600, { noteId: missingId }),
  ];

  await page.goto(`/notes/${note.id}`);
  await expect(page.getByRole("link", { name: "Download audio", exact: true })).toHaveCount(0);
  await page.evaluate(async (entries) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("voidnote-recordings", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("sessions"))
          db.createObjectStore("sessions", { keyPath: "id" });
        if (!db.objectStoreNames.contains("chunks")) {
          db.createObjectStore("chunks", { keyPath: "id" }).createIndex("by-session", "sessionId", {
            unique: false,
          });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to seed recordings"));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(["sessions", "chunks"], "readwrite");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("Recording seed failed"));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("Recording seed aborted"));
        for (const { session, bytes } of entries) {
          transaction.objectStore("sessions").put(session);
          transaction.objectStore("chunks").put({
            id: `${session.id}:1`,
            sessionId: session.id,
            sequence: 1,
            blob: new Blob([new Uint8Array(bytes)], { type: session.mimeType }),
            createdAt: session.createdAt,
          });
        }
      });
    } finally {
      database.close();
    }
  }, recordings);

  await page.reload();
  await page.getByRole("button", { name: "Recover audio", exact: true }).click();
  const download = page.getByRole("link", { name: "Download audio", exact: true });
  await expect(download).toHaveAttribute("href", /^blob:/);
  await expect(page.locator("audio")).toHaveCount(1);
  const recoveredBytes = await download.evaluate(async (element) => {
    const href = element.getAttribute("href");
    if (!href) throw new Error("Recovered audio has no download URL");
    return [...new Uint8Array(await (await fetch(href)).arrayBuffer())];
  });
  expect(
    recoveredBytes,
    "Newer foreign or unscoped recordings must never replace owned audio",
  ).toEqual(ownAudio);
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("link", { name: "Home", exact: true })
    .click();
  const list = page.getByRole("list", { name: "Notes", exact: true });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByRole("link", { name: new RegExp(note.title) })).toBeVisible();
  await expect(page.getByText("Deleted server note", { exact: true })).toHaveCount(0);
  expect(workspace.mutations, "Local recordings cannot create server notes").toHaveLength(0);
});
