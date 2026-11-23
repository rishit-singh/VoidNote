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

  if (!note) {
    const forbidden = unavailable === "forbidden";
    return (
      <section
        className="flex min-h-0 w-full flex-1 flex-col gap-section overflow-hidden px-[clamp(24px,5.5vw,80px)] pb-6 pt-14 [@media(min-height:481px)_and_(max-height:600px)]:!gap-3 [@media(min-height:481px)_and_(max-height:600px)]:!py-3 [@media(max-height:480px)]:!gap-1 [@media(max-height:480px)]:!py-1 [@media(max-height:480px)]:overflow-y-auto [@media(max-height:480px)]:overscroll-contain [@media(max-width:760px)]:gap-[18px] [@media(max-width:760px)]:px-6 [@media(max-width:760px)]:pt-[30px]"
        aria-label="Note editor"
      >
        <Link
          href="/"
          className="hidden shrink-0 self-start items-center gap-2 text-vn-muted [@media(max-width:760px)]:inline-flex"
        >
          ← Back to notes
        </Link>
        <div
          role="region"
          aria-label="Note status"
          tabIndex={0}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain [@media(max-height:480px)]:min-h-16 [@media(max-height:480px)]:shrink-0"
        >
          {unavailable ? (
            <Empty className="min-h-80 border-0 px-2 py-6 md:px-2 md:py-6">
              <EmptyHeader>
                <EmptyTitle>{forbidden ? "Note unavailable" : "Note not found"}</EmptyTitle>
                <EmptyDescription>
                  {forbidden
                    ? "You don’t have access to this note."
                    : "This note may have been deleted or the link may be incorrect."}
                </EmptyDescription>
              </EmptyHeader>
              <Button variant="ghost" onClick={() => void retry()}>
                Retry
              </Button>
            </Empty>
          ) : error ? (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-col items-start gap-3">
                <span>{error}</span>
                <Button variant="ghost" onClick={() => void retry()}>
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-col gap-[18px] text-vn-muted" role="status">
              <Skeleton className="h-8 w-2/3" />
              <Skeleton className="h-64 w-full" />
              <span>Loading note…</span>
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      className="mx-auto flex min-h-0 w-full max-w-[960px] flex-1 flex-col gap-section overflow-hidden px-[clamp(24px,5.5vw,80px)] pb-6 pt-14 [@media(min-height:481px)_and_(max-height:600px)]:!gap-3 [@media(min-height:481px)_and_(max-height:600px)]:!py-3 [@media(max-height:480px)]:!gap-1 [@media(max-height:480px)]:!py-1 [@media(max-height:480px)]:overflow-y-auto [@media(max-height:480px)]:overscroll-contain [@media(max-width:760px)]:gap-[18px] [@media(max-width:760px)]:px-6 [@media(max-width:760px)]:pt-[30px]"
      aria-labelledby="note-editor-title"
    >
      <header className="flex shrink-0 flex-col gap-section [@media(max-height:600px)]:!gap-3 [@media(max-height:480px)]:flex-row [@media(max-height:480px)]:items-center [@media(max-width:760px)]:gap-[18px]">
        <Link
          href="/"
          aria-label="Back to notes"
          className="hidden shrink-0 self-start items-center gap-2 text-vn-muted [@media(max-height:480px)]:min-h-11 [@media(max-height:480px)]:self-center [@media(max-width:760px)]:inline-flex"
        >
          <span className="[@media(max-height:480px)]:hidden">← Back to notes</span>
          <span className="hidden [@media(max-height:480px)]:inline">← Back</span>
        </Link>
        <div className="flex min-w-0 shrink-0 items-start justify-between gap-5 [@media(max-height:480px)]:flex-1 [@media(max-height:480px)]:items-center [@media(max-height:480px)]:gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 id="note-editor-title" className="sr-only">
              {note.title || "Untitled note"}
            </h1>
            <label className="sr-only" htmlFor="note-title">
              Title
            </label>
            <Input
              id="note-title"
              variant="title"
              maxLength={300}
              value={note.title}
              placeholder="Untitled note"
              aria-describedby="note-title-hint"
              disabled={locked}
              onChange={(event) => update({ title: event.target.value })}
            />
            <p className="m-0 text-meta text-vn-muted [@media(max-height:480px)]:sr-only">
              {note.updatedAt ? new Date(note.updatedAt).toLocaleString() : "New note"}
            </p>
            <p
              id="note-title-hint"
              className="m-0 text-meta text-vn-muted [@media(max-height:480px)]:sr-only"
            >
              Rename this note anytime
            </p>
          </div>
          <div className="max-h-[25dvh] max-w-[50%] overflow-y-auto overscroll-contain [@media(max-height:480px)]:max-h-11">
            <NoteActions noteId={note.id} />
          </div>
        </div>
      </header>
      <Tabs
        defaultValue="transcript"
        className="flex min-h-0 flex-1 flex-col [@media(max-height:480px)]:min-h-24 [@media(max-height:480px)]:shrink-0"
      >
        <TabsList
          variant="line"
          aria-label="Note content"
          className="shrink-0 [@media(max-height:480px)]:h-8"
        >
          <TabsTrigger variant="line" value="transcript" className="[@media(max-height:480px)]:h-8">
            Transcript
          </TabsTrigger>
          <TabsTrigger variant="line" value="summary" className="[@media(max-height:480px)]:h-8">
            Summary
          </TabsTrigger>
        </TabsList>
        <TabsContent
          value="transcript"
          className="mt-0 min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <NoteAudio noteId={note.id} />
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
        <TabsContent
          value="summary"
          className="mt-0 min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <NoteAudio noteId={note.id} />
          <div
            className="flex min-h-[190px] flex-col justify-center gap-2 border-b border-vn-stroke text-vn-muted"
            role="status"
          >
            <h2 className="m-0 text-[15px] font-medium text-vn-text">
              Summary isn’t available yet
            </h2>
            <p className="m-0 max-w-[560px]">
              Your conversation summary will appear here when this feature is ready.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}

export default NoteEditor;
