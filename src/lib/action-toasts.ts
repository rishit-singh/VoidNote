"use client";

import { toast } from "sonner";
import { useNoteStore } from "@/stores/use-note-store";

type Entity = "note" | "person";
type Action = "save" | "delete" | "retry" | "keep-draft" | "use-latest";
type Outcome = {
  status: "acknowledged" | "local" | "failed" | "ignored";
  deleted?: boolean;
  error?: string;
};

const attempts = new Set<string>();

function scopeKey(state: ReturnType<typeof useNoteStore.getState>) {
  return `${state.epoch}:${state.session?.user.id}:${state.session?.workspace.id}`;
}

/** Authentication refreshes within the same verified scope retain notifications. */
export function watchActionToastScope() {
  return useNoteStore.subscribe((state, previous) => {
    if (scopeKey(state) !== scopeKey(previous)) {
      toast.dismiss();
    }
  });
}

/**
 * Only explicit controls call this adapter; autosave stays silent. Store commands
 * resolve even on failure, so a resolved promise alone is not acknowledgement.
 */
export async function runEntityAction(
  entity: Entity,
  id: string,
  action: Action,
): Promise<Outcome> {
  const before = useNoteStore.getState();
  const key = `${entity}:${id}`;
  const edit = before.edits[key];
  const scope = scopeKey(before);
  const attempt = `${scope}:${key}`;
  const resolving = action === "keep-draft" || action === "use-latest";
  if (
    !before.session ||
    before.status !== "ready" ||
    !edit ||
    edit.saving ||
    before.unavailable[key] ||
    attempts.has(attempt) ||
    (resolving ? edit.conflict === null || !!edit.pending : edit.conflict !== null) ||
    ((action === "save" || action === "delete") && !!edit.pending) ||
    ((action === "save" || action === "retry") && !edit.dirty && !edit.pending)
  ) {
    return { status: "ignored" };
  }

  const deleting = action === "delete" || (action === "retry" && edit.pending?.kind === "delete");
  const label = entity === "note" ? "Note" : "Profile";
  const toastId = attempt;
  attempts.add(attempt);
  try {
    if (resolving) {
      await before.resolveConflict(entity, id, action === "keep-draft");
    } else if (action === "retry") {
      await before.retry(entity, id);
    } else if (entity === "note") {
      await (deleting ? before.deleteNote(id) : before.saveNote(id));
    } else {
      await (deleting ? before.deletePerson(id) : before.savePerson(id));
    }

    const current = useNoteStore.getState();
    if (scopeKey(current) !== scope) {
      return { status: "ignored" };
    }

    const nextEdit = current.edits[key];
    const record = entity === "note" ? current.noteRecords[id] : current.personRecords[id];
    const removed = !(entity === "note" ? current.notes : current.people).some(
      (item) => item.id === id,
    );
    // A query observer may republish the tombstone after removeDraft and recreate
    // its clean edit baseline. That baseline is not recoverable unsaved work.
    const discardedEdit =
      !nextEdit ||
      (record?.deletedAt &&
        nextEdit.baseRevision === record.revision &&
        !nextEdit.dirty &&
        !nextEdit.pending &&
        !nextEdit.saving &&
        !nextEdit.error &&
        nextEdit.conflict === null);
    if (
      action === "use-latest" &&
      removed &&
      discardedEdit &&
      current.unavailable[key] === "missing" &&
      current.lastDeleted?.entityType === entity &&
      current.lastDeleted.id === id
    ) {
      // Resolving a tombstone or a verified 404 discards only the local draft.
      // It is not acknowledgement of a delete command issued by this client.
      toast.info(`Deleted ${label.toLowerCase()} removed`, { id: toastId });
      return { status: "local", deleted: true };
    }
    if (deleting && removed) {
      if (record?.deletedAt && record.revision > edit.baseRevision) {
        toast.success(`${label} deleted`, { id: toastId });
        return { status: "acknowledged", deleted: true };
      }
      if (edit.baseRevision === 0 && !edit.pending) {
        toast.info("Unsaved draft discarded", { id: toastId });
        return { status: "local", deleted: true };
      }
    }

    const settled =
      nextEdit &&
      !nextEdit.error &&
      !nextEdit.pending &&
      !nextEdit.saving &&
      nextEdit.conflict === null &&
      !current.unavailable[key];
    if (settled && resolving) {
      const message =
        action === "keep-draft"
          ? "Draft kept for saving"
          : nextEdit.dirty
            ? "Newer draft kept"
            : "Latest version loaded";
      toast.info(message, { id: toastId });
      return { status: "local" };
    }
    if (settled && record && !record.deletedAt && nextEdit.baseRevision > edit.baseRevision) {
      toast.success(`${label} saved`, { id: toastId });
      return { status: "acknowledged" };
    }

    const error =
      nextEdit?.error ??
      (current.unavailable[key]
        ? `${label} is no longer available.`
        : "The change could not be confirmed. Your draft is kept here.");
    toast.error(error, { id: toastId });
    return { status: "failed", error };
  } catch (failure) {
    if (scopeKey(useNoteStore.getState()) !== scope) {
      return { status: "ignored" };
    }
    const error = failure instanceof Error ? failure.message : "The change could not be confirmed.";
    toast.error(error, { id: toastId });
    return { status: "failed", error };
  } finally {
    attempts.delete(attempt);
  }
}
