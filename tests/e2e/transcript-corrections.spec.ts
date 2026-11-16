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
    orderKey: "",
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
    commandDelay: null as Promise<void> | null,
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
  const after = new Map<string, typeof state.items>();
  const retired = new Map<string, { id: string; revision: number; attributionRevision: number }>();
  const result = (receipt: NonNullable<ReturnType<typeof receipts.get>>) => {
    const ids = new Set([
      ...(before.get(receipt.id) ?? []).map((turn) => turn.id),
      ...(after.get(receipt.id) ?? []).map((turn) => turn.id),
    ]);
    return {
      receipt,
      current: {
        items: state.items.filter((turn) => ids.has(turn.id)),
        removed: [...retired.values()].filter((turn) => ids.has(turn.id)),
        complete: true,
      },
    };
  };
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
    if (state.commandDelay) await state.commandDelay;
    if (receipts.has(command.commandId))
      return route.fulfill({ json: result(receipts.get(command.commandId)!) });
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
        revision: turn.revision + 1,
        attributionRevision: turn.attributionRevision + 1,
        personName:
          command.assignment.kind === "person"
            ? workspace.people.get(command.assignment.personId)!.displayName
            : null,
      }));
    if (command.kind === "split" && command.selection) {
      const s = command.selection;
      retired.set(original.id, {
        id: original.id,
        revision: original.revision + 1,
        attributionRevision: original.attributionRevision + 1,
      });
      state.items = [
        ...(s.startOffset
          ? [
              {
                ...original,
                id: command.leftId,
                parentId: original.id,
                orderKey: "00",
                text: original.text.slice(0, s.startOffset),
                endSeconds: s.startSeconds,
              },
            ]
          : []),
        {
          ...original,
          id: s.selectedId,
          parentId: original.id,
          orderKey: "01",
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
                parentId: original.id,
                orderKey: "1",
                text: original.text.slice(s.endOffset),
                startSeconds: s.endSeconds,
              },
            ]
          : []),
      ];
    }
    if (command.kind === "undo") {
      const restore = before.get(command.correctionId)!;
      for (const turn of state.items) {
        if (!restore.some((old) => old.id === turn.id)) {
          retired.set(turn.id, {
            id: turn.id,
            revision: turn.revision + 1,
            attributionRevision: turn.attributionRevision + 1,
          });
        }
      }
      state.items = restore.map((turn) => {
        const current =
          state.items.find((item) => item.id === turn.id) ?? retired.get(turn.id) ?? turn;
        retired.delete(turn.id);
        return {
          ...turn,
          revision: current.revision + 1,
          attributionRevision: current.attributionRevision + 1,
        };
      });
    }
    after.set(receipt.id, structuredClone(state.items));
    receipts.set(command.commandId, receipt);
    if (state.failure === "lost") {
      state.failure = null;
      return route.abort("connectionreset");
    }
    return route.fulfill({ json: result(receipt) });
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
    await expect.poll(() => f.state.commands.length).toBe(3);
    await expect(page.getByText("Undone", { exact: true })).toBeVisible();
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
    await expect.poll(() => f.state.commands.length).toBe(1);
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
    page
      .getByRole("region", { name: "Corrected transcript" })
      .getByRole("button", { name: "Retry", exact: true }),
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
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Review speech", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("assignment and Undo preview before acknowledgement and finish while refresh is held", async ({
  page,
  workspace,
}) => {
  const f = await fixture(page, workspace);
  await page.goto(`/notes/${f.note.id}`);
  await page.getByRole("button", { name: "Assign speaker at 0:00: Speaker 1" }).click();
  let releaseCommand!: () => void;
  let releaseRead!: () => void;
  f.state.commandDelay = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  f.state.delay = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const transcript = page.getByRole("region", { name: "Corrected transcript" });
  try {
    await page.getByRole("button", { name: "Select Alex Rivera" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Assign speaker at 0:00: Alex Rivera" }),
    ).toBeVisible();
    await expect(
      transcript.getByText("Saving… Undo is available after confirmation."),
    ).toBeVisible();
    await expect(transcript.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
    expect(f.state.items[0]!.assignment.kind).toBe("unassigned");
    // Text-only work can commit without changing the assignment concurrency token.
    f.state.items[0] = { ...f.state.items[0]!, text: "A newer text correction.", revision: 1 };
    releaseCommand();
    await expect(transcript.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    await expect(transcript.getByText("Speaker updated", { exact: true })).toBeVisible();

    f.state.commandDelay = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    await transcript.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Assign speaker at 0:00: Speaker 1" }),
    ).toBeVisible();
    await expect(transcript.getByText("Undoing…", { exact: true })).toBeVisible();
    await expect(transcript.getByText("A newer text correction.", { exact: true })).toBeVisible();
    expect(f.state.items[0].assignment.kind).toBe("person");
    releaseCommand();
    await expect(transcript.getByText("Undone", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Assign speaker at 0:00: Speaker 1" }),
    ).toBeEnabled();
  } finally {
    releaseCommand();
    releaseRead();
  }
});

test("selected speech previews stable children and a rejection removes only the pending preview", async ({
  page,
  workspace,
}) => {
  const f = await fixture(page, workspace);
  await page.goto(`/notes/${f.note.id}`);
  await page.getByRole("button", { name: "Select speech at 0:00" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Alex.", exact: true }).click();
  let release!: () => void;
  f.state.commandDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.failure = "conflict";
  try {
    await page.getByRole("button", { name: "Select Alex Rivera" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: "Timestamped transcript" }).getByRole("listitem"),
    ).toHaveCount(3);
    await expect(page.getByText("Alex.", { exact: true })).toBeVisible();
    release();
    await expect(page.getByRole("button", { name: "Review speech", exact: true })).toBeVisible();
    await expect(page.getByText("Hello Alex. Hello Sam.", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Timestamped transcript" }).getByRole("listitem"),
    ).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole("button", { name: "Review speech", exact: true })).toBeVisible();
    await expect(page.getByText("Hello Alex. Hello Sam.", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Timestamped transcript" }).getByRole("listitem"),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "Review speech", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Assign speaker at 0:00: Speaker 1" }),
    ).toBeEnabled();
  } finally {
    release();
  }
});

test("conflict recovery persistence failures remain visible instead of the generic conflict message", async ({
  page,
  workspace,
}) => {
  const f = await fixture(page, workspace);
  await page.goto(`/notes/${f.note.id}`);
  await page.getByRole("button", { name: "Assign speaker at 0:00: Speaker 1" }).click();
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the original receiver below.
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("voidnote:corrections:") && value.includes('"rejection":')) {
        throw new DOMException("Storage full", "QuotaExceededError");
      }
      set.call(this, key, value);
    };
  });
  f.state.failure = "conflict";
  await page.getByRole("button", { name: "Select Alex Rivera" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText(
      "This change was rejected, but its recovery status could not be saved. Review speech before leaving this note.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review speech", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Assign speaker at 0:00: Speaker 1" }),
  ).toBeEnabled();
});

