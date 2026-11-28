/// <reference lib="dom" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";

import type {
  AssistantHistory,
  AssistantThread,
  AssistantTurn,
} from "../../src/contracts/assistant";
import type { ResearchBatch } from "../../src/contracts/research";
import { ApiError } from "../../src/lib/api-error";
import { configureQueryIdentity, getQueryRuntime } from "../../src/lib/query-runtime";
import {
  assistantArtifactsQueryOptions,
  assistantHistoryQueryOptions,
  cancelAssistantTurn,
  refreshAssistantOutput,
  requestAssistantTurn,
} from "../../src/queries/assistant";
import { runResearchCommand } from "../../src/queries/research";
import { pendingAssistant } from "../../src/stores/pending-assistant";
import { pendingResearch } from "../../src/stores/pending-research";

function fixture() {
  const descriptors = ["window", "localStorage", "sessionStorage"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
  });
  const scope = { userId: randomUUID(), workspaceId: randomUUID(), noteId: randomUUID() };
  let identity = { userId: scope.userId, workspaceId: scope.workspaceId, epoch: 1 };
  configureQueryIdentity(() => identity);
  const runtime = getQueryRuntime();
  const recovery = pendingAssistant(scope);
  const thread: AssistantThread = {
    id: randomUUID(),
    noteId: scope.noteId,
    title: "Current note",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const prepare = async (text = "What did we decide?") => {
    recovery.setDraft(text);
    return recovery.prepare(thread.id, recovery.read().draft.generation);
  };
  const turn = (id: string, status: AssistantTurn["status"] = "queued"): AssistantTurn => ({
    id,
    threadId: thread.id,
    status,
    error: null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  });
  return {
    scope,
    runtime,
    recovery,
    values,
    thread,
    prepare,
    turn,
    switchAccount() {
      identity = { userId: randomUUID(), workspaceId: randomUUID(), epoch: identity.epoch + 1 };
      return getQueryRuntime();
    },
    restore() {
      runtime.queryClient.clear();
      getQueryRuntime().queryClient.clear();
      configureQueryIdentity(() => null);
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

void it("lost acceptance replays the exact persisted payload after reload and preserves a newer draft", async () => {
  const f = fixture();
  try {
    const command = await f.prepare("  Summarize the decision.  ");
    const payloads: unknown[] = [];
    let attempts = 0;
    const dependencies = {
      getRuntime: getQueryRuntime,
      open: () => Promise.resolve(f.thread),
      send: (
        _runtime: typeof f.runtime,
        input: { workspaceId: string; threadId: string; turnId: string; text: string },
      ) => {
        assert.deepEqual(pendingAssistant(f.scope).read().pending, command);
        payloads.push(input);
        if (++attempts === 1) return Promise.reject(new Error("lost response after acceptance"));
        return Promise.resolve(f.turn(command.turnId));
      },
      notify: () => {},
    };
    await assert.rejects(requestAssistantTurn(command, dependencies), /lost response/);
    f.recovery.setDraft("A newer follow-up");
    const reloaded = pendingAssistant(f.scope);
    await requestAssistantTurn(reloaded.read().pending!, dependencies);
    assert.deepEqual(payloads, [
      {
        workspaceId: f.scope.workspaceId,
        threadId: f.thread.id,
        turnId: command.turnId,
        text: "Summarize the decision.",
      },
      payloads[0],
    ]);
    assert.equal(reloaded.read().pending, null);
    assert.equal(reloaded.read().draft.text, "A newer follow-up");
    const next = await reloaded.prepare(f.thread.id, reloaded.read().draft.generation);
    await reloaded.acknowledge(command);
    assert.equal(reloaded.read().pending?.turnId, next.turnId);
    assert.deepEqual(await reloaded.prepare(f.thread.id, "old-generation"), next);
  } finally {
    f.restore();
  }
});

void it("concurrent replay deduplicates; a late acceptance after account change updates neither cache nor outgoing recovery", async () => {
  const f = fixture();
  try {
    const command = await f.prepare();
    let sendCount = 0;
    let notifyCount = 0;
    let resolve!: (turn: AssistantTurn) => void;
    const dependencies = {
      getRuntime: getQueryRuntime,
      open: () => Promise.resolve(f.thread),
      send: () => {
        sendCount++;
        return new Promise<AssistantTurn>((done) => {
          resolve = done;
        });
      },
      notify: () => {
        notifyCount++;
      },
    };
    const first = requestAssistantTurn(command, dependencies);
    const second = requestAssistantTurn(command, dependencies);
    await new Promise((done) => setImmediate(done));
    assert.equal(sendCount, 1);
    const nextRuntime = f.switchAccount();
    resolve(f.turn(command.turnId));
    await Promise.all([first, second]);
    assert.equal(notifyCount, 0);
    assert.equal(f.runtime.queryClient.getQueryCache().getAll().length, 0);
    assert.equal(nextRuntime.queryClient.getQueryCache().getAll().length, 0);
    assert.equal(f.recovery.read().pending?.turnId, command.turnId);
    const other = pendingAssistant({ ...f.scope, userId: nextRuntime.identity!.userId });
    assert.equal(other.read().pending, null);
    assert.equal(other.read().draft.text, "");
    assert.throws(() => requestAssistantTurn(command, dependencies), /previous workspace session/);
  } finally {
    f.restore();
  }
});

void it("an account change while opening a thread prevents the send RPC", async () => {
  const f = fixture();
  try {
    const command = await f.prepare();
    let sent = false;
    await assert.rejects(
      requestAssistantTurn(command, {
        getRuntime: getQueryRuntime,
        open: () => {
          f.switchAccount();
          return Promise.resolve(f.thread);
        },
        send: () => {
          sent = true;
          return Promise.resolve(f.turn(command.turnId));
        },
        notify: () => {},
      }),
      /previous workspace session/,
    );
    assert.equal(sent, false);
    assert.equal(f.recovery.read().pending?.turnId, command.turnId);
  } finally {
    f.restore();
  }
});

void it("definite rejection survives reload and cannot revive on retry; newer typing is retained", async () => {
  const f = fixture();
  try {
    const command = await f.prepare();
    f.recovery.setDraft("Keep this draft");
    await assert.rejects(
      requestAssistantTurn(command, {
        getRuntime: getQueryRuntime,
        open: () => Promise.resolve(f.thread),
        send: () => Promise.reject(new ApiError("Assistant is disabled.", 409)),
        notify: () => {},
      }),
      /disabled/,
    );
    const reloaded = pendingAssistant(f.scope);
    assert.equal(reloaded.read().pending?.status, "rejected");
    await assert.rejects(requestAssistantTurn(command), /no longer pending/);
    reloaded.dismissRejected(command.turnId);
    assert.equal(reloaded.read().draft.text, "Keep this draft");
    assert.equal(reloaded.read().pending, null);
  } finally {
    f.restore();
  }
});

void it("corrupt or unavailable persistence blocks sending and leaves recoverable bytes untouched", async () => {
  const f = fixture();
  try {
    f.recovery.setDraft("Saved locally");
    const generation = f.recovery.read().draft.generation;
    const key = [...f.values.keys()][0]!;
    f.values.set(key, "{broken recovery");
    const reloaded = pendingAssistant(f.scope);
    assert.equal(reloaded.snapshot().status, "error");
    assert.equal(reloaded.snapshot(), reloaded.snapshot());
    await assert.rejects(reloaded.prepare(f.thread.id, generation));
    assert.equal(f.values.get(key), "{broken recovery");
    f.values.delete(key);
    f.recovery.setDraft("Retry persistence");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (storageKey: string) => f.values.get(storageKey) ?? null,
        setItem: () => {
          throw new Error("Storage full");
        },
      },
    });
    await assert.rejects(
      f.recovery.prepare(f.thread.id, f.recovery.read().draft.generation),
      /Storage full/,
    );
    assert.equal(f.recovery.read().pending, null);
  } finally {
    f.restore();
  }
});

