"use client";

import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUp, Maximize2, Minimize2, Square, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefCallback,
  type RefObject,
} from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { AssistantMarkdown } from "@/components/assistant/markdown";
import { ResearchRunTasks } from "@/components/research/ResearchRunPanel";
import type { AssistantMessage, AssistantTurn } from "@/contracts/assistant";
import { asApiError } from "@/lib/api-error";
import {
  assistantArtifactsQueryOptions,
  assistantAvailabilityQueryOptions,
  assistantConversationSummaryQueryOptions,
  assistantHistoryQueryOptions,
  assistantThreadsQueryOptions,
  cancelAssistantTurn,
  isAssistantTurnActive,
  requestAssistantTurn,
} from "@/queries/assistant";
import {
  pendingAssistant,
  type AssistantRecoveryScope,
  type PendingAssistantTurn,
} from "@/stores/pending-assistant";
import { useNoteStore } from "@/stores/use-note-store";

import { ArtifactPreview } from "./artifacts";
import { ConversationSummary } from "./ConversationSummary";
import { Message } from "./messages";
import { useAssistantOutput } from "./use-assistant-output";

const turnLabels: Record<AssistantTurn["status"], string> = {
  queued: "Queued",
  running: "Working",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

const FOLLOW_BOTTOM_DISTANCE_PX = 48;
const SCROLL_BLOCKS = "h1,h2,h3,h4,p,pre,table,li";

/** Local DOM reading state only, shared by the responsive hosts of one note. */
export type AssistantScrollPosition = {
  scope: string;
  following: boolean;
  scrollTop: number;
  anchor: { messageId: string; blockIndex: number; offset: number } | null;
};

export function AssistantPanel({
  workspaceId,
  noteId,
  onClose,
  onComposerReady,
  expanded,
  onToggleExpanded,
  scrollPosition,
}: {
  workspaceId: string;
  noteId: string;
  onClose?: () => void;
  onComposerReady?: RefCallback<HTMLTextAreaElement>;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  scrollPosition?: RefObject<AssistantScrollPosition | null>;
}) {
  const userId = useNoteStore((state) => state.session?.user.id);
  const currentWorkspaceId = useNoteStore((state) => state.session?.workspace.id);
  const epoch = useNoteStore((state) => state.epoch);
  if (!userId || currentWorkspaceId !== workspaceId) return null;
  return (
    <ScopedAssistantPanel
      key={`${userId}:${workspaceId}:${epoch}:${noteId}`}
      userId={userId}
      workspaceId={workspaceId}
      noteId={noteId}
      scrollScope={`${userId}:${workspaceId}:${epoch}:${noteId}`}
      {...(scrollPosition ? { scrollPosition } : {})}
      {...(onClose ? { onClose } : {})}
      {...(onComposerReady ? { onComposerReady } : {})}
      {...(onToggleExpanded ? { onToggleExpanded, expanded: !!expanded } : {})}
    />
  );
}

function ScopedAssistantPanel({
  userId,
  workspaceId,
  noteId,
  onClose,
  onComposerReady,
  expanded,
  onToggleExpanded,
  scrollPosition,
  scrollScope,
}: AssistantRecoveryScope & {
  onClose?: () => void;
  onComposerReady?: RefCallback<HTMLTextAreaElement>;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  scrollPosition?: RefObject<AssistantScrollPosition | null>;
  scrollScope: string;
}) {
  const scope = useMemo(() => ({ userId, workspaceId, noteId }), [userId, workspaceId, noteId]);
  const recovery = useMemo(() => pendingAssistant(scope), [scope]);
  const local = useSyncExternalStore(
    recovery.subscribe,
    recovery.snapshot,
    recovery.serverSnapshot,
  );
  const composerRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      if (node && local.status === "ready") return onComposerReady?.(node);
    },
    [local.status, onComposerReady],
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const composerId = useId();
  const preserveHistoryPosition = useRef<(() => void) | null>(null);
  const messageScrollRef = useCallback(
    (content: HTMLDivElement | null) => {
      if (!content) return;
      const viewport = content.closest<HTMLElement>("[data-radix-scroll-area-viewport]");
      if (!viewport) return;

      // Attach to our stable DOM node, not Radix's root composed ref, which can
      // detach/reattach on updates and would reset the reader's follow preference.
      // These are DOM positions only; messages and pagination remain query-owned.
      const saved = scrollPosition?.current;
      let transfer = saved?.scope === scrollScope ? saved : null;
      let following = transfer?.following ?? true;
      let lastScrollTop = viewport.scrollTop;
      let layoutWidth = viewport.clientWidth;
      let layoutHeight = viewport.clientHeight;
      let contentHeight = content.offsetHeight;
      let anchor: { element: HTMLElement; offset: number } | null = null;
      const anchorOffset = (element: HTMLElement) => {
        const bounds = viewport.getBoundingClientRect();
        const layoutHeight = parseFloat(getComputedStyle(viewport).height);
        const scale = layoutHeight > 0 ? bounds.height / layoutHeight : 1;
        // Dialog zoom animations transform client rects, but scrollTop remains
        // in layout pixels. Keep saved offsets independent of the host transform.
        return (element.getBoundingClientRect().top - bounds.top) / (scale || 1);
      };
      const save = () => {
        if (!scrollPosition || transfer) return;
        const article = anchor?.element.closest<HTMLElement>("[data-message-id]");
        const messageId = article?.dataset.messageId;
        scrollPosition.current = {
          scope: scrollScope,
          following,
          scrollTop: viewport.scrollTop,
          anchor:
            anchor && article && messageId
              ? {
                  messageId,
                  blockIndex: Array.from(article.querySelectorAll(SCROLL_BLOCKS)).indexOf(
                    anchor.element,
                  ),
                  offset: anchor.offset,
                }
              : null,
        };
      };
      const rememberAnchor = () => {
        const top = viewport.getBoundingClientRect().top;
        const blocks = Array.from(
          content.querySelectorAll<HTMLElement>("[data-message-id]"),
        ).flatMap((article) => Array.from(article.querySelectorAll<HTMLElement>(SCROLL_BLOCKS)));
        const element = blocks.find((item) => item.getBoundingClientRect().bottom > top);
        anchor = element ? { element, offset: anchorOffset(element) } : null;
        save();
      };
      let initializing = true;
      const onScroll = () => {
        if (initializing) return;
        if (
          viewport.clientWidth !== layoutWidth ||
          viewport.clientHeight !== layoutHeight ||
          content.offsetHeight !== contentHeight
        ) {
          // A resize can clamp scrollTop and dispatch scroll before the resize
          // observer runs. That is layout, not a reader opting into bottom-follow.
          resize();
          return;
        }
        const scrollTop = viewport.scrollTop;
        // Scroll events are queued. A duplicate can arrive after streamed content
        // grows but before ResizeObserver follows it. Unchanged position is not a
        // reader scrolling away, even though the new bottom is now farther away.
        if (scrollTop === lastScrollTop) return;
        transfer = null;
        lastScrollTop = scrollTop;
        following =
          viewport.scrollHeight - viewport.clientHeight - scrollTop <= FOLLOW_BOTTOM_DISTANCE_PX;
        rememberAnchor();
      };
      const preserve = () => {
        following = false;
        lastScrollTop = viewport.scrollTop;
        layoutWidth = viewport.clientWidth;
        layoutHeight = viewport.clientHeight;
        contentHeight = content.offsetHeight;
        rememberAnchor();
      };
      preserveHistoryPosition.current = preserve;
      const resize = () => {
        if (transfer && !transfer.following) {
          const target = transfer.anchor;
          const article = target
            ? Array.from(content.querySelectorAll<HTMLElement>("[data-message-id]")).find(
                (item) => item.dataset.messageId === target.messageId,
              )
            : null;
          const element =
            article?.querySelectorAll<HTMLElement>(SCROLL_BLOCKS)[target?.blockIndex ?? -1];
          if (element && target) {
            anchor = { element, offset: target.offset };
            transfer = null;
          } else if (target && !content.querySelector("[data-message-id]")) {
            // History can hydrate after the new host mounts. Retain the anchor
            // until its message returns instead of replacing it with loading UI.
            return;
          } else {
            // A pending/provisional message may have been replaced by its saved
            // response while the host changed. Keep the reading position bounded.
            viewport.scrollTop = transfer.scrollTop;
            transfer = null;
          }
        } else {
          transfer = null;
        }
        if (following) {
          viewport.scrollTop = viewport.scrollHeight;
        } else if (anchor?.element.isConnected) {
          viewport.scrollTop += anchorOffset(anchor.element) - anchor.offset;
        }
        lastScrollTop = viewport.scrollTop;
        layoutWidth = viewport.clientWidth;
        layoutHeight = viewport.clientHeight;
        contentHeight = content.offsetHeight;
        rememberAnchor();
      };
      resize();
      // The mobile dialog may autofocus a control in older history on mount.
      // Position the newly opened viewport after that initial focus pass.
      const initialFrame = requestAnimationFrame(() => {
        resize();
        initializing = false;
      });
      viewport.addEventListener("scroll", onScroll, { passive: true });
      const observer = new ResizeObserver(resize);
      observer.observe(content);
      observer.observe(viewport);
      return () => {
        cancelAnimationFrame(initialFrame);
        observer.disconnect();
        viewport.removeEventListener("scroll", onScroll);
        if (preserveHistoryPosition.current === preserve) preserveHistoryPosition.current = null;
      };
    },
    [scrollPosition, scrollScope],
  );
  const pending = local.saved?.pending;
  const cancellation = local.saved?.cancellation;
  const availability = useQuery(assistantAvailabilityQueryOptions(workspaceId));
  const threads = useQuery(assistantThreadsQueryOptions(workspaceId, noteId));
  const latestThread = [...(threads.data ?? [])].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )[0];
  const threadId = pending?.threadId ?? cancellation?.threadId ?? latestThread?.id ?? "";
  const verifiedThread = !!threadId && !!threads.data?.some((thread) => thread.id === threadId);
  const history = useInfiniteQuery({
    ...assistantHistoryQueryOptions(workspaceId, threadId),
    enabled: verifiedThread,
  });
  const conversationSummary = useQuery(
    assistantConversationSummaryQueryOptions(workspaceId, threadId, verifiedThread),
  );
  const activeTurn = history.data?.pages[0]?.activeTurn;
  const turn = activeTurn ?? history.data?.pages[0]?.latestTurn;
  const active = isAssistantTurnActive(activeTurn);
  const artifacts = useQuery(assistantArtifactsQueryOptions(workspaceId, noteId));
  const messages = Array.from(
    new Map<string, AssistantMessage>(
      [...(history.data?.pages ?? [])]
        .reverse()
        .flatMap((page) => page.messages)
        .map((message) => [message.id, message]),
    ).values(),
  );
  const { mutate: replay, ...sending } = useMutation({
    mutationFn: (command: PendingAssistantTurn) => requestAssistantTurn(command),
  });
  const { mutate: stop, ...stopping } = useMutation({
    mutationFn: (command: { threadId: string; turnId: string }) =>
      cancelAssistantTurn(scope, command),
  });
  const preparing = useMutation({
    mutationFn: () =>
      recovery.prepare(threadId || crypto.randomUUID(), recovery.read().draft.generation),
  });
  const pendingId = pending?.turnId;
  const pendingStatus = pending?.status;
  const cancellationId = cancellation?.turnId;
  const provisionalText = useAssistantOutput({
    workspaceId,
    noteId,
    threadId,
    activeTurn,
    disabled:
      !!cancellation ||
      stopping.isPending ||
      (!!activeTurn && stopping.data?.id === activeTurn.id) ||
      history.isError ||
      messages.some((message) => message.turnId === activeTurn?.id && message.role === "assistant"),
  });
  const awaitingSnapshot =
    sending.isSuccess &&
    isAssistantTurnActive(sending.data) &&
    !messages.some((message) => message.turnId === sending.data.id) &&
    turn?.id !== sending.data.id;

  // This resumes durable commands only. Remote reads/polling belong to the queries above.
  // Depend on command identity, not the snapshot object: typing a newer draft must not retry.
  useEffect(() => {
    if (pendingId && pendingStatus === "pending") {
      const command = recovery.read().pending;
      if (command?.turnId === pendingId) replay(command);
    }
  }, [pendingId, pendingStatus, recovery, replay]);
  useEffect(() => {
    if (cancellationId) {
      const command = recovery.read().cancellation;
      if (command?.turnId === cancellationId) stop(command);
    }
  }, [cancellationId, recovery, stop]);

  const error = local.error ?? preparing.error ?? localError;
  const readError = availability.error ?? threads.error ?? history.error;
  const canSend =
    local.status === "ready" &&
    !!local.saved.draft.text.trim() &&
    availability.data?.enabled &&
    threads.isSuccess &&
    (!threadId || history.isSuccess) &&
    !active &&
    !pending &&
    !cancellation &&
    !awaitingSnapshot &&
    !preparing.isPending &&
    !sending.isPending;
  const retryRead = () => {
    void availability.refetch();
    void threads.refetch();
    if (threadId) void history.refetch();
  };

  return (
    <section
      aria-label="Assistant"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3 [overflow-wrap:anywhere]"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 pr-6">
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-medium">Ask</h2>
          <p className="text-xs text-muted-foreground">This note</p>
        </div>
        {turn && turn.status !== "succeeded" && (
          <Badge variant={turn.status === "failed" ? "destructive" : "secondary"}>
            {turnLabels[turn.status]}
          </Badge>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {onToggleExpanded && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={expanded ? "Restore Ask width" : "Expand Ask"}
              aria-pressed={expanded}
              onClick={onToggleExpanded}
            >
              {expanded ? <Minimize2 /> : <Maximize2 />}
            </Button>
          )}
          {onClose && (
            <Button variant="ghost" size="icon" aria-label="Close Ask" onClick={onClose}>
              <X />
            </Button>
          )}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <ScrollArea
          role="region"
          aria-label="Conversation messages"
          className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]]:overscroll-contain [&_[data-radix-scroll-area-viewport]]:[overflow-anchor:none] [&_[data-radix-scroll-area-viewport]>div]:!block"
        >
          <div ref={messageScrollRef} className="flex min-w-0 flex-col gap-5 pr-3">
            {verifiedThread && conversationSummary.data?.threadId === threadId && (
              <ConversationSummary
                key={threadId}
                summary={conversationSummary.data}
                refreshFailed={conversationSummary.isError}
                onArtifact={setArtifactId}
              />
            )}
            {verifiedThread && (
              <ResearchRunTasks workspaceId={workspaceId} threadId={threadId} noteId={noteId} />
            )}
            {availability.data && !availability.data.enabled && (
              <Alert>
                <AlertDescription>
                  {availability.data.reason ?? "Assistant is not enabled yet."}
                </AlertDescription>
              </Alert>
            )}
            {(error || readError) && (
              <Alert variant="destructive">
                <AlertDescription>
                  {typeof error === "string" ? error : asApiError(error ?? readError).message}
                  {readError && (
                    <Button variant="outline" size="sm" onClick={retryRead}>
                      Retry loading
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {threads.isPending ||
            (threadId && history.isPending && history.fetchStatus === "fetching") ? (
              <Skeleton className="h-36 w-full" />
            ) : (
              <>
                {history.hasNextPage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={history.isFetchingNextPage}
                    onClick={() => {
                      preserveHistoryPosition.current?.();
                      void history.fetchNextPage();
                    }}
                  >
                    {history.isFetchingNextPage ? "Loading…" : "Load earlier messages"}
                  </Button>
                )}
                {!messages.length && !pending && !readError && (
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle>Start with a question</EmptyTitle>
                      <EmptyDescription>
                        Ask what was decided, find related context, or request a follow-up.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
                {messages.map((message) => (
                  <Message key={message.id} message={message} onArtifact={setArtifactId} />
                ))}
                {provisionalText && (
                  <article
                    data-message-id={`provisional:${activeTurn?.id}`}
                    aria-label="Draft response — not yet saved"
                    className="flex min-w-0 flex-col gap-2"
                  >
                    <h3 className="text-xs font-medium text-muted-foreground" role="status">
                      Writing…
                    </h3>
                    <AssistantMarkdown content={provisionalText} />
                  </article>
                )}
                {pending &&
                  !messages.some(
                    (message) => message.turnId === pending.turnId && message.role === "user",
                  ) && (
                    <article
                      data-message-id={`pending:${pending.turnId}`}
                      aria-label="Pending message"
                      className="flex flex-col gap-2"
                    >
                      <h3 className="text-xs font-medium text-muted-foreground">
                        You · {pending.status === "rejected" ? "Not sent" : "Awaiting confirmation"}
                      </h3>
                      <p className="whitespace-pre-wrap break-words text-sm leading-7">
                        {pending.text}
                      </p>
                    </article>
                  )}
              </>
            )}
            <div role="status" aria-live="polite" className="text-xs text-muted-foreground">
              {local.status === "loading" ? "Restoring your saved draft…" : null}
              {active ? "Working in the background. You can close this panel." : null}
              {sending.isPending ? "Sending your saved message…" : null}
              {awaitingSnapshot ? "Message accepted. Checking saved progress…" : null}
              {stopping.isPending ? "Requesting stop…" : null}
              {turn?.error && <p>{turn.error}</p>}
              {stopping.data?.status === "cancelled" && !active ? "Stopped." : null}
            </div>
            {pending && !sending.isPending && (
              <Alert variant={pending.status === "rejected" ? "destructive" : "default"}>
                <AlertDescription>
                  <p>
                    {pending.rejection ??
                      "Confirmation hasn’t arrived. Your message is saved; retrying won’t send it twice."}
                  </p>
                  <div className="mt-2 flex gap-2">
                    {pending.status === "pending" ? (
                      <Button size="sm" variant="outline" onClick={() => replay(pending)}>
                        Retry message
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => recovery.dismissRejected(pending.turnId)}
                      >
                        Dismiss
                      </Button>
                    )}
                  </div>
                </AlertDescription>
              </Alert>
            )}
            {stopping.error && (
              <Alert>
                <AlertDescription>
                  Stop is not confirmed. Your stop request is saved.
                  {cancellation && (
                    <Button size="sm" variant="outline" onClick={() => stop(cancellation)}>
                      Retry stop
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {!!artifacts.data?.length && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  Created items ({artifacts.data.length})
                </summary>
                <ul className="mt-2 flex list-none flex-col gap-1 p-0">
                  {artifacts.data.map((artifact) => (
                    <li key={artifact.id} className="min-w-0">
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto max-w-full whitespace-normal text-left"
                        onClick={() => setArtifactId(artifact.id)}
                      >
                        {artifact.name}
                      </Button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {artifacts.error && (
              <p className="text-xs text-muted-foreground">
                Created items couldn’t load.{" "}
                <Button size="sm" variant="link" onClick={() => void artifacts.refetch()}>
                  Retry items
                </Button>
              </p>
            )}
          </div>
        </ScrollArea>
      </div>
      <Separator />
      <form
        className="shrink-0"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) preparing.mutate();
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={composerId} className="sr-only">
              Message Assistant
            </FieldLabel>
            <Textarea
              ref={composerRef}
              id={composerId}
              value={local.saved?.draft.text ?? ""}
              placeholder="Ask about this note…"
              maxLength={16_000}
              rows={2}
              className="max-h-32 resize-none"
              disabled={local.status !== "ready"}
              onChange={(event) => {
                try {
                  recovery.setDraft(event.target.value);
                  setLocalError(null);
                } catch (failure) {
                  setLocalError(asApiError(failure).message);
                }
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  if (canSend) preparing.mutate();
                }
              }}
            />
            <div className="flex items-center justify-between gap-3">
              <FieldDescription>⌘ / Ctrl + Enter to send</FieldDescription>
              <div className="flex shrink-0 gap-2">
                {active && turn && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={stopping.isPending}
                    onClick={() => stop({ threadId, turnId: turn.id })}
                  >
                    <Square data-icon="inline-start" />
                    Stop
                  </Button>
                )}
                <Button type="submit" size="sm" disabled={!canSend}>
                  <ArrowUp data-icon="inline-start" />
                  Send
                </Button>
              </div>
            </div>
          </Field>
        </FieldGroup>
      </form>
      {artifactId && (
        <ArtifactPreview
          workspaceId={workspaceId}
          id={artifactId}
          onClose={() => setArtifactId(null)}
          onArtifact={setArtifactId}
        />
      )}
    </section>
  );
}
