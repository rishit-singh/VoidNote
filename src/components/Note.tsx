"use client";
import type { NoteModel } from "@/lib/types";
import { NoteAudio } from "@/components/recording";

export function Note({ note }: { note: NoteModel; onUpdate: (note: NoteModel) => void }) {
  return <NoteAudio noteId={note.id} />;
}
