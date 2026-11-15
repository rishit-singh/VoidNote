import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { NoteRecord } from "../../src/contracts/workspace";
import { ApiError, workspaceApi } from "../../src/lib/workspace-api";
import { useNoteStore } from "../../src/stores/use-note-store";
import { workspaceRecovery, type RecoveryEntry } from "../../src/stores/workspace-recovery";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalApi = { ...workspaceApi };
const values = new Map<string, string>();
const scope = () => ({
  user: { id: randomUUID(), email: null },
  workspace: { id: randomUUID(), name: "Private" },
});
let owner = scope();
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const draft = (): RecoveryEntry => {
  const id = randomUUID();
  return {
    entity: "note",
    draft: {
      id,
      title: "Recovered draft",
      transcript: "",
      createdAt: null,
      updatedAt: null,
      recordingSessionId: null,
    },
    edit: {
      baseRevision: 1,
      generation: 2,
      dirty: true,
      conflict: null,
      pending: {
        kind: "note",
        generation: 1,
        command: {
          id,
          commandId: randomUUID(),
          expectedRevision: 1,
          content: { title: "Original uncertain request", transcript: "" },
        },
      },
    },
  };
};
const record = (id: string): NoteRecord => ({
  id,
  workspaceId: owner.workspace.id,
  title: "Server title",
  transcript: "",
  revision: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deletedAt: null,
});

