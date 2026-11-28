"use client";

import { useEffect, useMemo, useState } from "react";

import {
  ASSISTANT_OUTPUT_LEASE_MS,
  ASSISTANT_OUTPUT_PROTOCOL,
  assistantOutputFrameSchema,
  assistantOutputLeaseSchema,
  type AssistantOutputScope,
  type AssistantTurn,
} from "@/contracts/assistant";
import { ApiError, asApiError } from "@/lib/api-error";
import { getQueryRuntime } from "@/lib/query-runtime";
import {
  isAssistantTurnActive,
  refreshAssistantOutput,
  requestAssistantOutputLease,
} from "@/queries/assistant";

const outputPolicy = {
  maxFrameCharacters: 400_000, // Includes worst-case JSON escaping of a 64,000-character snapshot.
  maxConnections: 24,
  maxConsecutiveFailures: 3,
  reconnectDelayMs: 1_000,
  maxReconnectDelayMs: 8_000,
  maxSessionMs: 10 * 60_000,
} as const;

type OutputHandlers = {
  message: (data: unknown) => void;
  error: () => void;
  close: () => void;
};
type OutputConnection = { close: () => void };
type OutputLease = ReturnType<typeof assistantOutputLeaseSchema.parse>;
type OutputSession = {
  scope: AssistantOutputScope;
  origin: string;
  lease: () => Promise<OutputLease>;
  connect: (url: string, protocols: string[], handlers: OutputHandlers) => OutputConnection;
  schedule: (callback: () => void, milliseconds: number) => () => void;
  now: () => number;
  isCurrent: () => boolean;
  onText: (text: string | null) => void;
  onTerminal: () => void | Promise<void>;
};

/**
 * One disposable, read-only socket resource. The only view data is a bounded
 * replacement snapshot; there is no message cache, send command or replay path.
 * Exported for deterministic lifecycle tests with injected transports/timers.
 */
