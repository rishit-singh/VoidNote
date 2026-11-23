"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useNoteStore } from "@/stores/use-note-store";
import { useCaptureStore } from "@/stores/use-capture-store";
import { runEntityAction } from "@/lib/action-toasts";

export function NoteActions({ noteId }: { noteId: string }) {
  const router = useRouter();
  const edit = useNoteStore((s) => s.edits[`note:${noteId}`]);
  const ready = useNoteStore((s) => s.status === "ready");
  const capture = useCaptureStore((s) => s.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = !["idle", "error"].includes(capture);
  function fresh() {
    const state = useNoteStore.getState();
    if (
      !state.session ||
      state.status !== "ready" ||
      !state.notes.some((note) => note.id === noteId)
    )
      return;
    setError(null);
    try {
      // Keep the original intact. The new editor autosaves this empty-title draft;
      // its first acknowledged save assigns the workspace's next note number.
      const next = state.createNote();
      router.push(`/notes/${next.id}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not open a new note.");
    }
  }

  async function act(action: "delete" | "retry" | "keep-draft" | "use-latest") {
    const epoch = useNoteStore.getState().epoch;
    setBusy(true);
    setError(null);
    const outcome = await runEntityAction("note", noteId, action);
    if (useNoteStore.getState().epoch !== epoch) return;
    setBusy(false);
    if (outcome.error) setError(outcome.error);
    if (outcome.deleted) router.push("/");
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-3">
        <span role="status" className="text-meta text-muted-foreground">
          {busy
            ? "Working…"
            : edit?.saving || (edit?.dirty && !edit.error)
              ? "Saving…"
              : edit?.error || edit?.pending
                ? "Not saved"
                : "Saved"}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Note actions"
              title="Note actions"
              disabled={busy}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={!ready || active} onSelect={fresh}>
                <RotateCcw />
                Start over in a new note
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={
                  !ready || active || !!edit?.pending || !!edit?.saving || edit?.conflict != null
                }
                onSelect={() => void act("delete")}
              >
                <Trash2 />
                Delete note
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {(error || edit?.error || (edit?.pending && !edit.saving)) && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>
              {error ||
                (edit?.conflict != null
                  ? "This note changed elsewhere."
                  : "Could not save. Your changes are kept here.")}
            </span>
            {edit?.conflict != null ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy || edit.saving}
                  onClick={() => void act("keep-draft")}
                >
                  Keep mine
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy || edit.saving}
                  onClick={() => void act("use-latest")}
                >
                  Use latest
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                disabled={busy || edit?.saving}
                onClick={() => void act("retry")}
              >
                Retry
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
