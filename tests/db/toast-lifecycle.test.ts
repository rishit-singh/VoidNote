import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { toast } from "sonner";
import type { NoteRecord } from "../../src/contracts/workspace";
import { runEntityAction, watchActionToastScope } from "../../src/lib/action-toasts";
import { ApiError, workspaceApi } from "../../src/lib/workspace-api";
import { useNoteStore } from "../../src/stores/use-note-store";

const originalApi = { ...workspaceApi };
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const scope = {
  user: { id: randomUUID(), email: null },
  workspace: { id: randomUUID(), name: "Toast tests" },
};
const records = new Map<string, NoteRecord>();
let stopWatching = () => {};

async function createConflictedNote() {
  const note = useNoteStore.getState().createNote();
  await useNoteStore.getState().saveNote(note.id);
  useNoteStore.getState().upsertNote({ ...note, title: "Retained conflict" });
  workspaceApi.saveNote = () =>
    Promise.reject(new ApiError("Changed elsewhere", 409, "conflict", 2));
  await useNoteStore.getState().saveNote(note.id);
  assert.equal(useNoteStore.getState().edits[`note:${note.id}`]?.conflict, 2);
  return note;
}

void describe("explicit action toast lifecycle (no database)", { concurrency: false }, () => {
  beforeEach(async () => {
    useNoteStore.getState().clearSession();
    useNoteStore.setState(useNoteStore.getInitialState());
    toast.dismiss();
    records.clear();
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    workspaceApi.session = () => Promise.resolve(scope);
    workspaceApi.saveNote = (workspaceId, command) => {
      const record: NoteRecord = {
        ...command.content,
        id: command.id,
        workspaceId,
        revision: command.expectedRevision + 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      };
      records.set(record.id, record);
      return Promise.resolve(record);
    };
    workspaceApi.note = (_workspaceId, id) => {
      const record = records.get(id);
      return record ? Promise.resolve(record) : Promise.reject(new ApiError("Missing", 404));
    };
    workspaceApi.deleteNote = (_workspaceId, command) => {
      const record = {
        ...records.get(command.id)!,
        revision: command.expectedRevision + 1,
        deletedAt: new Date().toISOString(),
      };
      records.set(command.id, record);
      return Promise.resolve(record);
    };
    await useNoteStore.getState().initialize();
    stopWatching = watchActionToastScope();
  });

  afterEach(() => {
    stopWatching();
    useNoteStore.getState().clearSession();
    toast.dismiss();
    Object.assign(workspaceApi, originalApi);
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  void it("deduplicates pending actions and waits for acknowledgement while retaining newer edits", async () => {
    const note = useNoteStore.getState().createNote();
    const save = workspaceApi.saveNote;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    workspaceApi.saveNote = async (...args) => {
      calls++;
      await held;
      return save(...args);
    };

    const saving = runEntityAction("note", note.id, "save");
    assert.deepEqual(await runEntityAction("note", note.id, "save"), { status: "ignored" });
    assert.equal(toast.getToasts().length, 0);
    assert.equal(calls, 1);
    useNoteStore.getState().upsertNote({ ...note, title: "Newer draft" });
    release();
    assert.equal((await saving).status, "acknowledged");
    assert.equal(toast.getToasts().length, 1);
    const notification = toast.getToasts()[0]!;
    assert.equal("title" in notification && notification.title, "Note saved");
    assert.equal(useNoteStore.getState().edits[`note:${note.id}`]?.dirty, true);
  });

  void it("does not mistake a swallowed network failure for success and retries the exact command", async () => {
    const note = useNoteStore.getState().createNote();
    const save = workspaceApi.saveNote;
    workspaceApi.saveNote = async (...args) => {
      await save(...args);
      throw new ApiError("Connection lost. Retry to confirm.", 503);
    };
    assert.equal((await runEntityAction("note", note.id, "save")).status, "failed");
    assert.equal(
      toast.getToasts().filter((item) => "type" in item && item.type === "success").length,
      0,
    );
    const pending = useNoteStore.getState().edits[`note:${note.id}`]?.pending;
    assert.ok(pending);
    workspaceApi.saveNote = (workspaceId, command) => {
      assert.deepEqual(command, pending.command);
      return save(workspaceId, command);
    };
    assert.equal((await runEntityAction("note", note.id, "retry")).status, "acknowledged");
    assert.equal(useNoteStore.getState().edits[`note:${note.id}`]?.pending, null);
    assert.equal(
      toast.getToasts().filter((item) => "type" in item && item.type === "error").length,
      0,
    );
  });

  void it("does not announce a historical save receipt as success after a later deletion", async () => {
    const note = useNoteStore.getState().createNote();
    const save = workspaceApi.saveNote;
    workspaceApi.saveNote = async (...args) => {
      await save(...args);
      throw new ApiError("Response lost", 503);
    };
    await runEntityAction("note", note.id, "save");
    const receipt = records.get(note.id)!;
    records.set(note.id, {
      ...receipt,
      revision: receipt.revision + 1,
      deletedAt: new Date().toISOString(),
    });
    workspaceApi.saveNote = () => Promise.resolve(receipt);
    assert.equal((await runEntityAction("note", note.id, "retry")).status, "failed");
    assert.equal(
      toast.getToasts().filter((item) => "type" in item && item.type === "success").length,
      0,
    );
  });

  for (const response of ["tombstone", "404"] as const) {
    void it(`reports local removal when use-latest resolves a ${response}`, async () => {
      const note = await createConflictedNote();
      if (response === "tombstone") {
        records.set(note.id, {
          ...records.get(note.id)!,
          revision: 2,
          deletedAt: new Date().toISOString(),
        });
      } else {
        records.delete(note.id);
      }

      assert.deepEqual(await runEntityAction("note", note.id, "use-latest"), {
        status: "local",
        deleted: true,
      });
      assert.equal(
        useNoteStore.getState().notes.some((item) => item.id === note.id),
        false,
      );
      assert.equal(useNoteStore.getState().edits[`note:${note.id}`], undefined);
      const notifications = toast.getToasts();
      assert.equal(notifications.length, 1);
      const notification = notifications[0]!;
      assert.equal("type" in notification && notification.type, "info");
      assert.equal("title" in notification && notification.title, "Deleted note removed");
    });

    void it(`does not report removal when newer edits survive a ${response}`, async () => {
      const note = await createConflictedNote();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      workspaceApi.note = async () => {
        await held;
        if (response === "404") throw new ApiError("Missing", 404);
        return {
          ...records.get(note.id)!,
          revision: 2,
          deletedAt: new Date().toISOString(),
        };
      };
      const resolving = runEntityAction("note", note.id, "use-latest");
      useNoteStore.getState().upsertNote({ ...note, title: "Newer edit while resolving" });
      release();

      const outcome = await resolving;
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.deleted, undefined);
      assert.equal(
        useNoteStore.getState().notes.find((item) => item.id === note.id)?.title,
        "Newer edit while resolving",
      );
      const notification = toast.getToasts()[0]!;
      assert.equal("type" in notification && notification.type, "error");
    });
  }

  void it("keeps genuine conflict-resolution lookup failures as failures", async () => {
    const note = await createConflictedNote();
    workspaceApi.note = () => Promise.reject(new ApiError("Lookup unavailable", 503));
    const outcome = await runEntityAction("note", note.id, "use-latest");
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.deleted, undefined);
    assert.equal(
      useNoteStore.getState().notes.some((item) => item.id === note.id),
      true,
    );
    assert.equal(useNoteStore.getState().edits[`note:${note.id}`]?.error, "Lookup unavailable");
    const notification = toast.getToasts()[0]!;
    assert.equal("type" in notification && notification.type, "error");
  });

  void it("recognizes local removal when the editor observer republishes a clean tombstone baseline", async () => {
    const note = await createConflictedNote();
    const tombstone = {
      ...records.get(note.id)!,
      revision: 2,
      deletedAt: new Date().toISOString(),
    };
    records.set(note.id, tombstone);
    // useNoteEditor reconciles the query's tombstone into the store. If that
    // effect follows removeDraft, acceptNote recreates a clean revision baseline.
    const unsubscribe = useNoteStore.subscribe((state, previous) => {
      if (state.lastDeleted !== previous.lastDeleted && state.lastDeleted?.id === note.id) {
        state.reconcileNote(tombstone, state.epoch, Date.now());
      }
    });
    try {
      assert.deepEqual(await runEntityAction("note", note.id, "use-latest"), {
        status: "local",
        deleted: true,
      });
      const state = useNoteStore.getState();
      assert.equal(
        state.notes.some((item) => item.id === note.id),
        false,
      );
      assert.equal(state.edits[`note:${note.id}`]?.baseRevision, tombstone.revision);
      assert.equal(state.edits[`note:${note.id}`]?.dirty, false);
      const notification = toast.getToasts()[0]!;
      assert.equal("type" in notification && notification.type, "info");
      assert.equal("title" in notification && notification.title, "Deleted note removed");
    } finally {
      unsubscribe();
    }
  });

  void it("clears toasts on scope changes and ignores late outgoing completions", async () => {
    const first = useNoteStore.getState().createNote();
    await runEntityAction("note", first.id, "save");
    await useNoteStore.getState().refreshSession();
    assert.equal(toast.getToasts().length, 1, "same-scope refresh keeps the toast");
    const second = useNoteStore.getState().createNote();
    const save = workspaceApi.saveNote;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    workspaceApi.saveNote = async (...args) => {
      await held;
      return save(...args);
    };
    const saving = runEntityAction("note", second.id, "save");
    useNoteStore.getState().clearSession();
    assert.equal(toast.getToasts().length, 0);
    release();
    assert.equal((await saving).status, "ignored");
    assert.equal(toast.getToasts().length, 0);
  });

  void it("does not announce autosave or a no-op explicit save", async () => {
    const note = useNoteStore.getState().createNote();
    await useNoteStore.getState().saveNote(note.id);
    assert.equal((await runEntityAction("note", note.id, "save")).status, "ignored");
    assert.equal(toast.getToasts().length, 0);
  });

  void it("distinguishes local draft discard from acknowledged deletion", async () => {
    const local = useNoteStore.getState().createNote();
    assert.deepEqual(await runEntityAction("note", local.id, "delete"), {
      status: "local",
      deleted: true,
    });
    assert.equal(
      toast.getToasts().filter((item) => "type" in item && item.type === "success").length,
      0,
    );
    const saved = useNoteStore.getState().createNote();
    await useNoteStore.getState().saveNote(saved.id);
    assert.deepEqual(await runEntityAction("note", saved.id, "delete"), {
      status: "acknowledged",
      deleted: true,
    });
    assert.equal(
      toast.getToasts().filter((item) => "type" in item && item.type === "success").length,
      1,
    );
  });
});
