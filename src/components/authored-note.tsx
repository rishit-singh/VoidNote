"use client";

import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { getQueryRuntime } from "@/lib/query-runtime";

export function AuthoredNote({ workspaceId, noteId }: { workspaceId: string; noteId: string }) {
  const { trpc } = getQueryRuntime();
  const artifacts = useQuery(
    trpc.assistant.artifacts.queryOptions(
      { workspaceId, noteId },
      { enabled: Boolean(workspaceId) },
    ),
  );
  const authored = artifacts.data?.find((artifact) => artifact.kind === "note");

  if (artifacts.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Authored note content could not be loaded.</AlertDescription>
      </Alert>
    );
  }

  return authored ? <AuthoredContent workspaceId={workspaceId} artifactId={authored.id} /> : null;
}

function AuthoredContent({ workspaceId, artifactId }: { workspaceId: string; artifactId: string }) {
  const { trpc } = getQueryRuntime();
  const detail = useQuery(trpc.assistant.artifact.queryOptions({ workspaceId, id: artifactId }));

  if (detail.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Saved content is unavailable.</AlertDescription>
      </Alert>
    );
  }

  if (!detail.data) {
    return <p role="status">Loading saved content…</p>;
  }

  return (
    <article aria-label="Authored note" className="prose max-w-none">
      <ReactMarkdown>{detail.data.content}</ReactMarkdown>
    </article>
  );
}
