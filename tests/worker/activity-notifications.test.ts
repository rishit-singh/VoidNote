import assert from "node:assert/strict";
import test from "node:test";

import type { ActivityItem } from "../../src/contracts/activity.ts";
import {
  createActivityNotificationTracker,
  safeActivityHref,
} from "../../src/queries/activity-notifications.ts";

function item(
  id: string,
  type: ActivityItem["type"],
  executor: ActivityItem["executor"] = "workflow",
): ActivityItem {
  return {
    id,
    sequence: id,
    type,
    title: id,
    href: `/notes/${id}`,
    executor,
    createdAt: "2026-11-25T12:00:00.000Z",
    readAt: null,
    noteId: id,
    personId: null,
  };
}

void test("activity notification tracker skips edits, user events, duplicates, and incomplete catch-up", () => {
  const tracker = createActivityNotificationTracker();
  const oldCompletion = item("1", "summary.published");

  assert.equal(tracker.consume([oldCompletion], true), null);
  assert.equal(
    tracker.consume(
      [
        item("2", "note.changed"),
        item("3", "research.completed", "user"),
        oldCompletion,
        item("4", "research.completed", "agent"),
      ],
      true,
    ),
    null,
  );

  const latest = item("5", "transcript.ready");
  assert.deepEqual(tracker.consume([latest], false), latest);
  assert.equal(tracker.consume([latest], false), null);
});

void test("activity links are same-origin paths only", () => {
  assert.equal(safeActivityHref("/notes/note-id"), "/notes/note-id");
  assert.equal(safeActivityHref("//example.com"), "/");
  assert.equal(safeActivityHref("https://example.com"), "/");
});
