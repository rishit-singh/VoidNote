import { z } from "zod";

import {
  requestResearchSchema,
  researchScopeSchema,
  retryResearchSchema,
} from "@/contracts/research";

const scopeSchema = z.object({ userId: z.uuid(), workspaceId: z.uuid(), personId: z.uuid() });
const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request"), input: requestResearchSchema }),
  z.object({ kind: z.literal("retry"), input: retryResearchSchema }),
  z.object({ kind: z.literal("cancel"), input: researchScopeSchema }),
]);
const commandSchema = z.object({
  id: z.uuid(),
  operation: operationSchema,
  status: z.enum(["pending", "rejected"]),
  rejection: z.string().max(1000).nullable(),
});
const savedSchema = scopeSchema.extend({
  version: z.literal(1),
  draft: z.object({ questions: z.string().max(5000), urls: z.string().max(10_000) }),
  pending: commandSchema.nullable(),
});
export type ResearchRecoveryScope = z.infer<typeof scopeSchema>;
export type ResearchOperation = z.infer<typeof operationSchema>;
export type PendingResearchCommand = z.infer<typeof commandSchema>;
type SavedResearch = z.infer<typeof savedSchema>;
type Snapshot =
  | { status: "loading"; saved: null; error: null }
  | { status: "ready"; saved: SavedResearch; error: null }
  | { status: "error"; saved: null; error: Error };
const serverSnapshot: Snapshot = { status: "loading", saved: null, error: null };
const listeners = new Map<string, Set<() => void>>();

function validateOwner(scope: ResearchRecoveryScope, command: PendingResearchCommand) {
  const { operation } = command;
  if (
    operation.input.workspaceId !== scope.workspaceId ||
    (operation.kind === "request" &&
      (operation.input.people.length !== 1 ||
        operation.input.people[0]?.personId !== scope.personId ||
        operation.input.requestId !== command.id)) ||
    (operation.kind === "retry" &&
      (operation.input.personId !== scope.personId || operation.input.requestId !== command.id))
  ) {
    throw new Error("Saved research belongs to a different contact.");
  }
}

/**
 * Tab-local v1 recovery, owned by a verified user/workspace/person. Only form drafts
 * and exact unacknowledged operations are saved. Reload resumes the original payload;
 * acknowledgement removes that operation alone and never rewrites the draft.
 * Changing accounts leaves outgoing recovery intact. Invalid hydration blocks writes.
 */
export function pendingResearch(input: ResearchRecoveryScope) {
  const scope = scopeSchema.parse(input);
  const key = `voidnote:research:v1:${scope.userId}:${scope.workspaceId}:${scope.personId}`;
  let cachedRaw: string | null | undefined;
  let cached: Snapshot = serverSnapshot;
  const snapshot = (): Snapshot => {
    if (typeof sessionStorage === "undefined") return serverSnapshot;
    try {
      const raw = sessionStorage.getItem(key);
      if (raw === cachedRaw && cached.status === "ready") return cached;
      if (raw && raw.length > 200_000) throw new Error("Saved research recovery is too large.");
      const saved = raw
        ? savedSchema.parse(JSON.parse(raw) as unknown)
        : savedSchema.parse({
            ...scope,
            version: 1,
            draft: { questions: "", urls: "" },
            pending: null,
          });
      if (
        saved.userId !== scope.userId ||
        saved.workspaceId !== scope.workspaceId ||
        saved.personId !== scope.personId
      ) {
        throw new Error("Saved research belongs to a previous account or contact.");
      }
      if (saved.pending) validateOwner(scope, saved.pending);
      cachedRaw = raw;
      cached = { status: "ready", saved, error: null };
    } catch (error) {
      if (cached.status !== "error") {
        cached = {
          status: "error",
          saved: null,
          error: error instanceof Error ? error : new Error("Research recovery is unavailable."),
        };
      }
    }
    return cached;
  };
  const read = () => {
    const result = snapshot();
    if (!result.saved) throw result.error ?? new Error("Research recovery is still loading.");
    return result.saved;
  };
  const write = (saved: SavedResearch) => {
    sessionStorage.setItem(key, JSON.stringify(savedSchema.parse(saved)));
    cachedRaw = undefined;
    for (const listener of listeners.get(key) ?? []) listener();
  };
  return {
    snapshot,
    serverSnapshot: () => serverSnapshot,
    read,
    subscribe: (listener: () => void) => {
      const current = listeners.get(key) ?? new Set<() => void>();
      current.add(listener);
      listeners.set(key, current);
      return () => {
        current.delete(listener);
        if (!current.size) listeners.delete(key);
      };
    },
    setDraft(draft: SavedResearch["draft"]) {
      write({ ...read(), draft });
    },
    prepare(operation: ResearchOperation) {
      const saved = read();
      if (saved.pending) return saved.pending;
      const pending = commandSchema.parse({
        id: operation.kind === "cancel" ? crypto.randomUUID() : operation.input.requestId,
        operation,
        status: "pending",
        rejection: null,
      });
      validateOwner(scope, pending);
      write({ ...saved, pending });
      return pending;
    },
    acknowledge(command: PendingResearchCommand) {
      const saved = read();
      if (saved.pending?.id === command.id) write({ ...saved, pending: null });
    },
    reject(command: PendingResearchCommand, reason: string) {
      const saved = read();
      if (saved.pending?.id === command.id) {
        write({
          ...saved,
          pending: { ...saved.pending, status: "rejected", rejection: reason.slice(0, 1000) },
        });
      }
    },
    dismissRejected(id: string) {
      const saved = read();
      if (saved.pending?.id === id && saved.pending.status === "rejected")
        write({ ...saved, pending: null });
    },
  };
}
