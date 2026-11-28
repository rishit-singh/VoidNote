/// <reference lib="dom" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { build } from "esbuild";
import type { LocalRecordingSession } from "../../src/lib/recording-schemas";

type Subject = Pick<
  typeof import("../../src/lib/idb-recordings"),
  "acknowledgeRecordingProcessing"
>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

void describe("recording acknowledgement transaction (no database)", () => {
  let subject: Subject;
  let owner: LocalRecordingSession;
  let stored: LocalRecordingSession | undefined;
  let writes: LocalRecordingSession[];
  let transactions: number;
  let commit: Promise<void>;
  let putStarted: ReturnType<typeof deferred>;

  before(async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const result = await build({
      entryPoints: [`${root}src/lib/idb-recordings.ts`],
      tsconfig: `${root}tsconfig.json`,
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      packages: "external",
    });
    const output = result.outputFiles[0];
    assert.ok(output);
    const bundledModule: { exports: unknown } = { exports: {} };
    const require = createRequire(import.meta.url);
    const evaluate = compileFunction(output.text, [
      "require",
      "module",
      "exports",
      "globalThis",
    ]) as (...args: unknown[]) => void;
    const idb = {
      openDB: () =>
        Promise.resolve({
          transaction(name: string, mode: string) {
            // The read and conditional patch must share this exclusive transaction.
            // Discard's sessions/chunks readwrite transaction conflicts with this store.
            assert.equal(name, "sessions");
            assert.equal(mode, "readwrite");
            transactions++;
            return {
              done: commit,
              store: {
                get: (id: string) => {
                  assert.equal(id, owner.id);
                  return Promise.resolve(stored && structuredClone(stored));
                },
                put: (value: LocalRecordingSession) => {
                  assert.ok(stored, "Acknowledgement must not insert a discarded manifest");
                  writes.push(structuredClone(value));
                  stored = structuredClone(value);
                  putStarted.resolve();
                  return Promise.resolve();
                },
              },
              abort() {},
            };
          },
        }),
    };
    evaluate(
      (name: string): unknown => (name === "idb" ? idb : (require(name) as unknown)),
      bundledModule,
      bundledModule.exports,
      { indexedDB: {} },
    );
    subject = bundledModule.exports as Subject;
  });

  beforeEach(() => {
    owner = {
      id: randomUUID(),
      userId: randomUUID(),
      workspaceId: randomUUID(),
      noteId: randomUUID(),
      status: "finalized",
      processing: "pending",
      mimeType: "audio/webm",
      chunkCount: 2,
      byteCount: 100,
      createdAt: "2026-11-27T10:00:00.000Z",
      updatedAt: "2026-11-27T10:00:00.000Z",
    };
    stored = structuredClone(owner);
    writes = [];
    transactions = 0;
    commit = Promise.resolve();
    putStarted = deferred();
  });

  void it("patches only acknowledgement on the latest stored manifest in one readwrite transaction", async () => {
    const newer = {
      ...owner,
      mimeType: "audio/ogg",
      chunkCount: 3,
      byteCount: 200,
      error: "Newer recovery metadata",
      updatedAt: "2026-11-27T10:01:00.000Z",
      captureDeviceLabel: "Metadata written by a newer client",
    };
    stored = newer;
    const expected = { ...stored, processing: "submitted" };
    assert.deepEqual(await subject.acknowledgeRecordingProcessing(owner), expected);
    assert.deepEqual(writes, [expected]);
    assert.equal(transactions, 1);
  });

  void it("does not recreate a manifest discarded before the acknowledgement transaction", async () => {
    stored = undefined;
    assert.equal(await subject.acknowledgeRecordingProcessing(owner), null);
    assert.deepEqual(writes, []);
    assert.equal(stored, undefined);
    assert.equal(transactions, 1);
  });

  void it("does not acknowledge a changed owner, note, or non-finalized manifest", async () => {
    for (const patch of [
      { id: randomUUID() },
      { userId: randomUUID() },
      { workspaceId: randomUUID() },
      { noteId: randomUUID() },
      { status: "failed" as const },
      { status: "recoverable" as const },
    ]) {
      stored = { ...owner, ...patch };
      assert.equal(await subject.acknowledgeRecordingProcessing(owner), null);
      assert.deepEqual(stored, { ...owner, ...patch });
    }
    assert.deepEqual(writes, []);
  });

  void it("does not report acknowledgement before transaction commit", async () => {
    const held = deferred();
    commit = held.promise;
    let settled = false;
    const result = subject.acknowledgeRecordingProcessing(owner).then((value) => {
      settled = true;
      return value;
    });
    await putStarted.promise;
    assert.equal(settled, false);
    held.resolve();
    assert.equal((await result)?.processing, "submitted");
    assert.equal(transactions, 1);
  });

  void it("replays an existing acknowledgement without rewriting the manifest", async () => {
    stored = { ...owner, processing: "submitted", error: "Retained metadata" };
    assert.deepEqual(await subject.acknowledgeRecordingProcessing(owner), stored);
    assert.deepEqual(writes, []);
    assert.equal(transactions, 1);
  });
});