void it("lost stop responses retain the exact cancellation across reload without touching a newer draft", async () => {
  const f = fixture();
  try {
    f.recovery.setDraft("Next question");
    const cancellation = { threadId: f.thread.id, turnId: randomUUID() };
    await assert.rejects(
      cancelAssistantTurn(f.scope, cancellation, {
        cancel: () => Promise.reject(new Error("Stop response lost")),
        notify: () => {},
      }),
      /Stop response lost/,
    );
    const recovered = pendingAssistant(f.scope).read().cancellation!;
    assert.deepEqual(recovered, cancellation);
    let sent: unknown;
    await cancelAssistantTurn(f.scope, recovered, {
      cancel: (_runtime, input) => {
        sent = input;
        return Promise.resolve(f.turn(input.turnId, "cancelled"));
      },
      notify: () => {},
    });
    assert.deepEqual(sent, { workspaceId: f.scope.workspaceId, turnId: cancellation.turnId });
    assert.equal(f.recovery.read().cancellation, null);
    assert.equal(f.recovery.read().draft.text, "Next question");
  } finally {
    f.restore();
  }
});

void it("research lost acceptance replays exact questions, URLs and pinned revisions while retaining newer input", async () => {
  const f = fixture();
  try {
    const scope = {
      userId: f.scope.userId,
      workspaceId: f.scope.workspaceId,
      personId: randomUUID(),
    };
    const recovery = pendingResearch(scope);
    recovery.setDraft({
      questions: "What is their current role?",
      urls: "https://example.test/person",
    });
    const command = recovery.prepare({
      kind: "request",
      input: {
        workspaceId: scope.workspaceId,
        requestId: randomUUID(),
        people: [
          {
            personId: scope.personId,
            expectedProfileRevision: 4,
            expectedContactRevision: 2,
            requestedFacts: [{ key: "role", question: "What is their current role?" }],
            sourceUrls: ["https://example.test/person"],
          },
        ],
      },
    });
    const batch: ResearchBatch = {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      status: "queued",
      items: [],
      createdAt: new Date().toISOString(),
    };
    const sent: unknown[] = [];
    let attempts = 0;
    const dependencies = {
      notify: () => {},
      execute: (_runtime: typeof f.runtime, operation: typeof command.operation) => {
        assert.deepEqual(pendingResearch(scope).read().pending, command);
        sent.push(operation);
        return ++attempts === 1
          ? Promise.reject(new Error("lost research response"))
          : Promise.resolve(batch);
      },
    };
    await assert.rejects(
      runResearchCommand(scope, command, dependencies),
      /lost research response/,
    );
    recovery.setDraft({
      questions: "Keep this newer question",
      urls: "https://example.test/newer",
    });
    const reloaded = pendingResearch(scope);
    await runResearchCommand(scope, reloaded.read().pending!, dependencies);
    assert.deepEqual(sent, [command.operation, command.operation]);
    assert.equal(reloaded.read().pending, null);
    assert.equal(reloaded.read().draft.questions, "Keep this newer question");
    const retry = reloaded.prepare({
      kind: "retry",
      input: {
        workspaceId: scope.workspaceId,
        batchId: batch.id,
        personId: scope.personId,
        requestId: randomUUID(),
        expectedGeneration: 3,
      },
    });
    reloaded.acknowledge(command);
    assert.deepEqual(pendingResearch(scope).read().pending, retry);
  } finally {
    f.restore();
  }
});

