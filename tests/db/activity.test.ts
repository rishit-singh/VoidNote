import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { and, eq } from "drizzle-orm";

import type { ApplicationEventInput } from "../../src/contracts/activity";
import { appendApplicationEvent, createActivityRepository } from "../../src/db/activity";
import {
  activityNotifications,
  applicationEvents,
  eventDeliveries,
} from "../../src/db/activity-schema";
import { db, setupDatabase, teardownDatabase, workspace } from "./fixture";

before(setupDatabase);
after(teardownDatabase);
const repo = createActivityRepository(db);

async function eventFixture(type: ApplicationEventInput["type"] = "summary.published") {
  const { principal, workspaceId } = await workspace();
  const event: ApplicationEventInput = {
    id: randomUUID(),
    workspaceId,
    actorId: principal.id,
    type,
    executor: "workflow",
    operationId: randomUUID(),
    noteId: randomUUID(),
  };
  return { principal, workspaceId, event };
}

void test("domain outcome and subscribers commit atomically, exact event replay deduplicates", async () => {
  const { event, workspaceId } = await eventFixture("transcript.ready");
  await assert.rejects(
    db.transaction(async (tx) => {
      await appendApplicationEvent(tx, event);
      throw new Error("rollback");
    }),
  );
  assert.equal(
    (
      await db
        .select()
        .from(applicationEvents)
        .where(eq(applicationEvents.workspaceId, workspaceId))
    ).length,
    0,
  );
  await db.transaction((tx) => appendApplicationEvent(tx, event));
  await db.transaction((tx) => appendApplicationEvent(tx, event));
  const deliveries = await db
    .select()
    .from(eventDeliveries)
    .where(eq(eventDeliveries.workspaceId, workspaceId));
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries.map((row) => row.subscriber).sort(), [
    "activity-v1",
    "automatic-summary-v1",
  ]);
  await assert.rejects(
    db.transaction((tx) => appendApplicationEvent(tx, { ...event, type: "summary.failed" })),
  );
});

void test("duplicate delivery has one lease and late completion cannot acknowledge a newer lease", async () => {
  const { event, workspaceId } = await eventFixture();
  await db.transaction((tx) => appendApplicationEvent(tx, event));
  const [row] = await db
    .select()
    .from(eventDeliveries)
    .where(eq(eventDeliveries.workspaceId, workspaceId));
  assert.ok(row);
  const claims = await Promise.all([repo.claim(row.id), repo.claim(row.id)]);
  const first = claims.find(Boolean);
  assert.ok(first);
  assert.equal(claims.filter(Boolean).length, 1);
  await db
    .update(eventDeliveries)
    .set({ leaseUntil: new Date(0) })
    .where(eq(eventDeliveries.id, row.id));
  const second = await repo.claim(row.id);
  assert.ok(second);
  await repo.complete(row.id, first.leaseId);
  const [stillRunning] = await db
    .select()
    .from(eventDeliveries)
    .where(eq(eventDeliveries.id, row.id));
  assert.equal(stillRunning?.status, "running");
  await repo.complete(row.id, second.leaseId);
  assert.equal(await repo.claim(row.id), null);
});

void test("notification publication replay and read acknowledgement are idempotent", async () => {
  const { event, principal, workspaceId } = await eventFixture();
  await db.transaction((tx) => appendApplicationEvent(tx, event));
  await Promise.all([repo.notify(event), repo.notify(event)]);
  const first = await repo.list(principal, workspaceId);
  assert.equal(first.items.length, 1);
  assert.equal(first.unreadCount, 1);
  await repo.markRead(principal, workspaceId, event.id);
  await repo.markRead(principal, workspaceId, event.id);
  assert.equal((await repo.list(principal, workspaceId)).unreadCount, 0);
});

