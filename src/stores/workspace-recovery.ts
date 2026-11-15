import { z } from "zod";
import { createStore } from "zustand/vanilla";
import { persist, type PersistStorage } from "zustand/middleware";
import {
  deleteSchema,
  idSchema,
  saveNoteSchema,
  savePersonSchema,
  type Session,
} from "@/contracts/workspace";

const generation = z.number().int().nonnegative();
export const pendingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), command: saveNoteSchema, generation }),
  z.object({ kind: z.literal("person"), command: savePersonSchema, generation }),
  z.object({ kind: z.literal("delete"), command: deleteSchema, generation }),
]);
const editSchema = z.object({
  baseRevision: generation,
  generation,
  dirty: z.boolean(),
  pending: pendingSchema.nullable(),
  conflict: generation.nullable(),
});
const noteDraft = z.object({
  id: idSchema,
  title: z.string(),
  transcript: z.string(),
  createdAt: z.iso.datetime({ offset: true }).nullable(),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
  recordingSessionId: z.string().nullable(),
});
const personDraft = z.object({ id: idSchema, displayName: z.string(), description: z.string() });
const entrySchema = z
  .discriminatedUnion("entity", [
    z.object({ entity: z.literal("note"), draft: noteDraft, edit: editSchema }),
    z.object({ entity: z.literal("person"), draft: personDraft, edit: editSchema }),
  ])
  .refine(
    (entry) =>
      !entry.edit.pending ||
      (entry.edit.pending.command.id === entry.draft.id &&
        (entry.edit.pending.kind === "delete" || entry.edit.pending.kind === entry.entity)),
  );
const recoverySchema = z.object({
  userId: idSchema,
  workspaceId: idSchema,
  entries: z.array(entrySchema),
});
export type RecoveryEntry = z.infer<typeof entrySchema>;

export type RecoveryHydration = "idle" | "loading" | "ready" | "error";

/** Validate a recovery snapshot with bounded work and retain input order. */
export async function validateRecoveryEntries<T>(
  entries: RecoveryEntry[],
  validate: (entry: RecoveryEntry) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (next < entries.length) {
        const index = next++;
        try {
          results[index] = { status: "fulfilled", value: await validate(entries[index]!) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}

// One persist store/key per verified account/workspace. No session, projections,
// audio blobs, object URLs, or credentials enter this store.
export function workspaceRecovery(session: Session) {
  const scope = { userId: session.user.id, workspaceId: session.workspace.id };
  const storage: PersistStorage<z.infer<typeof recoverySchema>> = {
    getItem(name) {
      const raw = localStorage.getItem(name);
      if (!raw) return null;
      const value = z
        .object({ version: z.literal(1), state: recoverySchema })
        .parse(JSON.parse(raw) as unknown);
      if (value.state.userId !== scope.userId || value.state.workspaceId !== scope.workspaceId)
        throw new Error("Recovery belongs to another account or workspace.");
      return value;
    },
    setItem(name, value) {
      localStorage.setItem(name, JSON.stringify(value));
    },
    removeItem(name) {
      localStorage.removeItem(name);
    },
  };
  let hydrationError: unknown;
  const store = createStore<z.infer<typeof recoverySchema>>()(
    persist<z.infer<typeof recoverySchema>>(() => ({ ...scope, entries: [] }), {
      name: `voidnote:recovery:v1:${scope.userId}:${scope.workspaceId}`,
      version: 1,
      storage,
      skipHydration: true,
      merge: (saved, current) =>
        saved === undefined ? current : { ...current, ...recoverySchema.parse(saved) },
      onRehydrateStorage: () => (_state, error) => {
        hydrationError = error;
      },
    }),
  );
  let readFlight: Promise<RecoveryEntry[]> | null = null;
  return {
    read() {
      if (readFlight) return readFlight;
      const task = (async () => {
        hydrationError = undefined;
        await store.persist.rehydrate();
        if (hydrationError)
          throw hydrationError instanceof Error
            ? hydrationError
            : new Error("Draft recovery failed to hydrate.");
        return store.getState().entries;
      })().finally(() => {
        if (readFlight === task) readFlight = null;
      });
      readFlight = task;
      return task;
    },
    write(entries: RecoveryEntry[]) {
      store.setState(recoverySchema.parse({ ...scope, entries }));
    },
    discard() {
      store.persist.clearStorage();
    },
  };
}
