"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import Link from "next/link";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { asApiError } from "@/lib/api-error";
import { getQueryRuntime } from "@/lib/query-runtime";
import { assistantArtifactQueryOptions } from "@/queries/assistant";

import { Sources } from "./messages";

export function ArtifactPreview({
  workspaceId,
  id,
  onClose,
  onArtifact,
}: {
  workspaceId: string;
  id: string;
  onClose: () => void;
  onArtifact: (id: string) => void;
}) {
  const artifact = useQuery(assistantArtifactQueryOptions(workspaceId, id));
  const download = useMutation({
    mutationFn: async () => {
      const runtime = getQueryRuntime();
      const identity = runtime.identity;
      if (identity?.workspaceId !== workspaceId) throw new Error("Your workspace changed.");
      // Download through the authorized detail endpoint, never an assumed public R2 URL.
      const current = await runtime.queryClient.fetchQuery(
        assistantArtifactQueryOptions(workspaceId, id),
      );
      if (getQueryRuntime() !== runtime) return;
      const url = URL.createObjectURL(new Blob([current.content], { type: current.mediaType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      const name = Array.from(current.name)
        .map((character) =>
          character.charCodeAt(0) < 32 || "/\\".includes(character) ? "_" : character,
        )
        .join("");
      anchor.download = /\.[a-z0-9]+$/i.test(name)
        ? name
        : `${name}${current.mediaType === "text/markdown" ? ".md" : ".txt"}`;
      anchor.click();
      URL.revokeObjectURL(url);
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] max-w-2xl">
        <DialogHeader>
          <DialogTitle>{artifact.data?.name ?? "Created item"}</DialogTitle>
          <DialogDescription>Saved by Assistant in this workspace.</DialogDescription>
        </DialogHeader>
        {artifact.isPending && <Skeleton className="h-32 w-full" />}
        {(artifact.error || download.error) && (
          <Alert variant="destructive">
            <AlertDescription>
              {asApiError(artifact.error ?? download.error).message}
              {artifact.error && (
                <Button variant="outline" size="sm" onClick={() => void artifact.refetch()}>
                  Retry
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
        {artifact.data && (
          <>
            <ScrollArea className="max-h-[50dvh] [&>[data-radix-scroll-area-viewport]]:max-h-[50dvh]">
              <pre className="whitespace-pre-wrap break-words pr-4 font-sans text-sm leading-7">
                {artifact.data.content}
              </pre>
            </ScrollArea>
            <Sources sources={artifact.data.sources} onArtifact={onArtifact} />
            <div className="flex flex-wrap gap-2">
              {artifact.data.noteId && (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/notes/${encodeURIComponent(artifact.data.noteId)}`}>Open note</Link>
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={download.isPending}
                onClick={() => download.mutate()}
              >
                <Download data-icon="inline-start" />
                {download.isPending ? "Preparing…" : "Download"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
