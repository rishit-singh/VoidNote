"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react";
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
import { useRecordingProcessing } from "@/hooks/use-recording-processing";
import { buildRecordingBlob } from "@/lib/idb-recordings";

export function NoteActions({ noteId }: { noteId: string }) {
  const router = useRouter();
  const edit = useNoteStore((s) => s.edits[`note:${noteId}`]);
  const ready = useNoteStore((s) => s.status === "ready");
  const capture = useCaptureStore((s) => s.status);
  const p = useRecordingProcessing(noteId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = !["idle", "error"].includes(capture);
  async function fresh(copyAudio: boolean) {
    const state = useNoteStore.getState();
    const original = state.notes.find((n) => n.id === noteId);
    if (!original || !state.session) return;
    setBusy(true);
    setError(null);
    try {
      let blob: Blob | undefined;
      if (copyAudio && p.local?.status === "finalized")
        blob = await buildRecordingBlob(p.local.id, p.local.mimeType);
      else if (copyAudio && p.recording?.status === "ready") {
        const response = await fetch(
          `/api/workspaces/${state.session.workspace.id}/notes/${noteId}/recordings/${p.recording.id}/audio`,
        );
        if (!response.ok) throw new Error("Could not copy the audio. Please retry.");
        blob = await response.blob();
      }
      if (useNoteStore.getState().epoch !== state.epoch) return;
      const next = state.createNote();
      state.upsertNote({
        ...next,
        title: `${original.title || "Untitled note"}${copyAudio ? " (copy)" : ""}`,
      });
      await state.saveNote(next.id);
      if (useNoteStore.getState().epoch !== state.epoch) return;
      if (!useNoteStore.getState().noteRecords[next.id])
        throw new Error("Could not save the new note.");
      router.push(`/notes/${next.id}`);
      if (blob)
        await useCaptureStore.getState().upload(
          next.id,
          new File([blob], "recording", {
            type: blob.type || p.recording?.mimeType || "audio/wav",
          }),
        );
    } catch (failure) {
      if (useNoteStore.getState().epoch === state.epoch)
        setError(failure instanceof Error ? failure.message : "Could not create note.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-3">
        <span role="status" className="text-meta text-muted-foreground">
          {busy
            ? "Copying…"
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
              <DropdownMenuItem
                disabled={!ready || active || !p.loaded}
                onSelect={() => void fresh(true)}
              >
                <Copy />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!ready || active} onSelect={() => void fresh(false)}>
                <RotateCcw />
                Start over in a new note
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={active || !!edit?.pending || !!edit?.saving}
                onSelect={() =>
                  void useNoteStore
                    .getState()
                    .deleteNote(noteId)
                    .then(() => {
                      if (!useNoteStore.getState().notes.some((n) => n.id === noteId))
                        router.push("/");
                    })
                }
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
                  onClick={() => void useNoteStore.getState().resolveConflict("note", noteId, true)}
                >
                  Keep mine
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void useNoteStore.getState().resolveConflict("note", noteId, false)
                  }
                >
                  Use latest
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                onClick={() => void useNoteStore.getState().retry("note", noteId)}
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
