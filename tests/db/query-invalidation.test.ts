/// <reference lib="dom" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { QueryObserver, type QueryKey } from "@tanstack/react-query";
import {
  configureQueryIdentity,
  getQueryRuntime,
  notifyQueryChange,
} from "../../src/lib/query-runtime";

void it("invalidates paginated dependencies without touching unrelated recordings or scopes", async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  let identity = { userId: randomUUID(), workspaceId: randomUUID(), epoch: 1 };
  configureQueryIdentity(() => identity);
  const runtime = getQueryRuntime();
  try {
    const workspaceId = identity.workspaceId;
    const noteId = randomUUID();
    const runId = randomUUID();
    const scope = { workspaceId, noteId, runId };
    const { trpc, queryClient: cache } = runtime;
    const keys: Record<string, QueryKey> = {
      notes: trpc.notes.list.infiniteQueryKey({ workspaceId, q: "", limit: 30 }),
      searchedNotes: trpc.notes.list.infiniteQueryKey({ workspaceId, q: "Meeting", limit: 30 }),
      people: trpc.people.list.infiniteQueryKey({ workspaceId, q: "", limit: 30 }),
      appearances: trpc.people.appearances.infiniteQueryKey({ workspaceId, id: randomUUID() }),
      transcript: trpc.transcripts.page.infiniteQueryKey(scope),
      export: trpc.transcripts.page.queryKey(scope),
      history: trpc.transcripts.history.infiniteQueryKey(scope),
      overview: trpc.recordings.overview.queryKey({ workspaceId, noteId }),
      workspaceOverview: trpc.workspace.overview.queryKey({ workspaceId }),
      otherWorkspaceOverview: trpc.workspace.overview.queryKey({ workspaceId: randomUUID() }),
      otherTranscript: trpc.transcripts.page.infiniteQueryKey({ ...scope, noteId: randomUUID() }),
    };
    const queries = Object.fromEntries(
      Object.entries(keys).map(([name, queryKey]) => [
        name,
        cache.getQueryCache().build(cache, { queryKey }),
      ]),
    );
    const invalidated = () =>
      Object.entries(queries)
        .filter(([, query]) => query.state.isInvalidated)
        .map(([name]) => name)
        .sort();
    await notifyQueryChange("notes", { workspaceId, id: noteId }, runtime, true);
    assert.deepEqual(invalidated(), ["appearances", "notes", "searchedNotes", "workspaceOverview"]);
    queries.workspaceOverview!.setData({});
    await notifyQueryChange("transcript", scope, runtime);
    assert.deepEqual(invalidated(), [
      "appearances",
      "export",
      "history",
      "notes",
      "searchedNotes",
      "transcript",
    ]);
    for (const resource of ["people", "recordings"] as const) {
      await notifyQueryChange(resource, { workspaceId }, runtime);
      assert.equal(queries.workspaceOverview!.state.isInvalidated, true);
      assert.equal(queries.otherWorkspaceOverview!.state.isInvalidated, false);
      queries.workspaceOverview!.setData({});
    }
    identity = { ...identity, epoch: 2 };
    const next = getQueryRuntime();
    assert.notEqual(next, runtime);
    assert.equal(cache.getQueryCache().getAll().length, 0);
    const nextQuery = next.queryClient
      .getQueryCache()
      .build(next.queryClient, { queryKey: keys.notes! });
    await notifyQueryChange("notes", { workspaceId, id: noteId }, runtime);
    assert.equal(nextQuery.state.isInvalidated, false);
    next.queryClient.clear();
  } finally {
    runtime.queryClient.clear();
    configureQueryIdentity(() => null);
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

void it("restarts an initial overview read after a change and rejects its stale completion", async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  const identity = { userId: randomUUID(), workspaceId: randomUUID(), epoch: 1 };
  configureQueryIdentity(() => identity);
  const runtime = getQueryRuntime();
  const queryKey = runtime.trpc.workspace.overview.queryKey({ workspaceId: identity.workspaceId });
  let release!: (value: number) => void;
  const held = new Promise<number>((resolve) => {
    release = resolve;
  });
  let firstSignal: AbortSignal | undefined;
  let reads = 0;
  const observer = new QueryObserver(runtime.queryClient, {
    queryKey,
    queryFn: ({ signal }) => {
      reads += 1;
      if (reads === 1) {
        firstSignal = signal;
        return held;
      }
      return Promise.resolve(2);
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    assert.equal(reads, 1);
    await notifyQueryChange("recordings", { workspaceId: identity.workspaceId }, runtime);
    assert.equal(firstSignal?.aborted, true);
    assert.equal(reads, 2);
    assert.equal(runtime.queryClient.getQueryData(queryKey), 2);
    release(1);
    await held;
    await Promise.resolve();
    assert.equal(runtime.queryClient.getQueryData(queryKey), 2);
  } finally {
    release(1);
    unsubscribe();
    runtime.queryClient.clear();
    configureQueryIdentity(() => null);
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
