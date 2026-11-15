"use client";

import { useEffect } from "react";
import { useNoteStore } from "@/stores/use-note-store";

/** The persistent shell is the only owner of workspace bootstrap and browser lifecycle. */
export function useWorkspace() {
  const status = useNoteStore((state) => state.status);
  const session = useNoteStore((state) => state.session);
  const error = useNoteStore((state) => state.error);
  const recoveryError = useNoteStore((state) => state.recoveryError);
  const recoveryHydration = useNoteStore((state) => state.recoveryHydration);
  const retryRecovery = useNoteStore((state) => state.retryRecovery);
  const recoveredDraftCount = useNoteStore((state) => state.recoveredDraftCount);
  const refreshSession = useNoteStore((state) => state.refreshSession);
  const needsUnloadWarning = useNoteStore(
    (state) =>
      !!state.recoveryError &&
      Object.values(state.edits).some(
        (edit) => edit.dirty || edit.saving || edit.pending || edit.conflict !== null,
      ),
  );

  useEffect(() => {
    void useNoteStore.getState().initialize();
    const refresh = () => {
      if (useNoteStore.getState().session) void refreshSession();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refreshSession]);

  useEffect(() => {
    if (!needsUnloadWarning) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [needsUnloadWarning]);

  return {
    status,
    session,
    error,
    recoveryHydration,
    recoveryError,
    retryRecovery,
    recoveredDraftCount,
    refreshSession,
  };
}
