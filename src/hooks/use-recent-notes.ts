"use client";

import { useMemo } from "react";
import { useNoteStore } from "@/stores/use-note-store";
import { useNotesQuery } from "./use-workspace-queries";

/** Recent navigation is independent of the Home query, with current drafts taking precedence. */
export function useRecentNotes() {
  const query = useNotesQuery();
  const drafts = useNoteStore((state) => state.notes);
  const edits = useNoteStore((state) => state.edits);
  const unavailable = useNoteStore((state) => state.unavailable);
  return useMemo(() => {
    const notes = new Map(
      (query.data?.pages.flatMap((page) => page.items) ?? []).map((note) => [
        note.id,
        {
          id: note.id,
          title: note.title,
          updatedAt: note.updatedAt,
          deletedAt: note.deletedAt,
        },
      ]),
    );
    for (const note of drafts) {
      if (note.revision && !edits[`note:${note.id}`]?.dirty && !edits[`note:${note.id}`]?.pending)
        continue;
      notes.set(note.id, {
        id: note.id,
        title: note.title,
        updatedAt: note.updatedAt ?? "",
        deletedAt: note.deletedAt ?? null,
      });
    }
    return [...notes.values()]
      .filter((note) => !note.deletedAt && !unavailable[`note:${note.id}`])
      .sort(
        (a, b) =>
          (b.updatedAt || "~").localeCompare(a.updatedAt || "~") || b.id.localeCompare(a.id),
      )
      .slice(0, 5);
  }, [query.data, drafts, edits, unavailable]);
}
