import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import {
  recordingChunkSchema,
  recordingSessionSchema,
  type LocalRecordingSession,
} from "@/lib/recording-schemas";
import type { RecordingChunkRecord } from "@/lib/types";

interface RecordingDB extends DBSchema {
  sessions: { key: string; value: LocalRecordingSession };
  chunks: { key: string; value: RecordingChunkRecord; indexes: { "by-session": string } };
}
let connection: Promise<IDBPDatabase<RecordingDB>> | undefined;
function openDatabase() {
  if (!globalThis.indexedDB) throw new Error("Local audio storage is unavailable in this browser.");
  connection ??= openDB<RecordingDB>("voidnote-recordings", 1, {
    upgrade(db) {
      db.createObjectStore("sessions", { keyPath: "id" });
      db.createObjectStore("chunks", { keyPath: "id" }).createIndex("by-session", "sessionId");
    },
    blocking() {
      void connection?.then((db) => db.close());
      connection = undefined;
    },
    terminated() {
      connection = undefined;
    },
  }).catch((error) => {
    connection = undefined;
    throw error;
  });
  return connection;
}
export async function putRecordingSession(session: LocalRecordingSession) {
  const parsed = recordingSessionSchema.parse(session);
  const db = await openDatabase();
  const tx = db.transaction("sessions", "readwrite");
  await Promise.all([tx.store.put(parsed), tx.done]);
}
export async function getRecordingSessions() {
  const db = await openDatabase();
  const records: unknown[] = await db.getAll("sessions");
  return records.flatMap((record) => {
    const result = recordingSessionSchema.safeParse(record);
    return result.success ? [result.data] : [];
  });
}
export async function getRecordingSession(id: string) {
  return recordingSessionSchema.parse(await (await openDatabase()).get("sessions", id));
}

/** Serialize acknowledgement with discard and manifest edits; never recreate missing audio. */
export async function acknowledgeRecordingProcessing(
  owner: Pick<LocalRecordingSession, "id" | "userId" | "workspaceId" | "noteId">,
) {
  const db = await openDatabase();
  const tx = db.transaction("sessions", "readwrite");
  const done = tx.done;
  try {
    const raw = await tx.store.get(owner.id);
    if (!raw) {
      await done;
      return null;
    }
    const current = recordingSessionSchema.parse(raw);
    if (
      current.id !== owner.id ||
      current.userId !== owner.userId ||
      current.workspaceId !== owner.workspaceId ||
      current.noteId !== owner.noteId ||
      current.status !== "finalized"
    ) {
      await done;
      return null;
    }
    const acknowledged = { ...raw, processing: "submitted" as const };
    if (current.processing !== "submitted") await tx.store.put(acknowledged);
    await done;
    return acknowledged;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Already completed or aborted. */
    }
    await done.catch(() => {});
    throw error;
  }
}

// Chunk + manifest + transaction completion form a single commit boundary.
export async function appendRecordingChunk(sessionId: string, blob: Blob) {
  const db = await openDatabase();
  const tx = db.transaction(["sessions", "chunks"], "readwrite");
  const done = tx.done;
  try {
    const session = recordingSessionSchema.parse(await tx.objectStore("sessions").get(sessionId));
    if (session.status === "finalized" || session.status === "failed")
      throw new Error("This recording no longer accepts audio.");
    const sequence = session.chunkCount + 1;
    const updated: LocalRecordingSession = {
      ...session,
      chunkCount: sequence,
      byteCount: session.byteCount === undefined ? undefined : session.byteCount + blob.size,
      mimeType: session.mimeType || blob.type,
      updatedAt: new Date().toISOString(),
      status: "recoverable",
    };
    await tx.objectStore("chunks").add({
      id: `${sessionId}:${sequence}`,
      sessionId,
      sequence,
      blob,
      createdAt: updated.updatedAt,
    });
    await tx.objectStore("sessions").put(updated);
    await done;
    return updated;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Already aborted. */
    }
    await done.catch(() => {});
    throw error;
  }
}
export async function getRecordingChunks(sessionId: string) {
  const db = await openDatabase();
  const records: unknown[] = await db.getAllFromIndex("chunks", "by-session", sessionId);
  return recordingChunkSchema
    .array()
    .parse(records)
    .sort((a, b) => a.sequence - b.sequence);
}
export async function buildRecordingBlob(sessionId: string, mimeType: string) {
  const db = await openDatabase();
  const tx = db.transaction(["sessions", "chunks"]);
  const [raw, records] = await Promise.all([
    tx.objectStore("sessions").get(sessionId),
    tx.objectStore("chunks").index("by-session").getAll(sessionId),
    tx.done,
  ]);
  const session = recordingSessionSchema.parse(raw);
  const chunks = recordingChunkSchema
    .array()
    .parse(records)
    .sort((a, b) => a.sequence - b.sequence);
  const bytes = chunks.reduce((total, chunk) => total + chunk.blob.size, 0);
  if (
    !bytes ||
    chunks.length !== session.chunkCount ||
    chunks.some((chunk, index) => chunk.sequence !== index + 1 || chunk.sessionId !== sessionId) ||
    (session.byteCount !== undefined && bytes !== session.byteCount)
  ) {
    throw new Error("Local audio is incomplete. The saved recording has not been marked ready.");
  }
  return new Blob(
    chunks.map((chunk) => chunk.blob),
    { type: mimeType || session.mimeType },
  );
}
export async function deleteRecordingSessionData(sessionId: string) {
  const db = await openDatabase();
  const tx = db.transaction(["sessions", "chunks"], "readwrite");
  const done = tx.done;
  try {
    let cursor = await tx.objectStore("chunks").index("by-session").openCursor(sessionId);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.objectStore("sessions").delete(sessionId);
    await done;
  } catch (error) {
    await done.catch(() => {});
    throw error;
  }
}
