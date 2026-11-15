/// <reference lib="dom" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { QueryObserver } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { toPersonListItem } from "../../src/contracts/people";
import type { PersonListItem, PersonRecord, SavePerson } from "../../src/contracts/people";
import {
  configureQueryIdentity,
  getQueryRuntime,
  type QueryRuntime,
} from "../../src/lib/query-runtime";
import { deletePerson, reconcilePersonSnapshot, savePerson } from "../../src/queries/people";

type Page = { items: PersonListItem[]; nextCursor: string | null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const id = (value: number) => `${value.toString().padStart(8, "0")}-0000-4000-8000-000000000000`;

void describe("people acknowledgement caches", { concurrency: false }, () => {
  const nativeFetch = globalThis.fetch;
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  let identity: { userId: string; workspaceId: string; epoch: number };
  let runtime: QueryRuntime;
  let original: PersonRecord;
  let saved: PersonRecord;
  let command: SavePerson;

  beforeEach(() => {
    Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
    identity = { userId: randomUUID(), workspaceId: randomUUID(), epoch: 1 };
    configureQueryIdentity(() => identity);
    runtime = getQueryRuntime();
    original = {
      id: id(3),
      workspaceId: identity.workspaceId,
      displayName: "Before",
      description: "Full profile ".repeat(200),
      revision: 1,
      createdAt: "2026-11-14T10:00:00.000Z",
      updatedAt: "2026-11-14T10:00:00.000Z",
      deletedAt: null,
    };
    saved = { ...original, displayName: "After", revision: 2 };
    command = {
      id: original.id,
      commandId: randomUUID(),
      expectedRevision: 1,
      content: { displayName: saved.displayName, description: original.description },
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

  void it("cancels stale list reads and acknowledges full content before refresh completes", async () => {
    const { queryClient: cache, trpc } = runtime;
    const options = trpc.people.list.queryOptions(
      { workspaceId: identity.workspaceId, q: "", limit: 30 },
      { trpc: { abortOnUnmount: true } },
    );
    cache.setQueryData(options.queryKey, { items: [toPersonListItem(original)], nextCursor: null });
    const stale = deferred<Response>();
    const refresh = deferred<Response>();
    const started = deferred<void>();
    let signal: AbortSignal | null | undefined;
    let reads = 0;
    globalThis.fetch = (resource, init) => {
      const url = resource instanceof Request ? resource.url : resource.toString();
      if (url.includes("people.save"))
        return Promise.resolve(Response.json({ result: { data: saved } }));
      if (++reads === 1) {
        signal = init?.signal;
        started.resolve();
        return stale.promise;
      }
      return refresh.promise;
    };
    const observer = new QueryObserver(cache, { ...options, staleTime: 0, retry: false });
    const unsubscribe = observer.subscribe(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await started.promise;
      const result = await Promise.race([
        savePerson(identity.workspaceId, command),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Save waited for refresh")), 1000);
        }),
      ]);
      assert.equal(result.description, original.description);
      assert.equal(signal?.aborted, true);
      assert.equal(reads, 2);
      assert.equal(cache.getQueryState(options.queryKey)?.fetchStatus, "fetching");
      assert.deepEqual(cache.getQueryData(options.queryKey)?.items, [toPersonListItem(saved)]);
      stale.resolve(
        Response.json({
          result: { data: { items: [toPersonListItem(original)], nextCursor: null } },
        }),
      );
      await stale.promise;
      await Promise.resolve();
      assert.equal(cache.getQueryData(options.queryKey)?.items[0]?.displayName, "After");
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
    }
  });

  void it("keeps UUID ordering, search membership, unrelated loaded rows and page cursors", async () => {
    const { queryClient: cache, trpc } = runtime;
    const scope = { workspaceId: identity.workspaceId };
    const all = trpc.people.list.infiniteQueryKey({ ...scope, q: "", limit: 2 });
    const before = trpc.people.list.queryKey({ ...scope, q: "Before", limit: 2 });
    const after = trpc.people.list.infiniteQueryKey({ ...scope, q: "After", limit: 2 });
    const tail = trpc.people.list.queryKey({ ...scope, q: "", cursor: "cursor", limit: 2 });
    const item = (value: number) =>
      toPersonListItem({ ...original, id: id(value), displayName: "After other" });
    cache.setQueryData(all, {
      pages: [
        { items: [item(1), item(2)], nextCursor: "second" },
        { items: [toPersonListItem(original), item(4)], nextCursor: "third" },
      ],
      pageParams: [null, "second"],
    });
    cache.setQueryData(before, { items: [toPersonListItem(original)], nextCursor: null });
    cache.setQueryData(after, {
      pages: [
        { items: [item(1)], nextCursor: "second" },
        { items: [item(4)], nextCursor: "third" },
      ],
      pageParams: [null, "second"],
    });
    cache.setQueryData(tail, { items: [item(4)], nextCursor: null });
    await savePerson(scope.workspaceId, command);
    const data = cache.getQueryData<InfiniteData<Page>>(all)!;
    assert.deepEqual(
      data.pages.map((page) => page.items.map((row) => row.id)),
      [
        [id(1), id(2)],
        [id(3), id(4)],
      ],
    );
    assert.deepEqual(data.pageParams, [null, "second"]);
    assert.deepEqual(
      data.pages.map((page) => page.nextCursor),
      ["second", "third"],
    );
    assert.equal(cache.getQueryData(before)?.items.length, 0);
    assert.deepEqual(
      cache.getQueryData(after)?.pages.flatMap((page) => page.items.map((row) => row.id)),
      [id(1), id(3), id(4)],
    );
    assert.deepEqual(
      cache.getQueryData(tail)?.items.map((row) => row.id),
      [id(4)],
    );
    // A UUID outside the loaded partial range must not jump ahead of future pages.
    await reconcilePersonSnapshot({ ...saved, id: id(9) }, runtime);
    assert.deepEqual(
      cache.getQueryData(all)?.pages.flatMap((page) => page.items.map((row) => row.id)),
      [id(1), id(2), id(3), id(4)],
    );
  });

  void it("reconciles creation into a complete list without losing other rows", async () => {
    const { queryClient: cache, trpc } = runtime;
    const key = trpc.people.list.queryKey({ workspaceId: identity.workspaceId, q: "", limit: 1 });
    cache.setQueryData(key, {
      items: [toPersonListItem({ ...original, id: id(1) })],
      nextCursor: null,
    });
    await savePerson(identity.workspaceId, { ...command, expectedRevision: 0 });
    assert.deepEqual(
      cache.getQueryData(key)?.items.map((row) => row.id),
      [id(1), id(3)],
    );
  });

  void it("does not publish historical replay receipts and gives verified tombstones precedence", async () => {
    const { queryClient: cache, trpc } = runtime;
    const scope = { workspaceId: identity.workspaceId, id: original.id };
    const list = trpc.people.list.queryKey({ workspaceId: scope.workspaceId, q: "", limit: 30 });
    const detail = trpc.people.get.queryKey({ ...scope, includeDeleted: false });
    const verified = trpc.people.get.queryKey({ ...scope, includeDeleted: true });
    cache.setQueryData(detail, original);
    cache.setQueryData(list, { items: [toPersonListItem(original)], nextCursor: null });
    await savePerson(scope.workspaceId, command, { replaying: true });
    assert.equal(cache.getQueryData(detail)?.revision, 1);
    const tombstone = { ...saved, revision: 3, deletedAt: "2026-11-14T12:00:00.000Z" };
    cache.setQueryData(verified, tombstone);
    await reconcilePersonSnapshot(tombstone, runtime);
    await reconcilePersonSnapshot(saved, runtime);
    assert.equal(cache.getQueryData(detail)?.revision, 3);
    assert.equal(cache.getQueryData(list)?.items.length, 0);
  });

  void it("reconciles deletion without waiting for active list refresh", async () => {
    const { queryClient: cache, trpc } = runtime;
    const options = trpc.people.list.queryOptions({
      workspaceId: identity.workspaceId,
      q: "",
      limit: 30,
    });
    cache.setQueryData(options.queryKey, { items: [toPersonListItem(original)], nextCursor: null });
    const observer = new QueryObserver(cache, options);
    const unsubscribe = observer.subscribe(() => {});
    const refresh = deferred<Response>();
    const tombstone = { ...saved, deletedAt: "2026-11-14T12:00:00.000Z" };
    globalThis.fetch = (resource) => {
      const url = resource instanceof Request ? resource.url : resource.toString();
      return url.includes("people.delete")
        ? Promise.resolve(Response.json({ result: { data: tombstone } }))
        : refresh.promise;
    };
    try {
      const result = await deletePerson(identity.workspaceId, {
        commandId: randomUUID(),
        id: original.id,
        expectedRevision: 1,
      });
      assert.equal(result.deletedAt, tombstone.deletedAt);
      assert.equal(cache.getQueryData(options.queryKey)?.items.length, 0);
      assert.equal(cache.getQueryState(options.queryKey)?.fetchStatus, "fetching");
    } finally {
      unsubscribe();
    }
  });

  void it("cannot repopulate a retired identity during cancellation", async () => {
    const cache = runtime.queryClient;
    const cancel = cache.cancelQueries.bind(cache);
    const started = deferred<void>();
    const released = deferred<void>();
    cache.cancelQueries = async (...args) => {
      await cancel(...args);
      started.resolve();
      await released.promise;
    };
    try {
      const completion = savePerson(identity.workspaceId, command);
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
});
