/// <reference lib="dom" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { QueryObserver } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { noteListItemSchema } from "../../src/contracts/notes";
import type { NoteListItem, NoteRecord, SaveNote } from "../../src/contracts/notes";
import {
  configureQueryIdentity,
  getQueryRuntime,
  type QueryRuntime,
} from "../../src/lib/query-runtime";
import { reconcileNoteSnapshot, saveNote } from "../../src/queries/notes";
import { workspaceApi } from "../../src/lib/workspace-api";

type Page = { items: NoteListItem[]; nextCursor: string | null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

void describe("notes acknowledgement caches (no database)", { concurrency: false }, () => {
  const nativeFetch = globalThis.fetch;
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  let identity: { userId: string; workspaceId: string; epoch: number };
  let runtime: QueryRuntime;
  let original: NoteRecord;
  let saved: NoteRecord;
  let command: SaveNote;

  beforeEach(() => {
    Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
    identity = { userId: randomUUID(), workspaceId: randomUUID(), epoch: 1 };
    configureQueryIdentity(() => identity);
    runtime = getQueryRuntime();
    original = {
      id: randomUUID(),
      workspaceId: identity.workspaceId,
      title: "Before",
      transcript: "Preserved source text",
      revision: 1,
      createdAt: "2026-11-14T10:00:00.000Z",
      updatedAt: "2026-11-14T10:00:00.000Z",
      deletedAt: null,
    };
    saved = { ...original, title: "After", revision: 2, updatedAt: "2026-11-14T11:00:00.000Z" };
    command = {
      id: original.id,
      commandId: randomUUID(),
      expectedRevision: 1,
      content: { title: saved.title, transcript: original.transcript },
    };
    globalThis.fetch = () => Promise.resolve(Response.json({ result: { data: saved } }));
  });

  afterEach(() => {
    runtime.queryClient.clear();
    getQueryRuntime().queryClient.clear();
    configureQueryIdentity(() => null);
    globalThis.fetch = nativeFetch;
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });

  for (const fails of [false, true]) {
    void it(`collects completed save mutations after ${fails ? "failure" : "success"}`, async () => {
      const cache = runtime.queryClient;
      cache.setDefaultOptions({ ...cache.getDefaultOptions(), mutations: { gcTime: 0 } });
      if (fails) {
        globalThis.fetch = () => Promise.reject(new Error("Injected failure"));
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const completion = saveNote(identity.workspaceId, command);
        if (fails) await assert.rejects(completion, /Injected failure/);
        else assert.equal((await completion).revision, saved.revision);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(cache.getMutationCache().getAll().length, 0);
    });
  }

  void it("acknowledges deletion with a tombstone while refresh is blocked and clears dependent caches", async () => {
    const { queryClient: cache, trpc } = runtime;
    const scope = { workspaceId: identity.workspaceId, id: original.id };
    const detail = trpc.notes.get.queryKey({ ...scope, includeDeleted: false });
    const verified = trpc.notes.get.queryKey({ ...scope, includeDeleted: true });
    const list = trpc.notes.list.queryOptions({ workspaceId: scope.workspaceId, q: "", limit: 30 });
    const searched = trpc.notes.list.infiniteQueryKey({
      workspaceId: scope.workspaceId,
      q: "Before",
      limit: 30,
    });
    const dependentScope = { workspaceId: scope.workspaceId, noteId: original.id };
    const recording = trpc.recordings.overview.queryKey(dependentScope);
    const transcriptScope = { ...dependentScope, runId: randomUUID() };
    const transcript = trpc.transcripts.page.queryKey(transcriptScope);
    const infiniteTranscript = trpc.transcripts.page.infiniteQueryKey(transcriptScope);
    cache.setQueryData(detail, original);
    cache.setQueryData(verified, original);
    cache.setQueryData(list.queryKey, {
      items: [noteListItemSchema.parse(original)],
      nextCursor: null,
    });
    cache.setQueryData(searched, {
      pages: [{ items: [noteListItemSchema.parse(original)], nextCursor: "tail" }],
      pageParams: [null],
    });
    cache.setQueryData(recording, { recordings: [], runs: [] });
    cache.setQueryData(transcript, { items: [], nextCursor: null });
    cache.setQueryData(infiniteTranscript, {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [null],
    });
    const observer = new QueryObserver(cache, list);
    const unsubscribe = observer.subscribe(() => {});
    const refresh = deferred<Response>();
    const tombstone = { ...saved, deletedAt: "2026-11-14T12:00:00.000Z" };
    globalThis.fetch = (resource) => {
      const url = resource instanceof Request ? resource.url : resource.toString();
      return url.includes("notes.delete")
        ? Promise.resolve(Response.json({ result: { data: tombstone } }))
        : refresh.promise;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deleted = await Promise.race([
        workspaceApi.deleteNote(scope.workspaceId, {
          commandId: randomUUID(),
          id: original.id,
          expectedRevision: 1,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Delete waited for refresh")), 1000);
        }),
      ]);
      assert.equal(deleted.deletedAt, tombstone.deletedAt);
      assert.equal(cache.getQueryData(detail)?.deletedAt, tombstone.deletedAt);
      assert.equal(cache.getQueryData(verified)?.revision, tombstone.revision);
      assert.equal(cache.getQueryData(list.queryKey)?.items.length, 0);
      assert.equal(cache.getQueryData(searched)?.pages[0]?.items.length, 0);
      assert.equal(cache.getQueryData(searched)?.pages[0]?.nextCursor, "tail");
      assert.equal(cache.getQueryState(list.queryKey)?.fetchStatus, "fetching");
      for (const key of [recording, transcript, infiniteTranscript]) {
        assert.equal(cache.getQueryData(key), undefined);
      }
      await reconcileNoteSnapshot(original, runtime);
      assert.equal(cache.getQueryData(detail)?.revision, tombstone.revision);
      assert.equal(cache.getQueryData(list.queryKey)?.items.length, 0);
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
    }
  });

  void it("does not publish a deletion into either cache after a scope change during cleanup", async () => {
    const cache = runtime.queryClient;
    const cancel = cache.cancelQueries.bind(cache);
    const started = deferred<void>();
    const release = deferred<void>();
    cache.cancelQueries = async (...args) => {
      await cancel(...args);
      started.resolve();
      await release.promise;
    };
    globalThis.fetch = () =>
      Promise.resolve(
        Response.json({ result: { data: { ...saved, deletedAt: saved.updatedAt } } }),
      );
    try {
      const completion = workspaceApi.deleteNote(identity.workspaceId, {
        commandId: randomUUID(),
        id: original.id,
        expectedRevision: 1,
      });
      await started.promise;
      identity = { ...identity, epoch: 2 };
      const next = getQueryRuntime();
      release.resolve();
      await completion;
      assert.equal(cache.getQueryCache().getAll().length, 0);
      assert.equal(next.queryClient.getQueryCache().getAll().length, 0);
    } finally {
      release.resolve();
      cache.cancelQueries = cancel;
    }
  });

  void it("acknowledges before active refresh completes and rejects a cancelled stale list response", async () => {
    const { queryClient: cache, trpc } = runtime;
    const scope = { workspaceId: identity.workspaceId };
    const options = trpc.notes.list.queryOptions(
      { ...scope, q: "", limit: 30 },
      { trpc: { abortOnUnmount: true } },
    );
    cache.setQueryData(options.queryKey, {
      items: [noteListItemSchema.parse(original)],
      nextCursor: null,
    });
    const stale = deferred<Response>();
    const refreshing = deferred<Response>();
    const started = deferred<void>();
    let staleSignal: AbortSignal | null | undefined;
    let reads = 0;
    globalThis.fetch = (url, init) => {
      const address = url instanceof Request ? url.url : url.toString();
      if (address.includes("notes.save"))
        return Promise.resolve(Response.json({ result: { data: saved } }));
      reads++;
      if (reads === 1) {
        staleSignal = init?.signal;
        started.resolve();
        return stale.promise;
      }
      return refreshing.promise;
    };
    const observer = new QueryObserver(cache, { ...options, staleTime: 0, retry: false });
    const unsubscribe = observer.subscribe(() => {});
    await started.promise;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const acknowledgement = await Promise.race([
        saveNote(identity.workspaceId, command),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Save waited for follow-up reads")), 1_000);
        }),
      ]);
      assert.equal(acknowledgement.title, "After");
      assert.equal(staleSignal?.aborted, true);
      assert.equal(reads, 2);
      assert.equal(cache.getQueryState(options.queryKey)?.fetchStatus, "fetching");
      assert.equal(cache.getQueryData(options.queryKey)?.items[0]?.title, "After");
      assert.equal(
        cache.getQueryData(
          trpc.notes.get.queryKey({ ...scope, id: original.id, includeDeleted: false }),
        )?.transcript,
        original.transcript,
      );
      stale.resolve(Response.json({ result: { data: { items: [original], nextCursor: null } } }));
      await stale.promise;
      await Promise.resolve();
      assert.equal(cache.getQueryData(options.queryKey)?.items[0]?.title, "After");
      // A failed refresh belongs to the query; the mutation remains acknowledged.
      refreshing.resolve(
        Response.json(
          {
            error: {
              message: "Read unavailable",
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
            },
          },
          { status: 500 },
        ),
      );
      await observer.refetch();
      assert.equal(cache.getMutationCache().getAll()[0]?.state.status, "success");
      assert.equal(cache.getQueryData(options.queryKey)?.items[0]?.title, "After");
    } finally {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    }
  });

  void it("reconciles searched ordinary/infinite pages without dropping unrelated rows or changing cursors", async () => {
    const { queryClient: cache, trpc } = runtime;
    const scope = { workspaceId: identity.workspaceId };
    const unrelated = noteListItemSchema.parse({ ...original, id: randomUUID(), title: "Another" });
    const keys = {
      all: trpc.notes.list.infiniteQueryKey({ ...scope, q: "", limit: 1 }),
      before: trpc.notes.list.infiniteQueryKey({ ...scope, q: "Before", limit: 1 }),
      after: trpc.notes.list.queryKey({ ...scope, q: "After", limit: 1 }),
      tail: trpc.notes.list.queryKey({ ...scope, q: "", limit: 1, cursor: "tail" }),
    };
    cache.setQueryData(keys.all, {
      pages: [
        { items: [unrelated], nextCursor: "next" },
        { items: [noteListItemSchema.parse(original)], nextCursor: "tail" },
      ],
      pageParams: [null, "next"],
    });
    cache.setQueryData(keys.before, {
      pages: [{ items: [noteListItemSchema.parse(original)], nextCursor: "keep" }],
      pageParams: [null],
    });
    cache.setQueryData(keys.after, { items: [], nextCursor: null });
    cache.setQueryData(keys.tail, { items: [unrelated], nextCursor: null });
    await saveNote(identity.workspaceId, command);
    const all = cache.getQueryData<InfiniteData<Page>>(keys.all)!;
    assert.deepEqual(
      all.pages.flatMap((page) => page.items).map((item) => item.id),
      [saved.id, unrelated.id],
    );
    assert.deepEqual(
      all.pages.map((page) => page.nextCursor),
      ["next", "tail"],
    );
    assert.deepEqual(all.pageParams, [null, "next"]);
    assert.equal(cache.getQueryData(keys.before)?.pages[0]?.items.length, 0);
    assert.equal(cache.getQueryData(keys.before)?.pages[0]?.nextCursor, "keep");
    assert.equal(cache.getQueryData(keys.after)?.items[0]?.id, saved.id);
    assert.equal(
      cache.getQueryData(keys.after)?.items[0] &&
        "transcript" in cache.getQueryData(keys.after)!.items[0]!,
      false,
    );
    assert.deepEqual(
      cache.getQueryData(keys.tail)?.items.map((item) => item.id),
      [unrelated.id],
    );
  });

  void it("preserves newer cached revisions when an older receipt is replayed", async () => {
    const { queryClient: cache, trpc } = runtime;
    const scope = { workspaceId: identity.workspaceId };
    const newer = { ...saved, revision: 3, title: "Newest" };
    const detail = trpc.notes.get.queryKey({ ...scope, id: original.id, includeDeleted: false });
    const list = trpc.notes.list.queryKey({ ...scope, q: "", limit: 30 });
    cache.setQueryData(detail, newer);
    cache.setQueryData(list, { items: [noteListItemSchema.parse(newer)], nextCursor: null });
    assert.equal((await saveNote(identity.workspaceId, command)).revision, 2);
    assert.equal(cache.getQueryData(detail)?.revision, 3);
    assert.equal(cache.getQueryData(list)?.items[0]?.title, "Newest");
  });

  void it("does not repopulate the outgoing cache when scope changes during cancellation", async () => {
    const { queryClient: cache } = runtime;
    const cancel = cache.cancelQueries.bind(cache);
    const started = deferred<void>();
    const released = deferred<void>();
    cache.cancelQueries = async (...args) => {
      await cancel(...args);
      started.resolve();
      await released.promise;
    };
    try {
      const completion = saveNote(identity.workspaceId, command);
      await started.promise;
      identity = { ...identity, epoch: 2 };
      const next = getQueryRuntime();
      released.resolve();
      await completion;
      assert.equal(cache.getQueryCache().getAll().length, 0);
      assert.equal(next.queryClient.getQueryCache().getAll().length, 0);
    } finally {
      released.resolve();
      cache.cancelQueries = cancel;
    }
  });

  void it("never publishes a replay receipt and removes a verified tombstone while refresh is blocked", async () => {
    const { queryClient: cache, trpc } = runtime;
    const scope = { workspaceId: identity.workspaceId, id: original.id };
    const detail = trpc.notes.get.queryKey({ ...scope, includeDeleted: false });
    const verifiedKey = trpc.notes.get.queryKey({ ...scope, includeDeleted: true });
    const listOptions = trpc.notes.list.queryOptions({
      workspaceId: scope.workspaceId,
      q: "",
      limit: 30,
    });
    const tombstone = { ...saved, revision: 3, deletedAt: "2026-11-14T12:00:00.000Z" };
    cache.setQueryData(detail, original);
    cache.setQueryData(listOptions.queryKey, {
      items: [noteListItemSchema.parse(original)],
      nextCursor: null,
    });
    const observer = new QueryObserver(cache, listOptions);
    const unsubscribe = observer.subscribe(() => {});
    const refresh = deferred<Response>();
    globalThis.fetch = (resource) => {
      const url = resource instanceof Request ? resource.url : resource.toString();
      if (url.includes("notes.save"))
        return Promise.resolve(Response.json({ result: { data: saved } }));
      if (url.includes("notes.get"))
        return Promise.resolve(Response.json({ result: { data: tombstone } }));
      return refresh.promise;
    };
    try {
      const receipt = await saveNote(scope.workspaceId, command, { replaying: true });
      assert.equal(receipt.revision, 2);
      assert.equal(cache.getQueryData(detail)?.revision, 1);
      const current = await cache.fetchQuery(
        trpc.notes.get.queryOptions({ ...scope, includeDeleted: true }, { staleTime: 0 }),
      );
      await reconcileNoteSnapshot(current, runtime);
      assert.equal(cache.getQueryData(listOptions.queryKey)?.items.length, 0);
      assert.equal(cache.getQueryState(listOptions.queryKey)?.fetchStatus, "fetching");
      assert.equal(cache.getQueryData(detail)?.deletedAt, tombstone.deletedAt);
      assert.equal(cache.getQueryData(verifiedKey)?.revision, 3);
      // Even an ordinary late acknowledgement cannot override a known tombstone.
      await reconcileNoteSnapshot(saved, runtime);
      assert.equal(cache.getQueryData(listOptions.queryKey)?.items.length, 0);
      assert.equal(cache.getQueryData(detail)?.revision, 3);
    } finally {
      unsubscribe();
    }
  });
});
