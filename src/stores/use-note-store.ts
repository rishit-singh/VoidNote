"use client";

import { create } from "zustand";

import type { NoteRecord, PersonRecord, Session } from "@/contracts/workspace";
import {
  validateRecoveryEntries,
  workspaceRecovery,
  type RecoveryEntry,
  type RecoveryHydration,
} from "./workspace-recovery";
import { createNoteModel, type NoteModel } from "@/lib/types";
import { ApiError, workspaceApi } from "@/lib/workspace-api";
import { reconcileNoteSnapshot } from "@/queries/notes";
import { reconcilePersonSnapshot } from "@/queries/people";
import { createNoteDraftActions, prepareNoteCommand, type EditState } from "./notes";
import { createPersonDraftActions, preparePersonCommand, type PersonDraft } from "./people";

export type { EditState } from "./notes";
export type { PersonDraft } from "./people";

type Entity = "note" | "person";

interface NoteStoreState {
  session: Session | null;
  epoch: number;
  status: "idle" | "loading" | "ready" | "signedOut" | "setup" | "error";
  error: string | null;
  /** Legacy authentication-initialized flag; not local recovery readiness. */
  hydrated: boolean;
  /** Verified account/workspace-owned drafts; reset only on scope change/retry. */
  recoveryHydration: RecoveryHydration;
  recoveryEpoch: number | null;
  /** Opened/recovered editor drafts, not paginated remote list projections. */
  notes: NoteModel[];
  /** Acknowledged edit/ownership baselines; QueryClient owns remote freshness. */
  noteRecords: Record<string, NoteRecord>;
  currentNoteId: string | null;
  recoveryError: string | null;
  recoveredDraftCount: number;
  people: PersonDraft[];
  /** Acknowledged edit baselines, not an authoritative remote record cache. */
  personRecords: Record<string, PersonRecord>;
  currentPersonId: string | null;
  edits: Record<string, EditState>;
  unavailable: Record<string, "forbidden" | "missing">;
  recordErrors: Record<string, string | null>;
  lastDeleted: { entityType: Entity; id: string } | null;
  initialize: () => Promise<void>;
  refreshSession: () => Promise<void>;
  retryRecovery: () => Promise<void>;
  clearSession: () => void;
  signOut: (discardDrafts?: boolean) => Promise<void>;
  saveAll: () => Promise<boolean>;
  ensureNote: (id: string, retry?: boolean) => Promise<void>;
  ensurePerson: (id: string, retry?: boolean) => Promise<void>;
  reconcileNote: (record: NoteRecord, epoch?: number, updatedAt?: number) => void;
  reconcilePerson: (record: PersonRecord, epoch?: number, updatedAt?: number) => void;
  reconcileUnavailable: (
    entity: Entity,
    id: string,
    reason: "forbidden" | "missing",
    epoch: number,
    updatedAt?: number,
  ) => void;
  reportError: (error: unknown, epoch: number) => void;
  createNote: () => NoteModel;
  selectNote: (id: string) => void;
  upsertNote: (note: NoteModel) => void;
  saveNote: (id: string) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
  createPerson: () => PersonDraft;
  selectPerson: (id: string) => void;
  updatePerson: (person: PersonDraft) => void;
  savePerson: (id: string) => Promise<void>;
  deletePerson: (id: string) => Promise<void>;
  retry: (entity: Entity, id: string) => Promise<void>;
  resolveConflict: (entity: Entity, id: string, keepDraft: boolean) => Promise<void>;
}

const editKey = (entity: Entity, id: string) => `${entity}:${id}`;
const cleanEdit = (baseRevision = 0): EditState => ({
  baseRevision,
  generation: 0,
  dirty: baseRevision === 0,
  saving: false,
  pending: null,
  error: null,
  conflict: null,
});
const message = (error: unknown) =>
  error instanceof Error ? error.message : "The request failed. Please retry.";
const replace = <T extends { id: string }>(items: T[], item: T) =>
  items.some((entry) => entry.id === item.id)
    ? items.map((entry) => (entry.id === item.id ? item : entry))
    : [...items, item];