test("correction intent survives navigation while a delayed acknowledgement cannot update another note", async ({
  page,
  workspace,
}) => {
  const f = await fixture(page, workspace);
  const other = workspace.seedNote({ title: "Other note" });
  await page.goto(`/notes/${f.note.id}`);
  await page.getByRole("button", { name: "Assign speaker at 0:00: Speaker 1" }).click();
  let release!: () => void;
  f.state.commandDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.getByRole("button", { name: "Select Alex Rivera" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => f.state.commands.length).toBe(1);
    await page.getByRole("link", { name: other.title, exact: true }).click();
    // A completed click does not mean Next's navigation has committed. Hold the
    // response until the old editor unmounts, otherwise it may legitimately
    // acknowledge the command and clear recovery before we leave the note.
    await expect(page).toHaveURL(new RegExp(`/notes/${other.id}$`));
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(other.title);
    await expect(page.getByRole("region", { name: "Corrected transcript" })).toHaveCount(0);
    const acknowledgement = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.startsWith(
          `/api/workspaces/${workspaceId}/notes/${f.note.id}/`,
        ) &&
        new URL(response.url()).pathname.endsWith("/corrections"),
    );
    release();
    expect((await acknowledgement).ok()).toBe(true);
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(other.title);
    await expect(page.getByRole("region", { name: "Corrected transcript" })).toHaveCount(0);
    await page.getByRole("link", { name: f.note.title, exact: true }).click();
    await page
      .getByRole("region", { name: "Corrected transcript" })
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    await expect.poll(() => f.state.commands.length).toBe(2);
    expect(f.state.commands[1]).toEqual(f.state.commands[0]);
    await expect(
      page.getByRole("button", { name: "Assign speaker at 0:00: Alex Rivera" }),
    ).toBeEnabled();
  } finally {
    release();
  }
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

test("inline profile replay verifies deletion before updating cached profiles", async ({
  page,
  workspace,
}) => {
  const f = await fixture(page, workspace);
  await page.goto(`/notes/${f.note.id}`);
  await page.getByRole("button", { name: "Assign speaker at 0:00: Speaker 1" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose speaker" });
  await dialog.getByRole("textbox").fill("Historical guest");
  f.state.failure = "lost";
  await dialog.getByRole("button", { name: "Create “Historical guest”" }).click();
  await expect(
    page
      .getByRole("region", { name: "Corrected transcript" })
      .getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  const guest = [...workspace.people.values()].find(
    (person) => person.displayName === "Historical guest",
  )!;
  const createCommand = workspace.mutations[0]!.command;
  workspace.people.set(guest.id, {
    ...guest,
    revision: guest.revision + 1,
    deletedAt: new Date().toISOString(),
  });
  await page.reload();
  // Prime a current list, then retry against that cache with subsequent reads held.
  await page.getByRole("link", { name: "Profiles", exact: true }).first().click();
  await expect(page.locator(`a[href="/profiles/${f.person.id}"]`)).toBeVisible();
  await expect(page.locator(`a[href="/profiles/${guest.id}"]`)).toHaveCount(0);
  await page.getByRole("link", { name: f.note.title, exact: true }).click();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/workspaces/${workspaceId}/people?*`, async (route) => {
    await held;
    await route.fallback();
  });
  try {
    await page
      .getByRole("region", { name: "Corrected transcript" })
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    await expect.poll(() => f.state.commands.length).toBe(2);
    expect(workspace.mutations[1]!.command).toEqual(createCommand);
    expect(f.state.commands[1]).toEqual(f.state.commands[0]);
    expect(
      workspace.rpcRequests.some(
        (call) =>
          call.procedure === "people.get" &&
          call.input.id === guest.id &&
          call.input.includeDeleted === true,
      ),
    ).toBe(true);
    await page.getByRole("link", { name: "Profiles", exact: true }).first().click();
    await expect(page.locator(`a[href="/profiles/${f.person.id}"]`)).toBeVisible();
    await expect(page.locator(`a[href="/profiles/${guest.id}"]`)).toHaveCount(0);
  } finally {
    release();
  }
});

test("demo: grouped passage assigns all segments and downloads Markdown", async ({
  page,
  workspace,
}) => {
  const f = await fixture(page, workspace);
  const first = f.state.items[0]!;
  const secondId = randomUUID();
  f.state.items.push({
    ...first,
    id: secondId,
    sourceUtteranceId: secondId,
    sequence: 1,
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
  await expect.poll(() => f.state.commands.length).toBe(1);
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
