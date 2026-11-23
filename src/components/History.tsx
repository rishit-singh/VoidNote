"use client";

import { useEffect, useRef, useState } from "react";
import { Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { workspaceApi } from "@/lib/workspace-api";
import { useNoteStore } from "@/stores/use-note-store";
import { runEntityAction } from "@/lib/action-toasts";

type Entity = "note" | "person";
type HistoryPage = Awaited<ReturnType<typeof workspaceApi.history>>;

export function SaveControls({ entityType, entityId }: { entityType: Entity; entityId: string }) {
  const edit = useNoteStore((state) => state.edits[`${entityType}:${entityId}`]);
  if (!edit) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="icon"
          aria-label={`Save ${entityType === "person" ? "profile" : "note"}`}
          title="Save"
          disabled={edit.saving || !!edit.pending || edit.conflict !== null || !edit.dirty}
          onClick={() => void runEntityAction(entityType, entityId, "save")}
        >
          <Save />
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="icon"
          aria-label={`Delete ${entityType === "person" ? "profile" : "note"}`}
          title="Delete"
          disabled={edit.saving || !!edit.pending || edit.conflict !== null}
          onClick={() => void runEntityAction(entityType, entityId, "delete")}
        >
          <Trash2 />
        </Button>
        <span role="status" className="text-sm text-muted-foreground">
          {edit.saving
            ? "Request in progress"
            : edit.pending
              ? "Change outcome unknown"
              : edit.dirty
                ? "Unsaved changes"
                : "Saved"}
        </span>
      </div>
      {edit.error && (
        <Alert variant="destructive">
          <AlertDescription>{edit.error}</AlertDescription>
        </Alert>
      )}
      {edit.pending && !edit.saving && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">
            Could not confirm the save. Your changes are kept here.
          </p>
          <Button
            variant="outline"
            onClick={() => void runEntityAction(entityType, entityId, "retry")}
          >
            Retry pending change
          </Button>
        </div>
      )}
      {edit.conflict !== null && (
        <Alert variant="destructive" className="flex flex-col items-start gap-2 p-4">
          <p>This profile changed elsewhere. Your changes are kept here.</p>
          <p className="text-sm text-muted-foreground">
            Reload to discard it, or keep it on the latest revision and explicitly save again.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={edit.saving}
              onClick={() => void runEntityAction(entityType, entityId, "use-latest")}
            >
              Reload and discard draft
            </Button>
            <Button
              variant="secondary"
              disabled={edit.saving}
              onClick={() => void runEntityAction(entityType, entityId, "keep-draft")}
            >
              Rebase and keep draft
            </Button>
          </div>
        </Alert>
      )}
    </div>
  );
}

function HistoryContent({
  workspaceId,
  epoch,
  entityType,
  entityId,
}: {
  workspaceId: string;
  epoch: number;
  entityType: Entity;
  entityId: string;
}) {
  const [page, setPage] = useState<HistoryPage>({ items: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const busy = useRef(false);

  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    void workspaceApi
      .history(workspaceId, entityType, entityId)
      .then((result) => {
        if (!cancelled && useNoteStore.getState().epoch === epoch) {
          setPage(result);
          setLoading(false);
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled && useNoteStore.getState().epoch === epoch) {
          setError(failure instanceof Error ? failure.message : "Unable to load history.");
          setLoading(false);
          useNoteStore.getState().reportError(failure, epoch);
        }
      });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [workspaceId, epoch, entityType, entityId]);

  const load = async (more: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await workspaceApi.history(
        workspaceId,
        entityType,
        entityId,
        more ? page.nextCursor : null,
      );
      if (!mounted.current || useNoteStore.getState().epoch !== epoch) return;
      setPage((previous) => ({
        items: more
          ? [
              ...previous.items,
              ...result.items.filter((item) => !previous.items.some((old) => old.id === item.id)),
            ]
          : result.items,
        nextCursor: result.nextCursor,
      }));
    } catch (failure) {
      if (!mounted.current || useNoteStore.getState().epoch !== epoch) return;
      setError(failure instanceof Error ? failure.message : "Unable to load history.");
      useNoteStore.getState().reportError(failure, epoch);
    } finally {
      busy.current = false;
      if (mounted.current && useNoteStore.getState().epoch === epoch) setLoading(false);
    }
  };

  return (
    <section
      aria-label={`${entityType === "person" ? "Profile" : "Note"} history`}
      className="flex flex-col gap-4 rounded-lg border border-border p-4"
    >
      <h2 className="text-lg font-semibold">
        {entityType === "note" ? "Note" : "Profile"} history
      </h2>
      {loading && <Skeleton className="h-10 w-full" role="status" aria-label="Loading history" />}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!loading && !error && page.items.length === 0 && (
        <Empty className="min-h-24 border-0 p-4">
          <EmptyHeader>
            <EmptyTitle>No changes yet</EmptyTitle>
            <EmptyDescription>History will appear here after the first save.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <ol className="flex flex-col gap-4">
        {page.items.map((event) => (
          <li key={event.id} className="flex flex-col gap-1">
            <span className="font-medium">
              Revision {event.revision} · {event.operation}
            </span>
            <time className="text-sm text-muted-foreground" dateTime={event.createdAt}>
              {new Date(event.createdAt).toLocaleString()}
            </time>
            <span className="break-all text-xs text-muted-foreground">Actor: {event.actorId}</span>
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        {error && (
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => void load(page.items.length > 0)}
          >
            Retry history
          </Button>
        )}
        {page.nextCursor && (
          <Button variant="outline" disabled={loading} onClick={() => void load(true)}>
            Load more history
          </Button>
        )}
      </div>
    </section>
  );
}

export function History({ entityType, entityId }: { entityType: Entity; entityId: string }) {
  const session = useNoteStore((state) => state.session);
  const epoch = useNoteStore((state) => state.epoch);
  const revision = useNoteStore((state) =>
    entityType === "note"
      ? state.noteRecords[entityId]?.revision
      : state.personRecords[entityId]?.revision,
  );
  if (!session) return null;
  return (
    <HistoryContent
      key={`${epoch}:${entityType}:${entityId}:${revision}`}
      workspaceId={session.workspace.id}
      epoch={epoch}
      entityType={entityType}
      entityId={entityId}
    />
  );
}

export default History;
