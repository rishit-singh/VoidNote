"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import type { StateStorage } from "zustand/middleware";
import { useNoteStore } from "@/stores/use-note-store";

const preferencesSchema = z
  .object({
    deviceId: z.string().min(1).default("default"),
    liveText: z.boolean().default(false),
    waveform: z.boolean().default(true),
  })
  .strict();
const persistedSchema = z.object({
  byOwner: z.record(z.string(), preferencesSchema),
});

export type RecordingPreferences = z.infer<typeof preferencesSchema>;
export const defaultRecordingPreferences: RecordingPreferences = {
  deviceId: "default",
  liveText: false,
  waveform: true,
};
export const recordingPreferenceKey = () => {
  const session = useNoteStore.getState().session;
  return session ? `${session.user.id}:${session.workspace.id}` : "";
};

type PersistenceStatus = "hydrating" | "ready" | "error" | "invalid";
type PreferencesState = {
  byOwner: Record<string, RecordingPreferences>;
  persistenceStatus: PersistenceStatus;
  persistenceError: string | null;
  update: (changes: Partial<RecordingPreferences>) => boolean;
  reset: () => boolean;
};

let isWritingStatusOnly = false;
let reportStorageFailure: (() => void) | null = null;
let reportStorageReadFailure: (() => void) | null = null;
const browserStorage: StateStorage = {
  getItem: (name) => localStorage.getItem(name),
  removeItem: (name) => localStorage.removeItem(name),
  setItem: (name, value) => {
    if (isWritingStatusOnly) return;
    try {
      localStorage.setItem(name, value);
    } catch {
      reportStorageFailure?.();
    }
  },
};

export const useRecordingPreferences = create<PreferencesState>()(
  persist(
    (set, get) => {
      const setPersistenceStatus = (status: PersistenceStatus, message: string | null) => {
        const current = get();
        if (current.persistenceStatus === status && current.persistenceError === message) return;
        isWritingStatusOnly = true;
        try {
          set({ persistenceStatus: status, persistenceError: message });
        } finally {
          isWritingStatusOnly = false;
        }
      };
      reportStorageFailure = () =>
        setPersistenceStatus("error", "Recording preferences could not be saved in this browser.");
      reportStorageReadFailure = () =>
        setPersistenceStatus("error", "Recording preferences could not be read from this browser.");

      const save = (byOwner: Record<string, RecordingPreferences>) => {
        set({ byOwner, persistenceStatus: "ready", persistenceError: null });
        return get().persistenceStatus !== "error";
      };

      return {
        byOwner: {},
        persistenceStatus: "hydrating",
        persistenceError: null,
        update: (changes) => {
          const key = recordingPreferenceKey();
          if (!key) return false;
          try {
            const next = preferencesSchema.parse({
              ...defaultRecordingPreferences,
              ...get().byOwner[key],
              ...changes,
            });
            return save({ ...get().byOwner, [key]: next });
          } catch (error) {
            setPersistenceStatus("error", errorMessage(error));
            return false;
          }
        },
        reset: () => {
          const key = recordingPreferenceKey();
          if (!key) return false;
          const byOwner = { ...get().byOwner };
          delete byOwner[key];
          return save(byOwner);
        },
      };
    },
    {
      name: "voidnote-recording-preferences-v1",
      storage: createJSONStorage(() => browserStorage),
      partialize: ({ byOwner }) => ({ byOwner }),
      merge: (persisted, current) => {
        if (persisted === undefined || persisted === null) {
          return { ...current, persistenceStatus: "ready", persistenceError: null };
        }
        const result = persistedSchema.safeParse(persisted);
        return result.success
          ? {
              ...current,
              byOwner: result.data.byOwner,
              persistenceStatus: "ready",
              persistenceError: null,
            }
          : {
              ...current,
              byOwner: {},
              persistenceStatus: "invalid",
              persistenceError: "Saved recording preferences were invalid and were reset.",
            };
      },
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          // Synchronous hydration can fail before Zustand assigns the initial state.
          queueMicrotask(() => reportStorageReadFailure?.());
        }
      },
    },
  ),
);

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Recording preferences could not be saved.";
}
