import type { DeleteCommand, NoteRecord, Session } from "@/contracts/workspace";
import { saveNoteSchema } from "@/contracts/workspace";
import type { NoteModel } from "@/lib/types";
import { createNoteModel } from "@/lib/types";

import type { RecoveryEntry } from "./workspace-recovery";

/** Runtime editing flags extend the existing durable command/recovery contract. */
export type EditState = RecoveryEntry["edit"] & {
  saving: boolean;
  error: string | null;
};

interface NoteDraftState {
  session: Session | null;
  epoch: number;
  notes: NoteModel[];
  /** Acknowledged editing/media ownership baselines, not remote query freshness. */
  noteRecords: Record<string, NoteRecord>;
  currentNoteId: string | null;
  edits: Record<string, EditState>;
  unavailable: Record<string, "forbidden" | "missing">;
}

interface NoteDraftDependencies {
  get: () => NoteDraftState;
  isReady: () => boolean;
  /** The coordinator's checkpointing setter keeps every draft change recoverable. */
  set: (
    update: Partial<NoteDraftState> | ((state: NoteDraftState) => Partial<NoteDraftState>),
  ) => void;
  cleanEdit: (baseRevision?: number) => EditState;
}

const editKey = (id: string) => `note:${id}`;

const replaceNote = (notes: NoteModel[], note: NoteModel) =>
  notes.some((entry) => entry.id === note.id)
    ? notes.map((entry) => (entry.id === note.id ? note : entry))
    : [...notes, note];

const asModel = (record: NoteRecord, local?: NoteModel): NoteModel =>
  createNoteModel({
    ...record,
    audio: local?.audio ?? null,
    url: local?.url ?? null,
    recordingSessionId: local?.recordingSessionId ?? null,
  });

/** Prepare once; the coordinator persists this exact intent before transmission. */
export function prepareNoteCommand(
  note: NoteModel,
  command: DeleteCommand,
  generation: number,
): Extract<NonNullable<EditState["pending"]>, { kind: "note" }> {
  return {
    kind: "note",
    generation,
    command: saveNoteSchema.parse({
      ...command,
      content: {
        title: note.title,
        transcript: note.transcript,
      },
    }),
  };
}

/** Note responsibilities over the coordinator's state; no store or bootstrap of its own. */
export function createNoteDraftActions({ get, set, isReady, cleanEdit }: NoteDraftDependencies) {
  const acceptNote = (record: NoteRecord) =>
    set((state) => {
      if (record.workspaceId !== state.session?.workspace.id) {
        return {};
      }

      if (state.unavailable[editKey(record.id)] && !record.deletedAt) {
        return {};
      }

      if (state.noteRecords[record.id]?.deletedAt && !record.deletedAt) {
        return {};
      }

      if ((state.noteRecords[record.id]?.revision ?? 0) > record.revision) {
        return {};
      }

      const key = editKey(record.id);
      const edit = state.edits[key];
      const keepDraft =
        edit && (edit.dirty || edit.pending || edit.saving || edit.conflict !== null);
      let notes = state.notes;

      if (!keepDraft) {
        notes = record.deletedAt
          ? state.notes.filter((note) => note.id !== record.id)
          : replaceNote(state.notes, {
              ...asModel(
                record,
                state.notes.find((note) => note.id === record.id),
              ),
              scopeEpoch: state.epoch,
            });
      }

      return {
        noteRecords: { ...state.noteRecords, [record.id]: record },
        notes,
        edits: keepDraft ? state.edits : { ...state.edits, [key]: cleanEdit(record.revision) },
      };
    });

  const removeNoteDraft = (id: string) =>
    set((state) => {
      const edits = { ...state.edits };
      delete edits[editKey(id)];
      const removed = state.notes.find((note) => note.id === id);

      if (removed?.url?.startsWith("blob:")) {
        URL.revokeObjectURL(removed.url);
      }

      const notes = state.notes.filter((note) => note.id !== id);

      return {
        edits,
        notes,
        unavailable: { ...state.unavailable, [editKey(id)]: "missing" as const },
        currentNoteId: state.currentNoteId === id ? (notes[0]?.id ?? null) : state.currentNoteId,
      };
    });

  const createNote = () => {
    const session = get().session;

    if (!session || !isReady()) {
      throw new Error("Sign in and wait for recovery before creating a note.");
    }

    const note = createNoteModel({
      id: crypto.randomUUID(),
      workspaceId: session.workspace.id,
      revision: 0,
      scopeEpoch: get().epoch,
    });
    set((state) => ({
      notes: [...state.notes, note],
      currentNoteId: note.id,
      edits: { ...state.edits, [editKey(note.id)]: cleanEdit() },
    }));

    return note;
  };

  const selectNote = (id: string) => {
    if (get().notes.some((note) => note.id === id)) {
      set({ currentNoteId: id });
    }
  };

  const upsertNote = (note: NoteModel) => {
    const state = get();
    const existing = state.notes.find((entry) => entry.id === note.id);

    if (
      !state.session ||
      !existing ||
      note.scopeEpoch !== state.epoch ||
      (note.workspaceId && note.workspaceId !== state.session.workspace.id)
    ) {
      return;
    }

    const key = editKey(note.id);
    const edit = state.edits[key];

    if (!edit) {
      return;
    }

    const contentChanged = note.title !== existing.title || note.transcript !== existing.transcript;
    // Recorder callbacks may arrive while a save is pending. Keep them and use
    // generation tracking so the response cannot replace the newer draft.
    set({
      notes: replaceNote(state.notes, {
        ...note,
        workspaceId: state.session.workspace.id,
        revision: edit.baseRevision,
      }),
      edits: {
        ...state.edits,
        [key]: {
          ...edit,
          dirty: edit.dirty || contentChanged,
          generation: edit.generation + (contentChanged ? 1 : 0),
        },
      },
    });
  };

  return { acceptNote, removeNoteDraft, createNote, selectNote, upsertNote };
}
