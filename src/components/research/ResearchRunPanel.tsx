"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import type { ResearchRunDetail, ResearchRunStatus } from "@/contracts/research/runs";
import { asApiError } from "@/lib/api-error";
import {
  cancelResearchRun,
  isResearchRunActive,
  researchRunListQueryOptions,
  researchRunQueryOptions,
} from "@/queries/research-runs";
import { useNoteStore } from "@/stores/use-note-store";

const statusLabels: Record<ResearchRunStatus, string> = {
  queued: "Queued",
  running: "Researching",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
};

const stageLabels: Record<ResearchRunDetail["stage"], string> = {
  queued: "Waiting to start",
  planning: "Planning research",
  retrieving: "Gathering sources",
  analyzing: "Reviewing evidence",
  synthesizing: "Preparing findings",
  publishing: "Saving report",
  finished: "Research finished",
};

const outcomeLabels = {
  supported: "Supported",
  conflicting: "Conflicting evidence",
  "insufficient-evidence": "Insufficient evidence",
  failed: "Could not verify",
} as const;

const qualityLabels = {
  answered: "Answered",
  partial: "Partial",
  conflicting: "Conflicting",
  "insufficient-evidence": "Insufficient evidence",
} as const;

function safeCitationHref(rawUrl: string) {
  try {
    const url = new URL(rawUrl);

    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function RunStatus({ run }: { run: ResearchRunDetail }) {
  const quality = run.quality ?? run.report?.quality ?? null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>
        {statusLabels[run.status]}
      </Badge>
      {run.status === "completed" && quality && (
        <Badge variant="outline" aria-label={`Result quality: ${qualityLabels[quality]}`}>
          {qualityLabels[quality]}
        </Badge>
      )}
      {isResearchRunActive(run.status) && (
        <span className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {stageLabels[run.stage]}
        </span>
      )}
    </div>
  );
}

function RunFinding({ finding }: { finding: ResearchRunDetail["findings"][number] }) {
  return (
    <article className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h3 className="min-w-0 flex-1 break-words font-medium">{finding.question}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{outcomeLabels[finding.outcome]}</Badge>
          {finding.classification && (
            <Badge variant="secondary">
              {finding.classification === "deduction" ? "Deduction" : "Direct evidence"}
            </Badge>
          )}
        </div>
      </div>
      {finding.statement && <p className="text-sm leading-6">{finding.statement}</p>}
      {finding.explanation && (
        <p className="text-sm leading-6 text-muted-foreground">{finding.explanation}</p>
      )}
      {!!finding.citations.length && (
        <ul className="flex list-none flex-col gap-3 p-0">
          {finding.citations.map((citation, index) => (
            <li
              key={`${citation.sourceId}:${citation.startOffset}:${index}`}
              className="flex min-w-0 flex-col gap-1 border-l-2 pl-3 text-sm"
            >
              <blockquote className="break-words text-muted-foreground">
                “{citation.excerpt}”
              </blockquote>
              {safeCitationHref(citation.url) ? (
                <a
                  href={safeCitationHref(citation.url)!}
                  target="_blank"
                  rel="noreferrer"
                  className="w-fit break-all text-primary underline-offset-4 hover:underline"
                >
                  {citation.url}
                </a>
              ) : (
                <span className="break-all text-muted-foreground">{citation.url}</span>
              )}
              <time dateTime={citation.retrievedAt} className="text-xs text-muted-foreground">
                Retrieved {citation.retrievedAt.slice(0, 10)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

export function ResearchRunPanel({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  const userId = useNoteStore((state) => state.session?.user.id);
  const currentWorkspaceId = useNoteStore((state) => state.session?.workspace.id);
  const epoch = useNoteStore((state) => state.epoch);

  if (!userId || currentWorkspaceId !== workspaceId) return null;

  return (
    <ScopedResearchRunPanel
      key={`${userId}:${workspaceId}:${epoch}:${runId}`}
      workspaceId={workspaceId}
      runId={runId}
    />
  );
}

export function WorkspaceResearchRunPage({ runId }: { runId: string }) {
  const workspaceId = useNoteStore((state) => state.session?.workspace.id);

  if (!workspaceId) return null;

  return <ResearchRunPanel workspaceId={workspaceId} runId={runId} />;
}

function ScopedResearchRunPanel({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  const query = useQuery(researchRunQueryOptions(workspaceId, runId));
  const cancel = useMutation({
    mutationFn: () => cancelResearchRun(workspaceId, runId),
  });
  const run = query.data;
  const findings = run?.report?.findings ?? run?.findings ?? [];
  const gaps = run?.report?.gaps ?? run?.gaps ?? [];
  const readError = query.error;

  if (query.isPending && !run) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </main>
    );
  }

  if (!run) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8 sm:px-6">
        <Alert variant="destructive">
          <AlertTitle>Research could not be loaded</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{asApiError(readError).message}</span>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Retry loading
            </Button>
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  const date = new Date(run.updatedAt);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-3">
        <Link
          href={run.noteId ? `/notes/${run.noteId}` : "/"}
          className="w-fit text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {run.noteId ? "Back to note" : "Back to workspace"}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Research</h1>
            <p className="text-base leading-7">{run.question}</p>
            <p className="text-sm text-muted-foreground">
              Updated{" "}
              <time dateTime={run.updatedAt}>
                {Number.isNaN(date.getTime()) ? run.updatedAt : date.toLocaleString()}
              </time>
            </p>
          </div>
          {isResearchRunActive(run.status) && (
            <Button
              variant="outline"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              {cancel.isPending ? "Stopping…" : "Stop research"}
            </Button>
          )}
        </div>
        <RunStatus run={run} />
      </header>

      {readError && (
        <Alert>
          <AlertTitle>Showing the last saved research</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>Refresh failed: {asApiError(readError).message}</span>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Retry loading
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {cancel.error && (
        <Alert variant="destructive">
          <AlertTitle>Stop was not confirmed</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{asApiError(cancel.error).message}</span>
            <Button variant="outline" size="sm" onClick={() => cancel.mutate()}>
              Try stopping again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {run.report && (
        <Card>
          <CardHeader>
            <CardTitle>Answer</CardTitle>
            <CardDescription>Research report</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap break-words text-sm leading-7">{run.report.answer}</p>
          </CardContent>
        </Card>
      )}

      {!!findings.length && (
        <section aria-labelledby="research-findings-heading" className="flex flex-col gap-4">
          <h2 id="research-findings-heading" className="text-lg font-semibold">
            Findings
          </h2>
          <div className="flex flex-col gap-5">
            {findings.map((finding, index) => (
              <div key={finding.id} className="flex flex-col gap-5">
                {index > 0 && <Separator />}
                <RunFinding finding={finding} />
              </div>
            ))}
          </div>
        </section>
      )}

      {!!gaps.length && (
        <section aria-labelledby="research-gaps-heading" className="flex flex-col gap-3">
          <h2 id="research-gaps-heading" className="text-lg font-semibold">
            Still unknown
          </h2>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-6 text-muted-foreground">
            {gaps.map((gap, index) => (
              <li key={`${gap}:${index}`}>{gap}</li>
            ))}
          </ul>
        </section>
      )}

      {run.error && (
        <Alert variant="destructive">
          <AlertTitle>Research stopped before completion</AlertTitle>
          <AlertDescription>{run.error}</AlertDescription>
        </Alert>
      )}
      {!run.report && !findings.length && isResearchRunActive(run.status) && (
        <p className="text-sm text-muted-foreground">
          Your report will appear here when research is saved.
        </p>
      )}
      {!run.report && !findings.length && !isResearchRunActive(run.status) && !run.error && (
        <p className="text-sm text-muted-foreground">No validated findings were saved.</p>
      )}
    </main>
  );
}

export function ResearchRunTasks({
  workspaceId,
  threadId,
  noteId,
}: {
  workspaceId: string;
  threadId: string;
  noteId: string;
}) {
  const query = useQuery(
    researchRunListQueryOptions(workspaceId, {
      threadId,
      noteId,
      status: "all",
      limit: 6,
    }),
  );
  const runs = query.data ?? [];

  if (!runs.length && !query.error) return null;

  return (
    <section aria-label="Research tasks" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium text-muted-foreground">Research tasks</h3>
        {query.isFetching && (
          <span className="text-xs text-muted-foreground" role="status">
            Refreshing
          </span>
        )}
      </div>
      {query.error && (
        <Alert variant={runs.length ? "default" : "destructive"}>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {runs.length
                ? "Some saved tasks may be out of date."
                : "Research tasks could not load."}
            </span>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Retry tasks
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <ul className="flex list-none flex-col gap-2 p-0">
        {runs.map((run) => (
          <li key={run.id}>
            <Link
              href={`/research/${run.id}`}
              className="flex min-w-0 items-start justify-between gap-3 rounded-md border px-3 py-2.5 hover:bg-muted/50"
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="line-clamp-2 text-sm font-medium">{run.question}</span>
                {run.report?.answer && (
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {run.report.answer}
                  </span>
                )}
              </span>
              <Badge
                variant={run.status === "failed" ? "destructive" : "secondary"}
                className="shrink-0"
              >
                {statusLabels[run.status]}
              </Badge>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