const emptyData = () => ({
  notes: [] as NoteModel[],
  noteRecords: {} as Record<string, NoteRecord>,
  currentNoteId: null as string | null,
  recoveredDraftCount: 0,
  people: [] as PersonDraft[],
  personRecords: {} as Record<string, PersonRecord>,
  currentPersonId: null as string | null,
  edits: {} as Record<string, EditState>,
  unavailable: {} as Record<string, "forbidden" | "missing">,
  recordErrors: {} as Record<string, string | null>,
  lastDeleted: null as { entityType: Entity; id: string } | null,
});

export const useNoteStore = create<NoteStoreState>((rawSet, get) => {
  let recovery: ReturnType<typeof workspaceRecovery> | null = null;
  let recoveryReady = false;
  let retained: RecoveryEntry[] = [];
  const checkpoint = () => {
    if (!recovery || !recoveryReady || !get().session) return false;
    try {
      const state = get();
      const entries: RecoveryEntry[] = [...retained];
      for (const [key, edit] of Object.entries(state.edits)) {
        if (!edit.dirty && !edit.pending && edit.conflict === null) continue;
        const id = key.slice(key.indexOf(":") + 1);
        if (key.startsWith("note:")) {
          const draft = state.notes.find((note) => note.id === id);
          if (draft) entries.push({ entity: "note", draft, edit });
        } else {
          const draft = state.people.find((person) => person.id === id);
          if (draft) entries.push({ entity: "person", draft, edit });
        }
      }
      recovery.write(entries);
      rawSet({
        recoveryError: retained.length
          ? "Some recovered drafts could not be verified and remain in local recovery, not in the workspace."
          : null,
      });
      return true;
    } catch (error) {
      rawSet({
        recoveryError: `Draft recovery could not be stored on this device: ${message(error)}`,
      });
      return false;
    }
  };
  const set: typeof rawSet = (partial) => {
    rawSet(partial);
    checkpoint();
  };
  let sessionRequest = 0;
  const recordRequests = new Map<string, Promise<void>>();
  // Ordering evidence for the editor/ownership adapter, never persisted. Query
  // timestamps prevent old cached detail data from undoing a newer denial.
  const detailObservations = new Map<string, { updatedAt: number; unavailable: boolean }>();
  let sessionFlight: Promise<void> | null = null;
  let recoveryFlight: { epoch: number; promise: Promise<void> } | null = null;
  const updateEdit = (key: string, changes: Partial<EditState>) =>
    set((state) => ({
      edits: { ...state.edits, [key]: { ...(state.edits[key] ?? cleanEdit()), ...changes } },
    }));
  const scoped = (epoch: number) => get().epoch === epoch && get().session !== null;
  const revokeAudio = () => {
    for (const note of get().notes)
      if (note.url?.startsWith("blob:")) URL.revokeObjectURL(note.url);
  };

  const { acceptNote, removeNoteDraft, createNote, selectNote, upsertNote } =
    createNoteDraftActions({ get, set, isReady: () => get().status === "ready", cleanEdit });
  const { acceptPerson, createPerson, selectPerson, updatePerson } = createPersonDraftActions({
    get,
    set,
    isReady: () => get().status === "ready",
    cleanEdit,
  });

  const reconcileUnavailable: NoteStoreState["reconcileUnavailable"] = (
    entity,
    id,
    reason,
    epoch,
    updatedAt = Date.now(),
  ) => {
    if (!scoped(epoch)) return;
    const key = editKey(entity, id);
    if ((detailObservations.get(key)?.updatedAt ?? 0) > updatedAt) return;
    detailObservations.set(key, { updatedAt, unavailable: true });
    // Keep drafts and exact uncertain commands recoverable, but revoke every
    // ownership check that uses the acknowledged baseline immediately.
    set((state) => ({ unavailable: { ...state.unavailable, [key]: reason } }));
  };

  const reconcileDetail = (
    entity: Entity,
    record: NoteRecord | PersonRecord,
    epoch: number,
    updatedAt?: number,
  ) => {
    if (!scoped(epoch) || record.workspaceId !== get().session?.workspace.id) return;
    const key = editKey(entity, record.id);
    const previous = detailObservations.get(key);
    if (
      updatedAt !== undefined &&
      previous &&
      (updatedAt < previous.updatedAt || (updatedAt === previous.updatedAt && previous.unavailable))
    )
      return;
    const baseline =
      entity === "note" ? get().noteRecords[record.id] : get().personRecords[record.id];
    if ((baseline?.revision ?? 0) > record.revision || (baseline?.deletedAt && !record.deletedAt))
      return;
    if (updatedAt !== undefined && !record.deletedAt) {
      detailObservations.set(key, { updatedAt, unavailable: false });
      set((state) => {
        const unavailable = { ...state.unavailable };
        delete unavailable[key];
        return { unavailable, recordErrors: { ...state.recordErrors, [key]: null } };
      });
    }
    if (entity === "note") acceptNote(record as NoteRecord);
    else acceptPerson(record as PersonRecord);
    if (record.deletedAt) reconcileUnavailable(entity, record.id, "missing", epoch, updatedAt);
  };

  const removeDraft = (entity: Entity, id: string) => {
    if (entity === "note") return removeNoteDraft(id);
    set((state) => {
      const edits = { ...state.edits };
      delete edits[editKey(entity, id)];
      const people = state.people.filter((person) => person.id !== id);
      return {
        edits,
        people,
        unavailable: { ...state.unavailable, [editKey(entity, id)]: "missing" as const },
        currentPersonId:
          state.currentPersonId === id ? (people[0]?.id ?? null) : state.currentPersonId,
      };
    });
  };

  const mutate = async (entity: Entity, id: string, deleting = false) => {
    const state = get();
    // Recovery must resolve the original command before a new intent can be made.
    if (!state.session || !recoveryReady) return;
    const key = editKey(entity, id);
    if (state.unavailable[key]) return;
    const edit = state.edits[key];
    if (!edit || edit.saving || edit.conflict !== null) return;
    if (!deleting && !edit.dirty && !edit.pending) return;
    const epoch = state.epoch;
    const workspaceId = state.session.workspace.id;
    const replaying = edit.pending !== null;
    let pending = edit.pending;
    if (!pending) {
      if (deleting && edit.baseRevision === 0) {
        removeDraft(entity, id);
        return;
      }
      const command = { commandId: crypto.randomUUID(), id, expectedRevision: edit.baseRevision };
      try {
        if (deleting) pending = { kind: "delete", command, generation: edit.generation };
        else if (entity === "note") {
          const note = state.notes.find((entry) => entry.id === id);
          if (!note) return;
          pending = prepareNoteCommand(note, command, edit.generation);
        } else {
          const person = state.people.find((entry) => entry.id === id);
          if (!person) return;
          pending = preparePersonCommand(person, command, edit.generation);
        }
      } catch (error) {
        updateEdit(key, { error: message(error) });
        return;
      }
    }
    // The payload is parsed/cloned once, then retained through uncertain failures.
    updateEdit(key, { pending, saving: true, error: null });
    if (!checkpoint()) {
      updateEdit(key, {
        saving: false,
        error: "Save paused: durable command recovery is unavailable.",
      });
      return;
    }
    try {
      const record =
        pending.kind === "note"
          ? await workspaceApi.saveNote(workspaceId, pending.command, { replaying })
          : pending.kind === "person"
            ? await workspaceApi.savePerson(workspaceId, pending.command, { replaying })
            : entity === "note"
              ? await workspaceApi.deleteNote(workspaceId, pending.command)
              : await workspaceApi.deletePerson(workspaceId, pending.command);
      if (!scoped(epoch)) return;
      if (record.workspaceId !== workspaceId || record.id !== id)
        throw new Error("Unexpected saved record; retry the original command.");
      // A receipt is the original result, not a current projection. On replay,
      // recheck the live row so an old create/save receipt cannot revive a tombstone.
      if (replaying && !record.deletedAt) {
        const latest =
          entity === "note"
            ? await workspaceApi.note(workspaceId, id, true)
            : await workspaceApi.person(workspaceId, id, true);
        if (!scoped(epoch)) return;
        if (latest.workspaceId !== workspaceId || latest.id !== id)
          throw new Error("Unexpected current record; retry the original command.");
        if (entity === "note") {
          await reconcileNoteSnapshot(latest as NoteRecord);
        } else {
          await reconcilePersonSnapshot(latest as PersonRecord);
        }
        if (!scoped(epoch)) return;
        if (latest.deletedAt) {
          const current = get().edits[key];
          const draft =
            entity === "note"
              ? get().notes.find((item) => item.id === id)
              : get().people.find((item) => item.id === id);
          if (draft && current) {
            const recoveredEdit = {
              ...current,
              pending: null,
              dirty: true,
              conflict: latest.revision,
            };
            if (entity === "note")
              retained.push({ entity, draft: draft as NoteModel, edit: recoveredEdit });
            else retained.push({ entity, draft: draft as PersonDraft, edit: recoveredEdit });
          }
          removeDraft(entity, id);
          set((current) => ({ unavailable: { ...current.unavailable, [key]: "missing" } }));
          return;
        }
        if (entity === "note") acceptNote(latest as NoteRecord);
        else acceptPerson(latest as PersonRecord);
      }
      const current = get().edits[key];
      if (!current) return;
      const changedDuringSave = current.generation !== pending.generation;
      const knownRevision =
        entity === "note" ? get().noteRecords[id]?.revision : get().personRecords[id]?.revision;
      if (knownRevision !== undefined && knownRevision > record.revision) {
        updateEdit(key, {
          baseRevision: record.revision,
          dirty: true,
          pending: null,
          saving: false,
          conflict: knownRevision,
          error:
            "Your command succeeded, but a newer server revision is available. Review it before saving again.",
        });
        return;
      }
      updateEdit(key, {
        baseRevision: record.revision,
        dirty: changedDuringSave,
        pending: null,
        saving: false,
        error: null,
        conflict: null,
      });
      if (record.deletedAt && entity === "note") {
        const url = get().notes.find((note) => note.id === id)?.url;
        if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
      }
      if (entity === "note") acceptNote(record as NoteRecord);
      else acceptPerson(record as PersonRecord);
      if (record.deletedAt) {
        removeDraft(entity, id);
        set({ lastDeleted: { entityType: entity, id } });
      }
    } catch (error) {
      if (!scoped(epoch)) return;
      if (error instanceof ApiError && error.status === 401) {
        updateEdit(key, { saving: false });
        get().reportError(error, epoch);
        return;
      }
      const conflict =
        error instanceof ApiError && error.status === 409 && error.code !== "command_reused";
      // A 4xx response is a definite rejection. 5xx, invalid responses and network
      // failures may follow a commit, so only Retry can resolve that exact intent.
      const rejected =
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        // Authorization runs before receipt lookup, so denial cannot resolve an
        // earlier uncertain request using the same command.
        error.status !== 403 &&
        error.status !== 408 &&
        error.status !== 429;
      updateEdit(key, {
        saving: false,
        error: message(error),
        pending: rejected ? null : pending,
        conflict: conflict ? (error.currentRevision ?? edit.baseRevision) : null,
      });
    }
  };

  const loadRecord = async (entity: Entity, id: string, retry: boolean) => {
    const { session, epoch } = get();
    if (!session) return;
    const key = editKey(entity, id);
    if (get().unavailable[key] && !retry) return;
    // Unsaved creations have no server row. All saved records go through the
    // query-backed API so the legacy projection cannot bypass query freshness.
    const edit = get().edits[key];
    if (edit?.baseRevision === 0 && !retry) return;
    const previousObservation = detailObservations.get(key);
    set((state) => ({ recordErrors: { ...state.recordErrors, [key]: null } }));
    try {
      const record =
        entity === "note"
          ? await workspaceApi.note(session.workspace.id, id, retry)
          : await workspaceApi.person(session.workspace.id, id, retry);
      if (!scoped(epoch)) return;
      if (record.id !== id || record.workspaceId !== session.workspace.id)
        throw new Error("Unexpected record returned by server.");
      // An explicit retry performs a fresh API read. It may resolve the denial
      // present when it began, but cannot clear a newer failure received in flight.
      const verifiedAt =
        retry && detailObservations.get(key) === previousObservation
          ? Math.max(Date.now(), (previousObservation?.updatedAt ?? 0) + 1)
          : undefined;
      reconcileDetail(entity, record, epoch, verifiedAt);
    } catch (error) {
      if (!scoped(epoch)) return;
      if (error instanceof ApiError && (error.status === 403 || error.status === 404))
        reconcileUnavailable(entity, id, error.status === 403 ? "forbidden" : "missing", epoch);
      else if (error instanceof ApiError && error.status === 401) get().reportError(error, epoch);
      else set((state) => ({ recordErrors: { ...state.recordErrors, [key]: message(error) } }));
    }
  };

  const ensure = (entity: Entity, id: string, retry = false) => {
    const key = `${get().epoch}:${editKey(entity, id)}`;
    const pending = recordRequests.get(key);
    if (pending) return pending;
    const task = loadRecord(entity, id, retry).finally(() => recordRequests.delete(key));
    recordRequests.set(key, task);
    return task;
  };

  const recover = () => {
    const { session, epoch } = get();
    if (!session || !recovery) return Promise.resolve();
    if (recoveryFlight?.epoch === epoch) return recoveryFlight.promise;
    if (get().recoveryHydration === "ready" && get().recoveryEpoch === epoch)
      return Promise.resolve();
    const scopedRecovery = recovery;
    const initialEdits = get().edits;
    recoveryReady = false;
    rawSet({
      recoveryHydration: "loading",
      recoveryEpoch: epoch,
      status: "loading",
      recoveryError: null,
    });
    const promise = (async () => {
      try {
        const entries = await scopedRecovery.read();
        if (!scoped(epoch)) return;
        const validated = await validateRecoveryEntries(
          entries,
          async ({ entity, draft, edit }) => {
            if (!scoped(epoch)) return null;
            try {
              const record =
                entity === "note"
                  ? await workspaceApi.note(session.workspace.id, draft.id, true)
                  : await workspaceApi.person(session.workspace.id, draft.id, true);
              if (record.workspaceId !== session.workspace.id || record.id !== draft.id)
                throw new Error("Recovery returned a record from another scope.");
              return record;
            } catch (error) {
              // A never-saved local draft is valid when its server row is absent.
              if (error instanceof ApiError && error.status === 404 && edit.baseRevision === 0)
                return null;
              throw error;
            }
          },
        );
        if (!scoped(epoch)) return;
        // Transient failures are not successful empty recovery. Preserve the disk
        // snapshot and require explicit retry before permitting new commands.
        for (const result of validated) {
          if (result.status !== "rejected") continue;
          const error: unknown = result.reason;
          if (!(error instanceof ApiError && (error.status === 403 || error.status === 404)))
            throw error;
        }
        retained = [];
        let recoveredDraftCount = 0;
        for (const [index, entry] of entries.entries()) {
          const result = validated[index]!;
          if (result.status === "rejected" || result.value?.deletedAt) {
            retained.push(entry);
            continue;
          }
          const { entity, draft, edit } = entry;
          const key = editKey(entity, draft.id);
          const before = get().edits[key];
          const keepCurrent =
            !!before &&
            (before.dirty ||
              before.pending ||
              before.saving ||
              before.conflict !== null ||
              before.generation > (initialEdits[key]?.generation ?? 0));
          if (result.value) {
            if (entity === "note") acceptNote(result.value as NoteRecord);
            else acceptPerson(result.value as PersonRecord);
          }
          rawSet((state) => {
            const local = state.notes.find((note) => note.id === draft.id);
            return {
              ...(entry.entity === "note"
                ? {
                    notes: keepCurrent
                      ? state.notes
                      : replace(
                          state.notes,
                          createNoteModel({
                            ...entry.draft,
                            audio: local?.audio ?? null,
                            url: local?.url ?? null,
                            recordingSessionId:
                              local?.recordingSessionId ?? entry.draft.recordingSessionId,
                            workspaceId: session.workspace.id,
                            revision: edit.baseRevision,
                            scopeEpoch: epoch,
                          }),
                        ),
                  }
                : {
                    people: keepCurrent
                      ? state.people
                      : replace(state.people, {
                          ...entry.draft,
                          workspaceId: session.workspace.id,
                          scopeEpoch: epoch,
                        }),
                  }),
              edits: {
                ...state.edits,
                [key]:
                  keepCurrent && before
                    ? {
                        ...before,
                        // Keep edits made while validation was in flight, but retain
                        // the original uncertain payload independently of that draft.
                        baseRevision: edit.baseRevision,
                        generation: Math.max(before.generation, edit.generation + 1),
                        dirty: true,
                        pending: before.pending ?? edit.pending,
                        conflict: before.conflict ?? edit.conflict,
                        saving: false,
                      }
                    : { ...edit, saving: false, error: null },
              },
            };
          });
          recoveredDraftCount++;
        }
        recoveryReady = true;
        if (!checkpoint())
          throw new Error(get().recoveryError ?? "Draft recovery could not be stored.");
        rawSet({ status: "ready", recoveryHydration: "ready", recoveredDraftCount });
      } catch (error) {
        if (!scoped(epoch)) return;
        recoveryReady = false;
        rawSet({
          status: "error",
          recoveryHydration: "error",
          recoveryError: `Draft recovery could not be loaded: ${message(error)}`,
        });
        if (error instanceof ApiError && error.status === 401) get().clearSession();
      }
    })().finally(() => {
      if (recoveryFlight?.promise === promise) recoveryFlight = null;
    });
    recoveryFlight = { epoch, promise };
    return promise;
  };

  const refreshSessionNow = async () => {
    const requestId = ++sessionRequest;
    const epoch = get().epoch;
    if (!get().session) set({ status: "loading", error: null });
    try {
      const session = await workspaceApi.session();
      if (get().epoch !== epoch || requestId !== sessionRequest) return;
      const previous = get().session;
      if (previous?.user.id === session.user.id && previous.workspace.id === session.workspace.id) {
        // Authentication refresh is independent of recovery. In particular, it
        // must not clear a failed recovery or prematurely enable capture.
        set({ session, error: null, hydrated: true });
        if (recoveryFlight?.epoch === epoch) await recoveryFlight.promise;
        return;
      }
      revokeAudio();
      detailObservations.clear();
      recoveryReady = false;
      retained = [];
      recovery = workspaceRecovery(session);
      set({
        ...emptyData(),
        session,
        epoch: epoch + 1,
        status: "loading",
        error: null,
        hydrated: true,
        recoveryHydration: "idle",
        recoveryEpoch: null,
        recoveryError: null,
      });
      await recover();
    } catch (error) {
      if (get().epoch !== epoch || requestId !== sessionRequest) return;
      if (get().session && !(error instanceof ApiError && error.status === 401)) {
        set({ error: message(error) });
        return;
      }
      revokeAudio();
      set({
        ...emptyData(),
        session: null,
        epoch: epoch + 1,
        hydrated: true,
        recoveryHydration: "idle",
        recoveryEpoch: null,
        recoveryError: null,
        status:
          error instanceof ApiError && error.status === 401
            ? "signedOut"
            : error instanceof ApiError && error.status === 503
              ? "setup"
              : "error",
        error: error instanceof ApiError && error.status === 401 ? null : message(error),
      });
    }
  };

  const refreshSession = () => {
    if (sessionFlight) return sessionFlight;
    const task = refreshSessionNow().finally(() => {
      if (sessionFlight === task) sessionFlight = null;
    });
    sessionFlight = task;
    return task;
  };

  return {
    ...emptyData(),
    session: null,
    epoch: 0,
    status: "idle",
    error: null,
    hydrated: false,
    recoveryHydration: "idle",
    recoveryEpoch: null,
    recoveryError: null,
    initialize: async () => {
      if (get().status === "idle" || get().status === "loading") await refreshSession();
    },
    refreshSession,
    retryRecovery: recover,
    clearSession: () => {
      sessionFlight = null;
      recoveryFlight = null;
      detailObservations.clear();
      checkpoint();
      recoveryReady = false;
      recovery = null;
      retained = [];
      revokeAudio();
      set({
        ...emptyData(),
        session: null,
        epoch: get().epoch + 1,
        status: "signedOut",
        error: null,
        hydrated: true,
        recoveryHydration: "idle",
        recoveryEpoch: null,
        recoveryError: null,
      });
    },
    signOut: async (discardDrafts = false) => {
      if (!discardDrafts && !checkpoint()) {
        set({ error: "Sign-out paused: drafts could not be stored locally." });
        return;
      }
      const currentRecovery = recovery;
      const epoch = get().epoch;
      try {
        await workspaceApi.signOut();
        if (get().epoch !== epoch) return;
        get().clearSession();
        if (discardDrafts) {
          try {
            currentRecovery?.discard();
          } catch (error) {
            rawSet({
              recoveryError: `Signed out, but local draft recovery could not be removed: ${message(error)}`,
            });
          }
        }
      } catch (error) {
        if (get().epoch === epoch)
          set({ error: `Sign-out could not be confirmed: ${message(error)}` });
      }
    },
    reportError: (error, epoch) => {
      if (get().epoch !== epoch) return;
      if (error instanceof ApiError && error.status === 401) get().clearSession();
      else set({ error: message(error) });
    },
    createNote,
    selectNote,
    upsertNote,
    saveNote: (id) => mutate("note", id),
    deleteNote: (id) => mutate("note", id, true),
    createPerson,
    selectPerson,
    updatePerson,
    savePerson: (id) => mutate("person", id),
    deletePerson: (id) => mutate("person", id, true),
    retry: (entity, id) => mutate(entity, id),
    resolveConflict: async (entity, id, keepDraft) => {
      const { session, epoch } = get();
      const key = editKey(entity, id);
      const edit = get().edits[key];
      if (!session || !edit || edit.pending || edit.saving) return;
      updateEdit(key, { saving: true, error: null });
      try {
        const record =
          entity === "note"
            ? await workspaceApi.note(session.workspace.id, id, true)
            : await workspaceApi.person(session.workspace.id, id, true);
        if (!scoped(epoch)) return;
        if (record.id !== id || record.workspaceId !== session.workspace.id)
          throw new Error("Unexpected record returned by server.");
        if (keepDraft && record.deletedAt) {
          updateEdit(key, {
            saving: false,
            conflict: record.revision,
            error: "This record was deleted. Reload to discard this draft.",
          });
          return;
        }
        // A rebase updates only the base revision. It never saves implicitly.
        const changedDuringLoad = get().edits[key]?.generation !== edit.generation;
        updateEdit(key, {
          baseRevision: record.revision,
          dirty: keepDraft || changedDuringLoad,
          saving: false,
          conflict: null,
          error: null,
        });
        if (entity === "note") acceptNote(record as NoteRecord);
        else acceptPerson(record as PersonRecord);
        if (record.deletedAt) {
          removeDraft(entity, id);
          set({ lastDeleted: { entityType: entity, id } });
        }
      } catch (error) {
        if (!scoped(epoch)) return;
        if (error instanceof ApiError && error.status === 404) {
          if (keepDraft) {
            updateEdit(key, {
              saving: false,
              error:
                "This record is no longer available. Your draft is retained; reload to discard it.",
            });
          } else {
            removeDraft(entity, id);
            // A late list response must not resurrect a record confirmed missing.
            set((state) => ({
              unavailable: { ...state.unavailable, [key]: "missing" },
              lastDeleted: { entityType: entity, id },
            }));
          }
          return;
        }
        updateEdit(key, { saving: false, error: message(error) });
        if (error instanceof ApiError && (error.status === 401 || error.status === 403))
          get().reportError(error, epoch);
      }
    },
    ensureNote: (id, retry) => ensure("note", id, retry),
    ensurePerson: (id, retry) => ensure("person", id, retry),
    reconcileNote: (record, epoch = get().epoch, updatedAt) =>
      reconcileDetail("note", record, epoch, updatedAt),
    reconcilePerson: (record, epoch = get().epoch, updatedAt) =>
      reconcileDetail("person", record, epoch, updatedAt),
    reconcileUnavailable,
    saveAll: async () => {
      const epoch = get().epoch;
      if (!get().session || !recoveryReady) return false;
      for (const [key, edit] of Object.entries(get().edits)) {
        if (edit.dirty || edit.pending) {
          const entity = key.startsWith("note:") ? "note" : "person";
          await mutate(entity, key.slice(key.indexOf(":") + 1));
          if (!scoped(epoch)) return false;
          // One exact pending command can finish while a newer draft remains.
          const current = get().edits[key];
          if (current?.dirty && !current.pending && !current.error && current.conflict === null)
            await mutate(entity, key.slice(key.indexOf(":") + 1));
        }
      }
      return (
        scoped(epoch) &&
        Object.values(get().edits).every(
          (edit) =>
            !edit.dirty && !edit.pending && !edit.saving && edit.conflict === null && !edit.error,
        ) &&
        retained.length === 0
      );
    },
  };
});
