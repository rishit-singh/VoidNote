import { randomUUID } from "node:crypto";
import {
  correctedTurnSchema,
  correctionCommandSchema,
} from "../../src/contracts/transcript-corrections";
import { test, expect, timestamp, workspaceId } from "./workspace-fixture";

test("speaker scope previews unloaded matching segments and confirms only the chosen scope", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Speaker scope" });
  const self = workspace.seedPerson({ displayName: "Taylor" });
  workspace.selfPersonId = self.id;
  const recordingId = randomUUID();
  const runId = randomUUID();
  const turns = Array.from({ length: 105 }, (_, sequence) =>
    correctedTurnSchema.parse({
      id: randomUUID(),
      runId,
      recordingId,
      sequence,
      orderKey: sequence.toString(2).padStart(7, "0"),
      sourceUtteranceId: randomUUID(),
      parentId: null,
      startSeconds: sequence * 2,
      endSeconds: sequence * 2 + 0.5,
      speakerLabel: "SPEAKER_00",
      text: `Passage ${sequence}`,
      revision: 0,
      attributionRevision: 0,
      assignment: { kind: "unassigned" },
      assignmentSource: "unassigned",
      personName: null,
      reviewState: "unreviewed",
      providerScore: null,
      sampleSuitability: "not_evaluated",
      originalText: `Passage ${sequence}`,
      originalStartSeconds: sequence * 2,
      originalEndSeconds: sequence * 2 + 0.5,
    }),
  );
  const commandBodies: ReturnType<typeof correctionCommandSchema.parse>[] = [];
  const receiptIds = new Map<string, string>();
  const root = `/api/workspaces/${workspaceId}/notes/${note.id}`;
  await page.route(`**${root}/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice(root.length);
    if (path === "/recordings") {
      return route.fulfill({
        json: {
          recordings: [
            {
              id: recordingId,
              noteId: note.id,
              workspaceId,
              sha256: "a".repeat(64),
              bytes: 44,
              mimeType: "audio/wav",
              durationSeconds: 220,
              status: "ready",
              createdAt: timestamp,
            },
          ],
          runs: [
            {
              id: runId,
              noteId: note.id,
              workspaceId,
              recordingId,
              status: "succeeded",
              providerJobId: "fixture",
              error: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        },
      });
    }
    if (path === `/recordings/${recordingId}/audio`) {
      // This journey exercises attribution, not playback.
      return route.fulfill({ status: 204 });
    }
    const prefix = `/processing/${runId}/corrections`;
    if (path === `${prefix}/targets`) {
      return route.fulfill({
        json: {
          targets: turns.map(({ id, attributionRevision }) => ({
            id,
            expectedAttributionRevision: attributionRevision,
          })),
          excludedManualCount: 0,
        },
      });
    }
    if (path === prefix && route.request().method() === "GET") {
      return route.fulfill({
        json: { items: turns.slice(0, 100), nextCursor: "next-page" },
      });
    }
    if (path === `${prefix}/history`)
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === prefix && route.request().method() === "POST") {
      const command = correctionCommandSchema.parse(route.request().postDataJSON());
      commandBodies.push(command);
      const receiptId = randomUUID();
      receiptIds.set(command.commandId, receiptId);
      return route.fulfill({
        json: {
          receipt: {
            id: receiptId,
            commandId: command.commandId,
            kind: command.kind,
            affectedCount: command.kind === "assign" ? command.targets.length : 1,
            createdAt: timestamp,
            undoOf: null,
          },
          current: {
            items: turns.filter(
              (turn) =>
                command.kind === "assign" &&
                command.targets.some((target) => target.id === turn.id),
            ),
            removed: [],
            complete: true,
          },
        },
      });
    }
    return route.fallback();
  });

  await page.goto(`/notes/${note.id}`);
  await page.getByRole("button", { name: "Assign speaker at 0:00: Speaker 1" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose speaker" });
  await dialog.getByRole("textbox").fill("New guest");
  await dialog.getByRole("button", { name: "Create “New guest”" }).click();
  await expect(dialog.getByRole("button", { name: /All matching segments \(105\)/ })).toBeVisible();
  await expect(dialog.getByText(/105 unassigned/)).toBeVisible();
  await expect.poll(() => commandBodies).toHaveLength(0);
  expect(workspace.mutations.filter((mutation) => mutation.collection === "people")).toHaveLength(
    0,
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog.getByRole("group", { name: "Confirm speaker assignment" })).toHaveCount(0);
  expect(workspace.mutations.filter((mutation) => mutation.collection === "people")).toHaveLength(
    0,
  );
  await dialog.getByRole("textbox").fill("New guest");
  await dialog.getByRole("button", { name: "Create “New guest”" }).click();
  await expect(dialog.getByRole("button", { name: /All matching segments \(105\)/ })).toBeVisible();
  await dialog.getByRole("button", { name: /All matching segments/ }).click();
  await expect.poll(() => commandBodies).toHaveLength(1);
  const command = commandBodies[0]!;
  expect(command.kind).toBe("assign");
  if (command.kind === "assign") {
    expect(command.targets).toHaveLength(105);
    expect(command.targets.some((target) => target.id === turns[104]!.id)).toBe(true);
  }
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => commandBodies).toHaveLength(2);
  expect(commandBodies[1]?.kind).toBe("undo");
  if (commandBodies[1]?.kind === "undo")
    expect(commandBodies[1].correctionId).toBe(receiptIds.get(command.commandId));
  await page.getByRole("button", { name: "Assign speaker at 0:00: Speaker 1" }).click();
  const nextDialog = page.getByRole("dialog", { name: "Choose speaker" });
  await nextDialog.getByRole("textbox").fill("Nobody matches this search");
  await expect(nextDialog.getByRole("button", { name: "Select Taylor", exact: true })).toHaveCount(
    0,
  );
  await nextDialog.getByRole("button", { name: "Select Me (Taylor)", exact: true }).click();
  await expect.poll(() => commandBodies).toHaveLength(2);
  await nextDialog.getByRole("button", { name: "Only this passage" }).click();
  await expect.poll(() => commandBodies).toHaveLength(3);
  const single = commandBodies[2]!;
  expect(single.kind).toBe("assign");
  if (single.kind === "assign") {
    expect(single.assignment).toEqual({ kind: "person", personId: self.id });
    expect(single.targets).toHaveLength(100);
    expect(single.targets[0]?.id).toBe(turns[0]!.id);
    expect(single.targets.at(-1)?.id).toBe(turns[99]!.id);
  }
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => commandBodies).toHaveLength(4);
  const undoSelf = commandBodies[3]!;
  expect(undoSelf.kind).toBe("undo");
  if (undoSelf.kind === "undo") {
    expect(undoSelf.correctionId).toBe(receiptIds.get(single.commandId));
  }
  await expect
    .poll(() => workspace.mutations.filter((mutation) => mutation.collection === "people"))
    .toHaveLength(1);
});
