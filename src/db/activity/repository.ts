import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { eventPolicy, eventRetrySeconds } from "../../config/events";
import {
  activityItemSchema,
  applicationEventInputSchema,
  type ApplicationEventInput,
} from "../../contracts/activity";
import { type Principal, WorkspaceError } from "../../contracts/workspace";
import { activityNotifications, applicationEvents, eventDeliveries } from "../activity-schema";
import type { Database } from "../repository";
import { workspaceMemberships, workspaces } from "../schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Called in the owning domain transaction, after its mutation and receipt. */
export async function appendApplicationEvent(tx: Transaction, value: ApplicationEventInput) {
  const event = applicationEventInputSchema.parse(value);
  const [inserted] = await tx
    .insert(applicationEvents)
    .values({ workspaceId: event.workspaceId, id: event.id, type: event.type, payload: event })
    .onConflictDoNothing()
    .returning({ id: applicationEvents.id });

  if (!inserted) {
    const [existing] = await tx
      .select()
      .from(applicationEvents)
      .where(
        and(
          eq(applicationEvents.workspaceId, event.workspaceId),
          eq(applicationEvents.id, event.id),
        ),
      );
    if (!existing || JSON.stringify(existing.payload) !== JSON.stringify(event)) {
      // JSONB key ordering is not a fingerprint: compare through the same parser.
      if (
        !existing ||
        JSON.stringify(applicationEventInputSchema.parse(existing.payload)) !==
          JSON.stringify(event)
      ) {
        throw new WorkspaceError("conflict", "Event identity was reused for a different outcome.");
      }
    }
    return;
  }

  const subscribers: Array<"activity-v1" | "automatic-summary-v1"> = ["activity-v1"];
  if (event.type === "transcript.ready" || event.type === "transcript.corrected") {
    subscribers.push("automatic-summary-v1");
  }
  await tx.insert(eventDeliveries).values(
    subscribers.map((subscriber) => ({
      id: randomUUID(),
      workspaceId: event.workspaceId,
      eventId: event.id,
      subscriber,
    })),
  );
}

