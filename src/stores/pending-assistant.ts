import { z } from "zod";

import { sendAssistantTurnSchema } from "@/contracts/assistant";

const MAX_SAVED_CHARACTERS = 256_000;
const scopeSchema = z.object({
  userId: z.uuid(),
  workspaceId: z.uuid(),
  noteId: z.uuid(),
});
const pendingSchema = sendAssistantTurnSchema.extend({
  userId: z.uuid(),
  noteId: z.uuid(),
  status: z.enum(["pending", "rejected"]),
  rejection: z.string().max(1000).nullable(),
});
const cancellationSchema = z.object({ threadId: z.uuid(), turnId: z.uuid() });
const savedSchema = scopeSchema.extend({
  version: z.literal(1),
  draft: z.object({ text: z.string().max(16_000), generation: z.string() }),
  pending: pendingSchema.nullable(),
  cancellation: cancellationSchema.nullable(),
});

export type AssistantRecoveryScope = z.infer<typeof scopeSchema>;
export type PendingAssistantTurn = z.infer<typeof pendingSchema>;
export type AssistantCancellation = z.infer<typeof cancellationSchema>;
type SavedAssistant = z.infer<typeof savedSchema>;
export type AssistantRecoverySnapshot =
  | { status: "loading"; saved: null; error: null }
  | { status: "ready"; saved: SavedAssistant; error: null }
  | { status: "error"; saved: null; error: Error };

const serverSnapshot: AssistantRecoverySnapshot = { status: "loading", saved: null, error: null };
const listeners = new Map<string, Set<() => void>>();

/**
 * Per-user/workspace/note v1 recovery. Only drafts and exact unacknowledged commands
 * are local; messages, threads and active runs belong to QueryClient.
 * Synchronous hydration never merges an older snapshot over a newer draft.
 * Failure blocks writes, and account changes leave outgoing recovery intact.
 */
export function pendingAssistant(scopeInput: AssistantRecoveryScope) {
  const scope = scopeSchema.parse(scopeInput);
  const key = `voidnote:assistant:v1:${scope.userId}:${scope.workspaceId}:${scope.noteId}`;
  let cachedRaw: string | null | undefined;
  let cached: AssistantRecoverySnapshot = serverSnapshot;
  const empty = (): SavedAssistant => ({
    ...scope,
    version: 1,
    draft: { text: "", generation: "" },
    pending: null,
    cancellation: null,
  });
  const snapshot = (): AssistantRecoverySnapshot => {
    if (typeof localStorage === "undefined") return serverSnapshot;
    try {
      const raw = localStorage.getItem(key);
      if (raw === cachedRaw && cached.status === "ready") return cached;
      if (raw && raw.length > MAX_SAVED_CHARACTERS) {
        throw new Error("Saved Assistant recovery is too large to open.");
      }
      const saved = raw ? savedSchema.parse(JSON.parse(raw) as unknown) : empty();
      if (
        saved.userId !== scope.userId ||
        saved.workspaceId !== scope.workspaceId ||
        saved.noteId !== scope.noteId ||
        (saved.pending &&
          (saved.pending.userId !== scope.userId ||
            saved.pending.workspaceId !== scope.workspaceId ||
            saved.pending.noteId !== scope.noteId))
      ) {
        throw new Error("Saved Assistant recovery belongs to a different account or note.");
      }
      cachedRaw = raw;
      cached = { status: "ready", saved, error: null };
    } catch (error) {
      // Cache errors too: useSyncExternalStore requires stable snapshot identity.
      if (cached.status !== "error") {
        cached = {
          status: "error",
          saved: null,
          error: error instanceof Error ? error : new Error("Assistant recovery is unavailable."),
        };
      }
    }
    return cached;
  };
  const read = () => {
    const result = snapshot();
    if (result.status !== "ready") {
      throw result.error ?? new Error("Assistant recovery is still loading.");
    }
    return result.saved;
  };
  const write = (saved: SavedAssistant) => {
    localStorage.setItem(key, JSON.stringify(savedSchema.parse(saved)));
    cachedRaw = undefined;
    for (const listener of listeners.get(key) ?? []) listener();
  };
  const exclusive = <T>(operation: () => T): Promise<T> => {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request(key, operation);
    }
    return Promise.resolve().then(operation);
  };

  return {
    snapshot,
    serverSnapshot: () => serverSnapshot,
    read,
    subscribe: (listener: () => void) => {
      const current = listeners.get(key) ?? new Set<() => void>();
      current.add(listener);
      listeners.set(key, current);
      const changed = (event: StorageEvent) => {
        if (event.key === key || event.key === null) listener();
      };
      window.addEventListener("storage", changed);
      return () => {
        current.delete(listener);
        if (!current.size) listeners.delete(key);
        window.removeEventListener("storage", changed);
      };
    },
    setDraft(text: string) {
      write({ ...read(), draft: { text, generation: crypto.randomUUID() } });
    },
    prepare(threadId: string, draftGeneration: string) {
      return exclusive(() => {
        const saved = read();
        if (saved.pending) return saved.pending;
        if (saved.cancellation) throw new Error("Wait for the stop request to finish.");
        if (saved.draft.generation !== draftGeneration) {
          throw new Error("Your draft changed. Please send it again.");
        }
        const pending = pendingSchema.parse({
          ...scope,
          threadId,
          turnId: crypto.randomUUID(),
          text: saved.draft.text,
          status: "pending",
          rejection: null,
        });
        // Persist the exact payload before any RPC. Clearing now cannot erase later typing.
        write({
          ...saved,
          pending,
          draft: { text: "", generation: crypto.randomUUID() },
        });
        return pending;
      });
    },
    acknowledge(command: PendingAssistantTurn) {
      return exclusive(() => {
        const saved = read();
        if (saved.pending?.turnId === command.turnId) write({ ...saved, pending: null });
      });
    },
    reject(command: PendingAssistantTurn, reason: string) {
      return exclusive(() => {
        const saved = read();
        if (saved.pending?.turnId === command.turnId) {
          write({
            ...saved,
            pending: { ...saved.pending, status: "rejected", rejection: reason.slice(0, 1000) },
          });
        }
      });
    },
    dismissRejected(turnId: string) {
      const saved = read();
      if (saved.pending?.turnId === turnId && saved.pending.status === "rejected") {
        write({ ...saved, pending: null });
      }
    },
    prepareCancellation(command: AssistantCancellation) {
      const saved = read();
      if (saved.cancellation) return saved.cancellation;
      const cancellation = cancellationSchema.parse(command);
      write({ ...saved, cancellation });
      return cancellation;
    },
    acknowledgeCancellation(command: AssistantCancellation) {
      return exclusive(() => {
        const saved = read();
        if (saved.cancellation?.turnId === command.turnId) {
          write({ ...saved, cancellation: null });
        }
      });
    },
  };
}
