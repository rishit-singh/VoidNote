"use client";
import { useEffect } from "react";

import { queryPolicy } from "@/config/query";
import { useNoteStore } from "@/stores/use-note-store";

/** Shell-owned timers keep saving the original note after navigation. */
export function useNoteAutosave() {
  useEffect(() => {
    const timers = new Map<
      string,
      { generation: number; epoch: number; timer: ReturnType<typeof setTimeout> }
    >();
    const check = () => {
      const state = useNoteStore.getState();
      for (const [id, task] of timers) {
        const edit = state.edits[`note:${id}`];
        if (
          task.epoch !== state.epoch ||
          !edit?.dirty ||
          edit.generation !== task.generation ||
          edit.saving ||
          edit.pending ||
          edit.error ||
          edit.conflict !== null
        ) {
          clearTimeout(task.timer);
          timers.delete(id);
        }
      }

      if (!state.session || state.status !== "ready") {
        return;
      }

      for (const note of state.notes) {
        const edit = state.edits[`note:${note.id}`];
        if (
          !edit?.dirty ||
          edit.saving ||
          edit.pending ||
          edit.error ||
          edit.conflict !== null ||
          timers.has(note.id)
        ) {
          continue;
        }

        const timer = setTimeout(() => {
          timers.delete(note.id);
          if (useNoteStore.getState().epoch === state.epoch) {
            void useNoteStore.getState().saveNote(note.id);
          }
        }, queryPolicy.titleAutosaveDelayMs);
        timers.set(note.id, { generation: edit.generation, epoch: state.epoch, timer });
      }
    };

    const unsubscribe = useNoteStore.subscribe(check);
    check();

    return () => {
      unsubscribe();
      timers.forEach(({ timer }) => clearTimeout(timer));
    };
  }, []);
}
