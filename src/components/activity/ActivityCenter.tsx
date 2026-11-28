"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { BellIcon } from "@radix-ui/react-icons";
import { toast } from "sonner";

import {
  ACTIVITY_LEASE_MS,
  ACTIVITY_PROTOCOL,
  activityPageSchema,
  activitySubscriptionSchema,
  type ActivityItem,
} from "@/contracts/activity";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  activityChangesQueryOptions,
  activityPageQueryOptions,
  createActivityNotificationTracker,
  safeActivityHref,
} from "@/queries/activity";
import { applyActivityChanges, getQueryRuntime } from "@/lib/query-runtime";

type ActivityCenterProps = {
  userId: string;
  workspaceId: string;
};
type ActivityPage = ReturnType<typeof activityPageSchema.parse>;

function formatActivityTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function isCursorAfter(cursor: string, baseline: string) {
  return (
    /^[0-9]+$/.test(cursor) &&
    /^[0-9]+$/.test(baseline) &&
    (cursor.length > baseline.length || (cursor.length === baseline.length && cursor > baseline))
  );
}

export function ActivityCenter({ userId, workspaceId }: ActivityCenterProps) {
  const router = useRouter();
  const runtime = getQueryRuntime();
  const [open, setOpen] = useState(false);
  const [beforeCursors, setBeforeCursors] = useState<Array<string | undefined>>([undefined]);
  const [after, setAfter] = useState<string | null>(null);
  const [socketHealthy, setSocketHealthy] = useState(false);
  const [markReadError, setMarkReadError] = useState<string | null>(null);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const latestAfter = useRef<string | null>(null);
  const processedCursors = useRef(new Set<string>());
  const notificationTracker = useRef(createActivityNotificationTracker());

  const pageQueries = useQueries({
    queries: beforeCursors.map((before) => activityPageQueryOptions(workspaceId, before)),
  });
  const firstPage = pageQueries[0]?.data;
  const pages = pageQueries.flatMap((query) => (query.data ? [query.data] : []));
  const items = pages.flatMap((page) => page.items);
  const latestSequence = firstPage?.items[0]?.sequence ?? "0";
  const changesQuery = useQuery(
    activityChangesQueryOptions(workspaceId, after ?? "", socketHealthy),
  );

  const markRead = useMutation(
    runtime.trpc.activity.markRead.mutationOptions({
      onMutate: ({ id }) => {
        setMarkingId(id);
        setMarkReadError(null);
      },
      onSuccess: (_result, { id }) => {
        if (
          runtime !== getQueryRuntime() ||
          runtime.identity?.workspaceId !== workspaceId ||
          runtime.identity?.userId !== userId
        )
          return;
        const readAt = new Date().toISOString();
        runtime.queryClient.setQueriesData<ActivityPage>(
          runtime.trpc.activity.list.queryFilter({ workspaceId }),
          (page) => {
            if (!page) {
              return page;
            }

            const wasUnread = page.items.some((item) => item.id === id && item.readAt === null);
            return {
              ...page,
              items: page.items.map((item) =>
                item.id === id && item.readAt === null ? { ...item, readAt } : item,
              ),
              unreadCount: Math.max(0, page.unreadCount - (wasUnread ? 1 : 0)),
            };
          },
        );
      },
      onError: (error) => {
        setMarkReadError(
          error instanceof Error ? error.message : "Could not mark this update read.",
        );
      },
      onSettled: () => setMarkingId(null),
    }),
  );

  useEffect(() => {
    if (
      runtime !== getQueryRuntime() ||
      runtime.identity?.workspaceId !== workspaceId ||
      runtime.identity.userId !== userId
    ) {
      return;
    }

    if (after !== null || !firstPage) {
      return;
    }

    // The first list response establishes a notification baseline, not a toast backlog.
    latestAfter.current = latestSequence;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAfter(latestSequence);
  }, [after, firstPage, latestSequence, runtime, userId, workspaceId]);

  useEffect(() => {
    if (
      runtime !== getQueryRuntime() ||
      runtime.identity?.workspaceId !== workspaceId ||
      runtime.identity.userId !== userId
    ) {
      return;
    }

    if (
      !changesQuery.data ||
      after === null ||
      changesQuery.data.cursor === after ||
      !isCursorAfter(changesQuery.data.cursor, after) ||
      !isCursorAfter(changesQuery.data.cursor, latestAfter.current ?? after) ||
      processedCursors.current.has(changesQuery.data.cursor)
    ) {
      return;
    }

    processedCursors.current.add(changesQuery.data.cursor);
    if (processedCursors.current.size > 128) {
      const oldestCursor = processedCursors.current.values().next().value;
      if (oldestCursor) {
        processedCursors.current.delete(oldestCursor);
      }
    }
    void applyActivityChanges(workspaceId, changesQuery.data.items, runtime).catch(() => {});
    const listFilter = runtime.trpc.activity.list.queryFilter({ workspaceId });
    void runtime.queryClient
      .cancelQueries(listFilter)
      .then(() => {
        if (
          runtime === getQueryRuntime() &&
          runtime.identity?.workspaceId === workspaceId &&
          runtime.identity?.userId === userId
        ) {
          return runtime.queryClient.invalidateQueries(listFilter);
        }
      })
      .catch(() => {});

    const latestCompletion = notificationTracker.current.consume(
      changesQuery.data.items,
      changesQuery.data.hasMore,
    );
    if (latestCompletion) {
      const href = safeActivityHref(latestCompletion.href);
      toast(latestCompletion.title, {
        id: `activity:${latestCompletion.id}`,
        description:
          latestCompletion.type === "summary.failed"
            ? "Your saved transcript and speaker changes are unaffected."
            : latestCompletion.type.endsWith(".failed")
              ? "Background work needs attention."
              : "Background work completed.",
        action: {
          label: "View",
          onClick: () => {
            router.push(href);
          },
        },
      });
    }

    // Advance the transport cursor in response to the server's bounded change page.
    latestAfter.current = changesQuery.data.cursor;
    setAfter(changesQuery.data.cursor);
  }, [after, changesQuery.data, router, runtime, userId, workspaceId]);

  useEffect(() => {
    if (after === null) {
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let leaseTimer: ReturnType<typeof setTimeout> | null = null;
    let connectionTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let renewing = false;
    let catchingUp = false;
    let catchUpAgain = false;

    const currentScope = () =>
      !disposed &&
      runtime === getQueryRuntime() &&
      runtime.identity?.workspaceId === workspaceId &&
      runtime.identity?.userId === userId;

    const refreshActivity = () => {
      if (!currentScope()) {
        return;
      }

      if (catchingUp) {
        catchUpAgain = true;
        return;
      }

      catchingUp = true;
      void (async () => {
        do {
          catchUpAgain = false;
          if (!currentScope()) {
            return;
          }

          const cursor = latestAfter.current;
          if (cursor !== null) {
            await runtime.queryClient.refetchQueries({
              queryKey: runtime.trpc.activity.changes.queryKey({ workspaceId, after: cursor }),
              exact: true,
            });
          }
        } while (catchUpAgain && currentScope());
      })()
        .catch(() => {
          // Socket health is independent of the authoritative query's availability.
          // The normal query retry policy and safety poll recover missed reads.
        })
        .finally(() => {
          catchingUp = false;
        });
    };

    const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
      if (timer !== null) {
        clearTimeout(timer);
      }
    };

    const scheduleReconnect = (delay: number) => {
      if (disposed || reconnectTimer !== null) {
        return;
      }

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    const reconnectDelay = () => {
      const delay = Math.min(1_000 * 2 ** reconnectAttempt, 30_000);
      reconnectAttempt += 1;
      return delay;
    };

    async function connect() {
      if (!currentScope()) {
        return;
      }

      try {
        const lease = activitySubscriptionSchema.parse(
          await runtime.client.activity.subscribe.mutate({ workspaceId }),
        );
        if (
          !currentScope() ||
          lease.workspaceId !== workspaceId ||
          lease.userId !== userId ||
          lease.expiresAt <= Date.now()
        ) {
          scheduleReconnect(reconnectDelay());
          return;
        }

        const url = new URL("/api/activity/output", window.location.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("workspaceId", lease.workspaceId);
        url.searchParams.set("userId", lease.userId);

        const nextSocket = new WebSocket(url, [ACTIVITY_PROTOCOL, lease.ticket]);
        socket = nextSocket;
        renewing = false;

        connectionTimer = setTimeout(() => {
          if (nextSocket.readyState === WebSocket.CONNECTING) {
            nextSocket.close();
          }
        }, 10_000);

        nextSocket.onopen = () => {
          clearTimer(connectionTimer);
          connectionTimer = null;
          reconnectAttempt = 0;
          setSocketHealthy(true);
          refreshActivity();
          leaseTimer = setTimeout(() => {
            if (nextSocket.readyState === WebSocket.OPEN) {
              renewing = true;
              nextSocket.close(1000, "Renew activity subscription");
            }
          }, ACTIVITY_LEASE_MS - 5_000);
        };

        nextSocket.onmessage = (event) => {
          if (typeof event.data !== "string") {
            nextSocket.close(1002, "Invalid activity frame");
            return;
          }

          try {
            const frame: unknown = JSON.parse(event.data);
            if (
              !frame ||
              typeof frame !== "object" ||
              Array.isArray(frame) ||
              Object.keys(frame).length !== 1 ||
              (frame as { type?: unknown }).type !== "changed"
            ) {
              nextSocket.close(1002, "Invalid activity frame");
              return;
            }

            refreshActivity();
          } catch {
            nextSocket.close(1002, "Invalid activity frame");
          }
        };

        nextSocket.onerror = () => {
          setSocketHealthy(false);
          if (nextSocket.readyState === WebSocket.OPEN) {
            nextSocket.close();
          }
        };

        nextSocket.onclose = () => {
          clearTimer(connectionTimer);
          clearTimer(leaseTimer);
          connectionTimer = null;
          leaseTimer = null;
          if (socket === nextSocket) {
            socket = null;
          }
          setSocketHealthy(false);
          scheduleReconnect(renewing ? 250 : reconnectDelay());
        };
      } catch {
        setSocketHealthy(false);
        scheduleReconnect(reconnectDelay());
      }
    }

    void connect();

    return () => {
      disposed = true;
      clearTimer(reconnectTimer);
      clearTimer(connectionTimer);
      clearTimer(leaseTimer);
      socket?.close(1000, "Activity scope changed");
    };
    // The cursor advances frequently during catch-up; the socket is scoped to the
    // authenticated workspace, and reads use the latest cursor ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [after !== null, runtime, userId, workspaceId]);

  const unreadCount = firstPage?.unreadCount ?? 0;
  const lastPage = pageQueries.at(-1);
  const nextCursor = lastPage?.data?.nextCursor ?? null;
  const loading = !firstPage && (pageQueries[0]?.isPending ?? false);

  function loadMore() {
    if (!nextCursor || beforeCursors.includes(nextCursor)) return;
    setBeforeCursors((cursors) => [...cursors, nextCursor]);
  }

  function markItemRead(item: ActivityItem) {
    if (
      runtime === getQueryRuntime() &&
      runtime.identity?.workspaceId === workspaceId &&
      runtime.identity.userId === userId &&
      !item.readAt &&
      !markRead.isPending
    ) {
      void markRead.mutateAsync({ workspaceId, id: item.id });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="fixed right-4 top-4 z-30 [@media(max-width:760px)]:bottom-[calc(68px+env(safe-area-inset-bottom))] [@media(max-width:760px)]:left-3 [@media(max-width:760px)]:right-auto [@media(max-width:760px)]:top-auto">
        <DialogTrigger asChild>
          <Button
            variant="outline"
            className="relative gap-2 border-vn-stroke bg-vn-sidebar shadow-sm"
            aria-label={unreadCount > 0 ? `Activity, ${unreadCount} unread` : "Activity"}
          >
            <BellIcon aria-hidden="true" />
            <span className="[@media(max-width:760px)]:sr-only">Activity</span>
            {unreadCount > 0 && (
              <Badge variant="secondary" className="min-w-5 justify-center px-1.5 tabular-nums">
                {unreadCount > 99 ? "99+" : unreadCount}
              </Badge>
            )}
          </Button>
        </DialogTrigger>
      </div>
      <DialogContent className="max-h-[min(82dvh,720px)] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Activity</DialogTitle>
        </DialogHeader>
        {markReadError && (
          <Alert variant="destructive">
            <AlertDescription>{markReadError}</AlertDescription>
          </Alert>
        )}
        {loading ? (
          <div className="flex flex-col gap-3" role="status" aria-label="Loading activity">
            <Skeleton className="h-16 w-full" aria-hidden="true" />
            <Skeleton className="h-16 w-full" aria-hidden="true" />
            <Skeleton className="h-16 w-full" aria-hidden="true" />
          </div>
        ) : items.length === 0 ? (
          <Empty className="min-h-40 border-0 px-3 py-8">
            <EmptyHeader>
              <EmptyTitle>You’re all caught up</EmptyTitle>
              <EmptyDescription>Background updates will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-start justify-between gap-4 rounded-sm border border-vn-stroke px-3 py-3"
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Link
                    href={safeActivityHref(item.href)}
                    className="font-medium text-vn-text underline-offset-4 hover:underline"
                    onClick={() => markItemRead(item)}
                  >
                    {item.title}
                  </Link>
                  <span className="text-xs text-vn-muted">
                    {item.executor === "user"
                      ? "You"
                      : item.executor === "agent"
                        ? "Assistant"
                        : "Background workflow"}{" "}
                    · <time dateTime={item.createdAt}>{formatActivityTime(item.createdAt)}</time>
                  </span>
                </div>
                {!item.readAt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-none"
                    disabled={markRead.isPending && markingId === item.id}
                    onClick={() => markItemRead(item)}
                  >
                    {markRead.isPending && markingId === item.id ? "Saving…" : "Mark read"}
                  </Button>
                )}
              </li>
            ))}
          </ol>
        )}
        {nextCursor && (
          <Button variant="outline" className="w-full" onClick={loadMore}>
            Load older activity
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default ActivityCenter;
