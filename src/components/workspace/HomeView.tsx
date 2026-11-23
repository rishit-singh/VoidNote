"use client";

import { useState } from "react";
import { useNotesQuery } from "@/hooks/use-workspace-queries";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useNoteStore } from "@/stores/use-note-store";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { MagnifyingGlassIcon } from "@radix-ui/react-icons";
import { cn } from "@/lib/utils";
import { useWorkspaceOverview } from "@/queries/workspace";
import { HomeMetrics, RecentRecordings } from "./home-overview";

export function HomeView() {
  const router = useRouter();
  const createNote = useNoteStore((state) => state.createNote);
  const ready = useNoteStore((state) => state.status === "ready");
  const notes = useNoteStore((state) => state.notes);
  const edits = useNoteStore((state) => state.edits);
  const [search, setSearch] = useState("");
  const result = useNotesQuery(useDebouncedValue(search.trim()));
  const overview = useWorkspaceOverview();
  const notesLoading = result.isFetching;
  const notesError = result.error?.message;
  const notesCursor = result.hasNextPage;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const drafts = notes.filter(
    (note) =>
      !note.revision || edits[`note:${note.id}`]?.dirty || edits[`note:${note.id}`]?.pending,
  );
  const draftIds = new Set(drafts.map((note) => note.id));
  const visibleNotes = [
    ...drafts,
    ...(result.data?.pages.flatMap((page) => page.items) ?? []).filter(
      (note) => !draftIds.has(note.id),
    ),
  ].filter((note) =>
    (note.title || "Untitled note").toLocaleLowerCase().startsWith(normalizedSearch),
  );

  return (
    <section
      className="mx-auto flex min-h-0 w-full min-w-0 max-w-[1100px] flex-1 flex-col gap-8 overflow-hidden px-6 pb-6 pt-10 sm:px-10 [@media(max-height:600px)]:!gap-3 [@media(max-height:600px)]:!py-3 [@media(max-width:760px)]:gap-6 [@media(max-width:760px)]:px-6 [@media(max-width:760px)]:pt-[30px]"
      aria-labelledby="home-title"
    >
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-4">
        <h1
          id="home-title"
          className="m-0 text-title text-vn-text [@media(max-width:760px)]:text-[24px]"
        >
          Home
        </h1>
        <Button
          variant="workspace-outline"
          className="h-11"
          aria-label="New note"
          disabled={!ready}
          onClick={() => {
            const note = createNote();
            router.push(`/notes/${encodeURIComponent(note.id)}`);
          }}
        >
          + New note
        </Button>
      </div>
      <div
        role="region"
        aria-label="Home content"
        tabIndex={0}
        className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto overscroll-contain min-[1100px]:overflow-hidden [@media(max-height:600px)]:!overflow-y-auto"
      >
        <HomeMetrics overview={overview} />
        <div className="grid min-h-0 min-w-0 shrink-0 grid-cols-1 gap-8 min-[1100px]:flex-1 min-[1100px]:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)] min-[1100px]:grid-rows-[minmax(0,1fr)] min-[1100px]:gap-10 [@media(min-width:1100px)_and_(max-height:600px)]:min-h-[280px]">
          <section
            aria-labelledby="notes-title"
            className="flex max-h-[60dvh] min-h-0 min-w-0 flex-col gap-4 min-[1100px]:max-h-none"
          >
            <h2
              id="notes-title"
              className="sticky top-0 z-[1] m-0 flex min-h-9 shrink-0 items-center bg-vn-page text-[16px] font-medium leading-6 text-vn-text"
            >
              Notes
            </h2>
            <div className="flex h-[46px] flex-none items-center gap-3 rounded-[4px] border border-vn-stroke px-3.5">
              <MagnifyingGlassIcon
                className="size-4 flex-none fill-none stroke-vn-muted stroke-[1.2]"
                aria-hidden="true"
              />
              <label className="sr-only" htmlFor="note-search">
                Search notes
              </label>
              <Input
                variant="search"
                id="note-search"
                type="search"
                maxLength={200}
                placeholder="Search notes"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div
              role="region"
              aria-label="Notes list"
              tabIndex={0}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            >
              {notesLoading && visibleNotes.length === 0 && (
                <div className="flex flex-col" role="status" aria-label="Loading notes">
                  <Skeleton variant="row" className="h-[92px]" />
                  <Skeleton variant="row" className="h-[92px]" />
                  <Skeleton variant="row" className="h-[92px]" />
                </div>
              )}
              {notesError && (
                <Alert variant="error">
                  <AlertDescription>{notesError}</AlertDescription>
                  <Button variant="outline" onClick={() => void result.refetch()}>
                    Try again
                  </Button>
                </Alert>
              )}
              {!notesLoading && !notesError && visibleNotes.length === 0 && (
                <Empty variant="notes">
                  <EmptyHeader>
                    <EmptyTitle>
                      {normalizedSearch ? "No matching notes" : "No notes yet"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {normalizedSearch
                        ? "Try another search."
                        : "Create a note to start recording."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              <ul className="m-0 flex list-none flex-col p-0" aria-label="Notes">
                {visibleNotes.map((note) => {
                  const edit = edits[`note:${note.id}`];
                  const date = note.updatedAt
                    ? new Date(note.updatedAt)
                    : note.createdAt
                      ? new Date(note.createdAt)
                      : null;
                  const meta = edit?.dirty
                    ? "Unsaved changes"
                    : !note.revision
                      ? "Draft"
                      : date && !Number.isNaN(date.valueOf())
                        ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
                        : "Draft";
                  return (
                    <li key={note.id}>
                      <Link
                        href={`/notes/${encodeURIComponent(note.id)}`}
                        className="group/note flex min-h-[92px] items-center gap-3 border-b border-vn-stroke py-[18px] [@media(max-width:760px)]:min-h-[86px]"
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-[7px]">
                          <span className="truncate text-[14px] leading-5 text-vn-text group-hover/note:underline group-hover/note:underline-offset-4">
                            {note.title || "Untitled note"}
                          </span>
                          <span className="truncate text-[12px] leading-[18px] text-vn-muted">
                            {meta}
                          </span>
                        </span>
                        <span
                          className="flex size-11 flex-none items-center justify-center text-[16px] text-vn-muted"
                          aria-hidden="true"
                        >
                          ↗
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {notesCursor && (
                <Button
                  className={cn("mt-5 self-start", notesLoading && "opacity-50")}
                  variant="ghost"
                  disabled={notesLoading}
                  onClick={() => void result.fetchNextPage()}
                >
                  Load more notes
                </Button>
              )}
            </div>
          </section>
          <RecentRecordings overview={overview} />
        </div>
      </div>
    </section>
  );
}

export default HomeView;
