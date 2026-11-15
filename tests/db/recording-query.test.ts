/// <reference lib="dom" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { QueryClient, QueryObserver, skipToken } from "@tanstack/react-query";
import { createTRPCClient, httpLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type { AppRouter } from "../../src/server/trpc/router";
import type { ProcessingRun } from "../../src/contracts/recording-processing";
import {
  recordingOverviewOptions,
  beginProcessingRetryObservation,
  settleProcessingRetryObservation,
  processingJobKey,
  useProcessingJobs,
} from "../../src/lib/recording-processing-client";

const workspaceId = randomUUID();
const noteId = randomUUID();
const empty = { recordings: [], runs: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(transport: NonNullable<Parameters<typeof httpLink>[0]["fetch"]>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const client = createTRPCClient<AppRouter>({
    links: [httpLink({ url: "https://test.invalid/api/trpc", fetch: transport })],
  });
  const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient });
  return { queryClient, trpc };
}
const response = () => Response.json({ result: { data: empty } });

function retryFixture(status: "failed" | "submission_unknown" = "failed") {
  const userId = randomUUID();
  const key = processingJobKey(1, userId, workspaceId, noteId);
  const run: ProcessingRun = {
    id: randomUUID(),
    workspaceId,
    noteId,
    recordingId: randomUUID(),
    status,
    providerJobId: null,
    error: "Previous attempt needs attention",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
  };
  const runtime = fixture(() =>
    Promise.resolve(Response.json({ result: { data: { recordings: [], runs: [run] } } })),
  );
  return { key, userId, run, runtime };
}

