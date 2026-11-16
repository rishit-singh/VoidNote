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

export function HomeView() {
  const router = useRouter();
  const createNote = useNoteStore((state) => state.createNote);
  const ready = useNoteStore((state) => state.status === "ready");
  const notes = useNoteStore((state) => state.notes);
  const edits = useNoteStore((state) => state.edits);
  const [search, setSearch] = useState("");
  const result = useNotesQuery(useDebouncedValue(search.trim()));
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
      className="mx-auto flex w-full max-w-[960px] flex-[1_0_auto] flex-col gap-section px-[clamp(24px,5.5vw,80px)] pb-10 pt-14 [@media(max-width:760px)]:gap-[22px] [@media(max-width:760px)]:px-6 [@media(max-width:760px)]:pb-8 [@media(max-width:760px)]:pt-[30px]"
      aria-labelledby="notes-title"
    >
      <div className="flex min-h-11 items-center justify-between gap-4">
        <h1
          id="notes-title"
          className="m-0 text-title text-vn-text [@media(max-width:760px)]:text-[24px]"
        >
          Notes
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
            <EmptyTitle>{normalizedSearch ? "No matching notes" : "No notes yet"}</EmptyTitle>
            <EmptyDescription>
              {normalizedSearch
                ? "Try another search."
                : "Start with a new note. Your conversations will be kept here."}
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
                  <span className="truncate text-[14px] text-vn-text group-hover/note:underline group-hover/note:underline-offset-4">
                    {note.title || "Untitled note"}
                  </span>
                  <span className="truncate text-[12px] text-vn-muted">{meta}</span>
                </span>
                <span
                  className="flex size-11 flex-none items-center justify-center text-[16px] text-vn-muted [@media(max-width:760px)]:w-10"
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
    </section>
  );
}

export default HomeView;
