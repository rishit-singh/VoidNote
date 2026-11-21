/// <reference lib="dom" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { QueryObserver } from "@tanstack/react-query";
import type { NoteRecord, PersonRecord } from "../../src/contracts/workspace";
import { noteListItemSchema } from "../../src/contracts/notes";
import { toPersonListItem } from "../../src/contracts/people";
import {
  configureQueryIdentity,
  getQueryRuntime,
  type QueryRuntime,
} from "../../src/lib/query-runtime";
import { useNoteStore } from "../../src/stores/use-note-store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function beforeRefresh<T>(completion: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Conflict resolution waited for refresh")), 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

void describe(
  "workspace conflict query reconciliation (no database)",
  { concurrency: false },
  () => {
    const nativeFetch = globalThis.fetch;
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    let runtime: QueryRuntime;
    let note: NoteRecord;
    let person: PersonRecord;

    beforeEach(() => {
      Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
      useNoteStore.getState().clearSession();
      useNoteStore.setState({
        session: {
          user: { id: randomUUID(), email: null },
          workspace: { id: randomUUID(), name: "Private" },
        },
        status: "ready",
      });
      configureQueryIdentity(() => {
        const { session, epoch } = useNoteStore.getState();
        return session
          ? { userId: session.user.id, workspaceId: session.workspace.id, epoch }
          : null;
      });
      runtime = getQueryRuntime();
      const base = {
        workspaceId: runtime.identity!.workspaceId,
        revision: 1,
        createdAt: "2026-11-14T10:00:00.000Z",
        updatedAt: "2026-11-14T10:00:00.000Z",
        deletedAt: null,
      };
      note = { ...base, id: randomUUID(), title: "Before", transcript: "Original source" };
      person = {
        ...base,
        id: randomUUID(),
        displayName: "Before",
        description: "Original profile",
      };
      useNoteStore.getState().reconcileNote(note);
      useNoteStore.getState().reconcilePerson(person);
    });

    afterEach(() => {
      useNoteStore.getState().clearSession();
      runtime.queryClient.clear();
      getQueryRuntime().queryClient.clear();
      configureQueryIdentity(() => null);
      globalThis.fetch = nativeFetch;
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
      else Reflect.deleteProperty(globalThis, "window");
    });

    function conflict(entity: "note" | "person") {
      const state = useNoteStore.getState();
      const record = entity === "note" ? note : person;
      if (entity === "note") state.upsertNote({ ...state.notes[0]!, title: "Local draft" });
      else state.updatePerson({ ...state.people[0]!, displayName: "Local draft" });
      const key = `${entity}:${record.id}`;
      useNoteStore.setState((current) => ({
        edits: {
          ...current.edits,
          [key]: { ...current.edits[key]!, conflict: 2, error: "Conflict" },
        },
      }));
      return key;
    }

    for (const entity of ["note", "person"] as const) {
      for (const keepDraft of [false, true]) {
        void it(`${entity}: reconciles verified detail and list before ${keepDraft ? "rebasing" : "discarding"} with refresh blocked`, async () => {
          const { queryClient: cache, trpc } = runtime;
          const key = conflict(entity);
          const original = entity === "note" ? note : person;
          const latest =
            entity === "note"
              ? { ...note, title: "Server version", revision: 2 }
              : {
                  ...person,
                  displayName: "Server version",
                  description: "Updated profile",
                  revision: 2,
                };
          const scope = { workspaceId: original.workspaceId, id: original.id };
          const detail =
            entity === "note"
              ? trpc.notes.get.queryKey({ ...scope, includeDeleted: false })
              : trpc.people.get.queryKey({ ...scope, includeDeleted: false });
          const listInput = { workspaceId: scope.workspaceId, q: "", limit: 30 };
          const noteList = trpc.notes.list.queryOptions(listInput);
          const personList = trpc.people.list.queryOptions(listInput);
          const listKey = entity === "note" ? noteList.queryKey : personList.queryKey;
          cache.setQueryData(detail, original);
          if (entity === "note") {
            cache.setQueryData(noteList.queryKey, {
              items: [noteListItemSchema.parse(note)],
              nextCursor: null,
            });
          } else {
            cache.setQueryData(personList.queryKey, {
              items: [toPersonListItem(person)],
              nextCursor: null,
            });
          }
          const observer =
            entity === "note"
              ? new QueryObserver(cache, noteList)
              : new QueryObserver(cache, personList);
          const unsubscribe = observer.subscribe(() => {});
          const refresh = deferred<Response>();
          globalThis.fetch = (resource) => {
            const url = resource instanceof Request ? resource.url : resource.toString();
            return url.includes(".get")
              ? Promise.resolve(Response.json({ result: { data: latest } }))
              : refresh.promise;
          };
          try {
            await beforeRefresh(
              useNoteStore.getState().resolveConflict(entity, original.id, keepDraft),
            );
            assert.deepEqual(cache.getQueryData(detail), latest);
            assert.equal(
              cache.getQueryData<{ items: { revision: number }[] }>(listKey)?.items[0]?.revision,
              2,
            );
            assert.equal(cache.getQueryState(listKey)?.fetchStatus, "fetching");
            const state = useNoteStore.getState();
            assert.equal(state.edits[key]?.conflict, null);
            assert.equal(state.edits[key]?.saving, false);
            assert.equal(state.edits[key]?.dirty, keepDraft);
            assert.equal(state.edits[key]?.baseRevision, 2);
            assert.equal(
              entity === "note" ? state.notes[0]?.title : state.people[0]?.displayName,
              keepDraft ? "Local draft" : "Server version",
            );
            assert.deepEqual(
              entity === "note" ? state.noteRecords[note.id] : state.personRecords[person.id],
              latest,
            );
          } finally {
            unsubscribe();
          }
        });
      }

      void it(`${entity}: retains conflict and cached detail when verification is forbidden`, async () => {
        const { queryClient: cache, trpc } = runtime;
        const key = conflict(entity);
        const record = entity === "note" ? note : person;
        const scope = { workspaceId: record.workspaceId, id: record.id, includeDeleted: false };
        const detail =
          entity === "note" ? trpc.notes.get.queryKey(scope) : trpc.people.get.queryKey(scope);
        cache.setQueryData(detail, record);
        globalThis.fetch = () =>
          Promise.resolve(
            Response.json(
              {
                error: {
                  message: "Forbidden",
                  code: -32003,
                  data: { code: "FORBIDDEN", httpStatus: 403 },
                },
              },
              { status: 403 },
            ),
          );
        await useNoteStore.getState().resolveConflict(entity, record.id, false);
        assert.deepEqual(cache.getQueryData(detail), record);
        assert.equal(useNoteStore.getState().edits[key]?.conflict, 2);
        assert.equal(useNoteStore.getState().edits[key]?.saving, false);
        assert.match(useNoteStore.getState().edits[key]?.error ?? "", /Forbidden/);
      });

      void it(`${entity}: rejects resolution after the scope retires during cache cancellation`, async () => {
        const cache = runtime.queryClient;
        const cancel = cache.cancelQueries.bind(cache);
        const started = deferred<void>();
        const release = deferred<void>();
        conflict(entity);
        const record = entity === "note" ? note : person;
        globalThis.fetch = () =>
          Promise.resolve(Response.json({ result: { data: { ...record, revision: 2 } } }));
        cache.cancelQueries = async (...args) => {
          await cancel(...args);
          started.resolve();
          await release.promise;
        };
        try {
          const completion = useNoteStore.getState().resolveConflict(entity, record.id, false);
          await started.promise;
          useNoteStore.getState().clearSession();
          const next = getQueryRuntime();
          release.resolve();
          await completion;
          assert.deepEqual(useNoteStore.getState().edits, {});
          assert.equal(cache.getQueryCache().getAll().length, 0);
          assert.equal(next.queryClient.getQueryCache().getAll().length, 0);
        } finally {
          release.resolve();
          cache.cancelQueries = cancel;
        }
      });
    }

    void it("preserves note edits made after discard began while publishing the verified baseline", async () => {
      const key = conflict("note");
      const response = deferred<Response>();
      globalThis.fetch = () => response.promise;
      const completion = useNoteStore.getState().resolveConflict("note", note.id, false);
      useNoteStore
        .getState()
        .upsertNote({ ...useNoteStore.getState().notes[0]!, title: "Newer local edit" });
      const latest = { ...note, title: "Server version", revision: 2 };
      response.resolve(Response.json({ result: { data: latest } }));
      await completion;
      assert.equal(useNoteStore.getState().notes[0]?.title, "Newer local edit");
      assert.equal(useNoteStore.getState().edits[key]?.dirty, true);
      assert.equal(useNoteStore.getState().edits[key]?.baseRevision, 2);
      assert.deepEqual(
        runtime.queryClient.getQueryData(
          runtime.trpc.notes.get.queryKey({
            workspaceId: note.workspaceId,
            id: note.id,
            includeDeleted: false,
          }),
        ),
        latest,
      );
    });

    for (const outcome of ["deleted", "missing"] as const) {
      void it(`retains newer note edits when a deferred discard finds the record ${outcome}`, async () => {
        const key = conflict("note");
        const response = deferred<Response>();
        globalThis.fetch = () => response.promise;
        const completion = useNoteStore.getState().resolveConflict("note", note.id, false);
        useNoteStore
          .getState()
          .upsertNote({ ...useNoteStore.getState().notes[0]!, title: "Newer local edit" });
        response.resolve(
          outcome === "deleted"
            ? Response.json({
                result: { data: { ...note, revision: 2, deletedAt: note.updatedAt } },
              })
            : Response.json(
                {
                  error: {
                    message: "Missing",
                    code: -32004,
                    data: { code: "NOT_FOUND", httpStatus: 404 },
                  },
                },
                { status: 404 },
              ),
        );
        await completion;
        const state = useNoteStore.getState();
        assert.equal(state.notes[0]?.title, "Newer local edit");
        assert.equal(state.edits[key]?.dirty, true);
        assert.equal(state.edits[key]?.saving, false);
        assert.equal(state.edits[key]?.conflict, 2);
        assert.equal(state.lastDeleted, null);
      });
    }

    void it("resolves against a newer cached person snapshot rather than regressing its edit baseline", async () => {
      const key = conflict("person");
      const latest = { ...person, displayName: "Newest server version", revision: 3 };
      runtime.queryClient.setQueryData(
        runtime.trpc.people.get.queryKey({
          workspaceId: person.workspaceId,
          id: person.id,
          includeDeleted: false,
        }),
        latest,
      );
      globalThis.fetch = () =>
        Promise.resolve(Response.json({ result: { data: { ...person, revision: 2 } } }));
      await useNoteStore.getState().resolveConflict("person", person.id, false);
      assert.equal(useNoteStore.getState().edits[key]?.baseRevision, 3);
      assert.equal(useNoteStore.getState().people[0]?.displayName, latest.displayName);
    });
  },
);
