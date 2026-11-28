/// <reference lib="dom" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { QueryObserver, type QueryKey } from "@tanstack/react-query";
import {
  configureQueryIdentity,
  applyActivityChanges,
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
      selfProfile: trpc.selfProfile.get.queryKey({ workspaceId }),
      otherSelfProfile: trpc.selfProfile.get.queryKey({ workspaceId: randomUUID() }),
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
      if (resource === "people") {
        assert.equal(queries.selfProfile!.state.isInvalidated, true);
        assert.equal(queries.otherSelfProfile!.state.isInvalidated, false);
      }
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

void it("research completion refreshes its run and task lists without invalidating contacts", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  const identity = { userId: randomUUID(), workspaceId: randomUUID(), epoch: 1 };
  configureQueryIdentity(() => identity);
  const runtime = getQueryRuntime();
  const { queryClient: cache, trpc } = runtime;
  const workspaceId = identity.workspaceId;
  const runId = randomUUID();
  try {
    const keys: Record<string, QueryKey> = {
      run: trpc.researchRuns.get.queryKey({ workspaceId, runId }),
      otherRun: trpc.researchRuns.get.queryKey({ workspaceId, runId: randomUUID() }),
      tasks: trpc.researchRuns.list.queryKey({ workspaceId, status: "all", limit: 6 }),
      contacts: trpc.contacts.get.queryKey({ workspaceId, personId: randomUUID() }),
      legacy: trpc.research.list.queryKey({ workspaceId }),
      foreign: trpc.researchRuns.list.queryKey({
        workspaceId: randomUUID(),
        status: "all",
        limit: 6,
      }),
    };
    const queries = Object.fromEntries(
      Object.entries(keys).map(([name, queryKey]) => [
        name,
        cache.getQueryCache().build(cache, { queryKey }),
      ]),
    );
    await applyActivityChanges(
      workspaceId,
      [
        {
          id: randomUUID(),
          sequence: "1",
          type: "research.completed",
          title: "Research ready",
          href: `/research/${runId}`,
          executor: "workflow",
          createdAt: new Date().toISOString(),
          readAt: null,
          noteId: null,
          personId: null,
          runId,
        },
      ],
      runtime,
    );
    assert.deepEqual(
      Object.entries(queries)
        .filter(([, query]) => query.state.isInvalidated)
        .map(([name]) => name)
        .sort(),
      ["run", "tasks"],
    );
  } finally {
    cache.clear();
    configureQueryIdentity(() => null);
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

for (const resource of ["recordings", "people"] as const) {
  void it(`restarts an initial ${resource === "people" ? "self-profile" : "overview"} read after a change and rejects its stale completion`, async () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
    const identity = { userId: randomUUID(), workspaceId: randomUUID(), epoch: 1 };
    configureQueryIdentity(() => identity);
    const runtime = getQueryRuntime();
    const scope = { workspaceId: identity.workspaceId };
    const queryKey =
      resource === "people"
        ? runtime.trpc.selfProfile.get.queryKey(scope)
        : runtime.trpc.workspace.overview.queryKey(scope);
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
      await notifyQueryChange(resource, scope, runtime);
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
}

void it("source changes refresh only affected summaries and reject a late current result", async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  const identity = { userId: randomUUID(), workspaceId: randomUUID(), epoch: 1 };
  configureQueryIdentity(() => identity);
  const runtime = getQueryRuntime();
  const { queryClient: cache, trpc } = runtime;
  const noteId = randomUUID();
  const jobId = randomUUID();
  const resultKey: QueryKey = trpc.summaries.result.queryKey({
    workspaceId: identity.workspaceId,
    jobId,
  });
  const unrelatedKey: QueryKey = trpc.summaries.result.queryKey({
    workspaceId: identity.workspaceId,
    jobId: randomUUID(),
  });
  const original = { summary: { noteId }, freshness: "current" };
  cache.setQueryData(resultKey, original);
  cache.setQueryData(unrelatedKey, { summary: { noteId: randomUUID() }, freshness: "current" });
  let release!: (value: typeof original) => void;
  const held = new Promise<typeof original>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  let signal: AbortSignal | undefined;
  const observer = new QueryObserver(cache, {
    queryKey: resultKey,
    staleTime: 0,
    queryFn: (context) => {
      reads++;
      if (reads === 1) {
        signal = context.signal;
        return held;
      }
      return Promise.resolve({ ...original, freshness: "stale" });
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await notifyQueryChange(
      "transcript",
      { workspaceId: identity.workspaceId, noteId, runId: randomUUID() },
      runtime,
    );
    assert.equal(signal?.aborted, true);
    assert.equal(reads, 2);
    assert.equal(cache.getQueryData<typeof original>(resultKey)?.freshness, "stale");
    assert.equal(cache.getQueryState(unrelatedKey)?.isInvalidated, false);
    release(original);
    await held;
    await Promise.resolve();
    assert.equal(cache.getQueryData<typeof original>(resultKey)?.freshness, "stale");
  } finally {
    release(original);
    unsubscribe();
    cache.clear();
    configureQueryIdentity(() => null);
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
