"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { getQueryRuntime } from "@/lib/query-runtime";
import { useNoteStore } from "@/stores/use-note-store";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";

export function PersonAppearances({ personId }: { personId: string }) {
  const session = useNoteStore((state) => state.session);
  const epoch = useNoteStore((state) => state.epoch);
  if (!session) return null;
  return (
    <ScopedAppearances
      key={`${epoch}:${session.user.id}:${session.workspace.id}:${personId}`}
      personId={personId}
      workspaceId={session.workspace.id}
    />
  );
}

function ScopedAppearances({ personId, workspaceId }: { personId: string; workspaceId: string }) {
  const { trpc } = getQueryRuntime();
  const query = useInfiniteQuery(
    trpc.people.appearances.infiniteQueryOptions(
      { workspaceId, id: personId },
      {
        trpc: { abortOnUnmount: true },
        getNextPageParam: (last) => last.nextCursor ?? undefined,
      },
    ),
  );
  const page = query.data
    ? {
        items: query.data.pages.flatMap((item) => item.items),
        nextCursor: query.data.pages.at(-1)?.nextCursor,
      }
    : null;
  const loading = query.isFetching;
  const error = query.error?.message;
  const load = async (cursor?: string) => {
    if (cursor) await query.fetchNextPage();
    else await query.refetch();
  };
  return (
    <section aria-label="Recording appearances" className="flex min-h-0 flex-col gap-4 py-5">
      <Separator />
      <div className="sticky top-0 z-[1] flex shrink-0 flex-wrap items-center justify-between gap-3 bg-vn-page py-2">
        <h3 className="text-sm font-medium">Recording appearances</h3>
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
          Refresh appearances
        </Button>
      </div>
      <div
        role="region"
        aria-label="Appearance list"
        tabIndex={0}
        className="flex max-h-[50dvh] min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain [&>*]:shrink-0"
      >
        {error && (
          <Alert variant="destructive">
            <AlertDescription>
              {error}
              <Button variant="link" disabled={loading} onClick={() => void load()}>
                Retry appearances
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {loading && <Skeleton className="h-16 w-full" aria-label="Loading appearances" />}
        {page?.items.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No appearances yet</EmptyTitle>
              <EmptyDescription>Speech assigned to this profile will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <ol className="flex flex-col gap-4">
          {page?.items.map((item) => (
            <li key={`${item.runId}:${item.utteranceId}`} className="flex flex-col gap-1">
              <Button
                asChild
                variant="link"
                className="h-auto justify-start whitespace-normal px-0"
              >
                <Link
                  href={`/notes/${item.noteId}?recordingId=${item.recordingId}&at=${item.startSeconds}`}
                >
                  {item.noteTitle || "Untitled note"} · {Math.floor(item.startSeconds / 60)}:
                  {Math.floor(item.startSeconds % 60)
                    .toString()
                    .padStart(2, "0")}
                </Link>
              </Button>
              <p className="line-clamp-2 text-sm text-muted-foreground">{item.text}</p>
            </li>
          ))}
        </ol>
        {page?.nextCursor && (
          <Button variant="outline" disabled={loading} onClick={() => void load(page.nextCursor!)}>
            More appearances
          </Button>
        )}
      </div>
    </section>
  );
}
