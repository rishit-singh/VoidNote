"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { requestResearchSchema, type ResearchStatus } from "@/contracts/research";
import { asApiError } from "@/lib/api-error";
import {
  isResearchActive,
  researchAvailabilityQueryOptions,
  researchContactQueryOptions,
  researchListQueryOptions,
  runResearchCommand,
} from "@/queries/research";
import {
  pendingResearch,
  type PendingResearchCommand,
  type ResearchOperation,
  type ResearchRecoveryScope,
} from "@/stores/pending-research";
import { useNoteStore } from "@/stores/use-note-store";

import { ResearchFindings } from "./findings";

const statusLabels: Record<ResearchStatus, string> = {
  queued: "Queued",
  running: "Researching",
  "needs-input": "Needs more detail",
  partial: "Partial results",
  completed: "Complete",
  failed: "Failed",
  cancelled: "Stopped",
};
type Props = { workspaceId: string; personId: string; profileRevision: number };

export function ContactResearchPanel(props: Props) {
  const userId = useNoteStore((state) => state.session?.user.id);
  const workspaceId = useNoteStore((state) => state.session?.workspace.id);
  const epoch = useNoteStore((state) => state.epoch);
  if (!userId || workspaceId !== props.workspaceId) return null;
  return (
    <ScopedResearchPanel
      key={`${userId}:${workspaceId}:${epoch}:${props.personId}`}
      {...props}
      userId={userId}
    />
  );
}