void it("a late research acknowledgement after account change cannot erase outgoing recovery or populate the new account", async () => {
  const f = fixture();
  try {
    const scope = {
      userId: f.scope.userId,
      workspaceId: f.scope.workspaceId,
      personId: randomUUID(),
    };
    const recovery = pendingResearch(scope);
    const batchId = randomUUID();
    const command = recovery.prepare({
      kind: "cancel",
      input: { workspaceId: scope.workspaceId, batchId },
    });
    let resolve!: (batch: ResearchBatch) => void;
    let notifications = 0;
    const flight = runResearchCommand(scope, command, {
      execute: () =>
        new Promise<ResearchBatch>((done) => {
          resolve = done;
        }),
      notify: () => {
        notifications++;
      },
    });
    const runtime = f.switchAccount();
    resolve({
      id: batchId,
      workspaceId: scope.workspaceId,
      status: "cancelled",
      items: [],
      createdAt: new Date().toISOString(),
    });
    await flight;
    assert.equal(notifications, 0);
    assert.equal(recovery.read().pending?.id, command.id);
    assert.equal(
      pendingResearch({ ...scope, userId: runtime.identity!.userId }).read().pending,
      null,
    );
    assert.throws(() => runResearchCommand(scope, command), /previous workspace session/);
  } finally {
    f.restore();
  }
});