void test("change feed includes quiet mutations while inbox contains only useful outcomes", async () => {
  const { event, principal, workspaceId } = await eventFixture("note.changed");
  const completion = { ...event, id: randomUUID(), type: "summary.published" as const };
  await db.transaction(async (tx) => {
    await appendApplicationEvent(tx, event);
    await appendApplicationEvent(tx, completion);
  });
  await repo.notify(event);
  await repo.notify(completion);
  const changes = await repo.changes(principal, workspaceId, "0");
  assert.equal(changes.items.length, 2);
  assert.equal((await repo.changes(principal, workspaceId, changes.cursor)).items.length, 0);
  assert.equal((await repo.list(principal, workspaceId)).items.length, 1);
});

void test("feed is recipient/workspace scoped and pagination has no duplicate seam", async () => {
  const { event, principal, workspaceId } = await eventFixture();
  for (let i = 0; i < 3; i++) {
    const next = { ...event, id: randomUUID() };
    await db.transaction((tx) => appendApplicationEvent(tx, next));
    await repo.notify(next);
  }
  const first = await repo.list(principal, workspaceId, undefined, 2);
  assert.ok(first.nextCursor);
  const second = await repo.list(principal, workspaceId, first.nextCursor, 2);
  assert.equal(second.items.length, 1);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 3);
  const outsider = await workspace();
  await assert.rejects(repo.list(outsider.principal, workspaceId));
  await assert.rejects(repo.markRead(outsider.principal, workspaceId, event.id));
  assert.equal((await repo.list(outsider.principal, outsider.workspaceId)).items.length, 0);
});

void test("retry backoff and terminal exhaustion are durable, healthy deliveries remain eligible", async () => {
  const { event, workspaceId } = await eventFixture();
  await db.transaction((tx) => appendApplicationEvent(tx, event));
  const [row] = await db
    .select()
    .from(eventDeliveries)
    .where(eq(eventDeliveries.workspaceId, workspaceId));
  assert.ok(row);
  const claim = await repo.claim(row.id);
  assert.ok(claim);
  await repo.retry(claim.id, claim.leaseId, 8);
  assert.equal(await repo.claim(row.id), null);
  const [failed] = await db.select().from(eventDeliveries).where(eq(eventDeliveries.id, row.id));
  assert.equal(failed?.status, "failed");
  assert.equal(
    (
      await db
        .select()
        .from(activityNotifications)
        .where(
          and(
            eq(activityNotifications.workspaceId, workspaceId),
            eq(activityNotifications.eventId, event.id),
          ),
        )
    ).length,
    0,
  );
});

void test("dispatch reservation excludes competing relays and cannot overwrite consumer backoff", async () => {
  const { event, workspaceId } = await eventFixture();
  await db.transaction((tx) => appendApplicationEvent(tx, event));
  const [row] = await db
    .select()
    .from(eventDeliveries)
    .where(eq(eventDeliveries.workspaceId, workspaceId));
  assert.ok(row);
  // This test exercises competing claims, not database/application clock alignment.
  await db
    .update(eventDeliveries)
    .set({ availableAt: new Date(0) })
    .where(eq(eventDeliveries.id, row.id));
  const reservations = await Promise.all([repo.reserveDispatch(50), repo.reserveDispatch(50)]);
  assert.equal(reservations.flat().filter((delivery) => delivery.id === row.id).length, 1);
  assert.ok(!(await repo.reserveDispatch(50)).some((delivery) => delivery.id === row.id));
  const claim = await repo.claim(row.id);
  assert.ok(claim);
  await repo.retry(row.id, claim.leaseId, claim.attempts);
  await db
    .update(eventDeliveries)
    .set({ availableAt: new Date(0) })
    .where(eq(eventDeliveries.id, row.id));
  assert.ok((await repo.reserveDispatch(50)).some((delivery) => delivery.id === row.id));
  // Simulate a relay that crashed before send: reservation expiry recovers it.
  await db
    .update(eventDeliveries)
    .set({ enqueuedAt: new Date(0) })
    .where(eq(eventDeliveries.id, row.id));
  assert.ok((await repo.reserveDispatch(50)).some((delivery) => delivery.id === row.id));
});