function ScopedResearchPanel({
  userId,
  workspaceId,
  personId,
  profileRevision,
}: Props & { userId: string }) {
  const scope = useMemo<ResearchRecoveryScope>(
    () => ({ userId, workspaceId, personId }),
    [userId, workspaceId, personId],
  );
  const recovery = useMemo(() => pendingResearch(scope), [scope]);
  const local = useSyncExternalStore(
    recovery.subscribe,
    recovery.snapshot,
    recovery.serverSnapshot,
  );
  const availability = useQuery(researchAvailabilityQueryOptions(workspaceId));
  const contact = useQuery(researchContactQueryOptions(workspaceId, personId));
  const history = useQuery(researchListQueryOptions(workspaceId, personId));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const fieldId = useId();
  const pending = local.saved?.pending;
  const draft = local.saved?.draft;
  const batches = [...(history.data ?? [])].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  const latestUsefulBatch = batches.find((entry) =>
    entry.items.some(
      (entryItem) =>
        entryItem.personId === personId &&
        entryItem.findings.length > 0 &&
        (entryItem.status === "completed" || entryItem.status === "partial"),
    ),
  );
  const batch = batches.find((entry) => entry.id === selectedId) ?? latestUsefulBatch ?? batches[0];
  const item = batch?.items.find((entry) => entry.personId === personId);
  const latestBatch = batches[0];
  const latestItem = latestBatch?.items.find((entry) => entry.personId === personId);
  const active = batches.some((entry) =>
    entry.items.some(
      (entryItem) => entryItem.personId === personId && isResearchActive(entryItem.status),
    ),
  );
  const { mutate: resume, ...execution } = useMutation({
    mutationFn: (command: PendingResearchCommand) => runResearchCommand(scope, command),
  });
  const preparing = useMutation({
    mutationFn: (operation: ResearchOperation) => Promise.resolve(recovery.prepare(operation)),
  });
  const pendingId = pending?.id;
  const pendingStatus = pending?.status;
  useEffect(() => {
    if (pendingId && pendingStatus === "pending") {
      const command = recovery.read().pending;
      if (command?.id === pendingId) resume(command);
    }
  }, [pendingId, pendingStatus, recovery, resume]);

  const acceptedItem = execution.data?.items.find((entry) => entry.personId === personId);
  const awaitingSnapshot =
    execution.isSuccess &&
    isResearchActive(acceptedItem?.status) &&
    !batches.some(
      (entry) =>
        entry.id === execution.data.id &&
        entry.items.some(
          (entryItem) =>
            entryItem.personId === personId && entryItem.generation >= acceptedItem.generation,
        ),
    );
  const busy = !!pending || execution.isPending || preparing.isPending || awaitingSnapshot;
  const canRequest =
    local.status === "ready" &&
    availability.data?.enabled &&
    history.isSuccess &&
    !active &&
    !busy &&
    profileRevision > 0;
  const error = local.error ?? preparing.error ?? formError;
  const readError = availability.error ?? history.error;

  const changeDraft = (change: Partial<NonNullable<typeof draft>>) => {
    try {
      recovery.setDraft({ ...recovery.read().draft, ...change });
      setFormError(null);
    } catch (failure) {
      setFormError(asApiError(failure).message);
    }
  };
  const request = () => {
    if (!canRequest || !draft) return;
    try {
      const questions = draft.questions
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const sourceUrls = draft.urls
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (!questions.length || questions.length > 8)
        throw new Error("Add between one and eight questions, one per line.");
      if (!sourceUrls.length || sourceUrls.length > 4)
        throw new Error("Add between one and four public source URLs, one per line.");
      for (const value of sourceUrls) {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new Error("Use a complete HTTP or HTTPS source URL.");
        }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
          throw new Error("Use public HTTP or HTTPS URLs without credentials.");
        }
      }
      const parsed = requestResearchSchema.safeParse({
        workspaceId,
        requestId: crypto.randomUUID(),
        people: [
          {
            personId,
            expectedProfileRevision: profileRevision,
            ...(contact.data ? { expectedContactRevision: contact.data.revision } : {}),
            sourceUrls,
            requestedFacts: questions.map((question, index) => ({
              key: `fact_${index + 1}`,
              question,
            })),
          },
        ],
      });
      if (!parsed.success)
        throw new Error(parsed.error.issues[0]?.message ?? "Check your questions and URLs.");
      setFormError(null);
      setSelectedId(null);
      preparing.mutate({ kind: "request", input: parsed.data });
    } catch (failure) {
      setFormError(asApiError(failure).message);
    }
  };

  return (
    <section aria-label="Contact research" className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-medium">Research</h2>
        <p className="text-sm text-muted-foreground">
          Check specific questions against public pages you provide.
        </p>
      </header>
      {availability.data && !availability.data.enabled && (
        <Alert>
          <AlertDescription>
            {availability.data.reason ?? "Research is not enabled yet."}
          </AlertDescription>
        </Alert>
      )}
      {(error || readError) && (
        <Alert variant="destructive">
          <AlertDescription>
            {typeof error === "string" ? error : asApiError(error ?? readError).message}
            {readError && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void availability.refetch();
                  void history.refetch();
                }}
              >
                Retry loading
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          request();
        }}
      >
        <FieldGroup>
          <Field data-invalid={!!formError}>
            <FieldLabel htmlFor={`${fieldId}-questions`}>Questions to check</FieldLabel>
            <Textarea
              id={`${fieldId}-questions`}
              placeholder="What is their current role?"
              rows={3}
              maxLength={5000}
              value={draft?.questions ?? ""}
              disabled={local.status !== "ready"}
              aria-invalid={!!formError}
              onChange={(event) => changeDraft({ questions: event.target.value })}
            />
            <FieldDescription>One specific question per line, up to eight.</FieldDescription>
          </Field>
          <Field data-invalid={!!formError}>
            <FieldLabel htmlFor={`${fieldId}-urls`}>Public source URLs</FieldLabel>
            <Textarea
              id={`${fieldId}-urls`}
              placeholder="https://example.com/team/profile"
              rows={3}
              maxLength={10_000}
              value={draft?.urls ?? ""}
              disabled={local.status !== "ready"}
              aria-invalid={!!formError}
              onChange={(event) => changeDraft({ urls: event.target.value })}
            />
            <FieldDescription>
              One URL per line, up to four. Choose pages about this person.
            </FieldDescription>
            {!!contact.data?.links.length && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={local.status !== "ready"}
                onClick={() => {
                  const saved = recovery
                    .read()
                    .draft.urls.split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean);
                  const additions = [...new Set(contact.data.links.map((link) => link.url))]
                    .filter((url) => !saved.includes(url))
                    .slice(0, Math.max(0, 4 - saved.length));
                  changeDraft({ urls: [...saved, ...additions].join("\n") });
                }}
              >
                Add saved profile links
              </Button>
            )}
            {contact.error && (
              <FieldDescription>
                Saved profile links couldn’t load.{" "}
                <Button
                  type="button"
                  size="sm"
                  variant="link"
                  onClick={() => void contact.refetch()}
                >
                  Retry links
                </Button>
              </FieldDescription>
            )}
          </Field>
          <Button
            type="submit"
            disabled={!canRequest || !draft?.questions.trim() || !draft.urls.trim()}
          >
            Research this contact
          </Button>
        </FieldGroup>
      </form>
      <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
        {local.status === "loading" ? "Restoring your saved request…" : null}
        {execution.isPending ? "Sending your saved request…" : null}
        {awaitingSnapshot ? "Request accepted. Loading saved progress…" : null}
        {active ? "Research is running in the background." : null}
      </p>
      {pending && !execution.isPending && (
        <Alert variant={pending.status === "rejected" ? "destructive" : "default"}>
          <AlertDescription>
            <p>
              {pending.rejection ??
                "Confirmation hasn’t arrived. Retrying uses the same saved request."}
            </p>
            {pending.status === "pending" ? (
              <Button variant="outline" size="sm" onClick={() => resume(pending)}>
                Retry saved request
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => recovery.dismissRejected(pending.id)}
              >
                Dismiss
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      <Separator />
      {history.isPending && <Skeleton className="h-32 w-full" />}
      {history.isSuccess && !batches.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No research yet</EmptyTitle>
            <EmptyDescription>
              Saved answers, uncertainty, and supporting excerpts will appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {batches.length > 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          {active
            ? "A newer research attempt is still running. Your latest saved findings remain available below."
            : latestUsefulBatch && latestUsefulBatch.id !== batches[0]?.id
              ? "Showing the latest attempt with saved findings. Newer attempts remain in history."
              : null}
        </p>
      )}
      {latestBatch && latestItem && latestBatch.id !== batch?.id && (
        <section
          aria-label="Latest research attempt"
          className="flex flex-col gap-2 rounded-md border p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">Latest attempt</h3>
              <Badge variant={latestItem.status === "failed" ? "destructive" : "secondary"}>
                {statusLabels[latestItem.status]}
              </Badge>
            </div>
            <div className="flex gap-2">
              {isResearchActive(latestItem.status) && latestBatch.items.length === 1 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    preparing.mutate({
                      kind: "cancel",
                      input: { workspaceId, batchId: latestBatch.id },
                    })
                  }
                >
                  Stop research
                </Button>
              )}
              {latestItem.retryable && !isResearchActive(latestItem.status) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || active || !availability.data?.enabled}
                  onClick={() =>
                    preparing.mutate({
                      kind: "retry",
                      input: {
                        workspaceId,
                        batchId: latestBatch.id,
                        requestId: crypto.randomUUID(),
                        personId,
                        expectedGeneration: latestItem.generation,
                      },
                    })
                  }
                >
                  Retry research
                </Button>
              )}
            </div>
          </div>
          {latestItem.error && (
            <Alert variant="destructive">
              <AlertDescription>{latestItem.error}</AlertDescription>
            </Alert>
          )}
        </section>
      )}
      {batches.length > 1 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Research history ({batches.length})
          </summary>
          <div className="mt-3 flex flex-col gap-2">
            {batches.map((entry) => {
              const historyItem = entry.items.find((entryItem) => entryItem.personId === personId);
              return (
                <div key={entry.id} className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    {new Date(entry.createdAt).toLocaleString()} ·{" "}
                    {statusLabels[historyItem?.status ?? entry.status]}
                    {historyItem?.findings.length
                      ? ` · ${historyItem.findings.length} saved finding${historyItem.findings.length === 1 ? "" : "s"}`
                      : ""}
                  </span>
                  <Button
                    size="sm"
                    variant={entry.id === batch?.id ? "secondary" : "outline"}
                    onClick={() => setSelectedId(entry.id)}
                  >
                    {entry.id === batch?.id ? "Showing" : "View attempt"}
                  </Button>
                </div>
              );
            })}
          </div>
        </details>
      )}
      {batch && item && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">Saved research</h3>
              <Badge variant={item.status === "failed" ? "destructive" : "secondary"}>
                {statusLabels[item.status]}
              </Badge>
            </div>
            <div className="flex gap-2">
              {isResearchActive(item.status) && batch.items.length === 1 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    preparing.mutate({ kind: "cancel", input: { workspaceId, batchId: batch.id } })
                  }
                >
                  Stop research
                </Button>
              )}
              {item.retryable && !isResearchActive(item.status) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || active || !availability.data?.enabled}
                  onClick={() =>
                    preparing.mutate({
                      kind: "retry",
                      input: {
                        workspaceId,
                        batchId: batch.id,
                        requestId: crypto.randomUUID(),
                        personId,
                        expectedGeneration: item.generation,
                      },
                    })
                  }
                >
                  Retry research
                </Button>
              )}
            </div>
          </div>
          {(item.profileRevision !== profileRevision ||
            (contact.data && item.contactRevision !== contact.data.revision)) && (
            <p className="text-xs text-muted-foreground">
              This profile has changed since this research was saved.
            </p>
          )}
          {item.error && (
            <Alert>
              <AlertDescription>{item.error}</AlertDescription>
            </Alert>
          )}
          {item.status === "needs-input" && (
            <p className="text-sm text-muted-foreground">
              Add more specific questions or source pages above, then start a new request.
            </p>
          )}
          <ResearchFindings findings={item.findings} />
          {!item.findings.length && !isResearchActive(item.status) && (
            <p className="text-sm text-muted-foreground">
              No findings were saved for this request.
            </p>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Original questions and sources
            </summary>
            <ul className="mt-2 flex list-disc flex-col gap-2 pl-5">
              {item.requestedFacts.map((fact) => (
                <li key={fact.key}>{fact.question}</li>
              ))}
              {item.sourceUrls.map((url) => (
                <li key={url} className="break-all">
                  {url}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}
