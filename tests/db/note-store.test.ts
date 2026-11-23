import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useNoteStore } from "../../src/stores/use-note-store";
import { isOwnedSession } from "../../src/stores/use-recording-store";
import type { LocalRecordingSession } from "../../src/lib/recording-schemas";
import { ApiError, workspaceApi } from "../../src/lib/workspace-api";
import type { NoteRecord, PersonRecord, SaveNote, SavePerson } from "../../src/contracts/workspace";
import { workspaceRecovery } from "../../src/stores/workspace-recovery";

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
let personCommands: SavePerson[] = [];
let sessionCalls = 0;
let noteListCalls = 0;
let peopleListCalls = 0;
const records = new Map<string, NoteRecord>();
const personRecords = new Map<string, PersonRecord>();

void describe("workspace store recovery boundaries (no database)", { concurrency: false }, () => {
  beforeEach(async () => {
    failWrites = false;
    useNoteStore.getState().clearSession();
    useNoteStore.setState(useNoteStore.getInitialState());
    values.clear();
    records.clear();
    personRecords.clear();
    commands = [];
    personCommands = [];
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
      if ((existing?.revision ?? 0) !== command.expectedRevision || existing?.deletedAt) {
        return Promise.reject(
          new ApiError("The record has changed", 409, "conflict", existing?.revision ?? 0),
        );
      }
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
    workspaceApi.savePerson = (workspaceId, command) => {
      assert.equal(workspaceId, scope.workspace.id);
      assert.ok([...values.values()].some((raw) => raw.includes(command.commandId)));
      personCommands.push(command);
      if (mutationStatus !== 200)
        return Promise.reject(new ApiError("Injected failure", mutationStatus));
      const existing = personRecords.get(command.id);
      if ((existing?.revision ?? 0) !== command.expectedRevision || existing?.deletedAt) {
        return Promise.reject(
          new ApiError("The record has changed", 409, "conflict", existing?.revision ?? 0),
        );
      }
      const record: PersonRecord = {
        ...command.content,
        id: command.id,
        workspaceId,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      };
      personRecords.set(command.id, record);
      return Promise.resolve(record);
    };
    workspaceApi.person = (workspaceId, id) => {
      assert.equal(workspaceId, scope.workspace.id);
      const record = personRecords.get(id);
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

  void it("preserves newer draft generations and recorder handles during save acknowledgements", async () => {
    const note = useNoteStore.getState().createNote();
    const key = `note:${note.id}`;
    useNoteStore.getState().upsertNote({ ...note, title: "Original request" });
    const saveNote = workspaceApi.saveNote;
    let release!: () => void;
    workspaceApi.saveNote = async (...args) => {
      const record = await saveNote(...args);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return record;
    };
    const firstSave = useNoteStore.getState().saveNote(note.id);
    await Promise.resolve();
    const originalGeneration = useNoteStore.getState().edits[key]!.generation;
    const audio = new Blob(["captured audio"], { type: "audio/webm" });
    const recordingSessionId = randomUUID();
    useNoteStore.getState().upsertNote({
      ...note,
      title: "Newer draft",
      audio,
      url: "blob:first-capture",
      recordingSessionId,
    });
    release();
    await firstSave;
    assert.equal(commands[0]?.content.title, "Original request");
    assert.equal(useNoteStore.getState().noteRecords[note.id]?.title, "Original request");
    assert.equal(useNoteStore.getState().notes[0]?.title, "Newer draft");
    assert.equal(useNoteStore.getState().edits[key]?.generation, originalGeneration + 1);
    assert.equal(useNoteStore.getState().edits[key]?.dirty, true);

    const secondSave = useNoteStore.getState().saveNote(note.id);
    await Promise.resolve();
    const current = useNoteStore.getState().notes[0]!;
    const currentGeneration = useNoteStore.getState().edits[key]!.generation;
    useNoteStore.getState().upsertNote({ ...current, url: "blob:latest-capture" });
    assert.equal(useNoteStore.getState().edits[key]?.generation, currentGeneration);
    release();
    await secondSave;
    const acknowledged = useNoteStore.getState().notes[0]!;
    assert.equal(commands[1]?.expectedRevision, 1);
    assert.equal(commands[1]?.content.title, "Newer draft");
    assert.equal(acknowledged.title, "Newer draft");
    assert.equal(acknowledged.audio, audio);
    assert.equal(acknowledged.url, "blob:latest-capture");
    assert.equal(acknowledged.recordingSessionId, recordingSessionId);
    assert.equal(useNoteStore.getState().edits[key]?.dirty, false);
    assert.equal(useNoteStore.getState().edits[key]?.pending, null);
  });

  void it("accepts the server-allocated first title without fetching or deriving it from lists", async () => {
    const note = useNoteStore.getState().createNote();
    const saveNote = workspaceApi.saveNote;
    workspaceApi.saveNote = async (...args) => {
      const record = { ...(await saveNote(...args)), title: "Untitled note (42)" };
      records.set(note.id, record);
      return record;
    };
    await useNoteStore.getState().saveNote(note.id);
    assert.equal(commands[0]?.content.title, "");
    assert.equal(useNoteStore.getState().notes[0]?.title, "Untitled note (42)");
    assert.equal(useNoteStore.getState().noteRecords[note.id]?.title, "Untitled note (42)");
    assert.equal(useNoteStore.getState().edits[`note:${note.id}`]?.dirty, false);
    assert.equal(noteListCalls, 0);
    assert.deepEqual(await workspaceRecovery(scope).read(), []);
  });

  for (const newerTitle of [undefined, "Newer title", " \t"]) {
    void it(`reconciles an allocated title through newer ${newerTitle === undefined ? "transcript-only" : "title"} edits (${JSON.stringify(newerTitle)})`, async () => {
      const note = useNoteStore.getState().createNote();
      const key = `note:${note.id}`;
      const saveNote = workspaceApi.saveNote;
      let release!: () => void;
      workspaceApi.saveNote = async (...args) => {
        const saved = await saveNote(...args);
        const record = { ...saved, title: "Untitled note (7)" };
        records.set(note.id, record);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return record;
      };
      const saving = useNoteStore.getState().saveNote(note.id);
      await Promise.resolve();
      const audio = new Blob(["new audio"]);
      useNoteStore.getState().upsertNote({
        ...note,
        title: newerTitle ?? note.title,
        transcript: "Newer transcript",
        audio,
        url: "blob:live-capture",
      });
      const generation = useNoteStore.getState().edits[key]!.generation;
      release();
      await saving;

      const expectedTitle = newerTitle ?? "Untitled note (7)";
      const draft = useNoteStore.getState().notes[0]!;
      assert.equal(draft.title, expectedTitle);
      assert.equal(draft.transcript, "Newer transcript");
      assert.equal(draft.audio, audio);
      assert.equal(draft.url, "blob:live-capture");
      assert.equal(useNoteStore.getState().noteRecords[note.id]?.title, "Untitled note (7)");
      assert.equal(useNoteStore.getState().edits[key]?.generation, generation);
      assert.equal(useNoteStore.getState().edits[key]?.dirty, true);
      assert.equal(useNoteStore.getState().edits[key]?.pending, null);
      const [recovered] = await workspaceRecovery(scope).read();
      assert.equal(recovered?.entity === "note" && recovered.draft.title, expectedTitle);
      assert.equal(recovered?.entity === "note" && recovered.draft.transcript, "Newer transcript");

      workspaceApi.saveNote = saveNote;
      await useNoteStore.getState().saveNote(note.id);
      assert.equal(commands[1]?.expectedRevision, 1);
      assert.deepEqual(commands[1]?.content, {
        title: expectedTitle,
        transcript: "Newer transcript",
      });
      assert.equal(useNoteStore.getState().edits[key]?.dirty, false);
    });
  }

  for (const recovering of [false, true]) {
    void it(`preserves a later round-trip title clear on ${recovering ? "recovered exact retry" : "first acknowledgement"}`, async () => {
      const note = useNoteStore.getState().createNote();
      const key = `note:${note.id}`;
      const saveNote = workspaceApi.saveNote;
      let release!: () => void;
      let receipt!: NoteRecord;
      workspaceApi.saveNote = async (...args) => {
        receipt = { ...(await saveNote(...args)), title: "Untitled note (9)" };
        records.set(note.id, receipt);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (recovering) throw new ApiError("Response lost after commit", 503);
        return receipt;
      };
      const saving = useNoteStore.getState().saveNote(note.id);
      await Promise.resolve();
      const pending = useNoteStore.getState().edits[key]!.pending!;
      const originalCommand = JSON.stringify(pending.command);
      useNoteStore.getState().upsertNote({ ...note, title: "Temporary" });
      useNoteStore.getState().upsertNote({ ...note, title: "" });
      assert.equal(useNoteStore.getState().edits[key]?.titleGeneration, 2);
      assert.equal(useNoteStore.getState().edits[key]?.pending, pending);
      release();
      await saving;

      if (recovering) {
        useNoteStore.getState().clearSession();
        await useNoteStore.getState().refreshSession();
        assert.equal(useNoteStore.getState().edits[key]?.titleGeneration, 2);
        workspaceApi.saveNote = (_workspaceId, command, options) => {
          assert.equal(JSON.stringify(command), originalCommand);
          assert.deepEqual(options, { replaying: true });
          return Promise.resolve(receipt);
        };
        await useNoteStore.getState().retry("note", note.id);
      }
      assert.equal(useNoteStore.getState().notes[0]?.title, "");
      assert.equal(useNoteStore.getState().noteRecords[note.id]?.title, receipt.title);
      assert.equal(useNoteStore.getState().edits[key]?.dirty, true);
      assert.equal(useNoteStore.getState().edits[key]?.pending, null);
      const [stored] = await workspaceRecovery(scope).read();
      assert.equal(stored?.entity === "note" && stored.draft.title, "");
      workspaceApi.saveNote = saveNote;
      await useNoteStore.getState().saveNote(note.id);
      assert.equal(commands[1]?.content.title, "");
      assert.equal(commands[1]?.expectedRevision, 1);
      assert.equal(useNoteStore.getState().edits[key]?.dirty, false);
    });
  }

  void it("recovers an allocated first-save title after a lost response without changing the exact command", async () => {
    const note = useNoteStore.getState().createNote();
    useNoteStore.getState().upsertNote({ ...note, title: " \n" });
    const saveNote = workspaceApi.saveNote;
    let receipt!: NoteRecord;
    workspaceApi.saveNote = async (...args) => {
      receipt = { ...(await saveNote(...args)), title: "Untitled note (12)" };
      records.set(note.id, receipt);
      throw new ApiError("Response lost after commit", 503);
    };
    await useNoteStore.getState().saveNote(note.id);
    const original = commands[0]!;
    useNoteStore.getState().upsertNote({
      ...useNoteStore.getState().notes[0]!,
      transcript: "Newer transcript awaiting recovery",
    });
    useNoteStore.getState().clearSession();
    await useNoteStore.getState().refreshSession();
    assert.equal(useNoteStore.getState().notes[0]?.title, " \n");
    workspaceApi.saveNote = (_workspaceId, command, options) => {
      assert.deepEqual(command, original);
      assert.deepEqual(options, { replaying: true });
      return Promise.resolve(receipt);
    };
    await useNoteStore.getState().retry("note", note.id);
    assert.equal(useNoteStore.getState().notes[0]?.title, receipt.title);
    assert.equal(
      useNoteStore.getState().notes[0]?.transcript,
      "Newer transcript awaiting recovery",
    );
    assert.equal(useNoteStore.getState().edits[`note:${note.id}`]?.dirty, true);
    workspaceApi.saveNote = saveNote;
    await useNoteStore.getState().saveNote(note.id);
    assert.equal(commands[1]?.content.title, receipt.title);
    assert.equal(commands[1]?.expectedRevision, 1);
  });

  void it("does not merge a historical allocated title over a newer server revision during replay", async () => {
    const note = useNoteStore.getState().createNote();
    mutationStatus = 503;
    await useNoteStore.getState().saveNote(note.id);
    useNoteStore.getState().upsertNote({ ...note, transcript: "Newer local transcript" });
    const receipt: NoteRecord = {
      ...commands[0]!.content,
      id: note.id,
      title: "Untitled note (4)",
      workspaceId: scope.workspace.id,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    records.set(note.id, { ...receipt, title: "Renamed elsewhere", revision: 2 });
    workspaceApi.saveNote = () => Promise.resolve(receipt);
    await useNoteStore.getState().retry("note", note.id);
    assert.equal(useNoteStore.getState().notes[0]?.title, "");
    assert.equal(useNoteStore.getState().notes[0]?.transcript, "Newer local transcript");
    assert.equal(useNoteStore.getState().noteRecords[note.id]?.title, "Renamed elsewhere");
    assert.equal(useNoteStore.getState().edits[`note:${note.id}`]?.conflict, 2);
    assert.equal(useNoteStore.getState().edits[`note:${note.id}`]?.pending, null);
  });

  void it("verifies a replayed create receipt against the live tombstone and retains the newer draft", async () => {
    const note = useNoteStore.getState().createNote();
    useNoteStore.getState().upsertNote({ ...note, title: "Original request" });
    mutationStatus = 503;
    await useNoteStore.getState().saveNote(note.id);
    const original = commands[0]!;
    useNoteStore.getState().upsertNote({ ...note, title: "Newer draft" });
    const receipt: NoteRecord = {
      ...original.content,
      id: note.id,
      workspaceId: scope.workspace.id,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    workspaceApi.saveNote = (_workspaceId, command) => {
      assert.deepEqual(command, original);
      return Promise.resolve(receipt);
    };
    workspaceApi.note = (_workspaceId, id, includeDeleted) => {
      assert.equal(id, note.id);
      assert.equal(includeDeleted, true);
      return Promise.resolve({ ...receipt, revision: 2, deletedAt: new Date().toISOString() });
    };
    await useNoteStore.getState().retry("note", note.id);
    assert.equal(useNoteStore.getState().notes.length, 0);
    assert.equal(useNoteStore.getState().noteRecords[note.id], undefined);
    assert.equal(useNoteStore.getState().unavailable[`note:${note.id}`], "missing");
    const [retained] = await workspaceRecovery(scope).read();
    assert.equal(retained?.entity === "note" && retained.draft.title, "Newer draft");
    assert.equal(retained?.edit.pending, null);
    assert.equal(retained?.edit.conflict, 2);
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

  void it("retains unsynced work through logout without saving or discarding it", async () => {
    const note = useNoteStore.getState().createNote();
    useNoteStore.getState().upsertNote({ ...note, title: "Keep for next sign-in" });
    logoutStatus = 503;
    await useNoteStore.getState().signOut();
    assert.ok(useNoteStore.getState().session);
    assert.equal(values.size, 1);
    logoutStatus = 200;
    await useNoteStore.getState().signOut();
    assert.equal(useNoteStore.getState().session, null);
    assert.equal(values.size, 1);
    assert.equal(commands.length, 0);
    await useNoteStore.getState().refreshSession();
    assert.equal(useNoteStore.getState().notes[0]?.title, "Keep for next sign-in");
  });

  void it("allows clean logout even if draft storage is unavailable", async () => {
    failWrites = true;
    await useNoteStore.getState().signOut();
    assert.equal(useNoteStore.getState().session, null);
  });

  void it("retains an in-flight save through logout and reconciles its exact receipt on return", async () => {
    const note = useNoteStore.getState().createNote();
    useNoteStore.getState().upsertNote({ ...note, title: "Saving during logout" });
    const saveNote = workspaceApi.saveNote;
    let release!: () => void;
    let receipt: NoteRecord | undefined;
    workspaceApi.saveNote = async (workspaceId, command) => {
      if (receipt) {
        assert.deepEqual(command, commands[0]);
        return receipt;
      }
      receipt = await saveNote(workspaceId, command);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return receipt;
    };
    const saving = useNoteStore.getState().saveNote(note.id);
    await Promise.resolve();
    await useNoteStore.getState().signOut();
    const [retained] = await workspaceRecovery(scope).read();
    assert.deepEqual(retained?.edit.pending?.command, commands[0]);
    release();
    await saving;
    assert.equal(useNoteStore.getState().session, null);
    assert.deepEqual(useNoteStore.getState().notes, []);
    await useNoteStore.getState().refreshSession();
    await useNoteStore.getState().retry("note", note.id);
    assert.equal(useNoteStore.getState().notes[0]?.title, "Saving during logout");
    assert.equal(useNoteStore.getState().edits[`note:${note.id}`]?.pending, null);
    assert.equal(useNoteStore.getState().edits[`note:${note.id}`]?.dirty, false);
    assert.equal(commands.length, 1);
  });

  void it("does not lose a retained deleted-note draft when storage fails before logout", async () => {
    const note = useNoteStore.getState().createNote();
    useNoteStore.getState().upsertNote({ ...note, title: "Uncertain request" });
    mutationStatus = 503;
    await useNoteStore.getState().saveNote(note.id);
    const receipt: NoteRecord = {
      ...commands[0]!.content,
      id: note.id,
      workspaceId: scope.workspace.id,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    workspaceApi.saveNote = () => Promise.resolve(receipt);
    workspaceApi.note = () => {
      failWrites = true;
      useNoteStore.getState().upsertNote({ ...note, title: "Newer retained draft" });
      return Promise.resolve({ ...receipt, revision: 2, deletedAt: new Date().toISOString() });
    };
    await useNoteStore.getState().retry("note", note.id);
    assert.deepEqual(useNoteStore.getState().edits, {});
    assert.equal(useNoteStore.getState().notes.length, 0);
    await useNoteStore.getState().signOut();
    assert.equal(useNoteStore.getState().session?.user.id, scope.user.id);
    failWrites = false;
    await useNoteStore.getState().signOut();
    assert.equal(useNoteStore.getState().session, null);
    const [retained] = await workspaceRecovery(scope).read();
    assert.equal(retained?.entity === "note" && retained.draft.title, "Newer retained draft");
  });

  void it("keeps the session when unsynced edits cannot be checkpointed for logout", async () => {
    const note = useNoteStore.getState().createNote();
    useNoteStore.getState().upsertNote({ ...note, title: "Only here" });
    failWrites = true;
    await useNoteStore.getState().signOut();
    assert.equal(useNoteStore.getState().session?.user.id, scope.user.id);
    assert.equal(useNoteStore.getState().notes[0]?.title, "Only here");
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

  void it("preserves newer person drafts during pending saves and acknowledges only the sent generation", async () => {
    const person = useNoteStore.getState().createPerson();
    const key = `person:${person.id}`;
    useNoteStore.getState().updatePerson({ ...person, displayName: "Original name" });
    const savePerson = workspaceApi.savePerson;
    let release!: () => void;
    workspaceApi.savePerson = async (...args) => {
      assert.deepEqual(args[2], { replaying: false });
      const record = await savePerson(...args);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return record;
    };
    const firstSave = useNoteStore.getState().savePerson(person.id);
    await Promise.resolve();
    const pending = useNoteStore.getState().edits[key]!.pending!;
    useNoteStore.getState().updatePerson({
      ...person,
      displayName: "Newer name",
      description: "Newer description",
    });
    assert.equal(useNoteStore.getState().edits[key]?.pending, pending);
    assert.equal(useNoteStore.getState().edits[key]?.generation, pending.generation + 1);
    const [saved] = await workspaceRecovery(scope).read();
    assert.equal(saved?.entity === "person" && saved.draft.displayName, "Newer name");
    assert.deepEqual(saved?.edit.pending, pending);
    release();
    await firstSave;
    assert.equal(useNoteStore.getState().personRecords[person.id]?.displayName, "Original name");
    assert.equal(useNoteStore.getState().people[0]?.displayName, "Newer name");
    assert.equal(useNoteStore.getState().edits[key]?.dirty, true);
    assert.equal(useNoteStore.getState().edits[key]?.baseRevision, 1);

    workspaceApi.savePerson = savePerson;
    await useNoteStore.getState().savePerson(person.id);
    assert.equal(personCommands[1]?.expectedRevision, 1);
    assert.notEqual(personCommands[1]?.commandId, pending.command.commandId);
    assert.deepEqual(personCommands[1]?.content, {
      displayName: "Newer name",
      description: "Newer description",
    });
    assert.equal(useNoteStore.getState().edits[key]?.dirty, false);
    assert.equal(useNoteStore.getState().edits[key]?.pending, null);
  });

  void it("recovers full person descriptions and replays the exact command before saving newer edits", async () => {
    const person = useNoteStore.getState().createPerson();
    const description = `${"Original full description. ".repeat(100)}\nEnd of original description.`;
    useNoteStore.getState().updatePerson({ ...person, displayName: "Original", description });
    mutationStatus = 503;
    await useNoteStore.getState().savePerson(person.id);
    const original = personCommands[0]!;
    assert.equal(original.content.description, description);
    const newerDescription = `${description}\nNewer unsaved ending.`;
    useNoteStore.getState().updatePerson({
      ...person,
      displayName: "Newer",
      description: newerDescription,
    });
    useNoteStore.getState().clearSession();
    await useNoteStore.getState().refreshSession();
    assert.equal(useNoteStore.getState().recoveredDraftCount, 1);
    assert.equal(useNoteStore.getState().people[0]?.description, newerDescription);
    const savePerson = workspaceApi.savePerson;
    workspaceApi.savePerson = (...args) => {
      assert.deepEqual(args[2], { replaying: true });
      return savePerson(...args);
    };
    mutationStatus = 200;
    await useNoteStore.getState().retry("person", person.id);
    assert.deepEqual(personCommands[1], original);
    assert.equal(useNoteStore.getState().people[0]?.description, newerDescription);
    assert.equal(useNoteStore.getState().edits[`person:${person.id}`]?.dirty, true);
    workspaceApi.savePerson = savePerson;
    await useNoteStore.getState().savePerson(person.id);
    assert.equal(personCommands[2]?.content.description, newerDescription);
    assert.equal(personCommands[2]?.expectedRevision, 1);
  });

  for (const outcome of ["tombstone", "404"] as const) {
    void it(`rejects person edits during a deferred conflict discard returning ${outcome}`, async () => {
      const person = useNoteStore.getState().createPerson();
      const key = `person:${person.id}`;
      useNoteStore.getState().updatePerson({ ...person, displayName: "Saved name" });
      await useNoteStore.getState().savePerson(person.id);
      const record = personRecords.get(person.id)!;
      useNoteStore.getState().updatePerson({
        ...person,
        displayName: "Draft chosen for discard",
        description: "Accepted before the discard request",
      });
      mutationStatus = 409;
      await useNoteStore.getState().savePerson(person.id);
      assert.notEqual(useNoteStore.getState().edits[key]?.conflict, null);
      const acceptedDraft = useNoteStore.getState().people[0]!;
      let resolveRead!: (record: PersonRecord) => void;
      let rejectRead!: (error: Error) => void;
      workspaceApi.person = (workspaceId, id, includeDeleted) => {
        assert.equal(workspaceId, scope.workspace.id);
        assert.equal(id, person.id);
        assert.equal(includeDeleted, true);
        return new Promise<PersonRecord>((resolve, reject) => {
          resolveRead = resolve;
          rejectRead = reject;
        });
      };
      const discarding = useNoteStore.getState().resolveConflict("person", person.id, false);
      const resolvingEdit = useNoteStore.getState().edits[key]!;
      assert.equal(resolvingEdit.saving, true);
      assert.equal(resolvingEdit.pending, null);
      useNoteStore.getState().updatePerson({
        ...acceptedDraft,
        displayName: "Attempted after discard started",
        description: "This must never become accepted draft input",
      });
      assert.equal(useNoteStore.getState().people[0], acceptedDraft);
      assert.equal(useNoteStore.getState().edits[key], resolvingEdit);
      const [stored] = await workspaceRecovery(scope).read();
      assert.equal(
        stored?.entity === "person" && stored.draft.displayName,
        acceptedDraft.displayName,
      );
      assert.equal(
        stored?.entity === "person" && stored.draft.description,
        acceptedDraft.description,
      );
      assert.equal(stored?.edit.generation, resolvingEdit.generation);

      if (outcome === "tombstone") {
        resolveRead({ ...record, revision: 2, deletedAt: new Date().toISOString() });
      } else {
        rejectRead(new ApiError("Missing", 404));
      }
      await discarding;
      assert.equal(useNoteStore.getState().people.length, 0);
      assert.equal(useNoteStore.getState().currentPersonId, null);
      assert.equal(useNoteStore.getState().edits[key], undefined);
      assert.equal(useNoteStore.getState().unavailable[key], "missing");
      assert.deepEqual(useNoteStore.getState().lastDeleted, {
        entityType: "person",
        id: person.id,
      });
      assert.deepEqual(await workspaceRecovery(scope).read(), []);
    });
  }

  void it("keeps person deletion intent fixed while pending and removes the acknowledged draft", async () => {
    const person = useNoteStore.getState().createPerson();
    useNoteStore.getState().updatePerson({ ...person, displayName: "Delete me" });
    await useNoteStore.getState().savePerson(person.id);
    const record = personRecords.get(person.id)!;
    let release!: (record: PersonRecord) => void;
    workspaceApi.deletePerson = () =>
      new Promise<PersonRecord>((resolve) => {
        release = resolve;
      });
    const deleting = useNoteStore.getState().deletePerson(person.id);
    const pending = useNoteStore.getState().edits[`person:${person.id}`]!;
    useNoteStore.getState().updatePerson({ ...person, displayName: "Ignored while deleting" });
    assert.equal(useNoteStore.getState().people[0]?.displayName, "Delete me");
    assert.equal(useNoteStore.getState().edits[`person:${person.id}`], pending);
    release({ ...record, revision: 2, deletedAt: new Date().toISOString() });
    await deleting;
    assert.equal(useNoteStore.getState().people.length, 0);
    assert.equal(useNoteStore.getState().currentPersonId, null);
    assert.equal(useNoteStore.getState().edits[`person:${person.id}`], undefined);
    assert.deepEqual(useNoteStore.getState().lastDeleted, { entityType: "person", id: person.id });
  });

  void it("verifies replayed person receipts against current deletion and retains newer recovery", async () => {
    const person = useNoteStore.getState().createPerson();
    useNoteStore.getState().updatePerson({ ...person, displayName: "Original" });
    mutationStatus = 503;
    await useNoteStore.getState().savePerson(person.id);
    const original = personCommands[0]!;
    useNoteStore.getState().updatePerson({ ...person, displayName: "Newer" });
    const receipt: PersonRecord = {
      ...original.content,
      id: person.id,
      workspaceId: scope.workspace.id,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    workspaceApi.savePerson = (_workspaceId, command, options) => {
      assert.deepEqual(command, original);
      assert.deepEqual(options, { replaying: true });
      return Promise.resolve(receipt);
    };
    workspaceApi.person = (_workspaceId, id, includeDeleted) => {
      assert.equal(id, person.id);
      assert.equal(includeDeleted, true);
      return Promise.resolve({ ...receipt, revision: 2, deletedAt: new Date().toISOString() });
    };
    await useNoteStore.getState().retry("person", person.id);
    assert.equal(useNoteStore.getState().people.length, 0);
    assert.equal(useNoteStore.getState().unavailable[`person:${person.id}`], "missing");
    const [retained] = await workspaceRecovery(scope).read();
    assert.equal(retained?.entity === "person" && retained.draft.displayName, "Newer");
    assert.equal(retained?.edit.pending, null);
    assert.equal(retained?.edit.conflict, 2);
    assert.equal(await useNoteStore.getState().saveAll(), false);
  });

  void it("keeps newer acknowledged person revisions when an older save completes", async () => {
    const person = useNoteStore.getState().createPerson();
    useNoteStore.getState().updatePerson({ ...person, displayName: "Original" });
    const savePerson = workspaceApi.savePerson;
    let release!: () => void;
    workspaceApi.savePerson = async (...args) => {
      const record = await savePerson(...args);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return record;
    };
    const saving = useNoteStore.getState().savePerson(person.id);
    await Promise.resolve();
    useNoteStore.getState().updatePerson({ ...person, displayName: "Newer local" });
    useNoteStore.getState().reconcilePerson({
      ...personRecords.get(person.id)!,
      revision: 2,
      displayName: "Newer remote",
    });
    release();
    await saving;
    assert.equal(useNoteStore.getState().personRecords[person.id]?.displayName, "Newer remote");
    assert.equal(useNoteStore.getState().people[0]?.displayName, "Newer local");
    const edit = useNoteStore.getState().edits[`person:${person.id}`]!;
    assert.equal(edit.baseRevision, 1);
    assert.equal(edit.conflict, 2);
    assert.equal(edit.dirty, true);
    assert.equal(edit.pending, null);
    assert.equal(edit.saving, false);
  });

  void it("ignores a late person replay validation after the account epoch changes", async () => {
    const person = useNoteStore.getState().createPerson();
    useNoteStore.getState().updatePerson({ ...person, displayName: "Original" });
    mutationStatus = 503;
    await useNoteStore.getState().savePerson(person.id);
    const original = personCommands[0]!;
    let release!: (record: PersonRecord) => void;
    let started!: () => void;
    const validating = new Promise<void>((resolve) => {
      started = resolve;
    });
    workspaceApi.person = () => {
      started();
      return new Promise<PersonRecord>((resolve) => {
        release = resolve;
      });
    };
    mutationStatus = 200;
    const replay = useNoteStore.getState().retry("person", person.id);
    await validating;
    useNoteStore.getState().clearSession();
    release(personRecords.get(person.id)!);
    await replay;
    assert.equal(useNoteStore.getState().session, null);
    assert.equal(useNoteStore.getState().people.length, 0);
    assert.deepEqual(useNoteStore.getState().personRecords, {});
    const [retained] = await workspaceRecovery(scope).read();
    assert.deepEqual(retained?.edit.pending?.command, original);
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