void describe(
  "scoped hydration races (no database or authentication credentials)",
  { concurrency: false },
  () => {
    beforeEach(() => {
      useNoteStore.getState().clearSession();
      useNoteStore.setState({ status: "idle" });
      values.clear();
      owner = scope();
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => {
            values.set(key, value);
          },
          removeItem: (key: string) => {
            values.delete(key);
          },
        },
      });
      workspaceApi.session = () => Promise.resolve(owner);
      workspaceApi.notes = () => Promise.reject(new Error("Bootstrap must not fetch note lists"));
      workspaceApi.people = () =>
        Promise.reject(new Error("Bootstrap must not fetch people lists"));
    });
    afterEach(() => {
      useNoteStore.getState().clearSession();
      Object.assign(workspaceApi, originalApi);
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    });

    void it("keeps authentication independent of failed recovery until explicit retry succeeds", async () => {
      const key = `voidnote:recovery:v1:${owner.user.id}:${owner.workspace.id}`;
      values.set(key, "corrupt recovery");
      await useNoteStore.getState().initialize();
      assert.equal(useNoteStore.getState().session?.user.id, owner.user.id);
      assert.equal(useNoteStore.getState().hydrated, true);
      assert.equal(useNoteStore.getState().recoveryHydration, "error");
      assert.equal(useNoteStore.getState().status, "error");
      assert.throws(() => useNoteStore.getState().createNote(), /recovery/);
      await useNoteStore.getState().refreshSession();
      assert.equal(useNoteStore.getState().recoveryHydration, "error");
      assert.equal(useNoteStore.getState().status, "error");
      assert.equal(values.get(key), "corrupt recovery");
      values.delete(key);
      await useNoteStore.getState().retryRecovery();
      assert.equal(useNoteStore.getState().recoveryHydration, "ready");
      assert.equal(useNoteStore.getState().status, "ready");
    });

    void it("deduplicates hydration and preserves both in-flight edits and the exact recovered command", async () => {
      const saved = draft();
      workspaceRecovery(owner).write([saved]);
      const started = deferred<void>();
      const release = deferred<NoteRecord>();
      let validations = 0;
      let sessions = 0;
      workspaceApi.session = () => {
        sessions++;
        return Promise.resolve(owner);
      };
      workspaceApi.note = async (_workspace, id, includeDeleted) => {
        if (!includeDeleted) return record(id);
        validations++;
        started.resolve();
        return release.promise;
      };
      workspaceApi.saveNote = () => Promise.reject(new Error("Must not mutate during hydration"));
      const first = useNoteStore.getState().initialize();
      const second = useNoteStore.getState().initialize();
      await started.promise;
      const refresh = useNoteStore.getState().refreshSession();
      const retry = useNoteStore.getState().retryRecovery();
      assert.equal(useNoteStore.getState().recoveryHydration, "loading");
      assert.equal(useNoteStore.getState().status, "loading");
      await useNoteStore.getState().ensureNote(saved.draft.id);
      const current = useNoteStore.getState().notes[0]!;
      useNoteStore.getState().upsertNote({ ...current, title: "Typed during recovery" });
      await useNoteStore.getState().saveNote(current.id);
      release.resolve(record(current.id));
      await Promise.all([first, second, refresh, retry]);
      assert.equal(sessions, 1);
      assert.equal(validations, 1);
      assert.equal(useNoteStore.getState().status, "ready");
      assert.equal(useNoteStore.getState().notes[0]?.title, "Typed during recovery");
      const edit = useNoteStore.getState().edits[`note:${current.id}`]!;
      assert.deepEqual(edit.pending, saved.edit.pending);
      assert.ok(edit.generation > saved.edit.generation);
      const restored = await workspaceRecovery(owner).read();
      assert.equal(
        restored[0]?.entity === "note" && restored[0].draft.title,
        "Typed during recovery",
      );
      assert.deepEqual(restored[0]?.edit.pending, saved.edit.pending);
    });

    void it("bounds concurrent validation and never treats transient validation failure as ready", async () => {
      const entries = Array.from({ length: 9 }, draft);
      workspaceRecovery(owner).write(entries);
      const original = [...values.values()][0];
      const started = deferred<void>();
      const release = deferred<void>();
      let active = 0;
      let maximum = 0;
      let calls = 0;
      workspaceApi.note = async (_workspace, id) => {
        calls++;
        active++;
        maximum = Math.max(maximum, active);
        if (active === 4) started.resolve();
        await release.promise;
        active--;
        if (id === entries[0]!.draft.id) throw new ApiError("Temporarily unavailable", 503);
        return record(id);
      };
      const hydration = useNoteStore.getState().initialize();
      await started.promise;
      assert.equal(calls, 4);
      release.resolve();
      await hydration;
      assert.equal(calls, 9);
      assert.equal(maximum, 4);
      assert.equal(useNoteStore.getState().recoveryHydration, "error");
      assert.equal(useNoteStore.getState().status, "error");
      assert.equal([...values.values()][0], original);
      assert.equal(useNoteStore.getState().notes.length, 0);
      assert.equal(await useNoteStore.getState().saveAll(), false);
    });

    void it("rejects late validation after an account switch", async () => {
      const previousOwner = owner;
      const saved = draft();
      const oldRecord = record(saved.draft.id);
      workspaceRecovery(owner).write([saved]);
      const started = deferred<void>();
      const release = deferred<NoteRecord>();
      workspaceApi.note = async () => {
        started.resolve();
        return release.promise;
      };
      const oldHydration = useNoteStore.getState().initialize();
      await started.promise;
      useNoteStore.getState().clearSession();
      owner = scope();
      await useNoteStore.getState().refreshSession();
      const epoch = useNoteStore.getState().epoch;
      release.resolve(oldRecord);
      await oldHydration;
      assert.equal(useNoteStore.getState().session?.user.id, owner.user.id);
      assert.equal(useNoteStore.getState().recoveryEpoch, epoch);
      assert.equal(useNoteStore.getState().recoveryHydration, "ready");
      assert.equal(useNoteStore.getState().notes.length, 0);
      assert.deepEqual(await workspaceRecovery(previousOwner).read(), [saved]);
    });

    void it("same-account session revalidation awaits an in-progress recovery retry", async () => {
      const saved = draft();
      workspaceRecovery(owner).write([saved]);
      workspaceApi.note = () => Promise.reject(new ApiError("Try again", 503));
      await useNoteStore.getState().initialize();
      assert.equal(useNoteStore.getState().recoveryHydration, "error");
      const started = deferred<void>();
      const release = deferred<NoteRecord>();
      workspaceApi.note = () => {
        started.resolve();
        return release.promise;
      };
      const retry = useNoteStore.getState().retryRecovery();
      await started.promise;
      const sessionRead = deferred<void>();
      workspaceApi.session = () => {
        sessionRead.resolve();
        return Promise.resolve(owner);
      };
      let refreshDone = false;
      const refresh = useNoteStore
        .getState()
        .refreshSession()
        .then(() => {
          refreshDone = true;
        });
      await sessionRead.promise;
      await Promise.resolve();
      assert.equal(refreshDone, false);
      assert.equal(useNoteStore.getState().status, "loading");
      assert.equal(useNoteStore.getState().recoveryHydration, "loading");
      release.resolve(record(saved.draft.id));
      await Promise.all([retry, refresh]);
      assert.equal(refreshDone, true);
      assert.equal(useNoteStore.getState().status, "ready");
      assert.equal(useNoteStore.getState().notes[0]?.title, "Recovered draft");
    });

    void it("reconciles acknowledged records without replacing dirty drafts or accepting old scope results", async () => {
      await useNoteStore.getState().initialize();
      const first = record(randomUUID());
      const epoch = useNoteStore.getState().epoch;
      useNoteStore.getState().reconcileNote(first, epoch);
      const local = useNoteStore.getState().notes[0]!;
      useNoteStore.getState().upsertNote({ ...local, title: "Unsaved title" });
      const edit = useNoteStore.getState().edits[`note:${first.id}`];
      useNoteStore
        .getState()
        .reconcileNote({ ...first, revision: 2, title: "Remote title" }, epoch);
      assert.equal(useNoteStore.getState().noteRecords[first.id]?.revision, 2);
      assert.equal(useNoteStore.getState().notes[0]?.title, "Unsaved title");
      assert.equal(useNoteStore.getState().edits[`note:${first.id}`], edit);
      useNoteStore.getState().clearSession();
      owner = { ...owner, user: { id: randomUUID(), email: null } };
      await useNoteStore.getState().refreshSession();
      useNoteStore.getState().reconcileNote(first, epoch);
      useNoteStore.getState().reconcileNote({ ...first, workspaceId: randomUUID() });
      assert.equal(useNoteStore.getState().notes.length, 0);
    });
  },
);
