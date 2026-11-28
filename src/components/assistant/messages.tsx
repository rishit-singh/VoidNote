"use client";

import Link from "next/link";
import { useMutation } from "@tanstack/react-query";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AssistantMarkdown } from "@/components/assistant/markdown";
import type { AssistantMessage, AssistantSource, AssistantToolResult } from "@/contracts/assistant";
import { asApiError } from "@/lib/api-error";
import { playAudioRange, useAudioPlaybackStore } from "@/stores/use-audio-playback-store";
import { useNoteStore } from "@/stores/use-note-store";

function sourceHref(source: AssistantSource) {
  if (source.kind === "note") return `/notes/${encodeURIComponent(source.id)}`;
  if (source.kind === "person") return `/profiles/${encodeURIComponent(source.id)}`;
  if (source.kind === "transcript" && source.noteId)
    return `/notes/${encodeURIComponent(source.noteId)}`;
  if (source.kind === "url" && source.url) {
    const url = new URL(source.url);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  }
  return null;
}

export function Sources({
  sources,
  onArtifact,
}: {
  sources: AssistantSource[];
  onArtifact: (id: string) => void;
}) {
  const currentNoteId = useNoteStore((state) => state.currentNoteId);
  const playback = useMutation({
    mutationFn: async (source: AssistantSource) => {
      if (
        !source.noteId ||
        source.noteId !== currentNoteId ||
        !source.recordingId ||
        source.startSeconds === undefined
      )
        return;
      if (source.endSeconds !== undefined && source.endSeconds > source.startSeconds) {
        await playAudioRange(
          source.noteId,
          source.recordingId,
          source.startSeconds,
          source.endSeconds,
        );
      } else {
        const player = useAudioPlaybackStore.getState();
        if (
          await player.loadRemote(
            { noteId: source.noteId, recordingId: source.recordingId },
            source.startSeconds,
          )
        ) {
          await player.play();
        }
      }
    },
  });
  if (!sources.length) return null;
  return (
    <details className="min-w-0 text-sm [overflow-wrap:anywhere]">
      <summary className="cursor-pointer text-muted-foreground">Sources ({sources.length})</summary>
      <ul className="mt-2 flex list-none flex-col gap-2 p-0">
        {sources.map((source, index) => {
          const href = sourceHref(source);
          return (
            <li key={`${source.kind}:${source.id}:${index}`} className="min-w-0">
              {href ? (
                <Link
                  href={href}
                  className="underline underline-offset-4"
                  {...(source.kind === "url"
                    ? { target: "_blank", rel: "noopener noreferrer" }
                    : {})}
                >
                  {source.label}
                </Link>
              ) : source.kind === "artifact" ? (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto max-w-full whitespace-normal text-left"
                  onClick={() => onArtifact(source.id)}
                >
                  {source.label}
                </Button>
              ) : (
                <span>{source.label}</span>
              )}
              {source.kind === "transcript" &&
                source.noteId === currentNoteId &&
                source.recordingId &&
                source.startSeconds !== undefined && (
                  <Button
                    variant="link"
                    size="sm"
                    disabled={playback.isPending}
                    onClick={() => playback.mutate(source)}
                    aria-label={`Play source: ${source.label}`}
                  >
                    Play at {Math.floor(source.startSeconds / 60)}:
                    {String(Math.floor(source.startSeconds % 60)).padStart(2, "0")}
                  </Button>
                )}
            </li>
          );
        })}
      </ul>
      {playback.error && (
        <Alert variant="destructive">
          <AlertDescription>{asApiError(playback.error).message}</AlertDescription>
        </Alert>
      )}
    </details>
  );
}

const toolStatus: Record<AssistantToolResult["status"], string> = {
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
  uncertain: "Outcome unconfirmed",
};
const toolNames: Record<string, string> = {
  notes_search: "Find notes",
  notes_get: "Read note",
  contacts_search: "Find contacts",
  contacts_get: "Read contact",
  artifact_create: "Create item",
  memory_recall: "Recall saved context",
  memory_remember: "Save memory",
  memory_invalidate: "Forget saved context",
  research_dispatch: "Request research",
};

export function Message({
  message,
  onArtifact,
}: {
  message: AssistantMessage;
  onArtifact: (id: string) => void;
}) {
  return (
    <article
      data-message-id={message.id}
      className="flex min-w-0 flex-col gap-3"
      aria-label={message.role === "user" ? "You" : "Assistant response"}
    >
      <h3 className="text-xs font-medium text-muted-foreground">
        {message.role === "user" ? "You" : "Assistant"}
      </h3>
      {message.text && <AssistantMarkdown content={message.text} />}
      {!!message.tools.length && <ToolActivity tools={message.tools} onArtifact={onArtifact} />}
      <Sources sources={message.sources} onArtifact={onArtifact} />
    </article>
  );
}

function ToolActivity({
  tools,
  onArtifact,
}: {
  tools: AssistantToolResult[];
  onArtifact: (id: string) => void;
}) {
  const attention = tools.filter((tool) => tool.status === "failed" || tool.status === "uncertain");
  const running = tools.filter((tool) => tool.status === "running").length;
  return (
    <div className="flex min-w-0 flex-col gap-2 text-xs [overflow-wrap:anywhere]">
      {attention.map((tool) => (
        <p key={tool.id} role="status">
          <Badge variant={tool.status === "failed" ? "destructive" : "secondary"}>
            {toolStatus[tool.status]}
          </Badge>{" "}
          {toolNames[tool.name] ?? tool.name.replaceAll("_", " ")}: {tool.summary}
        </p>
      ))}
      <details>
        <summary className="cursor-pointer text-muted-foreground">
          Tool activity ({tools.length}){running > 0 ? ` · ${running} running` : ""}
          {attention.length > 0 ? ` · ${attention.length} need attention` : ""}
        </summary>
        <div className="mt-2 flex min-w-0 flex-col gap-2 border-l border-vn-stroke pl-3">
          {tools.map((tool) => (
            <details key={tool.id}>
              <summary className="cursor-pointer">
                {toolNames[tool.name] ?? tool.name.replaceAll("_", " ")}
                <span className="ml-2 text-muted-foreground">{toolStatus[tool.status]}</span>
              </summary>
              <div className="my-2 flex min-w-0 flex-col gap-2">
                <p className="whitespace-pre-wrap">{tool.summary}</p>
                <Sources sources={tool.sources} onArtifact={onArtifact} />
              </div>
            </details>
          ))}
        </div>
      </details>
    </div>
  );
}
