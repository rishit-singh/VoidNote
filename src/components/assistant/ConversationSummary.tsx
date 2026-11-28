"use client";

import { Badge } from "@/components/ui/badge";
import type { ConversationSummary as SavedConversationSummary } from "@/contracts/conversation-summaries";

import { Sources } from "./messages";

const statusLabels: Record<SavedConversationSummary["status"], string> = {
  queued: "Queued",
  running: "Summarizing",
  succeeded: "Saved",
  failed: "Failed",
  stale: "Sources changed",
};

export function ConversationSummary({
  summary,
  refreshFailed,
  onArtifact,
}: {
  summary: SavedConversationSummary;
  refreshFailed: boolean;
  onArtifact: (id: string) => void;
}) {
  const pending = summary.status === "queued" || summary.status === "running";
  return (
    <section aria-label="Conversation summary">
      <details className="rounded-md border p-3 text-sm">
        <summary className="cursor-pointer">
          <span className="mr-2 font-medium">Conversation recap</span>
          <Badge variant={summary.status === "failed" ? "destructive" : "secondary"}>
            {statusLabels[summary.status]}
          </Badge>
          <span className="mt-1 block text-xs text-muted-foreground">
            {summary.messageCount} earlier messages
          </span>
        </summary>
        <div className="mt-3 flex min-w-0 flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            A recap of earlier messages in this conversation.
          </p>
          {pending && <p role="status">Preparing a recap of earlier messages…</p>}
          {summary.status === "failed" && (
            <p role="status">{summary.error ?? "The background summary could not be completed."}</p>
          )}
          {summary.status === "stale" && (
            <p role="status">Some sources have changed. Check the original messages and sources.</p>
          )}
          {(summary.status === "succeeded" || summary.status === "stale") && summary.text && (
            <p className="whitespace-pre-wrap break-words leading-7">{summary.text}</p>
          )}
          <Sources sources={summary.sources} onArtifact={onArtifact} />
          <p className="text-xs text-muted-foreground">
            {summary.completedAt ? "Completed " : "Requested "}
            <time dateTime={summary.completedAt ?? summary.createdAt}>
              {new Date(summary.completedAt ?? summary.createdAt).toLocaleString()}
            </time>
          </p>
          {refreshFailed && (
            <p className="text-xs text-muted-foreground">
              Couldn’t refresh the summary. Showing the last saved record.
            </p>
          )}
        </div>
      </details>
    </section>
  );
}
