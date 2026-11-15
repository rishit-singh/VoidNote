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
    <section className="vn-page vn-home" aria-labelledby="notes-title">
      <div className="vn-page-heading">
        <h1 id="notes-title">Notes</h1>
        <Button
          variant="outline"
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
      <div className="vn-search">
        <MagnifyingGlassIcon aria-hidden="true" />
        <label className="sr-only" htmlFor="note-search">
          Search notes
        </label>
        <Input
          id="note-search"
          type="search"
          maxLength={200}
          placeholder="Search notes"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {notesLoading && visibleNotes.length === 0 && (
        <div className="vn-note-skeleton" role="status" aria-label="Loading notes">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      )}
      {notesError && (
        <Alert variant="destructive" className="vn-error">
          <AlertDescription>{notesError}</AlertDescription>
          <Button variant="outline" onClick={() => void result.refetch()}>
            Try again
          </Button>
        </Alert>
      )}
      {!notesLoading && !notesError && visibleNotes.length === 0 && (
        <Empty className="vn-empty">
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
      <ul className="vn-note-list" aria-label="Notes">
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
              <Link href={`/notes/${encodeURIComponent(note.id)}`} className="vn-note-row">
                <span className="vn-note-copy">
                  <span className="vn-note-title">{note.title || "Untitled note"}</span>
                  <span className="vn-note-meta">{meta}</span>
                </span>
                <span className="vn-note-arrow" aria-hidden="true">
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
