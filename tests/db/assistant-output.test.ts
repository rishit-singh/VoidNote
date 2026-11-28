/// <reference lib="dom" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";

import { observeAssistantOutput } from "../../src/components/assistant/use-assistant-output";
import { ApiError } from "../../src/lib/api-error";

type OutputSession = Parameters<typeof observeAssistantOutput>[0];
type Handlers = Parameters<OutputSession["connect"]>[2];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(lease?: OutputSession["lease"]) {
  let now = Date.parse("2026-11-25T12:00:00.000Z");
  let timerId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const scope = { workspaceId: randomUUID(), threadId: randomUUID(), turnId: randomUUID() };
  const state = { text: null as string | null, leases: 0, terminals: 0, current: true };
  const texts: (string | null)[] = [];
  const sockets: { url: string; protocols: string[]; handlers: Handlers; closed: boolean }[] = [];
  const stop = observeAssistantOutput({
    scope,
    origin: "https://voidnote.example.test",
    lease: () => {
      state.leases++;
      return lease
        ? lease()
        : Promise.resolve({
            ticket: state.leases.toString(16).padStart(64, "0"),
            expiresAt: new Date(now + 30_000).toISOString(),
          });
    },
    connect: (url, protocols, handlers) => {
      const socket = { url, protocols, handlers, closed: false };
      sockets.push(socket);
      return {
        close: () => {
          socket.closed = true;
        },
      };
    },
    schedule: (callback, milliseconds) => {
      const id = ++timerId;
      timers.set(id, { at: now + milliseconds, callback });
      return () => {
        timers.delete(id);
      };
    },
    now: () => now,
    isCurrent: () => state.current,
    onText: (text) => {
      state.text = text;
      texts.push(text);
    },
    onTerminal: () => {
      state.terminals++;
    },
  });
  return {
    scope,
    state,
    texts,
    sockets,
    stop,
    timers,
    snapshot(text: string, socket = sockets.at(-1)!) {
      socket.handlers.message(JSON.stringify({ type: "snapshot", turnId: scope.turnId, text }));
    },
    terminal(
      status: "succeeded" | "failed" | "cancelled" | "interrupted",
      socket = sockets.at(-1)!,
    ) {
      socket.handlers.message(JSON.stringify({ type: "terminal", turnId: scope.turnId, status }));
    },
    async advance(milliseconds: number) {
      now += milliseconds;
      const due = [...timers].filter(([, timer]) => timer.at <= now);
      for (const [id, timer] of due) {
        if (timers.delete(id)) timer.callback();
      }
      await flush();
    },
  };
}

void it("output snapshots replace text; tickets stay in protocols and cannot become URL credentials", async () => {
  const f = fixture();
  try {
    await flush();
    assert.equal(f.sockets.length, 1);
    const socket = f.sockets[0]!;
    const url = new URL(socket.url);
    assert.equal(url.protocol, "wss:");
    assert.equal(url.pathname, "/api/assistant/output");
    assert.deepEqual(Object.fromEntries(url.searchParams), f.scope);
    assert.deepEqual(socket.protocols, ["voidnote-output-v1", "1".padStart(64, "0")]);
    f.snapshot("Earlier draft");
    f.snapshot("Replacement draft");
    assert.equal(f.state.text, "Replacement draft");
    socket.handlers.message(
      JSON.stringify({ type: "snapshot", turnId: randomUUID(), text: "Other turn" }),
    );
    assert.equal(f.state.text, "Replacement draft");
    assert.equal(f.state.terminals, 0);
  } finally {
    f.stop();
  }
});

void it("lease expiry reconnects with a fresh ticket and ignores late frames from the old connection", async () => {
  const f = fixture();
  try {
    await flush();
    const first = f.sockets[0]!;
    f.snapshot("Old provisional response");
    await f.advance(30_000);
    assert.equal(first.closed, true);
    assert.equal(f.state.text, null);
    await f.advance(1_000);
    assert.equal(f.state.leases, 2);
    assert.equal(f.sockets.length, 2);
    assert.notEqual(f.sockets[1]!.protocols[1], first.protocols[1]);
    f.snapshot("New connection snapshot");
    f.snapshot("Late old snapshot", first);
    f.terminal("failed", first);
    assert.equal(f.state.text, "New connection snapshot");
    assert.equal(f.state.terminals, 0);
    assert.equal(f.state.leases, 2);
  } finally {
    f.stop();
  }
});

void it("account changes and disposal suppress late frames and late lease completions", async () => {
  const f = fixture();
  try {
    await flush();
    f.snapshot("Original account draft");
    const changes = f.texts.length;
    f.state.current = false;
    f.snapshot("Late private output");
    f.terminal("succeeded");
    assert.equal(f.texts.length, changes);
    assert.equal(f.state.terminals, 0);
    assert.equal(f.sockets[0]!.closed, true);
    assert.equal(f.timers.size, 0);
  } finally {
    f.stop();
  }
  let resolve!: (lease: Awaited<ReturnType<OutputSession["lease"]>>) => void;
  const late = fixture(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  late.stop();
  resolve({ ticket: "a".repeat(64), expiresAt: "2026-11-25T12:00:30.000Z" });
  await flush();
  assert.equal(late.sockets.length, 0);
  assert.deepEqual(late.texts, []);
  assert.equal(late.timers.size, 0);
});

void it("terminal success only refreshes saved records; failure/cancellation/interruption discard the draft", async () => {
  for (const status of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
    const f = fixture();
    try {
      await flush();
      f.snapshot("Not yet saved");
      f.terminal(status);
      assert.equal(f.state.text, status === "succeeded" ? "Not yet saved" : null);
      assert.equal(f.state.terminals, 1);
      assert.equal(f.sockets[0]!.closed, true);
      f.snapshot("Late success text");
      f.terminal("succeeded");
      await f.advance(60_000);
      assert.equal(f.state.terminals, 1);
      assert.equal(f.state.leases, 1);
    } finally {
      f.stop();
    }
  }
});

void it("transport failures clear drafts and exhaust bounded retries; disabled leases fall back without sockets", async () => {
  const f = fixture();
  try {
    await flush();
    f.snapshot("Unsafe provisional response");
    f.sockets[0]!.handlers.error();
    assert.equal(f.state.text, null);
    await f.advance(1_000);
    f.sockets[1]!.handlers.error();
    await f.advance(2_000);
    f.sockets[2]!.handlers.error();
    await f.advance(60_000);
    assert.equal(f.state.leases, 3);
    assert.equal(
      f.sockets.every((socket) => socket.closed),
      true,
    );
    assert.equal(f.timers.size, 0);
  } finally {
    f.stop();
  }
  const disabled = fixture(() => Promise.reject(new ApiError("Output unavailable", 501)));
  await flush();
  assert.equal(disabled.state.leases, 1);
  assert.equal(disabled.sockets.length, 0);
  assert.equal(disabled.timers.size, 0);
  disabled.stop();
});

void it("oversized or malformed output fails closed without rendering unvalidated data", async () => {
  for (const data of ["{not-json", "x".repeat(400_001), { type: "snapshot" }]) {
    const f = fixture();
    try {
      await flush();
      f.snapshot("Prior text");
      f.sockets[0]!.handlers.message(data);
      assert.equal(f.state.text, null);
      assert.equal(f.sockets[0]!.closed, true);
      assert.equal(f.timers.size, 0);
    } finally {
      f.stop();
    }
  }
  const oversized = fixture();
  await flush();
  oversized.snapshot("x".repeat(64_001));
  assert.equal(oversized.state.text, null);
  assert.equal(oversized.sockets[0]!.closed, true);
  oversized.stop();
});
