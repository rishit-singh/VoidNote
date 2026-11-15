"use client";

import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { type CorrectedTurn } from "@/contracts/transcript-corrections";
import { getQueryRuntime } from "@/lib/query-runtime";
import { useNoteStore } from "@/stores/use-note-store";

type Props = {
  noteId: string;
  runId: string;
  disabled?: boolean;
};

const escapeMarkdown = (value: string) => value.replace(/([\\`*_{}[\]<>()#+.!|~>-])/g, "\\$1");
const timestamp = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;

function markdown(turns: CorrectedTurn[]) {
  return [
    "# Transcript",
    ...turns.map((turn) => {
      const speaker =
        turn.assignment.kind === "unknown"
          ? `Unknown speaker (${turn.speakerLabel})`
          : turn.assignment.kind === "person"
            ? `${turn.personName ?? "Speaker"} (${turn.speakerLabel})`
            : turn.speakerLabel;
      return `## ${timestamp(turn.startSeconds)}–${timestamp(turn.endSeconds)} · ${escapeMarkdown(speaker)}\n\n${escapeMarkdown(turn.text)}`;
    }),
    "",
  ].join("\n\n");
}

export function TranscriptDownload(props: Props) {
  const session = useNoteStore((state) => state.session);
  const epoch = useNoteStore((state) => state.epoch);
  if (process.env.NEXT_PUBLIC_TRANSCRIPT_MARKDOWN_EXPORT !== "true" || !session) return null;
  return (
    <ScopedTranscriptDownload
      key={`${epoch}:${session.user.id}:${session.workspace.id}:${props.noteId}:${props.runId}`}
      {...props}
    />
  );
}

function ScopedTranscriptDownload({ noteId, runId, disabled }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function download() {
    if (disabled || inFlight.current || !mounted.current) return;
    const { session, epoch } = useNoteStore.getState();
    if (!session) return;
    const owned = () => {
      const current = useNoteStore.getState();
      return (
        mounted.current &&
        current.epoch === epoch &&
        current.session?.user.id === session.user.id &&
        current.session?.workspace.id === session.workspace.id
      );
    };
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const runtime = getQueryRuntime();
      const turns: CorrectedTurn[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        if (!owned()) return;
        const page: { items: CorrectedTurn[]; nextCursor: string | null } =
          await runtime.queryClient.fetchQuery(
            runtime.trpc.transcripts.page.queryOptions(
              { workspaceId: session.workspace.id, noteId, runId, ...(cursor ? { cursor } : {}) },
              { staleTime: 0, trpc: { abortOnUnmount: true } },
            ),
          );
        if (!owned()) return;
        turns.push(...page.items);
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (seen.has(cursor))
            throw new Error("Could not load the full transcript. Please retry.");
          seen.add(cursor);
        }
      } while (cursor !== null);
      const blob = new Blob([markdown(turns)], { type: "text/markdown;charset=utf-8" });
      if (!owned()) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `transcript-${noteId.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`;
      document.body.appendChild(link);
      try {
        if (owned()) link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (failure) {
      if (owned())
        setError(failure instanceof Error ? failure.message : "Could not download transcript.");
    } finally {
      inFlight.current = false;
      if (owned()) setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || busy}
        aria-busy={busy}
        onClick={() => void download()}
      >
        <Download data-icon="inline-start" aria-hidden="true" />
        {busy ? "Preparing Markdown…" : "Download Markdown"}
      </Button>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