void it("socket terminal refresh cancels and invalidates only its generated history and note-artifact keys", async () => {
  const f = fixture();
  try {
    const { trpc, queryClient } = f.runtime;
    const history = trpc.assistant.history.infiniteQueryKey({
      workspaceId: f.scope.workspaceId,
      threadId: f.thread.id,
      limit: 30,
    });
    const otherHistory = trpc.assistant.history.infiniteQueryKey({
      workspaceId: f.scope.workspaceId,
      threadId: randomUUID(),
      limit: 30,
    });
    const artifacts = trpc.assistant.artifacts.queryKey({
      workspaceId: f.scope.workspaceId,
      noteId: f.scope.noteId,
    });
    const otherArtifacts = trpc.assistant.artifacts.queryKey({
      workspaceId: f.scope.workspaceId,
      noteId: randomUUID(),
    });
    queryClient.setQueryData(history, { pages: [], pageParams: [] });
    queryClient.setQueryData(otherHistory, { pages: [], pageParams: [] });
    queryClient.setQueryData(artifacts, []);
    queryClient.setQueryData(otherArtifacts, []);
    await refreshAssistantOutput(
      {
        workspaceId: f.scope.workspaceId,
        noteId: f.scope.noteId,
        threadId: f.thread.id,
        turnId: randomUUID(),
      },
      f.runtime,
    );
    assert.equal(queryClient.getQueryState(history)?.isInvalidated, true);
    assert.equal(queryClient.getQueryState(artifacts)?.isInvalidated, true);
    assert.equal(queryClient.getQueryState(otherHistory)?.isInvalidated, false);
    assert.equal(queryClient.getQueryState(otherArtifacts)?.isInvalidated, false);
  } finally {
    f.restore();
  }
});

for (const completion of ["artifact_create", "succeeded", "cancelled", "failed"] as const) {
  void it(`history fallback refreshes artifacts on ${completion} without an artifact timer or socket`, async () => {
    const f = fixture();
    const nativeFetch = globalThis.fetch;
    try {
      const { queryClient, trpc } = f.runtime;
      const options = assistantHistoryQueryOptions(f.scope.workspaceId, f.thread.id);
      const artifacts = assistantArtifactsQueryOptions(f.scope.workspaceId, f.scope.noteId);
      const otherArtifacts = trpc.assistant.artifacts.queryKey({
        workspaceId: f.scope.workspaceId,
        noteId: randomUUID(),
      });
      const turn = f.turn(randomUUID(), "running");
      const previous = {
        thread: f.thread,
        messages: [],
        activeTurn: turn,
        latestTurn: turn,
        nextCursor: null,
      } satisfies AssistantHistory;
      queryClient.setQueryData(options.queryKey, { pages: [previous], pageParams: [null] });
      queryClient.setQueryData(artifacts.queryKey, []);
      queryClient.setQueryData(otherArtifacts, []);
      const page: AssistantHistory =
        completion === "artifact_create"
          ? {
              ...previous,
              messages: [
                {
                  id: randomUUID(),
                  threadId: f.thread.id,
                  turnId: turn.id,
                  role: "assistant",
                  text: "",
                  tools: [
                    {
                      id: "created-artifact",
                      name: "artifact_create",
                      status: "succeeded",
                      summary: "Saved",
                      sources: [],
                    },
                  ],
                  sources: [],
                  createdAt: turn.createdAt,
                },
              ],
            }
          : { ...previous, activeTurn: null, latestTurn: f.turn(turn.id, completion) };
      globalThis.fetch = () => Promise.resolve(Response.json({ result: { data: page } }));

      await queryClient.fetchInfiniteQuery(options);
      await new Promise((done) => setImmediate(done));

      assert.equal(queryClient.getQueryState(artifacts.queryKey)?.isInvalidated, true);
      assert.equal(queryClient.getQueryState(otherArtifacts)?.isInvalidated, false);
      assert.deepEqual(queryClient.getQueryData(options.queryKey)?.pages[0], page);
    } finally {
      globalThis.fetch = nativeFetch;
      f.restore();
    }
  });
}
