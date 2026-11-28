"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
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
import { SummaryPanel } from "@/components/summary/SummaryPanel";
import { AuthoredNote } from "@/components/authored-note";
import { AssistantPanel, type AssistantScrollPosition } from "@/components/assistant";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const sideBySideQuery = "(min-width: 1200px)";
const getWideLayout = () => window.matchMedia(sideBySideQuery).matches;
const getServerLayout = () => false;
type ComposerSelection = {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
};

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
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantExpanded, setAssistantExpanded] = useState(false);
  const noteLayoutRef = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const main = node.closest("main");
    const header = node.querySelector<HTMLElement>("[data-note-header]");
    if (!main || !header) return;
    let dock: HTMLElement | null = null;

    // Main owns note scrolling. Measure its usable viewport and the responsive
    // note header so the sticky panel never overlaps the title/tabs or composer.
    const measure = () => {
      const mainStyle = getComputedStyle(main);
      const viewportHeight =
        main.clientHeight -
        parseFloat(mainStyle.paddingTop) -
        parseFloat(mainStyle.paddingBottom) -
        (dock?.getBoundingClientRect().height ?? 0);
      node.style.setProperty("--note-viewport-height", `${viewportHeight}px`);
      node.style.setProperty("--note-header-height", `${header.getBoundingClientRect().height}px`);
    };
    const observer = new ResizeObserver(measure);
    const observeDock = () => {
      const nextDock = main.querySelector<HTMLElement>('section[aria-label="Audio recorder"]');
      if (nextDock !== dock) {
        if (dock) observer.unobserve(dock);
        dock = nextDock;
        if (dock) observer.observe(dock);
      }
      measure();
    };
    observeDock();
    observer.observe(main);
    observer.observe(header);
    // The shell may mount/unmount its dock after the note's ref attaches.
    const children = new MutationObserver(observeDock);
    children.observe(main, { childList: true });
    return () => {
      children.disconnect();
      observer.disconnect();
    };
  }, []);
  const assistantScrollPosition = useRef<AssistantScrollPosition | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const layoutFocus = useRef<{ scope: string; selection: ComposerSelection | null } | null>(null);
  const focusScope = `${epoch}:${session?.user.id}:${session?.workspace.id}:${noteId}`;
  const subscribeToLayout = useCallback(
    (onChange: () => void) => {
      const query = window.matchMedia(sideBySideQuery);
      const change = () => {
        const node = composer.current;
        layoutFocus.current = node
          ? {
              scope: focusScope,
              selection:
                document.activeElement === node
                  ? {
                      start: node.selectionStart,
                      end: node.selectionEnd,
                      direction: node.selectionDirection,
                    }
                  : null,
            }
          : null;
        onChange();
      };
      query.addEventListener("change", change);
      return () => query.removeEventListener("change", change);
    },
    [focusScope],
  );
  const wideLayout = useSyncExternalStore(subscribeToLayout, getWideLayout, getServerLayout);
  const onComposerReady = useCallback(
    (node: HTMLTextAreaElement | null) => {
      if (!node) return;
      composer.current = node;
      // The responsive host remounts, but its durable draft is restored before
      // this ref is attached. Restore DOM selection after the dialog autofocus.
      const frame = requestAnimationFrame(() => {
        const transfer = layoutFocus.current;
        if (transfer?.scope === focusScope && transfer.selection && node.isConnected) {
          node.focus({ preventScroll: true });
          node.setSelectionRange(
            transfer.selection.start,
            transfer.selection.end,
            transfer.selection.direction,
          );
        }
      });
      return () => {
        cancelAnimationFrame(frame);
        if (composer.current === node) composer.current = null;
      };
    },
    [focusScope],
  );
  const askTrigger = useRef<HTMLButtonElement>(null);
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
      <section
        className="flex w-full flex-[1_0_auto] flex-col gap-section px-[clamp(24px,5.5vw,80px)] pb-10 pt-14 [@media(max-width:760px)]:gap-[22px] [@media(max-width:760px)]:px-6 [@media(max-width:760px)]:pb-8 [@media(max-width:760px)]:pt-[30px]"
        aria-label="Note editor"
      >
        <Empty className="min-h-80 border-0 px-2 py-6 md:px-2 md:py-6">
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
      <section
        className="flex w-full flex-[1_0_auto] flex-col gap-section px-[clamp(24px,5.5vw,80px)] pb-10 pt-14 [@media(max-width:760px)]:gap-[22px] [@media(max-width:760px)]:px-6 [@media(max-width:760px)]:pb-8 [@media(max-width:760px)]:pt-[30px]"
        aria-label="Note editor"
      >
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
      <section
        className="flex w-full flex-[1_0_auto] flex-col gap-section px-[clamp(24px,5.5vw,80px)] pb-10 pt-14 [@media(max-width:760px)]:gap-[22px] [@media(max-width:760px)]:px-6 [@media(max-width:760px)]:pb-8 [@media(max-width:760px)]:pt-[30px]"
        aria-label="Note editor"
      >
        <div className="flex flex-col gap-4 text-vn-muted">
          <span role="status" aria-live="polite">
            Loading note…
          </span>
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-64 w-full" />
        </div>
        <Button asChild variant="ghost" className="self-start">
          <Link href="/">Back to notes</Link>
        </Button>
      </section>
    );

  return (
    <section
      ref={noteLayoutRef}
      className={cn(
        "vn-content-enter mx-auto flex min-w-0 w-full max-w-[912px] flex-[1_0_auto] flex-col px-14 pb-6 [@media(max-width:760px)]:px-6 [@media(max-width:760px)]:pb-4",
        assistantOpen && wideLayout && "max-w-none px-8",
      )}
      aria-labelledby="note-editor-title"
    >
      <Tabs defaultValue="transcript" className="flex min-w-0 flex-1 flex-col gap-5">
        <div
          data-note-header
          className="sticky top-0 z-10 flex shrink-0 flex-col gap-5 bg-vn-page pt-8 [@media(max-width:760px)]:gap-4 [@media(max-width:760px)]:pt-4"
        >
          <Link
            href="/"
            className="hidden items-center gap-2 text-vn-muted [@media(max-width:760px)]:inline-flex"
          >
            ← Notes
          </Link>
          <div className="flex shrink-0 items-start justify-between gap-5 [@media(min-width:761px)]:pr-32">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <h1 id="note-editor-title" className="sr-only">
                {note.title || "Untitled note"}
              </h1>
              <label className="sr-only" htmlFor="note-title">
                Title
              </label>
              <Input
                id="note-title"
                variant="noteTitle"
                maxLength={300}
                value={note.title}
                placeholder="Untitled note"
                disabled={locked}
                onChange={(event) => update({ title: event.target.value })}
              />
              <p className="m-0 text-meta text-vn-muted">
                {note.updatedAt
                  ? new Date(note.updatedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })
                  : "New note"}
              </p>
            </div>
            <NoteActions noteId={note.id} />
          </div>
          <div className="flex shrink-0 items-center justify-between gap-4 border-b border-vn-stroke">
            <TabsList variant="line" aria-label="Note content" className="border-b-0">
              <TabsTrigger variant="line" value="transcript">
                Transcript
              </TabsTrigger>
              <TabsTrigger variant="line" value="summary">
                Summary
              </TabsTrigger>
            </TabsList>
            {session &&
              !!note.revision &&
              (wideLayout ? (
                <Button
                  ref={askTrigger}
                  variant="workspace-ghost"
                  aria-expanded={assistantOpen}
                  aria-controls="note-ask-panel"
                  onClick={() => {
                    layoutFocus.current = null;
                    setAssistantOpen(!assistantOpen);
                    setAssistantExpanded(false);
                  }}
                >
                  Ask
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
              ) : (
                <Dialog
                  open={assistantOpen}
                  onOpenChange={(open) => {
                    layoutFocus.current = null;
                    setAssistantOpen(open);
                  }}
                >
                  <DialogTrigger asChild>
                    <Button variant="workspace-ghost">
                      Ask
                      <ArrowUpRight data-icon="inline-end" />
                    </Button>
                  </DialogTrigger>
                  <DialogContent
                    className="left-0 top-auto bottom-0 flex h-[85dvh] max-h-[85dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-t-xl px-6 pb-[calc(20px+env(safe-area-inset-bottom))] pt-4 sm:max-w-none sm:rounded-b-none"
                    onOpenAutoFocus={(event) => {
                      if (layoutFocus.current?.scope === focusScope) {
                        event.preventDefault();
                        if (!layoutFocus.current.selection && event.target instanceof HTMLElement) {
                          event.target.focus();
                        }
                      }
                    }}
                    onCloseAutoFocus={(event) => {
                      // Resizing is not closing Ask. The departing mobile dialog
                      // must not take focus back from the new desktop composer.
                      if (getWideLayout()) event.preventDefault();
                    }}
                  >
                    <DialogHeader className="sr-only">
                      <DialogTitle>Ask</DialogTitle>
                      <DialogDescription>Ask about this note and your workspace.</DialogDescription>
                    </DialogHeader>
                    <AssistantPanel
                      workspaceId={session.workspace.id}
                      noteId={note.id}
                      onComposerReady={onComposerReady}
                      scrollPosition={assistantScrollPosition}
                    />
                  </DialogContent>
                </Dialog>
              ))}
          </div>
        </div>
        <div
          className={cn(
            "min-w-0 flex-1",
            assistantOpen && wideLayout && "grid items-start gap-6",
            assistantOpen &&
              wideLayout &&
              (assistantExpanded
                ? "grid-cols-[minmax(280px,0.65fr)_minmax(0,1.35fr)]"
                : "grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]"),
          )}
        >
          <div className="flex min-w-0 flex-col gap-5" role="region" aria-label="Note content">
            {!!note.revision && session && (
              <AuthoredNote workspaceId={session.workspace.id} noteId={note.id} />
            )}
            <div className="shrink-0 empty:hidden [&:has(>section:empty)]:hidden">
              <NoteAudio noteId={note.id} />
            </div>
            <TabsContent value="transcript" className="mt-0">
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
            <TabsContent value="summary" className="mt-0">
              <SummaryPanel
                key={`${epoch}:${session?.user.id ?? "signed-out"}:${session?.workspace.id ?? "no-workspace"}:${note.id}`}
                noteId={note.id}
                workspaceId={session?.workspace.id ?? ""}
              />
            </TabsContent>
          </div>
          {assistantOpen && wideLayout && session && !!note.revision && (
            <aside
              id="note-ask-panel"
              className="sticky top-[calc(var(--note-header-height)+20px)] flex h-[calc(var(--note-viewport-height)-var(--note-header-height)-44px)] min-h-0 min-w-0 flex-col overflow-hidden rounded-[8px] border border-vn-stroke-strong bg-vn-surface p-5"
            >
              <AssistantPanel
                workspaceId={session.workspace.id}
                noteId={note.id}
                onComposerReady={onComposerReady}
                scrollPosition={assistantScrollPosition}
                expanded={assistantExpanded}
                onToggleExpanded={() => setAssistantExpanded((expanded) => !expanded)}
                onClose={() => {
                  layoutFocus.current = null;
                  setAssistantOpen(false);
                  setAssistantExpanded(false);
                  askTrigger.current?.focus();
                }}
              />
            </aside>
          )}
        </div>
      </Tabs>
    </section>
  );
}

export default NoteEditor;
