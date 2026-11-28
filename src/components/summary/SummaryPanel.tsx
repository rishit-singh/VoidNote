"use client";

import { useMemo, useReducer, useRef, useState } from "react";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import Link from "next/link";
import { asApiError } from "@/lib/api-error";
import {
  cancelSummary,
  isDefiniteSummaryRejection,
  requestSummary,
  summaryEvidenceQueryOptions,
  summaryHistoryQueryOptions,
  summaryJobQueryOptions,
  summaryOverviewQueryOptions,
  summaryResultQueryOptions,
} from "@/queries/summaries";
import { pendingSummaryCommands, type PendingSummaryCommand } from "@/stores/pending-summaries";
import { useAudioPlaybackStore } from "@/stores/use-audio-playback-store";
import { useNoteStore } from "@/stores/use-note-store";
import type { AnalysisJob, SummaryAnalysis } from "@/contracts/analysis";

function displaySummaryError(error: string) {
  // Older jobs used this fallback for both provider and publication failures.
  return error === "The Summary provider failed before a valid answer was produced."
    ? "The latest summary could not be completed."
    : error;
}

function SummaryText({
  citations,
  text,
  evidence,
  onCitation,
}: {
  citations: { evidenceId: string; quote: string }[];
  text: string;
  evidence: Map<string, { startSeconds: number; recordingId: string }>;
  onCitation: (recordingId: string, seconds: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-[15px] leading-6 text-vn-secondary">{text}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {citations.map((citation, index) => {
          const source = evidence.get(citation.evidenceId);
          return source ? (
            <Button
              key={`${citation.evidenceId}:${index}`}
              type="button"
              variant="workspace-ghost"
              size="sm"
              className="h-auto min-h-8 px-0"
              aria-label={`Play source: ${citation.quote}`}
              title={citation.quote}
              onClick={() => onCitation(source.recordingId, source.startSeconds)}
            >
              ↗ {Math.floor(source.startSeconds / 60)}:
              {String(Math.floor(source.startSeconds % 60)).padStart(2, "0")}
            </Button>
          ) : null;
        })}
      </div>
    </div>
  );
}

function Statements({
  items,
  evidence,
  onCitation,
}: {
  items: SummaryAnalysis["quickSummary"];
  evidence: Map<string, { startSeconds: number; recordingId: string }>;
  onCitation: (recordingId: string, seconds: number) => void;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-4 p-0">
      {items.map((item, index) => (
        <li key={`${item.text}:${index}`}>
          <SummaryText {...item} evidence={evidence} onCitation={onCitation} />
        </li>
      ))}
    </ul>
  );
}

