/// <reference lib="dom" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { QueryObserver } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import type {
  CorrectedTurn,
  CorrectionCommand,
  CorrectionResult,
} from "../../src/contracts/transcript-corrections";
import {
  configureQueryIdentity,
  getQueryRuntime,
  type QueryRuntime,
} from "../../src/lib/query-runtime";
import {
  flattenTranscriptPages,
  optimisticCorrection,
  reconcileCorrectionResult,
  submitCorrection,
  transcriptQueryOptions,
  type TranscriptScope,
} from "../../src/queries/transcript-corrections";

const id = (value: number) => `${value.toString().padStart(8, "0")}-0000-4000-8000-000000000000`;
type Page = { items: CorrectedTurn[]; nextCursor: string | null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function turn(value: number, overrides: Partial<CorrectedTurn> = {}): CorrectedTurn {
  return {
    id: id(value),
    runId: id(90),
    recordingId: id(91),
    sequence: value,
    orderKey: "",
    sourceUtteranceId: id(value),
    parentId: null,
    revision: 1,
    attributionRevision: 1,
    startSeconds: value * 10,
    endSeconds: value * 10 + 9,
    speakerLabel: "A",
    text: "Left middle right",
    assignment: { kind: "unassigned" },
    assignmentSource: "unassigned",
    personName: null,
    reviewState: "unreviewed",
    providerScore: null,
    sampleSuitability: "not_evaluated",
    originalText: "Left middle right",
    originalStartSeconds: value * 10,
    originalEndSeconds: value * 10 + 9,
    ...overrides,
  };
}

function result(
  items: CorrectedTurn[],
  removed: CorrectionResult["current"]["removed"] = [],
): CorrectionResult {
  return {
    receipt: {
      id: randomUUID(),
      commandId: randomUUID(),
      kind: "edit",
      affectedCount: 1,
      createdAt: "2026-11-14T12:00:00.000Z",
      undoOf: null,
    },
    current: { items, removed, complete: true },
  };
}

function split(parent = turn(2)): Extract<CorrectionCommand, { kind: "split" }> {
  return {
    kind: "split",
    commandId: id(70),
    utteranceId: parent.id,
    expectedRevision: parent.revision,
    splitSeconds: parent.startSeconds + 4,
    textOffset: 5,
    leftId: id(72),
    rightId: id(73),
  };
}

void describe("transcript correction query ownership", { concurrency: false }, () => {
  const nativeFetch = globalThis.fetch;
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  let identity: { userId: string; workspaceId: string; epoch: number };
  let runtime: QueryRuntime;
  let scope: TranscriptScope;

  beforeEach(() => {
    Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
    identity = { userId: randomUUID(), workspaceId: randomUUID(), epoch: 1 };
    configureQueryIdentity(() => identity);
    runtime = getQueryRuntime();
    scope = { workspaceId: identity.workspaceId, noteId: id(89), runId: id(90) };
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
    void it(`collects completed correction mutations after ${fails ? "failure" : "success"}`, async () => {
      const cache = runtime.queryClient;
      cache.setDefaultOptions({ ...cache.getDefaultOptions(), mutations: { gcTime: 0 } });
      const acknowledgement = result([turn(2, { revision: 2 })]);
      globalThis.fetch = () =>
        fails
          ? Promise.reject(new Error("Injected failure"))
          : Promise.resolve(Response.json({ result: { data: acknowledgement } }));
      for (let attempt = 0; attempt < 3; attempt++) {
        const completion = submitCorrection(scope, split());
        if (fails) await assert.rejects(completion, /Injected failure/);
        else assert.deepEqual(await completion, acknowledgement);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(cache.getMutationCache().getAll().length, 0);
    });
  }

  void it("cancels stale reads and completes acknowledgement while scoped refresh is blocked", async () => {
    const { queryClient: cache, trpc } = runtime;
    const options = trpc.transcripts.page.queryOptions(scope, { trpc: { abortOnUnmount: true } });
    const old = turn(2);
    const saved = { ...old, text: "Saved", revision: 2 };
    const acknowledgement = result([saved]);
    cache.setQueryData(options.queryKey, { items: [old], nextCursor: null });
    const stale = deferred<Response>();
    const refresh = deferred<Response>();
    const started = deferred<void>();
    let signal: AbortSignal | null | undefined;
    let reads = 0;
    globalThis.fetch = (resource, init) => {
      const url = resource instanceof Request ? resource.url : resource.toString();
      if (url.includes("transcripts.command")) {
        return Promise.resolve(Response.json({ result: { data: acknowledgement } }));
      }
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
      const received = await Promise.race([
        submitCorrection(
          scope,
          {
            kind: "edit",
            commandId: acknowledgement.receipt.commandId,
            utteranceId: old.id,
            expectedRevision: 1,
            text: saved.text,
            startSeconds: old.startSeconds,
            endSeconds: old.endSeconds,
          },
          runtime,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Waited for refetch")), 1000);
        }),
      ]);
      assert.deepEqual(received, acknowledgement);
      assert.equal(signal?.aborted, true);
      assert.equal(reads, 2);
      assert.equal(cache.getQueryState(options.queryKey)?.fetchStatus, "fetching");
      assert.deepEqual(cache.getQueryData(options.queryKey)?.items, [saved]);
      stale.resolve(Response.json({ result: { data: { items: [old], nextCursor: null } } }));
      await stale.promise;
      await Promise.resolve();
      assert.equal(cache.getQueryData(options.queryKey)?.items[0]?.text, "Saved");
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
    }
  });

  void it("guards updates and removals by both tokens and retains tombstones against replay", async () => {
    const { queryClient: cache, trpc } = runtime;
    const key = trpc.transcripts.page.queryKey(scope);
    const newer = turn(2, { revision: 5, attributionRevision: 4 });
    cache.setQueryData(key, { items: [newer], nextCursor: null });
    await reconcileCorrectionResult(
      scope,
      result([turn(2, { revision: 6, attributionRevision: 3 })]),
      runtime,
    );
    await reconcileCorrectionResult(
      scope,
      result([], [{ id: newer.id, revision: 4, attributionRevision: 4 }]),
      runtime,
    );
    assert.deepEqual(cache.getQueryData(key)?.items, [newer]);
    await reconcileCorrectionResult(
      scope,
      result([], [{ id: newer.id, revision: 6, attributionRevision: 5 }]),
      runtime,
    );
    assert.deepEqual(cache.getQueryData(key)?.items, []);
    await reconcileCorrectionResult(scope, result([newer]), runtime);
    assert.deepEqual(cache.getQueryData(key)?.items, []);
  });

  void it("reconciles a boundary split in ordinary/infinite variants without moving cursors or sorting by time", async () => {
    const { queryClient: cache, trpc } = runtime;
    const parent = turn(2);
    const children = optimisticCorrection([parent], split(parent)).map((child) => ({
      ...child,
      revision: 2,
      attributionRevision: 2,
    }));
    const acknowledgement = result(children, [
      { id: parent.id, revision: 2, attributionRevision: 2 },
    ]);
    const ordinary = trpc.transcripts.page.queryKey(scope);
    const infinite = transcriptQueryOptions(scope).queryKey;
    const other = trpc.transcripts.page.queryKey({ ...scope, runId: id(99) });
    const first = {
      items: [turn(1), parent],
      passages: [
        { id: id(80), turnIds: [parent.id], text: parent.text, startSeconds: 20, endSeconds: 29 },
      ],
      nextCursor: "split-boundary",
    };
    const second = { items: [turn(3, { startSeconds: 0, endSeconds: 1 })], nextCursor: "tail" };
    cache.setQueryData(ordinary, first);
    cache.setQueryData(infinite, { pages: [first, second], pageParams: [null, "split-boundary"] });
    cache.setQueryData(other, first);
    await reconcileCorrectionResult(scope, acknowledgement, runtime);
    const data = cache.getQueryData<InfiniteData<Page>>(infinite)!;
    assert.deepEqual(
      data.pages.map((page) => page.items.map((row) => row.id)),
      [[id(1), id(72), id(73)], [id(3)]],
    );
    assert.deepEqual(data.pageParams, [null, "split-boundary"]);
    assert.deepEqual(
      data.pages.map((page) => page.nextCursor),
      ["split-boundary", "tail"],
    );
    assert.equal("passages" in data.pages[0]!, false);
    assert.deepEqual(
      cache.getQueryData(ordinary)?.items.map((row) => row.id),
      [id(1), id(72), id(73)],
    );
    assert.equal(cache.getQueryData(other), first);
    const later = {
      items: [{ ...children[1]!, text: "Newer", revision: 3 }, turn(3)],
      nextCursor: null,
    };
    const flat = flattenTranscriptPages([...data.pages, later]);
    assert.deepEqual(
      flat.map((row) => row.id),
      [id(1), id(72), id(73), id(3)],
    );
    assert.equal(flat.find((row) => row.id === id(73))?.text, "Newer");
    assert.equal(
      flattenTranscriptPages([...data.pages, { items: [parent], nextCursor: null }]).some(
        (row) => row.id === parent.id,
      ),
      false,
    );
  });

  void it("restores a parent at its loaded children and leaves unseen targets outside the loaded range", async () => {
    const { queryClient: cache, trpc } = runtime;
    const key = trpc.transcripts.page.infiniteQueryKey(scope);
    const parent = turn(2);
    const children = optimisticCorrection([parent], split(parent)).map((child) => ({
      ...child,
      revision: 2,
      attributionRevision: 2,
    }));
    cache.setQueryData(key, {
      pages: [
        { items: [children[0]!], nextCursor: "between" },
        { items: [children[1]!, turn(3)], nextCursor: "more" },
      ],
      pageParams: [null, "between"],
    });
    await reconcileCorrectionResult(
      scope,
      result(
        [turn(1), { ...parent, revision: 3, attributionRevision: 3 }, turn(8)],
        children.map((child) => ({ id: child.id, revision: 3, attributionRevision: 3 })),
      ),
      runtime,
    );
    const data = cache.getQueryData(key)!;
    assert.deepEqual(
      data.pages.map((page) => page.items.map((row) => row.id)),
      [[parent.id], [id(3)]],
    );
    assert.deepEqual(data.pageParams, [null, "between"]);
  });

  void it("does not introduce split children when a newer parent rejects removal", async () => {
    const key = runtime.trpc.transcripts.page.queryKey(scope);
    const parent = turn(2);
    const current = { ...parent, revision: 4, attributionRevision: 3 };
    runtime.queryClient.setQueryData(key, { items: [current], nextCursor: null });
    const children = optimisticCorrection([parent], split(parent)).map((child) => ({
      ...child,
      revision: 2,
      attributionRevision: 2,
    }));
    await reconcileCorrectionResult(
      scope,
      result(children, [{ id: parent.id, revision: 2, attributionRevision: 2 }]),
      runtime,
    );
    assert.deepEqual(runtime.queryClient.getQueryData(key)?.items, [current]);
  });

  void it("rejects a delayed ancestor restoration over freshly fetched nested descendants", async () => {
    const { queryClient: cache, trpc } = runtime;
    const ordinary = trpc.transcripts.page.queryKey(scope);
    const infinite = trpc.transcripts.page.infiniteQueryKey(scope);
    const parent = turn(2);
    const nested = ["00", "01"].map((orderKey, index) => ({
      ...parent,
      id: id(78 + index),
      parentId: id(76),
      orderKey,
      revision: 5,
      attributionRevision: 5,
    }));
    const rightBranch = ["10", "11"].map((orderKey, index) => ({
      ...parent,
      id: id(80 + index),
      parentId: id(77),
      orderKey,
      revision: 5,
      attributionRevision: 5,
    }));
    const items = [turn(1), ...nested, ...rightBranch, turn(3)];
    // Fresh reads carry no tombstones for the parent or its retired children.
    cache.setQueryData(ordinary, { items, nextCursor: "more" });
    cache.setQueryData(infinite, {
      pages: [
        { items: items.slice(0, 2), nextCursor: "nested" },
        { items: items.slice(2), nextCursor: "more" },
      ],
      pageParams: [null, "nested"],
    });
    await reconcileCorrectionResult(
      scope,
      result(
        [{ ...parent, revision: 3, attributionRevision: 3 }],
        [72, 73].map((value) => ({ id: id(value), revision: 3, attributionRevision: 3 })),
      ),
      runtime,
    );
    assert.deepEqual(cache.getQueryData(ordinary)?.items, items);
    const data = cache.getQueryData(infinite)!;
    assert.deepEqual(flattenTranscriptPages(data.pages), items);
    assert.deepEqual(data.pageParams, [null, "nested"]);
  });

  void it("rejects reused lineage keys with different IDs while accepting unrelated sibling updates", async () => {
    const { queryClient: cache, trpc } = runtime;
    const key = trpc.transcripts.page.queryKey(scope);
    const parent = turn(2);
    const current = {
      ...parent,
      id: id(76),
      parentId: parent.id,
      orderKey: "0",
      revision: 4,
      attributionRevision: 4,
    };
    const sibling = {
      ...parent,
      id: id(77),
      parentId: parent.id,
      orderKey: "1",
      revision: 4,
      attributionRevision: 4,
    };
    cache.setQueryData(key, { items: [turn(1), current, sibling, turn(3)], nextCursor: null });
    const updatedSibling = { ...sibling, text: "Current sibling", revision: 5 };
    await reconcileCorrectionResult(
      scope,
      result(
        [{ ...current, id: id(72), revision: 2, attributionRevision: 2 }, updatedSibling],
        [{ id: parent.id, revision: 2, attributionRevision: 2 }],
      ),
      runtime,
    );
    assert.deepEqual(cache.getQueryData(key)?.items, [turn(1), current, updatedSibling, turn(3)]);
  });

  void it("requires version-valid retirement of every overlapping lineage before replacing it", async () => {
    const { queryClient: cache, trpc } = runtime;
    const key = trpc.transcripts.page.queryKey(scope);
    const parent = turn(2);
    const nested = {
      ...parent,
      id: id(78),
      parentId: id(76),
      orderKey: "00",
      revision: 5,
      attributionRevision: 5,
    };
    const replacement = { ...parent, revision: 6, attributionRevision: 6 };
    cache.setQueryData(key, { items: [turn(1), nested, turn(3)], nextCursor: null });
    await reconcileCorrectionResult(
      scope,
      result([replacement], [{ id: nested.id, revision: 6, attributionRevision: 4 }]),
      runtime,
    );
    assert.deepEqual(cache.getQueryData(key)?.items, [turn(1), nested, turn(3)]);
    await reconcileCorrectionResult(
      scope,
      result([replacement], [{ id: nested.id, revision: 6, attributionRevision: 6 }]),
      runtime,
    );
    assert.deepEqual(cache.getQueryData(key)?.items, [turn(1), replacement, turn(3)]);
  });

  void it("incomplete projections do not invent changes but still invalidate in background", async () => {
    const key = runtime.trpc.transcripts.page.queryKey(scope);
    const page = { items: [turn(2)], nextCursor: "more" };
    runtime.queryClient.setQueryData(key, page);
    const acknowledgement = result([turn(2, { text: "Must not publish" })]);
    acknowledgement.current.complete = false;
    await reconcileCorrectionResult(scope, acknowledgement, runtime);
    assert.equal(runtime.queryClient.getQueryData(key), page);
    assert.equal(runtime.queryClient.getQueryState(key)?.isInvalidated, true);
  });

  void it("rejects completion after identity retirement during cancellation", async () => {
    const cache = runtime.queryClient;
    cache.setQueryData(runtime.trpc.transcripts.page.queryKey(scope), {
      items: [turn(2)],
      nextCursor: null,
    });
    const cancel = cache.cancelQueries.bind(cache);
    const started = deferred<void>();
    const release = deferred<void>();
    cache.cancelQueries = async (...args) => {
      await cancel(...args);
      started.resolve();
      await release.promise;
    };
    try {
      const completion = reconcileCorrectionResult(
        scope,
        result([turn(2, { revision: 2 })]),
        runtime,
      );
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

  void it("does not send a pending command through a retired runtime", async () => {
    let requests = 0;
    globalThis.fetch = () => {
      requests += 1;
      return Promise.resolve(Response.json({ result: { data: result([]) } }));
    };
    identity = { ...identity, epoch: 2 };
    await assert.rejects(submitCorrection(scope, split(), runtime), /previous workspace session/);
    assert.equal(requests, 0);
    assert.equal(getQueryRuntime().queryClient.getMutationCache().getAll().length, 0);
  });
});

void describe("pure correction overlays", () => {
  void it("assigns only matching attribution tokens without fabricating unloaded targets or acknowledgement", () => {
    const original = [turn(1), turn(2, { attributionRevision: 3 })];
    const command: CorrectionCommand = {
      kind: "assign",
      commandId: id(70),
      assignment: { kind: "person", personId: id(80) },
      targets: [1, 2, 3].map((value) => ({ id: id(value), expectedAttributionRevision: 1 })),
    };
    const overlay = optimisticCorrection(original, command, { personName: "Ada" });
    assert.equal(overlay.length, 2);
    assert.equal(overlay[0]?.personName, "Ada");
    assert.equal(overlay[0]?.revision, 1);
    assert.equal(overlay[0]?.attributionRevision, 1);
    assert.equal(overlay[1], original[1]);
    assert.equal(original[0]?.personName, null);
    const newer = [
      turn(1, { attributionRevision: 2, revision: 2, text: "Concurrent success" }),
      original[1]!,
    ];
    assert.equal(optimisticCorrection(newer, command)[0], newer[0]);
    assert.equal(newer[0]?.text, "Concurrent success");
  });

  void it("preserves source evidence and exact child identities/order for selected-range splits", () => {
    const parent = turn(2, { orderKey: "10", revision: 4, attributionRevision: 2 });
    const command = {
      ...split(parent),
      selection: {
        startOffset: 5,
        endOffset: 11,
        startSeconds: 23,
        endSeconds: 26,
        selectedId: id(74),
        assignment: { kind: "person" as const, personId: id(80) },
      },
    };
    const overlay = optimisticCorrection([parent, turn(3)], command, { personName: "Ada" });
    assert.deepEqual(
      overlay.map((row) => row.id),
      [id(72), id(74), id(73), id(3)],
    );
    assert.deepEqual(
      overlay.slice(0, 3).map((row) => row.orderKey),
      ["1000", "1001", "101"],
    );
    assert.deepEqual(
      overlay.slice(0, 3).map((row) => row.text),
      ["Left ", "middle", " right"],
    );
    for (const child of overlay.slice(0, 3)) {
      assert.equal(child.parentId, parent.id);
      assert.equal(child.sourceUtteranceId, parent.sourceUtteranceId);
      assert.equal(child.originalText, parent.originalText);
      assert.equal(child.originalStartSeconds, parent.originalStartSeconds);
      assert.equal(child.originalEndSeconds, parent.originalEndSeconds);
      assert.equal(child.revision, parent.revision);
      assert.equal(child.attributionRevision, parent.attributionRevision);
    }
    assert.equal(overlay[1]?.personName, "Ada");
    assert.deepEqual(optimisticCorrection([parent], { ...command, expectedRevision: 3 }), [parent]);
    assert.equal(parent.parentId, null);
  });

  void it("edits without reordering by audio time and leaves newer rows intact when overlay is removed", () => {
    const original = [turn(1), turn(2)];
    const command: CorrectionCommand = {
      kind: "edit",
      commandId: id(70),
      utteranceId: id(2),
      expectedRevision: 1,
      text: "Pending",
      startSeconds: 0,
      endSeconds: 1,
    };
    const overlay = optimisticCorrection(original, command);
    assert.deepEqual(
      overlay.map((row) => row.id),
      [id(1), id(2)],
    );
    assert.equal(overlay[1]?.revision, 1);
    assert.equal(original[1]?.text, "Left middle right");
    const newer = [original[0]!, turn(2, { revision: 2, text: "Acknowledged elsewhere" })];
    assert.deepEqual(optimisticCorrection(newer, command), newer);
  });

  void it("undo previews require every acknowledged after-version and keep current tokens", () => {
    const before = turn(2);
    const after = { ...before, text: "Saved", revision: 2 };
    const command: CorrectionCommand = { kind: "undo", commandId: id(70), correctionId: id(71) };
    const undo = { before: [before], after: [after] };
    const overlay = optimisticCorrection([after], command, { undo });
    assert.equal(overlay[0]?.text, before.text);
    assert.equal(overlay[0]?.revision, after.revision);
    assert.deepEqual(optimisticCorrection([], command, { undo }), []);
    const newer = { ...after, attributionRevision: 3 };
    assert.deepEqual(optimisticCorrection([newer], command, { undo }), [newer]);
    assert.deepEqual(optimisticCorrection([after], command), [after]);
    const children = optimisticCorrection([before], split(before)).map((child) => ({
      ...child,
      revision: 2,
      attributionRevision: 2,
    }));
    const splitUndo = { before: [before], after: children };
    assert.deepEqual(optimisticCorrection(children, command, { undo: splitUndo }), [before]);
    assert.deepEqual(optimisticCorrection([children[0]!], command, { undo: splitUndo }), [
      children[0],
    ]);
  });
});
