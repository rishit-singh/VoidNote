/// <reference lib="dom" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";

import type { AnalysisJob } from "../../src/contracts/analysis";
import {
  cancelSummary,
  isDefiniteSummaryRejection,
  requestSummary,
  summaryJobQueryOptions,
} from "../../src/queries/summaries";
import { ApiError } from "../../src/lib/api-error";
import {
  configureQueryIdentity,
  getQueryRuntime,
  notifyQueryChange,
} from "../../src/lib/query-runtime";
import { pendingSummaryCommands } from "../../src/stores/pending-summaries";

const workspaceId = randomUUID();
const noteId = randomUUID();
const userId = randomUUID();
const jobId = randomUUID();

function installBrowser(
  identity:
    | { userId: string; workspaceId: string; epoch: number }
    | (() => { userId: string; workspaceId: string; epoch: number }),
) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  configureQueryIdentity(typeof identity === "function" ? identity : () => identity);
  const runtime = getQueryRuntime();
  return {
    runtime,
    restore() {
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", previousWindow);
      } else {
        delete (globalThis as { window?: Window }).window;
      }
    },
  };
}

function makeJob(status: AnalysisJob["status"] = "queued", commandId: string = randomUUID()) {
  return {
    id: jobId,
    noteId,
    commandId,
    status,
    source: { noteId, recordingId: randomUUID(), runId: randomUUID(), generation: 1 },
    resultId: status === "succeeded" ? randomUUID() : null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as const;
}

void it("Generate sends the exact strict RPC payload and updates the accepted-job cache immediately", async () => {
  const browser = installBrowser({ userId, workspaceId, epoch: 1 });
  try {
    const { runtime } = browser;
    const overviewInput = { workspaceId, noteId };
    const overviewKey = runtime.trpc.summaries.overview.queryKey(overviewInput);
    const oldOverview = {
      latestJob: null,
      latestSummaryJobId: null,
      canGenerate: true,
      unavailableReason: null,
    };
    runtime.queryClient.setQueryData(overviewKey, oldOverview);
    const pendingFilters: string[] = [];
    const cancelQueries = runtime.queryClient.cancelQueries.bind(runtime.queryClient);
    runtime.queryClient.cancelQueries = async (filters) => {
      pendingFilters.push(JSON.stringify(filters?.queryKey));
      return cancelQueries(filters);
    };
    const accepted = makeJob();
    let sent: unknown;
    let sendCount = 0;
    let resolveSend!: (result: { job: typeof accepted }) => void;
    const dependencies = {
      getRuntime: () => runtime,
      notifyChange: () => {},
      send: (_runtime: typeof runtime, _workspaceId: string, command: unknown) => {
        sendCount += 1;
        sent = command;
        assert.deepEqual(runtime.queryClient.getQueryData(overviewKey), oldOverview);
        return new Promise<{ job: typeof accepted }>((resolve) => {
          resolveSend = resolve;
        });
      },
    };
    const command = { commandId: accepted.commandId, noteId, userId };
    const first = requestSummary(workspaceId, command, dependencies);
    const second = requestSummary(workspaceId, command, dependencies);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sendCount, 1);
    resolveSend({ job: accepted });
    const [result] = await Promise.all([first, second]);

    assert.deepEqual(sent, { commandId: accepted.commandId, noteId });
    assert.equal(pendingFilters.length, 2);
    assert.equal(result.id, accepted.id);
    assert.deepEqual(runtime.queryClient.getQueryData(overviewKey), {
      ...oldOverview,
      latestJob: accepted,
    });
    assert.deepEqual(
      runtime.queryClient.getQueryData(runtime.trpc.summaries.job.queryKey({ workspaceId, jobId })),
      accepted,
    );
  } finally {
    browser.restore();
  }
});

void it("a lost response retries the same persisted command and an old acknowledgement preserves a newer command", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const browser = installBrowser({ userId, workspaceId, epoch: 2 });
  try {
    const recovery = pendingSummaryCommands({
      user: { id: userId },
      workspace: { id: workspaceId },
    } as Parameters<typeof pendingSummaryCommands>[0]);
    const pending = recovery.prepare(noteId);
    const payloads: unknown[] = [];
    let attempts = 0;
    const dependencies = {
      getRuntime: () => browser.runtime,
      notifyChange: () => {},
      send: (_runtime: typeof browser.runtime, _workspaceId: string, command: unknown) => {
        payloads.push(command);
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error("response lost after server accepted"));
        }
        return Promise.resolve({ job: makeJob("queued", pending.commandId) });
      },
    };
    assert.equal(recovery.prepare(noteId).commandId, pending.commandId);

    await assert.rejects(
      requestSummary(workspaceId, { ...pending, userId }, dependencies),
      /response lost after server accepted/,
    );
    const retry = recovery.forNote(noteId)!;
    assert.equal(retry.commandId, pending.commandId);
    await requestSummary(workspaceId, retry, dependencies);
    assert.deepEqual(payloads[0], { commandId: pending.commandId, noteId });
    assert.deepEqual(payloads[1], payloads[0]);

    recovery.acknowledge(pending);
    const newer = recovery.prepare(noteId);
    recovery.acknowledge(pending);
    assert.equal(recovery.forNote(noteId)?.commandId, newer.commandId);
    const rejected = recovery.prepare(randomUUID());
    recovery.reject(rejected, "Summary generation is disabled.");
    assert.equal(recovery.forNote(rejected.noteId)?.status, "rejected");
    assert.equal(isDefiniteSummaryRejection(new ApiError("No transcript", 409)), true);
    assert.equal(isDefiniteSummaryRejection(new ApiError("Server error", 500)), false);
    assert.equal(isDefiniteSummaryRejection(new Error("Connection lost")), false);

    const storageKey = `voidnote:pending-summaries:v1:${userId}:${workspaceId}`;
    values.set(storageKey, "{malformed saved request");
    const damaged = pendingSummaryCommands({
      user: { id: userId },
      workspace: { id: workspaceId },
    } as Parameters<typeof pendingSummaryCommands>[0]);
    assert.match(damaged.snapshot().error?.message ?? "", /JSON|Unexpected/);
    assert.equal(values.get(storageKey), "{malformed saved request");
    assert.throws(() => damaged.prepare(randomUUID()));
  } finally {
    browser.restore();
    if (originalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
});

