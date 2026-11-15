import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useNoteStore } from "../../src/stores/use-note-store";
import { isOwnedSession } from "../../src/stores/use-recording-store";
import type { LocalRecordingSession } from "../../src/lib/recording-schemas";
import { ApiError, workspaceApi } from "../../src/lib/workspace-api";
import type { NoteRecord, PersonRecord, SaveNote } from "../../src/contracts/workspace";

const originalApi = { ...workspaceApi };
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const values = new Map<string, string>();
const scope = {
  user: { id: randomUUID(), email: null },
  workspace: { id: randomUUID(), name: "Private" },
};
let failWrites = false;
let mutationStatus = 200;
let logoutStatus = 200;
let commands: SaveNote[] = [];
let sessionCalls = 0;
let noteListCalls = 0;
let peopleListCalls = 0;
const records = new Map<string, NoteRecord>();

void describe("workspace store recovery boundaries (no database)", { concurrency: false }, () => {
  beforeEach(async () => {
    failWrites = false;
    useNoteStore.getState().clearSession();
    useNoteStore.setState(useNoteStore.getInitialState());
    values.clear();
    records.clear();
    commands = [];
    mutationStatus = 200;
    logoutStatus = 200;
    sessionCalls = 0;
    noteListCalls = 0;
    peopleListCalls = 0;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (failWrites) throw new Error("Storage blocked");
          values.set(key, value);
        },
        removeItem: (key: string) => {
          values.delete(key);
        },
      },
    });
    workspaceApi.session = () => {
      sessionCalls++;
      return Promise.resolve(scope);
    };
    workspaceApi.signOut = () =>
      logoutStatus === 200
        ? Promise.resolve({ ok: true })
        : Promise.reject(new ApiError("Logout failed", logoutStatus));
    workspaceApi.saveNote = (workspaceId, command) => {
      assert.equal(workspaceId, scope.workspace.id);
      // The exact command must already be durable before the API is invoked.
      assert.ok([...values.values()].some((raw) => raw.includes(command.commandId)));
      commands.push(command);
      if (mutationStatus !== 200)
        return Promise.reject(new ApiError("Injected failure", mutationStatus));
      const existing = records.get(command.id);
      const record: NoteRecord = {
        ...command.content,
        id: command.id,
        workspaceId,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      };
      records.set(command.id, record);
      return Promise.resolve(record);
    };
    workspaceApi.note = (workspaceId, id) => {
      assert.equal(workspaceId, scope.workspace.id);
      const record = records.get(id);
      return record ? Promise.resolve(record) : Promise.reject(new ApiError("Missing", 404));
    };
    workspaceApi.notes = () => {
      noteListCalls++;
      return Promise.resolve({ items: [], nextCursor: null });
    };
    workspaceApi.people = () => {
      peopleListCalls++;
      return Promise.resolve({ items: [], nextCursor: null });
    };
    await useNoteStore.getState().initialize();
  });
  afterEach(() => {
    useNoteStore.getState().clearSession();
    Object.assign(workspaceApi, originalApi);
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  void it("persists drafts and exact uncertain commands across session rehydration", async () => {
    const note = useNoteStore.getState().createNote();
    useNoteStore.getState().upsertNote({ ...note, title: "Original request" });
    mutationStatus = 503;
    await useNoteStore.getState().saveNote(note.id);
    const original = commands[0]!;
    useNoteStore.getState().upsertNote({ ...note, title: "Newer draft" });
    useNoteStore.getState().clearSession();
    await useNoteStore.getState().refreshSession();
    assert.equal(useNoteStore.getState().recoveredDraftCount, 1);
    assert.equal(useNoteStore.getState().notes[0]?.title, "Newer draft");
    mutationStatus = 200;
    await useNoteStore.getState().retry("note", note.id);
    assert.deepEqual(commands[1], original);
    assert.equal(useNoteStore.getState().edits[`note:${note.id}`]?.dirty, true);
  });

  void it("does not send a mutation without durable command storage", async () => {
    const note = useNoteStore.getState().createNote();
    failWrites = true;
    await useNoteStore.getState().saveNote(note.id);
    assert.equal(commands.length, 0);
    assert.match(useNoteStore.getState().recoveryError!, /could not be stored/);
    assert.equal(await useNoteStore.getState().saveAll(), false);
  });

  void it("retains exact recovery on expiry, but does not sign out on authorization denial", async () => {
    const note = useNoteStore.getState().createNote();
    mutationStatus = 403;
    await useNoteStore.getState().saveNote(note.id);
    assert.equal(useNoteStore.getState().session?.user.id, scope.user.id);
    mutationStatus = 401;
    await useNoteStore.getState().saveNote(note.id);
    const pendingId = commands.at(-1)!.commandId;
    assert.equal(useNoteStore.getState().session, null);
    assert.deepEqual(useNoteStore.getState().notes, []);
    assert.ok([...values.values()].some((raw) => raw.includes(pendingId)));
    await useNoteStore.getState().refreshSession();
    assert.equal(
      useNoteStore.getState().edits[`note:${note.id}`]?.pending?.command.commandId,
      pendingId,
    );
  });

  void it("discards current scope only after successful logout confirmation", async () => {
    useNoteStore.getState().createNote();
    logoutStatus = 503;
    await useNoteStore.getState().signOut(true);
    assert.ok(useNoteStore.getState().session);
    assert.equal(values.size, 1);
    logoutStatus = 200;
    await useNoteStore.getState().signOut(true);
    assert.equal(useNoteStore.getState().session, null);
    assert.equal(values.size, 0);
  });

  void it("hydrates deep links without a list hit and scopes missing route state", async () => {
    const id = randomUUID();
    records.set(id, {
      id,
      workspaceId: scope.workspace.id,
      title: "Deep link",
      transcript: "",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    });
    await useNoteStore.getState().ensureNote(id);
    assert.equal(useNoteStore.getState().noteRecords[id]?.title, "Deep link");
    const missing = randomUUID();
    await useNoteStore.getState().ensureNote(missing);
    assert.equal(useNoteStore.getState().unavailable[`note:${missing}`], "missing");
  });

  void it("coalesces concurrent workspace initialization without fetching remote lists", async () => {
    useNoteStore.getState().clearSession();
    useNoteStore.setState({ status: "idle" });
    sessionCalls = 0;
    await Promise.all([
      useNoteStore.getState().initialize(),
      useNoteStore.getState().initialize(),
      useNoteStore.getState().refreshSession(),
    ]);
    assert.equal(sessionCalls, 1);
    assert.equal(noteListCalls, 0);
    assert.equal(peopleListCalls, 0);
    assert.equal(useNoteStore.getState().status, "ready");
  });

  void it("deduplicates deep-link loads and explicitly retries missing records", async () => {
    const id = randomUUID();
    const note = workspaceApi.note;
    let calls = 0;
    workspaceApi.note = (...args) => {
      if (args[1] === id) calls++;
      return note(...args);
    };
    await Promise.all([
      useNoteStore.getState().ensureNote(id),
      useNoteStore.getState().ensureNote(id),
    ]);
    assert.equal(calls, 1);
    await useNoteStore.getState().ensureNote(id);
    assert.equal(calls, 1);
    records.set(id, {
      id,
      workspaceId: scope.workspace.id,
      title: "Available now",
      transcript: "",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    });
    await useNoteStore.getState().ensureNote(id, true);
    assert.equal(calls, 2);
    assert.equal(useNoteStore.getState().unavailable[`note:${id}`], undefined);
    assert.equal(useNoteStore.getState().noteRecords[id]?.title, "Available now");
  });

  void it("keeps record failures scoped and ignores a late response after sign-out", async () => {
    const failed = randomUUID();
    workspaceApi.note = () => Promise.reject(new ApiError("Temporary record failure", 503));
    await useNoteStore.getState().ensureNote(failed);
    assert.match(useNoteStore.getState().recordErrors[`note:${failed}`]!, /Temporary/);
    assert.equal(useNoteStore.getState().error, null);
    let release!: (value: NoteRecord) => void;
    workspaceApi.note = () =>
      new Promise<NoteRecord>((resolve) => {
        release = resolve;
      });
    const id = randomUUID();
    const pending = useNoteStore.getState().ensureNote(id);
    useNoteStore.getState().clearSession();
    release({
      id,
      workspaceId: scope.workspace.id,
      title: "Late",
      transcript: "",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    });
    await pending;
    assert.equal(useNoteStore.getState().notes.length, 0);
    assert.deepEqual(useNoteStore.getState().recordErrors, {});
  });

  void it("does not reopen a server-deleted record from recovered drafts or pending creates", async () => {
    const note = useNoteStore.getState().createNote();
    mutationStatus = 503;
    await useNoteStore.getState().saveNote(note.id);
    // Model a create whose response was lost followed by another client's delete.
    records.set(note.id, {
      id: note.id,
      workspaceId: scope.workspace.id,
      title: "Deleted elsewhere",
      transcript: "",
      revision: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: new Date().toISOString(),
    });
    useNoteStore.getState().clearSession();
    await useNoteStore.getState().refreshSession();
    assert.equal(useNoteStore.getState().notes.length, 0);
    assert.equal(useNoteStore.getState().noteRecords[note.id], undefined);
    assert.ok(
      [...values.values()].some((raw) => raw.includes(note.id)),
      "quarantined recovery remains available locally",
    );
    assert.equal(await useNoteStore.getState().saveAll(), false);
    assert.match(useNoteStore.getState().recoveryError!, /could not be verified/);
  });

  void it("refreshes acknowledged note baselines through ensure without replacing dirty editor work", async () => {
    const id = randomUUID();
    const record: NoteRecord = {
      id,
      workspaceId: scope.workspace.id,
      title: "Acknowledged title",
      transcript: "",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    useNoteStore.getState().reconcileNote(record, useNoteStore.getState().epoch);
    const draft = useNoteStore.getState().notes[0]!;
    useNoteStore.getState().upsertNote({ ...draft, title: "Unsaved title" });
    const edit = useNoteStore.getState().edits[`note:${id}`];
    records.set(id, { ...record, revision: 2, title: "New server title" });
    await useNoteStore.getState().ensureNote(id);
    assert.equal(useNoteStore.getState().noteRecords[id]?.revision, 2);
    assert.equal(useNoteStore.getState().notes[0]?.title, "Unsaved title");
    assert.equal(useNoteStore.getState().edits[`note:${id}`], edit);
    useNoteStore.getState().reconcileNote(record);
    assert.equal(useNoteStore.getState().noteRecords[id]?.revision, 2);
  });

  void it("reconciles person baselines monotonically without replacing edits or accepting stale scopes", () => {
    const person: PersonRecord = {
      id: randomUUID(),
      workspaceId: scope.workspace.id,
      displayName: "Original name",
      description: "",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    const epoch = useNoteStore.getState().epoch;
    useNoteStore.getState().reconcilePerson(person, epoch);
    const draft = useNoteStore.getState().people[0]!;
    useNoteStore.getState().updatePerson({ ...draft, displayName: "Unsaved name" });
    const edit = useNoteStore.getState().edits[`person:${person.id}`];
    useNoteStore
      .getState()
      .reconcilePerson({ ...person, revision: 2, displayName: "Remote name" }, epoch);
    useNoteStore.getState().reconcilePerson(person, epoch);
    assert.equal(useNoteStore.getState().personRecords[person.id]?.revision, 2);
    assert.equal(useNoteStore.getState().people[0]?.displayName, "Unsaved name");
    assert.equal(useNoteStore.getState().edits[`person:${person.id}`], edit);
    const baseline = useNoteStore.getState().personRecords[person.id];
    useNoteStore.getState().reconcilePerson({ ...person, revision: 3 }, epoch - 1);
    useNoteStore
      .getState()
      .reconcilePerson({ ...person, workspaceId: randomUUID(), revision: 3 }, epoch);
    assert.equal(useNoteStore.getState().personRecords[person.id], baseline);
    useNoteStore.getState().reconcileUnavailable("person", person.id, "forbidden", epoch, 100);
    useNoteStore.getState().reconcilePerson({ ...person, revision: 2 }, epoch, 99);
    assert.equal(useNoteStore.getState().unavailable[`person:${person.id}`], "forbidden");
    useNoteStore.getState().reconcilePerson({ ...person, revision: 2 }, epoch, 101);
    assert.equal(useNoteStore.getState().unavailable[`person:${person.id}`], undefined);
    assert.equal(useNoteStore.getState().people[0]?.displayName, "Unsaved name");
    assert.equal(useNoteStore.getState().edits[`person:${person.id}`], edit);
  });

  void it("revokes audio ownership on authoritative denial while preserving drafts and exact commands", async () => {
    const note = useNoteStore.getState().createNote();
    await useNoteStore.getState().saveNote(note.id);
    const record = useNoteStore.getState().noteRecords[note.id]!;
    const epoch = useNoteStore.getState().epoch;
    const audio: LocalRecordingSession = {
      id: randomUUID(),
      noteId: note.id,
      userId: scope.user.id,
      workspaceId: scope.workspace.id,
      status: "finalized",
      mimeType: "audio/webm",
      chunkCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    assert.equal(isOwnedSession(audio), true);
    useNoteStore.getState().upsertNote({ ...note, title: "Uncertain title" });
    mutationStatus = 503;
    await useNoteStore.getState().saveNote(note.id);
    useNoteStore.getState().upsertNote({ ...note, title: "Newer unsaved title" });
    const edit = useNoteStore.getState().edits[`note:${note.id}`]!;
    useNoteStore.getState().reconcileUnavailable("note", note.id, "forbidden", epoch, 100);
    assert.equal(isOwnedSession(audio), false);
    for (const updatedAt of [undefined, 99, 100]) {
      useNoteStore.getState().reconcileNote(record, epoch, updatedAt);
      assert.equal(isOwnedSession(audio), false);
    }
    assert.equal(useNoteStore.getState().notes[0]?.title, "Newer unsaved title");
    assert.equal(useNoteStore.getState().edits[`note:${note.id}`], edit);
    assert.ok([...values.values()].some((raw) => raw.includes(edit.pending!.command.commandId)));
    useNoteStore.getState().reconcileNote(record, epoch, 101);
    assert.equal(isOwnedSession(audio), true);
    assert.equal(useNoteStore.getState().notes[0]?.title, "Newer unsaved title");
    assert.equal(useNoteStore.getState().edits[`note:${note.id}`], edit);
  });

  void it("keeps missing notes unavailable during retry and rejects an older retry after a newer denial", async () => {
    const note = useNoteStore.getState().createNote();
    await useNoteStore.getState().saveNote(note.id);
    const record = useNoteStore.getState().noteRecords[note.id]!;
    const epoch = useNoteStore.getState().epoch;
    useNoteStore.getState().reconcileUnavailable("note", note.id, "missing", epoch, 100);
    let release!: (value: NoteRecord) => void;
    const deferred = new Promise<NoteRecord>((resolve) => {
      release = resolve;
    });
    workspaceApi.note = (_workspace, _id, includeDeleted) => {
      assert.equal(includeDeleted, true, "explicit retry uses the fresh detail API");
      return deferred;
    };
    const retry = useNoteStore.getState().ensureNote(note.id, true);
    assert.equal(useNoteStore.getState().unavailable[`note:${note.id}`], "missing");
    useNoteStore.getState().reconcileUnavailable("note", note.id, "forbidden", epoch, 101);
    release(record);
    await retry;
    assert.equal(useNoteStore.getState().unavailable[`note:${note.id}`], "forbidden");
    await useNoteStore.getState().ensureNote(note.id, true);
    assert.equal(useNoteStore.getState().unavailable[`note:${note.id}`], undefined);
  });

  void it("ignores old-epoch failures and never revives an acknowledged tombstone from a live snapshot", async () => {
    const note = useNoteStore.getState().createNote();
    await useNoteStore.getState().saveNote(note.id);
    const record = useNoteStore.getState().noteRecords[note.id]!;
    const previousEpoch = useNoteStore.getState().epoch;
    useNoteStore.getState().clearSession();
    await useNoteStore.getState().refreshSession();
    const epoch = useNoteStore.getState().epoch;
    useNoteStore.getState().reconcileNote(record, epoch, 100);
    useNoteStore.getState().reconcileUnavailable("note", note.id, "forbidden", previousEpoch, 200);
    assert.equal(useNoteStore.getState().unavailable[`note:${note.id}`], undefined);
    useNoteStore.getState().reconcileUnavailable("note", note.id, "missing", epoch, 101);
    useNoteStore
      .getState()
      .reconcileNote({ ...record, revision: 2, deletedAt: new Date().toISOString() }, epoch, 102);
    useNoteStore.getState().reconcileNote({ ...record, revision: 3 }, epoch, 103);
    assert.equal(useNoteStore.getState().unavailable[`note:${note.id}`], "missing");
    assert.ok(useNoteStore.getState().noteRecords[note.id]?.deletedAt);
    assert.equal(useNoteStore.getState().notes.length, 0);
  });
});