void describe("shared recording query (no database)", () => {
  void it("deduplicates shell, playback and UI reads, including fresh remounts", async () => {
    let reads = 0;
    const pending = deferred<Response>();
    const runtime = fixture(() => {
      reads++;
      return pending.promise;
    });
    const options = recordingOverviewOptions(runtime, workspaceId, noteId);
    const observers = [true, false, false, false].map(
      (polling) =>
        new QueryObserver(
          runtime.queryClient,
          recordingOverviewOptions(runtime, workspaceId, noteId, polling),
        ),
    );
    const unsubscribers = observers.map((observer) => observer.subscribe(() => {}));
    const result = runtime.queryClient.fetchQuery(options);
    pending.resolve(response());
    assert.deepEqual(await result, empty);
    assert.equal(reads, 1);
    for (const observer of observers) assert.deepEqual(observer.getCurrentResult().data, empty);
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    const remounted = new QueryObserver(runtime.queryClient, options);
    const unsubscribe = remounted.subscribe(() => {});
    assert.equal(reads, 1);
    unsubscribe();
    runtime.queryClient.clear();
  });

  void it("only the shell polls active runs and stops on terminal or attention states", () => {
    const runtime = fixture(() => Promise.resolve(response()));
    const ui = recordingOverviewOptions(runtime, workspaceId, noteId);
    const shell = recordingOverviewOptions(runtime, workspaceId, noteId, true);
    const query = new QueryObserver(runtime.queryClient, shell).getCurrentQuery();
    assert.equal(ui.refetchInterval, false);
    assert.equal(typeof shell.refetchInterval, "function");
    if (typeof shell.refetchInterval !== "function") throw new Error("Missing polling policy");
    assert.equal(shell.refetchInterval(query), false);
    const run: ProcessingRun = {
      id: randomUUID(),
      workspaceId,
      noteId,
      recordingId: randomUUID(),
      status: "queued",
      providerJobId: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    for (const status of ["queued", "submitting", "submitted", "running"] as const) {
      query.setData({ recordings: [], runs: [{ ...run, status }] });
      assert.equal(shell.refetchInterval(query), 4000);
    }
    for (const status of ["succeeded", "failed", "blocked", "submission_unknown"] as const) {
      query.setData({ recordings: [], runs: [{ ...run, status }] });
      assert.equal(shell.refetchInterval(query), false);
    }
    assert.equal(
      recordingOverviewOptions(runtime, workspaceId, undefined, true).queryFn,
      skipToken,
    );
    runtime.queryClient.clear();
  });

  void it("invalidates one note without refetching unrelated recordings", async () => {
    let reads = 0;
    const runtime = fixture(() => {
      reads++;
      return Promise.resolve(response());
    });
    const options = recordingOverviewOptions(runtime, workspaceId, noteId);
    const other = recordingOverviewOptions(runtime, workspaceId, randomUUID());
    await Promise.all([
      runtime.queryClient.fetchQuery(options),
      runtime.queryClient.fetchQuery(other),
    ]);
    const unsubscribers = [options, other].map((input) =>
      new QueryObserver(runtime.queryClient, input).subscribe(() => {}),
    );
    await runtime.queryClient.invalidateQueries({ queryKey: options.queryKey, exact: true });
    assert.equal(reads, 3);
    assert.equal(runtime.queryClient.getQueryState(other.queryKey)?.isInvalidated, false);
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    runtime.queryClient.clear();
  });

  void it("cancels a departed note read and rejects its late response", async () => {
    const pending = deferred<Response>();
    const started = deferred<AbortSignal>();
    const runtime = fixture((_url, init) => {
      assert.ok(init?.signal);
      started.resolve(init.signal);
      return pending.promise;
    });
    const options = recordingOverviewOptions(runtime, workspaceId, noteId);
    const observer = new QueryObserver(runtime.queryClient, options);
    const unsubscribe = observer.subscribe(() => {});
    const signal = await started.promise;
    const completion = runtime.queryClient.fetchQuery(options);
    unsubscribe();
    assert.equal(signal.aborted, true);
    pending.resolve(response());
    await assert.rejects(completion);
    assert.equal(runtime.queryClient.getQueryData(options.queryKey), undefined);
    runtime.queryClient.clear();
  });

  for (const status of ["failed", "submission_unknown"] as const) {
    void it(`keeps one shell polling when accepted retry still reads old ${status}`, async () => {
      const { key, run, runtime } = retryFixture(status);
      const acceptedAt = Date.now();
      const retry = beginProcessingRetryObservation(key, run, acceptedAt);
      assert.equal(retry.expiresAt, acceptedAt + 60_000);
      const options = recordingOverviewOptions(runtime, workspaceId, noteId, true, retry);
      const observer = new QueryObserver(runtime.queryClient, options);
      const unsubscribe = observer.subscribe(() => {});
      await runtime.queryClient.fetchQuery(options);
      const query = observer.getCurrentQuery();
      if (typeof options.refetchInterval !== "function") throw new Error("Missing polling policy");
      assert.equal(options.refetchInterval(query), 4000);
      assert.equal(
        recordingOverviewOptions(runtime, workspaceId, noteId, false, retry).refetchInterval,
        false,
      );
      assert.equal(settleProcessingRetryObservation(key, retry, query.state.data?.runs), false);
      assert.equal(useProcessingJobs.getState().jobs[key]?.retry, retry);
      assert.match(useProcessingJobs.getState().jobs[key]?.progress ?? "", /Waiting.*restart/);
      // Preserve authoritative server status throughout the restart observation window.
      assert.equal(query.state.data?.runs[0]?.status, status);

      query.setData({ recordings: [], runs: [{ ...run, status: "running" }] });
      assert.equal(settleProcessingRetryObservation(key, retry, query.state.data?.runs), true);
      assert.equal(useProcessingJobs.getState().jobs[key]?.retry, undefined);
      const settled = recordingOverviewOptions(runtime, workspaceId, noteId, true);
      if (typeof settled.refetchInterval !== "function") throw new Error("Missing polling policy");
      assert.equal(settled.refetchInterval(query), 4000);
      query.setData({ recordings: [], runs: [{ ...run, status: "succeeded" }] });
      assert.equal(settled.refetchInterval(query), false);
      unsubscribe();
      runtime.queryClient.clear();
    });
  }

  void it("settles fast terminal completions even when the active phase was never observed", () => {
    const { key, run } = retryFixture();
    const retry = beginProcessingRetryObservation(key, run);
    assert.equal(
      settleProcessingRetryObservation(key, retry, [
        { ...run, updatedAt: new Date().toISOString() },
      ]),
      true,
    );
    assert.equal(useProcessingJobs.getState().jobs[key]?.retry, undefined);
    assert.equal(useProcessingJobs.getState().jobs[key]?.error, null);
  });

  void it("bounds unchanged or unavailable retry observations and exposes an explicit retry error", () => {
    for (const available of [true, false]) {
      const { key, run, runtime } = retryFixture("submission_unknown");
      const retry = beginProcessingRetryObservation(key, run, Date.now() - 60_001);
      const options = recordingOverviewOptions(runtime, workspaceId, noteId, true, retry);
      const query = new QueryObserver(runtime.queryClient, options).getCurrentQuery();
      if (available) query.setData({ recordings: [], runs: [run] });
      if (typeof options.refetchInterval !== "function") throw new Error("Missing polling policy");
      assert.equal(options.refetchInterval(query), false);
      assert.equal(settleProcessingRetryObservation(key, retry, query.state.data?.runs), true);
      const job = useProcessingJobs.getState().jobs[key];
      assert.equal(job?.retry, undefined);
      assert.equal(job?.busy, false);
      assert.equal(job?.progress, null);
      assert.match(job?.error ?? "", /restart was not confirmed.*Retry/);
      runtime.queryClient.clear();
    }
  });

  void it("isolates account generations and ignores an older command's deadline", () => {
    const { key, userId, run, runtime } = retryFixture();
    const old = beginProcessingRetryObservation(key, run, Date.now() - 60_001);
    const current = beginProcessingRetryObservation(key, run);
    settleProcessingRetryObservation(key, old, undefined);
    assert.equal(useProcessingJobs.getState().jobs[key]?.retry, current);
    const nextKey = processingJobKey(2, userId, workspaceId, noteId);
    assert.equal(useProcessingJobs.getState().jobs[nextKey]?.retry, undefined);
    const nextOptions = recordingOverviewOptions(
      runtime,
      workspaceId,
      noteId,
      true,
      useProcessingJobs.getState().jobs[nextKey]?.retry,
    );
    const query = new QueryObserver(runtime.queryClient, nextOptions).getCurrentQuery();
    query.setData({ recordings: [], runs: [run] });
    if (typeof nextOptions.refetchInterval !== "function")
      throw new Error("Missing polling policy");
    assert.equal(nextOptions.refetchInterval(query), false);
    runtime.queryClient.clear();
  });
});