void it("late cancellation after an account/workspace epoch change cannot mutate the old cache", async () => {
  let identity = { userId, workspaceId, epoch: 6 };
  const browser = installBrowser(() => identity);
  try {
    const oldRuntime = browser.runtime;
    const jobKey = oldRuntime.trpc.summaries.job.queryKey({ workspaceId, jobId });
    const running = makeJob("running");
    oldRuntime.queryClient.setQueryData(jobKey, running);
    let resolveCancellation!: (job: ReturnType<typeof makeJob>) => void;
    const cancellation = cancelSummary(workspaceId, jobId, {
      getRuntime: getQueryRuntime,
      notifyChange: () => {},
      send: () =>
        new Promise((resolve) => {
          resolveCancellation = resolve;
        }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    identity = { userId: randomUUID(), workspaceId: randomUUID(), epoch: 7 };
    const newRuntime = getQueryRuntime();
    resolveCancellation({ ...running, status: "cancelled" });
    await cancellation;

    assert.equal(oldRuntime.queryClient.getQueryData(jobKey), undefined);
    assert.equal(
      newRuntime.queryClient.getQueryData(
        newRuntime.trpc.summaries.job.queryKey({ workspaceId, jobId }),
      ),
      undefined,
    );
  } finally {
    browser.restore();
  }
});

void it("late acceptance after session change does not update either session cache", async () => {
  let identity = { userId, workspaceId, epoch: 3 };
  const browser = installBrowser(() => identity);
  try {
    const oldRuntime = browser.runtime;
    const oldOverview = {
      latestJob: null,
      latestSummaryJobId: null,
      canGenerate: true,
      unavailableReason: null,
    };
    const overviewKey = oldRuntime.trpc.summaries.overview.queryKey({ workspaceId, noteId });
    oldRuntime.queryClient.setQueryData(overviewKey, oldOverview);
    let resolveSend!: (value: { job: ReturnType<typeof makeJob> }) => void;
    const result = requestSummary(
      workspaceId,
      { commandId: jobId, noteId, userId },
      {
        getRuntime: getQueryRuntime,
        notifyChange: () => {},
        send: () =>
          new Promise((resolve) => {
            resolveSend = resolve;
          }),
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    identity = { userId: randomUUID(), workspaceId: randomUUID(), epoch: 4 };
    const newRuntime = getQueryRuntime();
    resolveSend({ job: makeJob() });
    await result;

    assert.equal(oldRuntime.queryClient.getQueryData(overviewKey), undefined);
    assert.equal(
      newRuntime.queryClient.getQueryData(
        newRuntime.trpc.summaries.overview.queryKey({ workspaceId, noteId }),
      ),
      undefined,
    );
  } finally {
    browser.restore();
  }
});

void it("terminal completion notifies once and invalidates the saved result, history, and overview", async () => {
  const browser = installBrowser({ userId, workspaceId, epoch: 5 });
  try {
    const { runtime } = browser;
    const jobKey = runtime.trpc.summaries.job.queryKey({ workspaceId, jobId });
    const overviewKey = runtime.trpc.summaries.overview.queryKey({ workspaceId, noteId });
    const historyKey = runtime.trpc.summaries.history.infiniteQueryKey({
      workspaceId,
      noteId,
      limit: 30,
    });
    const resultKey = runtime.trpc.summaries.result.queryKey({ workspaceId, jobId });
    runtime.queryClient
      .getQueryCache()
      .build(runtime.queryClient, { queryKey: overviewKey })
      .setData({});
    runtime.queryClient
      .getQueryCache()
      .build(runtime.queryClient, { queryKey: historyKey })
      .setData({ pages: [], pageParams: [] });
    runtime.queryClient
      .getQueryCache()
      .build(runtime.queryClient, { queryKey: resultKey })
      .setData({ summary: { noteId }, freshness: "current" });

    let notifyCount = 0;
    let notification: Promise<void> | undefined;
    const options = summaryJobQueryOptions(workspaceId, jobId, {
      getRuntime: () => runtime,
      notifyChange: (scope, changedWorkspace, changedNote) => {
        notifyCount += 1;
        notification = notifyQueryChange(
          "summaries",
          { workspaceId: changedWorkspace, noteId: changedNote },
          scope,
        );
      },
      fetchJob: () => Promise.resolve(makeJob("succeeded")),
    });
    const terminal = await options.queryFn({
      client: runtime.queryClient,
      queryKey: jobKey,
      signal: new AbortController().signal,
      meta: undefined,
    });
    await notification;
    assert.equal(terminal.status, "succeeded");
    assert.equal(notifyCount, 1);
    assert.equal(runtime.queryClient.getQueryState(resultKey)?.isInvalidated, true);
    assert.equal(runtime.queryClient.getQueryState(historyKey)?.isInvalidated, true);
    assert.equal(runtime.queryClient.getQueryState(overviewKey)?.isInvalidated, true);

    runtime.queryClient.setQueryData(jobKey, terminal);
    await options.queryFn({
      client: runtime.queryClient,
      queryKey: jobKey,
      signal: new AbortController().signal,
      meta: undefined,
    });
    assert.equal(notifyCount, 1);
  } finally {
    browser.restore();
  }
});