export function observeAssistantOutput(session: OutputSession) {
  let stopped = false;
  let sequence = 0;
  let connections = 0;
  let failures = 0;
  let socket: OutputConnection | null = null;
  let cancelLeaseTimer: (() => void) | null = null;
  let cancelReconnect: (() => void) | null = null;
  let cancelSessionTimer: (() => void) | null = null;
  const current = () => !stopped && session.isCurrent();

  const disconnect = () => {
    sequence++;
    cancelLeaseTimer?.();
    cancelLeaseTimer = null;
    const previous = socket;
    socket = null;
    previous?.close();
  };
  const stop = () => {
    stopped = true;
    cancelReconnect?.();
    cancelReconnect = null;
    cancelSessionTimer?.();
    cancelSessionTimer = null;
    disconnect();
  };
  const fallback = () => {
    if (current()) session.onText(null);
    stop();
  };
  const reconnect = (failed: boolean) => {
    if (!current()) {
      stop();
      return;
    }
    session.onText(null);
    disconnect();
    if (failed) failures++;
    else failures = 0;
    if (
      connections >= outputPolicy.maxConnections ||
      failures >= outputPolicy.maxConsecutiveFailures
    ) {
      stop();
      return;
    }
    const delay = Math.min(
      outputPolicy.reconnectDelayMs * 2 ** Math.max(0, failures - 1),
      outputPolicy.maxReconnectDelayMs,
    );
    cancelReconnect = session.schedule(() => {
      cancelReconnect = null;
      void connect();
    }, delay);
  };
  const connect = async () => {
    if (!current()) {
      stop();
      return;
    }
    connections++;
    const attempt = ++sequence;
    const ownsConnection = () => {
      if (!current()) {
        stop();
        return false;
      }
      return sequence === attempt;
    };
    try {
      const lease = assistantOutputLeaseSchema.parse(await session.lease());
      if (!ownsConnection()) return;
      const remaining = Math.min(
        Date.parse(lease.expiresAt) - session.now(),
        ASSISTANT_OUTPUT_LEASE_MS,
      );
      if (remaining <= 0) {
        reconnect(true);
        return;
      }
      const expiresAt = session.now() + remaining;
      const url = new URL("/api/assistant/output", session.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.search = new URLSearchParams(session.scope).toString();
      const connection = session.connect(url.href, [ASSISTANT_OUTPUT_PROTOCOL, lease.ticket], {
        message: (data) => {
          if (!ownsConnection()) return;
          if (typeof data !== "string" || data.length > outputPolicy.maxFrameCharacters) {
            fallback();
            return;
          }
          let value: unknown;
          try {
            value = JSON.parse(data) as unknown;
          } catch {
            fallback();
            return;
          }
          const parsed = assistantOutputFrameSchema.safeParse(value);
          if (!parsed.success) {
            fallback();
            return;
          }
          const frame = parsed.data;
          if (frame.turnId !== session.scope.turnId) return;
          if (frame.type === "snapshot") {
            failures = 0;
            session.onText(frame.text || null);
            return;
          }
          if (frame.status !== "succeeded") session.onText(null);
          // Even "succeeded" remains provisional until the SQL history publishes.
          stop();
          if (session.isCurrent()) {
            void Promise.resolve(session.onTerminal()).catch(() => {});
          }
        },
        error: () => {
          if (ownsConnection()) reconnect(true);
        },
        close: () => {
          if (ownsConnection()) reconnect(session.now() < expiresAt);
        },
      });
      if (!ownsConnection()) {
        connection.close();
        return;
      }
      socket = connection;
      cancelLeaseTimer = session.schedule(() => {
        if (ownsConnection()) reconnect(false);
      }, remaining);
    } catch (error) {
      if (!ownsConnection()) return;
      const failure = asApiError(error);
      if (failure instanceof ApiError && (failure.status < 500 || failure.status === 501)) {
        // Disabled/unauthorized output simply leaves the existing SQL polling UI.
        fallback();
      } else {
        reconnect(true);
      }
    }
  };

  cancelSessionTimer = session.schedule(fallback, outputPolicy.maxSessionMs);
  void connect();
  return stop;
}

function connectBrowserOutput(url: string, protocols: string[], handlers: OutputHandlers) {
  const socket = new WebSocket(url, protocols);
  const message = (event: MessageEvent<unknown>) => handlers.message(event.data);
  socket.addEventListener("message", message);
  socket.addEventListener("error", handlers.error);
  socket.addEventListener("close", handlers.close);
  return {
    close: () => {
      socket.removeEventListener("message", message);
      socket.removeEventListener("error", handlers.error);
      socket.removeEventListener("close", handlers.close);
      socket.close();
    },
  };
}

export function useAssistantOutput({
  workspaceId,
  noteId,
  threadId,
  activeTurn,
  disabled,
}: {
  workspaceId: string;
  noteId: string;
  threadId: string;
  activeTurn: AssistantTurn | null | undefined;
  disabled: boolean;
}) {
  const runtime = getQueryRuntime();
  const turnId = activeTurn?.id;
  const active = isAssistantTurnActive(activeTurn) && activeTurn?.threadId === threadId;
  // Owner identity also changes when disabled and re-enabled for the same turn.
  // Old text is hidden synchronously during render, before effect cleanup runs.
  const owner = useMemo(
    () =>
      active && turnId && !disabled && runtime.identity?.workspaceId === workspaceId
        ? { runtime, noteId, scope: { workspaceId, threadId, turnId } }
        : null,
    [active, disabled, noteId, runtime, threadId, turnId, workspaceId],
  );
  const [snapshot, setSnapshot] = useState<{
    owner: NonNullable<typeof owner>;
    text: string | null;
  } | null>(null);

  useEffect(() => {
    if (!owner || typeof WebSocket === "undefined") return;
    return observeAssistantOutput({
      scope: owner.scope,
      origin: window.location.origin,
      lease: () => requestAssistantOutputLease(owner.scope, owner.runtime),
      connect: connectBrowserOutput,
      schedule: (callback, milliseconds) => {
        const timer = window.setTimeout(callback, milliseconds);
        return () => window.clearTimeout(timer);
      },
      now: Date.now,
      isCurrent: () => getQueryRuntime() === owner.runtime,
      onText: (text) => setSnapshot({ owner, text }),
      onTerminal: () =>
        refreshAssistantOutput({ ...owner.scope, noteId: owner.noteId }, owner.runtime),
    });
  }, [owner]);

  return owner && snapshot?.owner === owner ? snapshot.text : null;
}
