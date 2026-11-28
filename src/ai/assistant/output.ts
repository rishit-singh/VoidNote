import type { Streams } from "agents/streams";
import { z } from "zod";

import {
  ASSISTANT_OUTPUT_LEASE_MS,
  type AssistantOutputFrame,
  assistantOutputFrameSchema,
  type AssistantOutputScope,
  assistantOutputScopeSchema,
} from "../../contracts/assistant/output";
import type { AssistantExecution } from "./services";

const mintSchema = assistantOutputScopeSchema.extend({ actorId: z.string().min(1).max(256) });

const openSchema = assistantOutputScopeSchema.extend({
  ticket: z.string().regex(/^[a-f0-9]{64}$/),
});

const maxTextLength = 64_000;

const maxReplaySegments = 4_096;

const maxReplayBytes = 8 * 1024 * 1024;

const maxLeases = 64;

const maxReaders = 8;

const batchIntervalMs = 250;

const idleAuthorizationMs = 5_000;

type Lease = AssistantOutputScope & {
  actorId: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type OutputHost = {
  execution(scope: AssistantOutputScope): Promise<AssistantExecution>;
  text(scope: AssistantOutputScope, signal: AbortSignal): Promise<string | null>;
};

type NativeOutputHost = {
  streams: Streams;
  inspect(): Promise<{ requestId?: string | null; messageId?: string | null } | null>;
  streamInfo(requestId: string): { id: string } | null;
  flush(): void;
  message(id: string): Promise<{
    role: string;
    parts: readonly { type: string; text?: string }[];
  } | null>;
};

/** Think 0.24 / agents chat stores a string body or an array of string bodies
 * per durable segment. Decode only UI text; never forward the native protocol.
 * Reads stop at the captured durable cursor, with bounded work and output.
 */
export async function readAssistantOutputText(
  host: NativeOutputHost,
  signal: AbortSignal,
): Promise<string | null> {
  const persisted = async (messageId: string) => {
    const message = await host.message(messageId);

    return message?.role === "assistant"
      ? message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n")
          .slice(0, maxTextLength)
      : null;
  };

  const submission = await host.inspect();

  if (submission?.messageId) {
    return persisted(submission.messageId);
  }

  if (!submission?.requestId || signal.aborted) {
    return null;
  }

  host.flush();
  const info = host.streamInfo(submission.requestId);

  if (!info) {
    return null;
  }

  const status = await host.streams.status(info.id);

  if (!status?.cursor) {
    return null;
  }

  if (status.cursor > maxReplaySegments) {
    throw new Error("Assistant output replay exceeds limit.");
  }

  let text = "";

  let bytes = 0;

  let lastTextId: string | undefined;

  try {
    for await (const batch of host.streams.readBatches(info.id, { batchSize: 32, signal })) {
      for (const segment of batch) {
        if (segment.seq >= status.cursor) {
          break;
        }

        const bodies = Array.isArray(segment.chunk) ? segment.chunk : [segment.chunk];

        for (const body of bodies) {
          if (typeof body !== "string") {
            throw new Error("Unsupported native output segment.");
          }

          bytes += new TextEncoder().encode(body).byteLength;

          if (bytes > maxReplayBytes) {
            throw new Error("Assistant output replay exceeds limit.");
          }

          const chunk: unknown = JSON.parse(body);

          if (
            typeof chunk !== "object" ||
            chunk === null ||
            !("type" in chunk) ||
            chunk.type !== "text-delta" ||
            !("delta" in chunk) ||
            typeof chunk.delta !== "string" ||
            !("id" in chunk) ||
            typeof chunk.id !== "string"
          ) {
            continue;
          }

          if (lastTextId !== undefined && lastTextId !== chunk.id) {
            text += "\n";
          }

          lastTextId = chunk.id;
          text = (text + chunk.delta).slice(0, maxTextLength);

          if (text.length === maxTextLength) {
            return text;
          }
        }
      }

      if ((batch.at(-1)?.seq ?? -1) >= status.cursor - 1) {
        break;
      }
    }
  } catch (error) {
    // Native cutover atomically deletes the stream and saves its exact message.
    const current = await host.inspect();

    if (current?.messageId && !signal.aborted) {
      return persisted(current.messageId);
    }

    throw error;
  }

  const current = await host.inspect();

  return current?.messageId ? persisted(current.messageId) : text;
}

async function ticketHash(ticket: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket));

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Ephemeral, bounded capabilities. Eviction invalidates outstanding leases;
 * reconnect must obtain a fresh ticket through authenticated HTTP. Raw tickets
 * are never retained. No timers, observers or credentials survive expiry.
 */
export class AssistantOutput {
  #leases = new Map<string, Lease>();
  #readers = new Set<() => void>();

  private readonly host: OutputHost;

  constructor(host: OutputHost) {
    this.host = host;
  }

