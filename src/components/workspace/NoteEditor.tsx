"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { NoteActions } from "./note-actions";
import { NoteAudio } from "@/components/recording";
import { ProcessingPanel } from "@/components/recording/processing-panel";
import { useAudioPlaybackStore } from "@/stores/use-audio-playback-store";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useNoteEditor } from "@/hooks/use-note-editor";
import { useNoteStore } from "@/stores/use-note-store";

export function NoteEditor({
  noteId,
  initialPlayback,
}: {
  noteId: string;
  initialPlayback?: { recordingId: string; seconds: number } | undefined;
}) {
  const { note, unavailable, error, update, retry, locked } = useNoteEditor(noteId);
  const epoch = useNoteStore((state) => state.epoch);
  const session = useNoteStore((state) => state.session);
  const consumedBookmark = useRef<string | null>(null);
  const loadedId = note?.id;
  const recordingId = initialPlayback?.recordingId;
  const seconds = initialPlayback?.seconds;
  useEffect(() => {
    if (!loadedId || unavailable || !recordingId || seconds === undefined) return;
    const state = useNoteStore.getState();
    const ownedNote = state.noteRecords[loadedId];
    if (
      !session ||
      state.epoch !== epoch ||
      state.session?.user.id !== session.user.id ||
      ownedNote?.workspaceId !== session.workspace.id ||
      ownedNote.deletedAt
    )
      return;
    const bookmark = `${epoch}:${session.user.id}:${session.workspace.id}:${loadedId}:${recordingId}:${seconds}`;
    if (consumedBookmark.current === bookmark) return;
    consumedBookmark.current = bookmark;
    // Profile appearance links select the same persistent player as transcript
    // timestamps. Loading a link queues its position without starting autoplay.
    void useAudioPlaybackStore.getState().loadRemote({ noteId: loadedId, recordingId }, seconds);
  }, [loadedId, unavailable, recordingId, seconds, epoch, session]);

  if (!note && unavailable) {
    const forbidden = unavailable === "forbidden";
    return (
      <section className="vn-page" aria-label="Note editor">
        <Empty className="vn-missing-record">
          <EmptyHeader>
            <EmptyTitle>{forbidden ? "Note unavailable" : "Note not found"}</EmptyTitle>
            <EmptyDescription>
              {forbidden
                ? "You don’t have access to this note."
                : "This note may have been deleted or the link may be incorrect."}
            </EmptyDescription>
          </EmptyHeader>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link href="/">Back to notes</Link>
            </Button>
            <Button variant="ghost" onClick={() => void retry()}>
              Retry
            </Button>
          </div>
        </Empty>
      </section>
    );
  }
  if (!note && error)
    return (
      <section className="vn-page" aria-label="Note editor">
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{error}</span>
            <div className="flex gap-2">
              <Button asChild variant="outline">
                <Link href="/">Back to notes</Link>
              </Button>
              <Button variant="ghost" onClick={() => void retry()}>
                Retry
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </section>
    );
  if (!note)
    return (
      <section className="vn-page" aria-label="Note editor">
        <div className="vn-record-loading" role="status">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-64 w-full" />
          <span>Loading note…</span>
        </div>
        <Button asChild variant="ghost" className="self-start">
          <Link href="/">Back to notes</Link>
        </Button>
      </section>
    );

  return (
    <section className="vn-page vn-note-editor" aria-labelledby="note-editor-title">
      <Link href="/" className="vn-mobile-back-link">
        ← Notes
      </Link>
      <div className="vn-note-heading">
        <div className="vn-note-heading-copy">
          <h1 id="note-editor-title" className="sr-only">
            {note.title || "Untitled note"}
          </h1>
          <label className="sr-only" htmlFor="note-title">
            Title
          </label>
          <Input
            id="note-title"
            className="vn-title-input"
            maxLength={300}
            value={note.title}
            placeholder="Untitled note"
            disabled={locked}
            onChange={(event) => update({ title: event.target.value })}
          />
          <p className="vn-note-date">
            {note.updatedAt ? new Date(note.updatedAt).toLocaleString() : "New note"}
          </p>
        </div>
        <NoteActions noteId={note.id} />
      </div>
      <NoteAudio noteId={note.id} />
      <Tabs defaultValue="transcript" className="vn-note-tabs">
        <TabsList className="vn-tabs" aria-label="Note content">
          <TabsTrigger value="transcript">Transcript</TabsTrigger>
          <TabsTrigger value="summary">Summary</TabsTrigger>
        </TabsList>
        <TabsContent value="transcript" className="vn-tab-content">
          {!!note.revision && (
            <ProcessingPanel
              noteId={note.id}
              onSeek={(seconds, recordingId) => {
                const player = useAudioPlaybackStore.getState();
                void player
                  .loadRemote({ noteId: note.id, recordingId }, seconds)
                  .then((selected) => {
                    if (selected) void player.play();
                  });
              }}
            />
          )}
        </TabsContent>
        <TabsContent value="summary" className="vn-tab-content">
          <div className="vn-unavailable" role="status">
            <h2>Summary isn’t available yet</h2>
            <p>Your conversation summary will appear here when this feature is ready.</p>
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}

export default NoteEditor;
