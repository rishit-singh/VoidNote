import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { test, expect, timestamp, workspaceId, type WorkspaceFixture } from "./workspace-fixture";
import {
  correctedTurnSchema,
  correctionCommandSchema,
  type CorrectionCommand,
} from "../../src/contracts/transcript-corrections";

async function fixture(page: Page, workspace: WorkspaceFixture) {
  const note = workspace.seedNote({ title: "Speaker workshop" });
  const person = workspace.seedPerson({ displayName: "Alex Rivera" });
  const recordingId = randomUUID(),
    runId = randomUUID(),
    id = randomUUID();
  const original = correctedTurnSchema.parse({
    id,
    runId,
    recordingId,
    sequence: 0,
    sourceUtteranceId: id,
    parentId: null,
    startSeconds: 0,
    endSeconds: 12,
    speakerLabel: "SPEAKER_00",
    text: "Hello Alex. Hello Sam.",
    revision: 0,
    attributionRevision: 0,
    assignment: { kind: "unassigned" },
    assignmentSource: "unassigned",
    personName: null,
    reviewState: "unreviewed",
    providerScore: null,
    sampleSuitability: "not_evaluated",
    originalText: "Hello Alex. Hello Sam.",
    originalStartSeconds: 0,
    originalEndSeconds: 12,
  });
  const state = {
    items: [original],
    commands: [] as CorrectionCommand[],
    failure: null as "lost" | "conflict" | null,
    delay: null as Promise<void> | null,
  };
  const receipts = new Map<
    string,
    {
      id: string;
      commandId: string;
      kind: string;
      affectedCount: number;
      createdAt: string;
      undoOf: string | null;
    }
  >();
  const before = new Map<string, typeof state.items>();
  const root = `/api/workspaces/${workspaceId}/notes/${note.id}`;
  const bytes = Buffer.alloc(44 + 12 * 16000);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  await page.route(`**${root}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.slice(root.length);
    if (path === "/recordings")
      return route.fulfill({
        json: {
          recordings: [
            {
              id: recordingId,
              noteId: note.id,
              workspaceId,
              sha256: "a".repeat(64),
              bytes: bytes.length,
              mimeType: "audio/wav",
              durationSeconds: 12,
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
    if (path.endsWith("/audio")) {
      const range = route
        .request()
        .headers()
        .range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      return route.fulfill({
        status: range ? 206 : 200,
        contentType: "audio/wav",
        body: bytes.subarray(start, end + 1),
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          ...(range ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}),
        },
      });
    }
    if (path.endsWith("/history")) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (!path.endsWith("/corrections")) return route.fallback();
    if (route.request().method() === "GET") {
      const items = structuredClone(state.items);
      if (state.delay) await state.delay;
      return route.fulfill({ json: { items, nextCursor: null } });
    }
    const command = correctionCommandSchema.parse(route.request().postDataJSON());
    state.commands.push(command);
    if (receipts.has(command.commandId))
      return route.fulfill({ json: receipts.get(command.commandId) });
    if (state.failure === "conflict") {
      state.failure = null;
      return route.fulfill({
        status: 409,
        json: { code: "conflict", error: "Speech changed elsewhere." },
      });
    }
    const receipt = {
      id: randomUUID(),
      commandId: command.commandId,
      kind: command.kind,
      affectedCount: 1,
      createdAt: timestamp,
      undoOf: command.kind === "undo" ? command.correctionId : null,
    };
    before.set(receipt.id, structuredClone(state.items));
    if (command.kind === "assign")
      state.items = state.items.map((turn) => ({
        ...turn,
        assignment: command.assignment,
        assignmentSource: "manual",
        attributionRevision: turn.attributionRevision + 1,
        personName:
          command.assignment.kind === "person"
            ? workspace.people.get(command.assignment.personId)!.displayName
            : null,
      }));
    if (command.kind === "split" && command.selection) {
      const s = command.selection;
      state.items = [
        ...(s.startOffset
          ? [
              {
                ...original,
                id: command.leftId,
                text: original.text.slice(0, s.startOffset),
                endSeconds: s.startSeconds,
              },
            ]
          : []),
        {
          ...original,
          id: s.selectedId,
          text: original.text.slice(s.startOffset, s.endOffset),
          startSeconds: s.startSeconds,
          endSeconds: s.endSeconds,
          assignment: s.assignment,
          assignmentSource: "manual" as const,
          personName:
            s.assignment.kind === "person"
              ? workspace.people.get(s.assignment.personId)!.displayName
              : null,
        },
        ...(s.endOffset < original.text.length
          ? [
              {
                ...original,
                id: command.rightId,
                text: original.text.slice(s.endOffset),
                startSeconds: s.endSeconds,
              },
            ]
          : []),
      ];
    }
    if (command.kind === "undo") state.items = before.get(command.correctionId)!;
    receipts.set(command.commandId, receipt);
    if (state.failure === "lost") {
      state.failure = null;
      return route.abort("connectionreset");
    }
    return route.fulfill({ json: receipt });
  });
  return { note, person, state };
}

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"}: immediate speaker assignment, inline creation and undo`, async ({
    page,
    workspace,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const f = await fixture(page, workspace);
    await page.goto(`/notes/${f.note.id}`);
    await page.getByRole("button", { name: "Assign speaker at 0:00: Speaker 1" }).click();
    const dialog = page.getByRole("dialog", { name: "Choose speaker" });
    await expect(dialog.getByRole("textbox")).toBeFocused();
    await dialog.getByRole("button", { name: "Select Alex Rivera" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Assign speaker at 0:00: Alex Rivera" }).click();
    await dialog.getByRole("textbox").fill("Sam Lee");
    await page.screenshot({
      path: test.info().outputPath("speaker-picker.png"),
      animations: "disabled",
    });
    await dialog.getByRole("button", { name: "Create “Sam Lee”" }).click();
    await expect(
      page.getByRole("button", { name: "Assign speaker at 0:00: Sam Lee" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Assign speaker at 0:00: Alex Rivera" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /history/i })).toHaveCount(0);
    expect(f.state.commands).toHaveLength(3);
  });
  test(`${mobile ? "mobile" : "desktop"}: visual range replays only selection and assigns in one command`, async ({
    page,
    workspace,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const f = await fixture(page, workspace);
    await page.goto(`/notes/${f.note.id}`);
    await page.getByRole("button", { name: "Select speech at 0:00" }).click();
    const dialog = page.getByRole("dialog", { name: "Assign selected speech" });
    await dialog.getByRole("button", { name: "Alex.", exact: true }).click();
    const end = dialog.getByRole("slider", { name: /Audio end/ });
    await end.fill("4");
    await dialog.getByRole("button", { name: "Replay selection" }).click();
    const audio = page.getByTestId("persistent-audio");
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
      .toBeGreaterThan(3.4);
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
    expect(await audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeLessThan(4.5);
    await page.screenshot({
      path: test.info().outputPath("speech-selection.png"),
      animations: "disabled",
    });
    await dialog.getByRole("button", { name: "Select Alex Rivera" }).click();
    await expect(dialog).toHaveCount(0);
    expect(f.state.commands).toHaveLength(1);
    expect(f.state.commands[0]?.kind).toBe("split");
    if (f.state.commands[0]?.kind === "split")
      expect(f.state.commands[0].selection?.endSeconds).toBeCloseTo(4, 1);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByText("Hello Alex. Hello Sam.", { exact: true })).toBeVisible();
  });
}

test("uncertain assignment replays its exact command after reload; stale assignment is reviewable", async ({
  page,
  workspace,
}) => {
  const f = await fixture(page, workspace);
  await page.goto(`/notes/${f.note.id}`);
  await page.getByRole("button", { name: "Assign speaker at 0:00: Speaker 1" }).click();
  f.state.failure = "lost";
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Unknown speaker", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("region", { name: "Corrected transcript" })
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect.poll(() => f.state.commands[1]).toEqual(f.state.commands[0]);
  await page.getByRole("button", { name: "Assign speaker at 0:00: Unknown speaker" }).click();
  f.state.failure = "conflict";
  await page.getByRole("button", { name: "Select Alex Rivera" }).click();
  await page.getByRole("button", { name: "Review speech", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("closing a selection clears its stop boundary before normal playback", async ({
  page,
  workspace,
}) => {
  const f = await fixture(page, workspace);
  await page.goto(`/notes/${f.note.id}`);
  await page.getByRole("button", { name: "Select speech at 0:00" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Alex.", exact: true }).click();
  await dialog.getByRole("slider", { name: /Audio end/ }).fill("4");
  await dialog.getByRole("button", { name: "Replay selection" }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Play audio", exact: true }).click();
  await expect
    .poll(() =>
      page.getByTestId("persistent-audio").evaluate((audio: HTMLAudioElement) => audio.currentTime),
    )
    .toBeGreaterThan(4.5);
});

test("demo: grouped passage assigns all segments and downloads Markdown", async ({
  page,
  workspace,
}) => {
  const f = await fixture(page, workspace);
  const first = f.state.items[0]!;
  f.state.items.push({
    ...first,
    id: randomUUID(),
    startSeconds: 12.5,
    endSeconds: 15,
    text: "The conversation continues.",
  });
  await page.goto(`/notes/${f.note.id}`);
  await expect(
    page.getByRole("list", { name: "Timestamped transcript" }).getByRole("listitem"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Assign speaker at 0:00: Speaker 1" }).click();
  await page.getByRole("button", { name: "Select Alex Rivera" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const command = f.state.commands[0];
  expect(command?.kind).toBe("assign");
  if (command?.kind === "assign") expect(command.targets).toHaveLength(2);
  test.skip(
    (await page.getByRole("button", { name: "Download Markdown" }).count()) === 0,
    "Markdown export requires NEXT_PUBLIC_TRANSCRIPT_MARKDOWN_EXPORT=true at build time.",
  );
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Markdown" }).click();
  const download = await downloadEvent;
  const content = await readFile(await download.path(), "utf8");
  expect(download.suggestedFilename()).toMatch(/\.md$/);
  expect(content).toContain("Alex Rivera");
  expect(content).toContain("conversation continues");
});
