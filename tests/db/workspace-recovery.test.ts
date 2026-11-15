import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, describe, it } from "node:test";
import { workspaceRecovery, type RecoveryEntry } from "../../src/stores/workspace-recovery";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const values = new Map<string, string>();
let failWrites = false;
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (failWrites) throw new Error("Quota exceeded");
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
};
const session = () => ({
  user: { id: randomUUID(), email: null },
  workspace: { id: randomUUID(), name: "Private" },
});
const entry = (): RecoveryEntry => {
  const id = randomUUID();
  return {
    entity: "note",
    draft: {
      id,
      title: "Newer draft",
      transcript: "Newer text",
      createdAt: null,
      updatedAt: null,
      recordingSessionId: null,
    },
    edit: {
      baseRevision: 0,
      generation: 2,
      dirty: true,
      conflict: null,
      pending: {
        kind: "note",
        generation: 1,
        command: {
          id,
          commandId: randomUUID(),
          expectedRevision: 0,
          content: { title: "Exact request", transcript: "Original payload" },
        },
      },
    },
  };
};

void describe("scoped Zustand draft recovery (no database)", { concurrency: false }, () => {
  beforeEach(() => {
    values.clear();
    failWrites = false;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  });
  after(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  void it("does not hydrate until requested and preserves exact commands independently of newer drafts", async () => {
    const scope = session();
    const original = entry();
    const writer = workspaceRecovery(scope);
    assert.equal(values.size, 0);
    writer.write([original]);
    assert.deepEqual(await workspaceRecovery(scope).read(), [original]);
  });

  void it("isolates both account and workspace and discards only the requested scope", async () => {
    const a = session();
    const b = { ...a, user: { ...a.user, id: randomUUID() } };
    const c = { ...a, workspace: { ...a.workspace, id: randomUUID() } };
    const draft = entry();
    workspaceRecovery(a).write([draft]);
    workspaceRecovery(b).write([draft]);
    assert.deepEqual(await workspaceRecovery(c).read(), []);
    workspaceRecovery(a).discard();
    assert.deepEqual(await workspaceRecovery(a).read(), []);
    assert.deepEqual(await workspaceRecovery(b).read(), [draft]);
  });

  void it("rejects corrupt, wrong-scope and mismatched-command data without overwriting it", async () => {
    const scope = session();
    const recovery = workspaceRecovery(scope);
    recovery.write([entry()]);
    const key = [...values.keys()][0]!;
    for (const raw of [
      "invalid json",
      JSON.stringify({
        version: 1,
        state: { userId: randomUUID(), workspaceId: scope.workspace.id, entries: [] },
      }),
    ]) {
      values.set(key, raw);
      await assert.rejects(workspaceRecovery(scope).read());
      assert.equal(values.get(key), raw);
    }
    const bad = entry();
    bad.edit.pending!.command.id = randomUUID();
    assert.throws(() => recovery.write([bad]));
  });

  void it("propagates storage failure rather than reporting a durable checkpoint", () => {
    failWrites = true;
    assert.throws(() => workspaceRecovery(session()).write([entry()]), /Quota exceeded/);
    assert.equal(values.size, 0);
  });
});