async function authorize(tx: Transaction, principal: Principal, workspaceId: string) {
  const [member] = await tx
    .select({ id: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.id),
        isNull(workspaceMemberships.revokedAt),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  if (!member) throw new WorkspaceError("forbidden", "Workspace access denied.");
}

const notificationCopy = (event: ApplicationEventInput) => {
  const titles = {
    "note.changed": "Note updated",
    "profile.changed": "Profile updated",
    "transcript.ready": "Transcript ready",
    "transcript.corrected": "Transcript updated",
    "summary.published": "Summary ready",
    "summary.failed": "Summary needs attention",
    "research.completed": "Research ready",
    "research.failed": "Research needs attention",
  };
  return {
    title: titles[event.type],
    href:
      event.type.startsWith("research.") && event.runId
        ? `/research/${event.runId}`
        : event.noteId
          ? `/notes/${event.noteId}`
          : event.personId
            ? `/profiles/${event.personId}`
            : "/",
  };
};

export function createActivityRepository(db: Database) {
  async function readItems(
    tx: Transaction,
    workspaceId: string,
    recipientId: string,
    boundary: { before?: bigint; after?: bigint },
    limit: number,
    ascending: boolean,
    visibleOnly = false,
  ) {
    const n = activityNotifications;
    const rows = await tx
      .select({ notification: n, event: applicationEvents.payload })
      .from(n)
      .innerJoin(
        applicationEvents,
        and(eq(applicationEvents.workspaceId, n.workspaceId), eq(applicationEvents.id, n.eventId)),
      )
      .where(
        and(
          eq(n.workspaceId, workspaceId),
          eq(n.recipientId, recipientId),
          visibleOnly ? eq(n.visible, true) : undefined,
          boundary.before === undefined ? undefined : lt(n.sequence, boundary.before),
          boundary.after === undefined ? undefined : gt(n.sequence, boundary.after),
        ),
      )
      .orderBy(ascending ? asc(n.sequence) : desc(n.sequence))
      .limit(limit);
    return rows.map(({ notification: row, event }) =>
      activityItemSchema.parse({
        id: row.eventId,
        sequence: row.sequence.toString(),
        type: event.type,
        title: row.title,
        href: row.href,
        executor: event.executor,
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt?.toISOString() ?? null,
        noteId: event.noteId ?? null,
        personId: event.personId ?? null,
        runId: event.runId ?? null,
      }),
    );
  }

  return {
    async assertAccess(principal: Principal, workspaceId: string) {
      await db.transaction((tx) => authorize(tx, principal, workspaceId));
    },
    async list(principal: Principal, workspaceId: string, before?: string, limit = 20) {
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        const size = Math.min(50, Math.max(1, limit));
        const items = await readItems(
          tx,
          workspaceId,
          principal.id,
          { ...(before ? { before: BigInt(before) } : {}) },
          size + 1,
          false,
          true,
        );
        const [count] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(activityNotifications)
          .where(
            and(
              eq(activityNotifications.workspaceId, workspaceId),
              eq(activityNotifications.recipientId, principal.id),
              eq(activityNotifications.visible, true),
              isNull(activityNotifications.readAt),
            ),
          );
        return {
          items: items.slice(0, size),
          nextCursor: items.length > size ? items[size - 1]!.sequence : null,
          unreadCount: count?.count ?? 0,
        };
      });
    },
    async changes(principal: Principal, workspaceId: string, after: string) {
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        const rows = await readItems(
          tx,
          workspaceId,
          principal.id,
          { after: BigInt(after) },
          eventPolicy.changePageSize + 1,
          true,
        );
        const items = rows.slice(0, eventPolicy.changePageSize);
        return {
          items,
          cursor: items.at(-1)?.sequence ?? after,
          hasMore: rows.length > items.length,
        };
      });
    },
    async markRead(principal: Principal, workspaceId: string, eventId: string) {
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        await tx
          .update(activityNotifications)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(activityNotifications.workspaceId, workspaceId),
              eq(activityNotifications.recipientId, principal.id),
              eq(activityNotifications.eventId, eventId),
              isNull(activityNotifications.readAt),
            ),
          );
        return { acknowledged: true as const };
      });
    },
    async reserveDispatch(limit: number = eventPolicy.batchSize) {
      const now = new Date();
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: eventDeliveries.id })
          .from(eventDeliveries)
          .where(
            and(
              or(
                eq(eventDeliveries.status, "pending"),
                and(eq(eventDeliveries.status, "running"), lt(eventDeliveries.leaseUntil, now)),
              ),
              lt(eventDeliveries.availableAt, now),
              or(
                isNull(eventDeliveries.enqueuedAt),
                lt(
                  eventDeliveries.enqueuedAt,
                  new Date(now.getTime() - eventPolicy.leaseSeconds * 1000),
                ),
              ),
            ),
          )
          .orderBy(asc(eventDeliveries.availableAt), asc(eventDeliveries.id))
          .limit(Math.min(50, limit))
          .for("update", { skipLocked: true });
        if (rows.length) {
          await tx
            .update(eventDeliveries)
            .set({ enqueuedAt: now })
            .where(
              inArray(
                eventDeliveries.id,
                rows.map((row) => row.id),
              ),
            );
        }
        // Reserve before sending. If send/ack is lost, this expires and retries.
        // No late send acknowledgement may overwrite a consumer's backoff.
        return rows;
      });
    },
    async claim(id: string) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(eventDeliveries)
          .where(eq(eventDeliveries.id, id))
          .for("update")
          .limit(1);
        const now = new Date();
        if (
          !row ||
          row.status === "completed" ||
          row.status === "failed" ||
          row.availableAt > now ||
          (row.status === "running" && row.leaseUntil && row.leaseUntil > now)
        )
          return null;
        const leaseId = randomUUID();
        await tx
          .update(eventDeliveries)
          .set({
            status: "running",
            attempts: row.attempts + 1,
            leaseId,
            leaseUntil: new Date(now.getTime() + eventPolicy.leaseSeconds * 1000),
          })
          .where(eq(eventDeliveries.id, id));
        const [event] = await tx
          .select()
          .from(applicationEvents)
          .where(
            and(
              eq(applicationEvents.workspaceId, row.workspaceId),
              eq(applicationEvents.id, row.eventId),
            ),
          )
          .limit(1);
        if (!event) throw new Error("Delivery event missing.");
        return {
          ...row,
          leaseId,
          attempts: row.attempts + 1,
          event: applicationEventInputSchema.parse(event.payload),
        };
      });
    },
    async complete(id: string, leaseId: string) {
      await db
        .update(eventDeliveries)
        .set({ status: "completed", completedAt: new Date(), leaseUntil: null, error: null })
        .where(
          and(
            eq(eventDeliveries.id, id),
            eq(eventDeliveries.leaseId, leaseId),
            eq(eventDeliveries.status, "running"),
          ),
        );
    },
    async retry(id: string, leaseId: string, attempts: number) {
      await db
        .update(eventDeliveries)
        .set({
          status: attempts >= eventPolicy.maxAttempts ? "failed" : "pending",
          availableAt: new Date(Date.now() + eventRetrySeconds(attempts) * 1000),
          leaseUntil: null,
          enqueuedAt: null,
          error: "Subscriber did not complete.",
        })
        .where(
          and(
            eq(eventDeliveries.id, id),
            eq(eventDeliveries.leaseId, leaseId),
            eq(eventDeliveries.status, "running"),
          ),
        );
    },
    async notify(event: ApplicationEventInput) {
      return db.transaction(async (tx) => {
        // Serialize only feed append: sequence order is commit-safe within scope.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`activity:${event.workspaceId}:${event.actorId}`}, 0))`,
        );
        const [member] = await tx
          .select({ id: workspaceMemberships.userId })
          .from(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, event.workspaceId),
              eq(workspaceMemberships.userId, event.actorId),
              isNull(workspaceMemberships.revokedAt),
            ),
          )
          .limit(1);
        if (!member) return;
        await tx
          .insert(activityNotifications)
          .values({
            workspaceId: event.workspaceId,
            recipientId: event.actorId,
            eventId: event.id,
            visible: !["note.changed", "profile.changed", "transcript.corrected"].includes(
              event.type,
            ),
            ...notificationCopy(event),
          })
          .onConflictDoNothing();
      });
    },
  };
}
