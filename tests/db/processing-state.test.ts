/// <reference lib="dom" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { QueryObserver } from "@tanstack/react-query";
import type { ProcessingRun, RemoteRecording } from "../../src/contracts/recording-processing";
import { configureQueryIdentity, getQueryRuntime } from "../../src/lib/query-runtime";
import {
  processingJobKey,
  recordingOverviewOptions,
  recordingProcessingView,
  refreshRecordingProcessing,
  submitRecordingProcessing,
  useProcessingJobs,
} from "../../src/lib/recording-processing-client";
import type { LocalRecordingSession } from "../../src/lib/recording-schemas";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const response = (data: unknown) => Response.json({ result: { data } });

function fixture() {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  let identity = { userId: randomUUID(), workspaceId: randomUUID(), epoch: 1 };
  configureQueryIdentity(() => identity);
  const runtime = getQueryRuntime();
  runtime.queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  const input = {
    workspaceId: identity.workspaceId,
    noteId: randomUUID(),
    recordingId: randomUUID(),
  };
  const key = processingJobKey(1, identity.userId, input.workspaceId, input.noteId);
  const recording: RemoteRecording = {
    id: input.recordingId,
    workspaceId: input.workspaceId,
    noteId: input.noteId,
    status: "ready",
    sha256: "a".repeat(64),
    bytes: 100,
    mimeType: "audio/webm",
    durationSeconds: 10,
    createdAt: new Date().toISOString(),
  };
  const run: ProcessingRun = {
    id: randomUUID(), // Existing canonical run IDs need not equal the retried command ID.
    workspaceId: input.workspaceId,
    noteId: input.noteId,
    recordingId: input.recordingId,
    status: "queued",
    providerJobId: null,
    error: null,
    createdAt: recording.createdAt,
    updatedAt: recording.createdAt,
  };
  const local: LocalRecordingSession = {
    id: input.recordingId,
    noteId: input.noteId,
    userId: identity.userId,
    workspaceId: input.workspaceId,
    status: "finalized",
    processing: "pending",
    mimeType: "audio/webm",
    byteCount: 100,
    chunkCount: 1,
    createdAt: recording.createdAt,
    updatedAt: recording.createdAt,
  };
  const options = recordingOverviewOptions(runtime, input.workspaceId, input.noteId);
  const owned = () => runtime === getQueryRuntime();
  const view = (overrides: Partial<Parameters<typeof recordingProcessingView>[0]> = {}) => {
    const state = runtime.queryClient.getQueryState(options.queryKey);
    return recordingProcessingView({
      run: state?.data?.runs.find((item) => item.recordingId === recording.id),
      recording: state?.data?.recordings[0],
      local,
      job: useProcessingJobs.getState().jobs[key],
      loaded: !!state?.data,
      loading: state?.status === "pending",
      dataUpdatedAt: state?.dataUpdatedAt ?? 0,
      statusError: state?.error?.message,
      mutationPending: false,
      mutationError: undefined,
      ...overrides,
    });
  };
  return {
    runtime,
    input,
    key,
    recording,
    run,
    local,
    options,
    view,
    submit: () => submitRecordingProcessing(runtime, input, key, owned),
    switchAccount() {
      identity = { userId: randomUUID(), workspaceId: randomUUID(), epoch: 2 };
      return getQueryRuntime();
    },
    restore() {
      runtime.queryClient.clear();
      getQueryRuntime().queryClient.clear();
      configureQueryIdentity(() => null);
      useProcessingJobs.setState({ jobs: {} });
      globalThis.fetch = originalFetch;
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

void it("acknowledges before a delayed refresh, cancels the initial null read, and rejects its late completion", async () => {
  const f = fixture();
  const oldRead = deferred<Response>();
  const currentRead = deferred<Response>();
  const initialStarted = deferred<void>();
  const refreshStarted = deferred<void>();
  let reads = 0;
  let oldSignal: AbortSignal | null | undefined;
  globalThis.fetch = (url, init) => {
    const path = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (path.includes("processing.start")) {
      assert.equal(typeof init?.body, "string");
      assert.deepEqual(JSON.parse(init!.body as string), {
        workspaceId: f.input.workspaceId,
        noteId: f.input.noteId,
        command: { id: f.recording.id, recordingId: f.recording.id },
      });
      return Promise.resolve(response(f.run));
    }
    reads++;
    if (reads === 1) {
      oldSignal = init?.signal;
      initialStarted.resolve();
      return oldRead.promise;
    }
    refreshStarted.resolve();
    return currentRead.promise;
  };
  const observer = new QueryObserver(f.runtime.queryClient, f.options);
  const unsubscribe = observer.subscribe(() => {});
  try {
    await initialStarted.promise;
    const accepted = await f.submit();
    await refreshStarted.promise;
    assert.equal(accepted?.id, f.run.id);
    assert.equal(oldSignal?.aborted, true);
    assert.equal(useProcessingJobs.getState().jobs[f.key]?.busy, false);
    assert.equal(useProcessingJobs.getState().jobs[f.key]?.acceptance?.runId, f.run.id);
    assert.deepEqual(f.view(), { phase: "accepted", retryAction: null });
    assert.equal(f.runtime.queryClient.getQueryData(f.options.queryKey), undefined);

    const finished = f.runtime.queryClient.fetchQuery(f.options);
    currentRead.resolve(
      response({ recordings: [f.recording], runs: [{ ...f.run, status: "succeeded" }] }),
    );
    await finished;
    oldRead.resolve(response({ recordings: [], runs: [] }));
    await oldRead.promise;
    await Promise.resolve();
    assert.deepEqual(f.view(), { phase: "ready", retryAction: null });
  } finally {
    oldRead.resolve(response({ recordings: [], runs: [] }));
    currentRead.resolve(response({ recordings: [], runs: [] }));
    unsubscribe();
    f.restore();
  }
});

void it("keeps cached active evidence on a transient status error and exposes only status retry", async () => {
  const f = fixture();
  f.runtime.queryClient.setQueryData(f.options.queryKey, {
    recordings: [f.recording],
    runs: [{ ...f.run, status: "running" }],
  });
  globalThis.fetch = () => Promise.reject(new Error("Status temporarily unavailable"));
  const observer = new QueryObserver(f.runtime.queryClient, f.options);
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch();
    assert.equal(
      f.runtime.queryClient.getQueryData(f.options.queryKey)?.runs[0]?.status,
      "running",
    );
    assert.deepEqual(f.view(), { phase: "processing", retryAction: "status" });
  } finally {
    unsubscribe();
    f.restore();
  }
});

void it("does not overwrite server completion that arrives before start acknowledgement", async () => {
  const f = fixture();
  const start = deferred<Response>();
  const started = deferred<void>();
  globalThis.fetch = () => {
    started.resolve();
    return start.promise;
  };
  try {
    const work = f.submit();
    await started.promise;
    f.runtime.queryClient.setQueryData(f.options.queryKey, {
      recordings: [f.recording],
      runs: [{ ...f.run, status: "succeeded" }],
    });
    start.resolve(response(f.run));
    await work;
    assert.deepEqual(f.view(), { phase: "ready", retryAction: null });
    assert.equal(
      f.runtime.queryClient.getQueryData(f.options.queryKey)?.runs[0]?.status,
      "succeeded",
    );
  } finally {
    start.resolve(response(f.run));
    f.restore();
  }
});

void it("does not publish a late acknowledgement or refresh into a departed account", async () => {
  const f = fixture();
  const start = deferred<Response>();
  const started = deferred<void>();
  globalThis.fetch = () => {
    started.resolve();
    return start.promise;
  };
  try {
    const work = f.submit();
    await started.promise;
    const next = f.switchAccount();
    start.resolve(response(f.run));
    assert.equal(await work, undefined);
    await refreshRecordingProcessing(f.input, f.runtime);
    assert.equal(useProcessingJobs.getState().jobs[f.key]?.acceptance, undefined);
    assert.equal(f.runtime.queryClient.getQueryCache().getAll().length, 0);
    assert.equal(next.queryClient.getQueryCache().getAll().length, 0);
  } finally {
    start.resolve(response(f.run));
    f.restore();
  }
});

void it("treats a reloaded submitted manifest as recovery and never infers failure from an empty cache", () => {
  const f = fixture();
  try {
    const local = { ...f.local, processing: "submitted" as const };
    assert.deepEqual(f.view({ local, loading: true }), { phase: "loading", retryAction: null });
    assert.deepEqual(f.view({ local, loading: false, loaded: true }), {
      phase: "uncertain",
      retryAction: "status",
    });
    assert.deepEqual(f.view({ local, loading: false, statusError: "Offline" }), {
      phase: "uncertain",
      retryAction: "status",
    });
    const polling = recordingOverviewOptions(
      f.runtime,
      f.input.workspaceId,
      f.input.noteId,
      true,
      undefined,
      local.id,
    );
    const query = new QueryObserver(f.runtime.queryClient, polling).getCurrentQuery();
    assert.equal(typeof polling.refetchInterval, "function");
    if (typeof polling.refetchInterval !== "function") throw new Error("Missing polling policy");
    assert.equal(polling.refetchInterval(query), 4000);
    query.setData({ recordings: [f.recording], runs: [{ ...f.run, status: "succeeded" }] });
    assert.equal(polling.refetchInterval(query), false);
  } finally {
    f.restore();
  }
});

void it("accepts authoritative nonmonotonic recovery states without ranking statuses", () => {
  const f = fixture();
  try {
    for (const [status, phase] of [
      ["failed", "failed"],
      ["running", "processing"],
      ["submitted", "processing"],
      ["succeeded", "ready"],
    ] as const) {
      f.runtime.queryClient.setQueryData(f.options.queryKey, {
        recordings: [f.recording],
        runs: [{ ...f.run, status }],
      });
      assert.equal(f.view().phase, phase);
    }
  } finally {
    f.restore();
  }
});