  async createLease(input: AssistantOutputScope & { actorId: string }) {
    const scope = mintSchema.parse(input);

    await this.#authorize(scope);

    if (this.#leases.size >= maxLeases) {
      throw new Error("Too many assistant output leases.");
    }

    const ticket = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    const hash = await ticketHash(ticket);

    // Recheck after the asynchronous digest so concurrent mints remain bounded.
    if (this.#leases.size >= maxLeases) {
      throw new Error("Too many assistant output leases.");
    }

    const expiresAt = Date.now() + ASSISTANT_OUTPUT_LEASE_MS;

    const timer = setTimeout(() => this.#leases.delete(hash), ASSISTANT_OUTPUT_LEASE_MS);

    this.#leases.set(hash, { ...scope, expiresAt, timer });

    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  async open(
    input: AssistantOutputScope & { ticket: string },
  ): Promise<ReadableStream<Uint8Array>> {
    const scope = openSchema.parse(input);

    const hash = await ticketHash(scope.ticket);

    const lease = this.#leases.get(hash);

    // Consume before any await. Concurrent opens cannot reuse this capability.
    this.#leases.delete(hash);

    if (lease) {
      clearTimeout(lease.timer);
    }

    if (
      !lease ||
      lease.expiresAt <= Date.now() ||
      lease.workspaceId !== scope.workspaceId ||
      lease.threadId !== scope.threadId ||
      lease.turnId !== scope.turnId
    ) {
      throw new Error("Assistant output ticket is unavailable.");
    }

    await this.#authorize(lease);

    if (lease.expiresAt <= Date.now() || this.#readers.size >= maxReaders) {
      throw new Error("Assistant output lease is unavailable.");
    }

    const abort = new AbortController();

    let controller: ReadableStreamDefaultController<Uint8Array>;

    let closed = false;

    let running = false;

    let dirty = false;

    let lastBatchAt = 0;

    let previousText: string | null = null;

    let timer: ReturnType<typeof setTimeout> | undefined;

    let deadline: ReturnType<typeof setTimeout> | undefined;

    const close = () => {
      if (closed) {
        return;
      }

      closed = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      this.#readers.delete(wake);
      abort.abort();
      controller.close();
    };

    const enqueue = (frame: AssistantOutputFrame) => {
      controller.enqueue(
        new TextEncoder().encode(`${JSON.stringify(assistantOutputFrameSchema.parse(frame))}\n`),
      );
    };

    const schedule = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void pump(), delay);
    };

    const wake = () => {
      if (closed) {
        return;
      }

      dirty = true;

      if (!running) {
        schedule(Math.max(0, lastBatchAt + batchIntervalMs - Date.now()));
      }
    };

    const pump = async () => {
      if (closed || running) {
        return;
      }

      if (Date.now() >= lease.expiresAt) {
        return close();
      }

      // Never accumulate snapshots for a stalled reader; the next pull replays
      // the latest replacement, while the independent deadline still closes it.
      if ((controller.desiredSize ?? 0) <= 0) {
        return;
      }

      running = true;
      dirty = false;

      try {
        const text = await this.host.text(lease, abort.signal);

        const execution = await this.#authorize(lease);

        // Authorization is immediately before this batch, including after
        // native replay/cutover awaits. Failed SQL publication drops provisional
        // text; only SQL terminal status can declare success.
        if (closed || Date.now() >= lease.expiresAt) {
          return close();
        }

        const status = execution.turn.status;

        const terminal =
          status === "succeeded" ||
          status === "failed" ||
          status === "cancelled" ||
          status === "interrupted";

        if ((!terminal || status === "succeeded") && text !== null && text !== previousText) {
          enqueue({ type: "snapshot", turnId: lease.turnId, text });
          previousText = text;
        }

        if (terminal) {
          enqueue({ type: "terminal", turnId: lease.turnId, status });
          close();
        }
      } catch {
        // Revocation, unavailable authorization and unsupported native formats
        // fail closed, without publishing an invented SQL status.
        close();
      } finally {
        running = false;
        lastBatchAt = Date.now();

        if (!closed) {
          schedule(dirty ? batchIntervalMs : idleAuthorizationMs);
        }
      }
    };

    return new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
        this.#readers.add(wake);
        deadline = setTimeout(close, Math.max(0, lease.expiresAt - Date.now()));
        wake();
      },
      pull: wake,
      cancel: () => {
        // The stream has already been cancelled; cleanup must not close twice.
        closed = true;
        clearTimeout(timer);
        clearTimeout(deadline);
        this.#readers.delete(wake);
        abort.abort();
      },
    });
  }

  wake(): void {
    for (const wake of this.#readers) {
      wake();
    }
  }

  async #authorize(scope: AssistantOutputScope & { actorId: string }) {
    const execution = await this.host.execution(scope);

    if (
      execution.principal.id !== scope.actorId ||
      execution.thread.id !== scope.threadId ||
      execution.turn.threadId !== scope.threadId ||
      execution.turn.id !== scope.turnId
    ) {
      throw new Error("Assistant output is no longer authorized.");
    }

    return execution;
  }
}