function AnalysisView({
  analysis,
  evidence,
  onCitation,
}: {
  analysis: SummaryAnalysis;
  evidence: Map<string, { startSeconds: number; recordingId: string }>;
  onCitation: (recordingId: string, seconds: number) => void;
}) {
  return (
    <div className="flex flex-col gap-7">
      <section aria-labelledby="summary-quick">
        <h3 id="summary-quick" className="mb-3 text-[20px] font-medium leading-7">
          At a glance
        </h3>
        <Statements items={analysis.quickSummary} evidence={evidence} onCitation={onCitation} />
      </section>
      {analysis.decisions.length > 0 && (
        <section aria-labelledby="summary-decisions">
          <h3 id="summary-decisions" className="mb-3 text-label font-medium">
            Decisions
          </h3>
          <Statements items={analysis.decisions} evidence={evidence} onCitation={onCitation} />
        </section>
      )}
      <section aria-labelledby="summary-next">
        <h3 id="summary-next" className="mb-3 text-label font-medium">
          Next steps
        </h3>
        {analysis.nextSteps.length ? (
          <ul className="flex list-none flex-col gap-4 p-0">
            {analysis.nextSteps.map((step, index) => (
              <li key={`${step.action.text}:${index}`} className="flex flex-col gap-1">
                <SummaryText {...step.action} evidence={evidence} onCitation={onCitation} />
                {(step.dueDate || step.ownerPersonId) && (
                  <p className="mt-1 text-sm text-vn-muted">
                    {step.ownerPersonId && (
                      <Link
                        className="underline underline-offset-4"
                        href={`/profiles/${encodeURIComponent(step.ownerPersonId)}`}
                      >
                        Assigned person
                      </Link>
                    )}
                    {step.ownerPersonId && step.dueDate ? " · " : ""}
                    {step.dueDate ? `Due ${step.dueDate}` : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-vn-muted">No next steps were identified.</p>
        )}
      </section>
      <section aria-labelledby="summary-moments">
        <h3 id="summary-moments" className="mb-3 text-label font-medium">
          Key moments
        </h3>
        {analysis.keyMoments.length ? (
          <ul className="flex list-none flex-col gap-4 p-0">
            {analysis.keyMoments.map((moment, index) => (
              <li key={`${moment.title}:${index}`}>
                <h4 className="mb-1 font-medium">{moment.title}</h4>
                <SummaryText {...moment.significance} evidence={evidence} onCitation={onCitation} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-vn-muted">No key moments were identified.</p>
        )}
      </section>
      {(analysis.detailedSummary.length > 0 || analysis.keywords.length > 0) && (
        <details className="text-sm">
          <summary className="cursor-pointer text-vn-muted">More detail</summary>
          <div className="mt-4 flex flex-col gap-4">
            <Statements
              items={analysis.detailedSummary}
              evidence={evidence}
              onCitation={onCitation}
            />
            <div className="flex flex-wrap gap-2" aria-label="Keywords">
              {analysis.keywords.map((keyword) => (
                <Badge key={keyword} variant="secondary">
                  {keyword}
                </Badge>
              ))}
            </div>
          </div>
        </details>
      )}
      {analysis.uncertainties.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-vn-muted">What needs clarification</summary>
          <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-vn-secondary">
            {analysis.uncertainties.map((uncertainty, index) => (
              <li key={`${index}:${uncertainty}`}>{uncertainty}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function SummaryPanel({ noteId, workspaceId }: { noteId: string; workspaceId: string }) {
  const session = useNoteStore((state) => state.session);
  const epoch = useNoteStore((state) => state.epoch);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, refreshRecovery] = useReducer((revision: number) => revision + 1, 0);
  const submittingRef = useRef(false);
  const overview = useQuery(summaryOverviewQueryOptions(workspaceId, noteId));
  const history = useInfiniteQuery(summaryHistoryQueryOptions(workspaceId, noteId));
  const activeLatestJob = overview.data?.latestJob ?? null;
  const activeLatestJobQuery = useQuery(
    summaryJobQueryOptions(
      workspaceId,
      activeLatestJob &&
        (activeLatestJob.status === "queued" || activeLatestJob.status === "running")
        ? activeLatestJob.id
        : "",
    ),
  );
  const liveActiveLatestJob = activeLatestJobQuery.data ?? activeLatestJob;
  const latestSavedJobId =
    overview.data?.latestSummaryJobId ??
    history.data?.pages.flatMap((page) => page.items)[0]?.jobId ??
    null;
  const jobId = selectedJobId ?? latestSavedJobId ?? liveActiveLatestJob?.id ?? null;
  const selectedJob = useQuery(summaryJobQueryOptions(workspaceId, jobId ?? ""));
  const job: AnalysisJob | undefined =
    selectedJob.data ??
    (selectedJobJobId(activeLatestJob, jobId) ? (activeLatestJob ?? undefined) : undefined);
  const result = useQuery({
    ...summaryResultQueryOptions(workspaceId, job?.id ?? ""),
    enabled: job?.status === "succeeded",
    placeholderData: (previous) => (previous?.summary.noteId === noteId ? previous : undefined),
  });
  const evidence = useQuery({
    ...summaryEvidenceQueryOptions(workspaceId, result.data?.summary.jobId ?? ""),
    enabled: !!result.data,
  });
  const sourceMap = useMemo(
    () =>
      new Map(
        (evidence.data?.passages ?? []).map((passage) => [
          passage.evidenceId,
          { startSeconds: passage.startSeconds, recordingId: evidence.data!.source.recordingId },
        ]),
      ),
    [evidence.data],
  );
  const canUsePending =
    typeof window !== "undefined" && !!session && session.workspace.id === workspaceId;
  const recoveryStore = useMemo(
    () => (canUsePending && session ? pendingSummaryCommands(session) : null),
    [canUsePending, session],
  );
  const recovery = recoveryStore?.snapshot();
  const pending = recovery?.commands.find((command) => command.noteId === noteId) ?? null;
  const historyItems = history.data?.pages.flatMap((page) => page.items) ?? [];
  const isCurrentOwner = () => {
    const current = useNoteStore.getState();
    return (
      !!session &&
      current.epoch === epoch &&
      current.session?.user.id === session.user.id &&
      current.session.workspace.id === session.workspace.id &&
      session.workspace.id === workspaceId
    );
  };

  const playCitation = (recordingId: string, seconds: number) => {
    const player = useAudioPlaybackStore.getState();
    void player.loadRemote({ noteId, recordingId }, seconds).then((loaded) => {
      if (loaded) {
        void player.play();
      }
    });
  };
  const submit = async (retry = false) => {
    if (!session || submittingRef.current || !isCurrentOwner()) return;
    setError(null);
    submittingRef.current = true;
    setSubmitting(true);
    const commands = pendingSummaryCommands(session);
    let command: PendingSummaryCommand | null = null;
    try {
      const existing = commands.forNote(noteId);
      if (!retry && existing) {
        throw new Error("Retry the saved summary request before creating another.");
      }
      command = retry ? existing : await commands.prepareExclusive(noteId);
      refreshRecovery();
      if (!command) throw new Error("No saved request is available to retry.");
      if (command.status === "rejected") {
        throw new Error("Dismiss the rejected request before creating another summary.");
      }
      await requestSummary(workspaceId, {
        commandId: command.commandId,
        noteId: command.noteId,
        userId: command.userId,
      });
      if (!isCurrentOwner()) return;
      commands.acknowledge(command);
      setSelectedJobId(null);
    } catch (cause) {
      if (isCurrentOwner()) {
        const failure = asApiError(cause);
        if (command && isDefiniteSummaryRejection(cause)) {
          try {
            commands.reject(command, failure.message);
            refreshRecovery();
          } catch {
            // Preserve the original response and surface recovery persistence failure below.
          }
        }
        setError(failure.message || "Summary request could not be confirmed.");
      }
    } finally {
      submittingRef.current = false;
      if (isCurrentOwner()) setSubmitting(false);
    }
  };
  const dismissRejected = () => {
    if (!pending || pending.status !== "rejected" || !recoveryStore) return;
    try {
      recoveryStore.acknowledge(pending);
      refreshRecovery();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Saved request could not be cleared.");
    }
  };
  const cancel = async () => {
    if (!liveActiveLatestJob || !isCurrentOwner()) return;
    setError(null);
    try {
      await cancelSummary(workspaceId, liveActiveLatestJob.id);
    } catch (cause) {
      if (isCurrentOwner()) {
        setError(cause instanceof Error ? cause.message : "Cancellation could not be confirmed.");
      }
    }
  };

  if (overview.isPending)
    return <Skeleton className="h-40 w-full" role="status" aria-label="Loading summary" />;
  if (overview.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex items-center justify-between gap-3">
          <span>{overview.error.message}</span>
          <Button variant="outline" onClick={() => void overview.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );

  return (
    <div className="flex min-w-0 flex-col gap-7 pb-8">
      <div className="order-last flex flex-wrap items-center justify-between gap-3">
        <h2 className="sr-only">Conversation summary</h2>
        <div className="flex flex-wrap gap-2">
          {pending &&
            (pending.status === "pending" ? (
              <Button variant="outline" disabled={submitting} onClick={() => void submit(true)}>
                {submitting ? "Retrying…" : "Retry saved request"}
              </Button>
            ) : (
              <Button variant="outline" onClick={dismissRejected}>
                Dismiss rejected request
              </Button>
            ))}
          {liveActiveLatestJob &&
          (liveActiveLatestJob.status === "queued" || liveActiveLatestJob.status === "running") ? (
            <Button variant="outline" onClick={() => void cancel()}>
              Cancel generation
            </Button>
          ) : (
            <Button
              variant={result.data ? "outline" : "default"}
              disabled={!overview.data.canGenerate || submitting || !!pending || !!recovery?.error}
              onClick={() => void submit()}
            >
              {submitting ? "Requesting…" : result.data ? "Regenerate summary" : "Generate summary"}
            </Button>
          )}
        </div>
      </div>
      {overview.data.unavailableReason && (
        <Empty className="min-h-36 border-0 px-0 py-5 md:px-0">
          <EmptyHeader>
            <EmptyTitle>
              {overview.data.canGenerate ? "Summary not ready" : "Transcript required"}
            </EmptyTitle>
            <EmptyDescription>{overview.data.unavailableReason}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {result.isError && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>Could not load this saved summary: {result.error.message}</span>
            <Button variant="outline" onClick={() => void result.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {history.isError && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>Could not load summary history: {history.error.message}</span>
            <Button variant="outline" onClick={() => void history.refetch()}>
              Retry history
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {liveActiveLatestJob && liveActiveLatestJob.id !== jobId && (
        <section aria-label="Latest summary attempt" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">Latest summary refresh</h3>
            <Badge
              variant={
                ["failed", "blocked"].includes(liveActiveLatestJob.status)
                  ? "destructive"
                  : "secondary"
              }
            >
              {liveActiveLatestJob.status === "queued"
                ? "Queued"
                : liveActiveLatestJob.status === "running"
                  ? "Generating"
                  : liveActiveLatestJob.status}
            </Badge>
          </div>
          {liveActiveLatestJob.error && (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-col gap-2">
                <p>{displaySummaryError(liveActiveLatestJob.error)}</p>
                <p>Your saved transcript and speaker changes are unaffected.</p>
              </AlertDescription>
            </Alert>
          )}
        </section>
      )}
      {pending &&
        (pending.status === "pending" ? (
          <p role="status" className="text-sm text-vn-muted">
            We haven’t received confirmation yet. Your request is saved; retrying won’t create a
            duplicate summary.
          </p>
        ) : (
          <Alert variant="destructive">
            <AlertDescription>
              This request was rejected and will not be retried automatically. {pending.rejection}
            </AlertDescription>
          </Alert>
        ))}
      {recovery?.error && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>Saved request recovery could not be read: {recovery.error.message}</span>
            <Button variant="outline" onClick={refreshRecovery}>
              Retry recovery
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {historyItems.length > 0 && (
        <details className="order-last text-sm">
          <summary className="cursor-pointer text-vn-muted">
            Summary history ({historyItems.length}
            {history.hasNextPage ? "+" : ""})
          </summary>
          <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Saved summaries">
            {historyItems.map((item) => (
              <Button
                key={item.jobId}
                size="sm"
                variant={jobId === item.jobId ? "secondary" : "outline"}
                aria-pressed={jobId === item.jobId}
                onClick={() => setSelectedJobId(item.jobId)}
              >
                {item.jobId === latestSavedJobId ? "Latest · " : ""}
                {new Date(item.createdAt).toLocaleString()}
              </Button>
            ))}
            {history.hasNextPage && (
              <Button size="sm" variant="ghost" onClick={() => void history.fetchNextPage()}>
                Older
              </Button>
            )}
          </div>
        </details>
      )}
      {result.data ? (
        <div className="flex flex-col gap-5">
          {(result.data.freshness === "stale" || result.isPlaceholderData || selectedJobId) && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-vn-muted">
              {result.data.freshness === "stale" && (
                <Badge variant="outline">Transcript changed since this summary</Badge>
              )}
              {result.isPlaceholderData && <span>Loading selected summary…</span>}
              <span>Saved {new Date(result.data.summary.createdAt).toLocaleString()}</span>
            </div>
          )}
          {evidence.isError && (
            <Alert>
              <AlertDescription>
                Source links are temporarily unavailable. The saved summary is still shown.
              </AlertDescription>
            </Alert>
          )}
          {result.data.summary.analysis.engagement.limitations.length > 0 && (
            <details className="order-last text-sm text-vn-muted">
              <summary className="cursor-pointer">About this summary</summary>
              <p className="mt-3">
                {result.data.summary.analysis.engagement.limitations.join(" ")}
              </p>
            </details>
          )}
          <AnalysisView
            analysis={result.data.summary.analysis}
            evidence={sourceMap}
            onCitation={playCitation}
          />
        </div>
      ) : job?.status === "queued" || job?.status === "running" ? (
        <div role="status" className="flex items-center gap-3 py-5">
          <Skeleton className="h-5 w-5 rounded-full" />
          <span>
            {job.status === "queued" ? "Summary is queued…" : "Summary is being generated…"}
          </span>
        </div>
      ) : job && ["failed", "blocked", "cancelled", "superseded"].includes(job.status) ? (
        <Alert variant="destructive">
          <AlertDescription>
            {(job.error ? displaySummaryError(job.error) : null) ??
              (job.status === "cancelled"
                ? "Summary stopped. You can generate another when you’re ready."
                : "This summary couldn’t be completed. You can try again.")}
          </AlertDescription>
        </Alert>
      ) : !jobId ? (
        <Empty className="min-h-36 border-0 px-0 py-5 md:px-0">
          <EmptyHeader>
            <EmptyTitle>No summary yet</EmptyTitle>
            <EmptyDescription>
              Get the main points, next steps, and key moments from this conversation.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : result.isPending ? (
        <Skeleton className="h-32 w-full" role="status" aria-label="Loading saved summary" />
      ) : null}
    </div>
  );
}

function selectedJobJobId(latestJob: AnalysisJob | null, jobId: string | null) {
  return !!latestJob && latestJob.id === jobId;
}
