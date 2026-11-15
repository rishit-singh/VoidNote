import type { DeleteCommand, PersonRecord, Session } from "@/contracts/workspace";
import { savePersonSchema } from "@/contracts/workspace";

import type { EditState } from "./notes";

export type PersonDraft = Pick<
  PersonRecord,
  "id" | "workspaceId" | "displayName" | "description"
> & { scopeEpoch: number };

interface PersonDraftState {
  session: Session | null;
  epoch: number;
  people: PersonDraft[];
  /** Acknowledged editing baselines, not remote query freshness. */
  personRecords: Record<string, PersonRecord>;
  currentPersonId: string | null;
  edits: Record<string, EditState>;
  unavailable: Record<string, "forbidden" | "missing">;
}

interface PersonDraftDependencies {
  get: () => PersonDraftState;
  isReady: () => boolean;
  /** The coordinator's checkpointing setter keeps every draft change recoverable. */
  set: (
    update: Partial<PersonDraftState> | ((state: PersonDraftState) => Partial<PersonDraftState>),
  ) => void;
  cleanEdit: (baseRevision?: number) => EditState;
}

const editKey = (id: string) => `person:${id}`;

const replacePerson = (people: PersonDraft[], person: PersonDraft) =>
  people.some((entry) => entry.id === person.id)
    ? people.map((entry) => (entry.id === person.id ? person : entry))
    : [...people, person];

/** Prepare once; the coordinator persists this exact intent before transmission. */
export function preparePersonCommand(
  person: PersonDraft,
  command: DeleteCommand,
  generation: number,
): Extract<NonNullable<EditState["pending"]>, { kind: "person" }> {
  return {
    kind: "person",
    generation,
    command: savePersonSchema.parse({
      ...command,
      content: {
        displayName: person.displayName,
        description: person.description,
      },
    }),
  };
}

/** People responsibilities over coordinator state; no store or bootstrap of its own. */
export function createPersonDraftActions({
  get,
  set,
  isReady,
  cleanEdit,
}: PersonDraftDependencies) {
  const acceptPerson = (record: PersonRecord) =>
    set((state) => {
      if (record.workspaceId !== state.session?.workspace.id) {
        return {};
      }

      if (state.unavailable[editKey(record.id)] && !record.deletedAt) {
        return {};
      }

      if (state.personRecords[record.id]?.deletedAt && !record.deletedAt) {
        return {};
      }

      if ((state.personRecords[record.id]?.revision ?? 0) > record.revision) {
        return {};
      }

      const key = editKey(record.id);
      const edit = state.edits[key];
      const keepDraft =
        edit && (edit.dirty || edit.pending || edit.saving || edit.conflict !== null);
      let people = state.people;

      if (!keepDraft) {
        people = record.deletedAt
          ? state.people.filter((person) => person.id !== record.id)
          : replacePerson(state.people, { ...record, scopeEpoch: state.epoch });
      }

      return {
        personRecords: { ...state.personRecords, [record.id]: record },
        people,
        edits: keepDraft ? state.edits : { ...state.edits, [key]: cleanEdit(record.revision) },
      };
    });

  const createPerson = () => {
    const session = get().session;

    if (!session || !isReady()) {
      throw new Error("Sign in and wait for recovery before creating a person.");
    }

    const person: PersonDraft = {
      id: crypto.randomUUID(),
      workspaceId: session.workspace.id,
      displayName: "",
      description: "",
      scopeEpoch: get().epoch,
    };
    set((state) => ({
      people: [...state.people, person],
      currentPersonId: person.id,
      edits: { ...state.edits, [editKey(person.id)]: cleanEdit() },
    }));

    return person;
  };

  const selectPerson = (id: string) => {
    if (get().people.some((person) => person.id === id)) {
      set({ currentPersonId: id });
    }
  };

  const updatePerson = (person: PersonDraft) => {
    const state = get();

    if (
      !state.session ||
      person.scopeEpoch !== state.epoch ||
      person.workspaceId !== state.session.workspace.id ||
      !state.people.some((entry) => entry.id === person.id)
    ) {
      return;
    }

    const key = editKey(person.id);
    const edit = state.edits[key];

    // Conflict resolution can discard the draft after its read completes. Keep
    // that read locked; pending saves retain newer edits through generations.
    if (!edit || edit.pending?.kind === "delete" || (edit.saving && !edit.pending)) {
      return;
    }

    // A pending save owns its original payload. Newer edits advance only the draft
    // generation, so acknowledgement cannot erase them or silently change a retry.
    set({
      people: replacePerson(state.people, person),
      edits: { ...state.edits, [key]: { ...edit, dirty: true, generation: edit.generation + 1 } },
    });
  };

  return { acceptPerson, createPerson, selectPerson, updatePerson };
}
