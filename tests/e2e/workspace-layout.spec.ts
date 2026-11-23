import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { toPersonListItem } from "../../src/contracts/people";
import { correctedTurnSchema } from "../../src/contracts/transcript-corrections";
import { expect, test, timestamp, workspaceId, type WorkspaceFixture } from "./workspace-fixture";

// Browser launch configuration is worker-scoped and must be declared at file scope.
test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

async function box(locator: Locator) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

async function expectStationary(locator: Locator, before: Awaited<ReturnType<typeof box>>) {
  const after = await box(locator);
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(after[key] - before[key]), `Stationary ${key}`).toBeLessThanOrEqual(1);
  }
}

async function expectContained(page: Page) {
  await expect(
    page.getByRole("main"),
    "Authenticated routes expose only the workspace main",
  ).toHaveCount(1);
  expect(
    await page.evaluate(() => ({
      width: document.documentElement.scrollWidth <= window.innerWidth,
      height: document.documentElement.scrollHeight <= window.innerHeight,
      documentScroll: document.scrollingElement?.scrollTop ?? 0,
      mainScroll: document.querySelector("#main-content")?.scrollTop ?? 0,
    })),
  ).toEqual({ width: true, height: true, documentScroll: 0, mainScroll: 0 });
  const mobile = page.getByRole("navigation", { name: "Mobile workspace navigation" });
  const navigation =
    page.viewportSize()!.width <= 760
      ? mobile
      : page.getByRole("navigation", { name: "Workspace", exact: true });
  await expect(navigation).toBeInViewport({ ratio: 1 });
  for (const link of await navigation.getByRole("link").all()) {
    await expect(link).toBeInViewport({ ratio: 1 });
  }
}

async function wheelOverflow(page: Page, region: Locator) {
  await expect
    .poll(() => region.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(80);
  expect(await region.evaluate((element) => getComputedStyle(element).overflowY)).toMatch(
    /^(auto|scroll)$/,
  );
  await region.scrollIntoViewIfNeeded();
  await region.hover();
  await page.mouse.wheel(0, 420);
  await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
}

async function scrollToEnd(region: Locator) {
  await region.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
}

async function attachLayout(page: Page, name: string) {
  await test.info().attach(name, {
    body: await page.screenshot(),
    contentType: "image/png",
  });
}

async function expectReadableLandscapeEditor(page: Page, title: string) {
  const editor = await box(page.getByRole("region", { name: title, exact: true }));
  const tabs = page.getByRole("tablist", { name: "Note content", exact: true });
  const tabsBox = await box(tabs);
  expect(tabsBox.y).toBeGreaterThanOrEqual(editor.y);
  expect(tabsBox.y + tabsBox.height).toBeLessThanOrEqual(editor.y + editor.height + 1);
  for (const tab of await tabs.getByRole("tab").all()) {
    await expect(tab).toBeInViewport({ ratio: 1 });
  }
  const transcript = page.getByRole("tabpanel", { name: "Transcript", exact: true });
  // Two readable lines: a merely positive 1px pane still leaves the editor unusable.
  expect(await transcript.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(48);
  const content = await box(transcript);
  expect(content.y).toBeGreaterThanOrEqual(tabsBox.y + tabsBox.height - 1);
  expect(content.y + content.height).toBeLessThanOrEqual(editor.y + editor.height + 1);
  const recorder = page.getByRole("region", { name: "Audio recorder", exact: true });
  const recorderBox = await box(recorder);
  expect(content.y + content.height).toBeLessThanOrEqual(recorderBox.y + 1);
  await expect(recorder).toBeInViewport({ ratio: 1 });
  for (const control of await recorder.getByRole("button").all()) {
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  const navigation = await box(
    page.getByRole("navigation", { name: "Mobile workspace navigation" }),
  );
  expect(recorderBox.y + recorderBox.height).toBeLessThanOrEqual(navigation.y + 1);
  await expectContained(page);
}

for (const viewport of [
  { width: 1440, height: 640 },
  { width: 760, height: 640 },
  { width: 761, height: 640 },
]) {
  test(`overflowing notes paginate within their own scroll region at ${viewport.width}px`, async ({
    page,
    workspace,
  }) => {
    const notes = Array.from({ length: 36 }, (_, index) =>
      workspace.seedNote({ title: `Layout note ${String(index + 1).padStart(2, "0")}` }),
    );
    await page.route("**/api/workspaces/*/notes?*", (route) => {
      const next = new URL(route.request().url()).searchParams.has("cursor");
      return route.fulfill({
        json: {
          items: next ? notes.slice(35) : notes.slice(0, 35),
          nextCursor: next ? null : "notes-page-2",
        },
      });
    });
    await page.setViewportSize(viewport);
    await page.goto("/");
    const list = page.getByRole("region", { name: "Notes list", exact: true });
    await expect(list.getByRole("link")).toHaveCount(35);
    const heading = page.getByRole("heading", { name: "Home", exact: true });
    const create = page.getByRole("button", { name: "New note", exact: true });
    const headingBox = await box(heading);
    const createBox = await box(create);
    expect(
      Math.abs(headingBox.y + headingBox.height / 2 - createBox.y - createBox.height / 2),
    ).toBeLessThanOrEqual(4);
    await wheelOverflow(page, list);
    await scrollToEnd(list);
    const more = list.getByRole("button", { name: "Load more notes", exact: true });
    // On the stacked home layout the Home content owner also scrolls; the
    // header and main element still must not move to expose pagination.
    await more.scrollIntoViewIfNeeded();
    await expect(more).toBeInViewport({ ratio: 1 });
    await more.click();
    await expect(list.getByRole("link")).toHaveCount(36);
    await scrollToEnd(list);
    await expect(list.getByRole("link").last()).toBeInViewport({ ratio: 1 });
    await expectStationary(heading, headingBox);
    await expectStationary(create, createBox);
    await expectContained(page);
    if (viewport.width === 1440) await attachLayout(page, "desktop-home-overflow");
    await list.getByRole("link").last().click();
    await expect(page).toHaveURL(new RegExp(`/notes/${notes[35]!.id}$`));
  });
}

async function seedTranscript(page: Page, workspace: WorkspaceFixture) {
  const note = workspace.seedNote({ title: "Long recorded conversation" });
  const recordingId = randomUUID();
  const runId = randomUUID();
  const turns = Array.from({ length: 33 }, (_, index) => {
    const id = randomUUID();
    return correctedTurnSchema.parse({
      id,
      runId,
      recordingId,
      sequence: index,
      orderKey: "",
      sourceUtteranceId: id,
      parentId: null,
      startSeconds: index * 8,
      endSeconds: index * 8 + 6,
      speakerLabel: `SPEAKER_0${index % 2}`,
      text:
        index === 32
          ? "Passage 33. End of transcript."
          : `Passage ${index + 1}. ${"A detailed discussion of the next steps and decisions. ".repeat(4)}`,
      revision: 0,
      attributionRevision: 0,
      assignment: { kind: "unassigned" },
      assignmentSource: "unassigned",
      personName: null,
      reviewState: "unreviewed",
      providerScore: null,
      sampleSuitability: "not_evaluated",
      originalText: `Original passage ${index + 1}`,
      originalStartSeconds: index * 8,
      originalEndSeconds: index * 8 + 6,
    });
  });
  const audio = Buffer.alloc(44 + 300 * 16000);
  audio.write("RIFF");
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24);
  audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  const root = `/api/workspaces/${workspaceId}/notes/${note.id}`;
  await page.route(`**${root}/**`, (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice(root.length);
    if (path === "/recordings")
      return route.fulfill({
        json: {
          recordings: [
            {
              id: recordingId,
              noteId: note.id,
              workspaceId,
              sha256: "a".repeat(64),
              bytes: audio.length,
              mimeType: "audio/wav",
              durationSeconds: 300,
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
              providerJobId: "layout-fixture",
              error: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        },
      });
    if (path.endsWith("/corrections")) {
      const next = url.searchParams.has("cursor");
      return route.fulfill({
        json: {
          items: next ? turns.slice(32) : turns.slice(0, 32),
          nextCursor: next ? null : "transcript-page-2",
        },
      });
    }
    if (path.endsWith("/history")) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith("/audio")) return route.fulfill({ contentType: "audio/wav", body: audio });
    return route.fallback();
  });
  return note;
}

for (const viewport of [
  { width: 1440, height: 640 },
  { width: 390, height: 640 },
  { width: 760, height: 560 },
  { width: 761, height: 560 },
]) {
  test(`transcript pagination scrolls independently of header and recorder at ${viewport.width}px`, async ({
    page,
    workspace,
  }) => {
    const note = await seedTranscript(page, workspace);
    await page.setViewportSize(viewport);
    await page.goto(`/notes/${note.id}`);
    const title = page.getByLabel("Title", { exact: true });
    await expect(title).toHaveValue(note.title);
    const region = page.getByRole("tabpanel", { name: "Transcript", exact: true });
    await expect(region.getByText(/^Passage 32\./)).toBeVisible();
    const titleBox = await box(title);
    const actions = page.getByRole("button", { name: "Note actions", exact: true });
    const actionsBox = await box(actions);
    expect(
      Math.abs(titleBox.y + titleBox.height / 2 - actionsBox.y - actionsBox.height / 2),
    ).toBeLessThanOrEqual(18);
    const recorder = page.getByRole("region", { name: "Audio recorder", exact: true });
    await expect(page.getByRole("button", { name: "Play audio", exact: true })).toBeEnabled();
    const recorderBox = await box(recorder);
    await wheelOverflow(page, region);
    await scrollToEnd(region);
    const more = region.getByRole("button", { name: "Load more", exact: true });
    await expect(more).toBeInViewport({ ratio: 1 });
    await more.click();
    await expect(region.getByText(/^Passage 33\./)).toBeVisible();
    await scrollToEnd(region);
    await expect(region.getByText(/^Passage 33\./)).toBeInViewport({ ratio: 1 });
    await expectStationary(title, titleBox);
    await expectStationary(actions, actionsBox);
    await expectStationary(recorder, recorderBox);
    await expect(title).toBeInViewport({ ratio: 1 });
    await expect(actions).toBeInViewport({ ratio: 1 });
    const regionBox = await box(region);
    expect(regionBox.y + regionBox.height).toBeLessThanOrEqual(recorderBox.y + 1);
    await expect(recorder).toBeInViewport({ ratio: 1 });
    for (const control of await recorder.getByRole("button").all()) {
      await expect(control).toBeInViewport({ ratio: 1 });
    }
    if (viewport.width <= 760) {
      const navigation = await box(
        page.getByRole("navigation", { name: "Mobile workspace navigation" }),
      );
      expect(recorderBox.y + recorderBox.height).toBeLessThanOrEqual(navigation.y + 1);
    }
    await expectContained(page);
    if (viewport.width === 390) await attachLayout(page, "mobile-transcript-overflow");
  });
}

for (const width of [390, 761]) {
  test(`short viewport keeps the new-note recorder and navigation unclipped at ${width}px`, async ({
    page,
    workspace,
  }) => {
    const note = workspace.seedNote({ title: "Ready to record" });
    await page.setViewportSize({ width, height: 420 });
    await page.goto(`/notes/${note.id}`);
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(note.title);
    const record = page.getByRole("button", { name: "Record", exact: true });
    await expect(record).toBeEnabled();
    await expect(record).toBeInViewport({ ratio: 1 });
    await expect(page.getByLabel("Title", { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Note actions", exact: true })).toBeInViewport({
      ratio: 1,
    });
    const recorder = await box(page.getByRole("region", { name: "Audio recorder", exact: true }));
    const content = await box(page.getByRole("tabpanel", { name: "Transcript", exact: true }));
    expect(content.height).toBeGreaterThan(0);
    expect(content.y + content.height).toBeLessThanOrEqual(recorder.y + 1);
    if (width <= 760) {
      const navigation = await box(
        page.getByRole("navigation", { name: "Mobile workspace navigation" }),
      );
      expect(recorder.y + recorder.height).toBeLessThanOrEqual(navigation.y + 1);
    }
    await expectContained(page);
  });
}

test("760×320 landscape retains a readable, scrollable transcript below contained tabs", async ({
  page,
  workspace,
}) => {
  const note = await seedTranscript(page, workspace);
  await page.setViewportSize({ width: 760, height: 320 });
  await page.goto(`/notes/${note.id}`);
  await expect(page.getByRole("button", { name: "Play audio", exact: true })).toBeEnabled();
  const transcript = page.getByRole("tabpanel", { name: "Transcript", exact: true });
  await expect(transcript.getByText(/^Passage 32\./)).toBeVisible();
  await expectReadableLandscapeEditor(page, note.title);
  const title = page.getByLabel("Title", { exact: true });
  const titleBox = await box(title);
  await wheelOverflow(page, transcript);
  await scrollToEnd(transcript);
  const more = transcript.getByRole("button", { name: "Load more", exact: true });
  await expect(more).toBeInViewport({ ratio: 1 });
  await more.click();
  await expect(transcript.getByText(/^Passage 33\./)).toBeVisible();
  await scrollToEnd(transcript);
  await expect(transcript.getByText(/^Passage 33\./)).toBeInViewport({ ratio: 1 });
  await expectStationary(title, titleBox);
  await expectReadableLandscapeEditor(page, note.title);
});

test.describe("landscape with active microphone capture", () => {
  test.use({
    permissions: ["microphone"],
  });

  test("760×320 keeps transcript readable and recording controls reachable during navigation", async ({
    page,
    workspace,
  }) => {
    const owner = workspace.seedNote({ title: "Active landscape recording" });
    const transcriptNote = await seedTranscript(page, workspace);
    await page.setViewportSize({ width: 760, height: 320 });
    await page.goto(`/notes/${owner.id}`);
    const record = page.getByRole("button", { name: "Record", exact: true });
    await expect(record).toBeInViewport({ ratio: 1 });
    await record.click();
    const pause = page.getByRole("button", { name: "Pause recording", exact: true });
    await expect(pause).toBeEnabled();
    await expectReadableLandscapeEditor(page, owner.title);
    await page
      .getByRole("navigation", { name: "Mobile workspace navigation" })
      .getByRole("link", { name: "Home", exact: true })
      .click();
    await page
      .getByRole("list", { name: "Notes", exact: true })
      .getByRole("link", { name: new RegExp(transcriptNote.title) })
      .click();
    await expect(page).toHaveURL(new RegExp(`/notes/${transcriptNote.id}$`));
    await expect(pause).toBeEnabled();
    await expect(
      page.getByRole("link", { name: "Open recording note", exact: true }),
    ).toHaveAttribute("href", `/notes/${owner.id}`);
    const transcript = page.getByRole("tabpanel", { name: "Transcript", exact: true });
    await expect(transcript.getByText(/^Passage 32\./)).toBeVisible();
    await expectReadableLandscapeEditor(page, transcriptNote.title);
    await wheelOverflow(page, transcript);
    await scrollToEnd(transcript);
    await expect(transcript.getByRole("button", { name: "Load more", exact: true })).toBeInViewport(
      { ratio: 1 },
    );
    await expectReadableLandscapeEditor(page, transcriptNote.title);
    await pause.click();
    await expect(
      page.getByRole("button", { name: "Resume recording", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Stop recording", exact: true })).toBeInViewport({
      ratio: 1,
    });
  });
});

for (const width of [390, 1100, 1101]) {
  test(`profiles pagination and detail remain reachable at ${width}px`, async ({
    page,
    workspace,
  }) => {
    const people = Array.from({ length: 36 }, (_, index) =>
      workspace.seedPerson({ displayName: `Speaker ${String(index + 1).padStart(2, "0")}` }),
    );
    await page.route("**/api/workspaces/*/people?*", (route) => {
      const next = new URL(route.request().url()).searchParams.has("cursor");
      return route.fulfill({
        json: {
          items: (next ? people.slice(35) : people.slice(0, 35)).map(toPersonListItem),
          nextCursor: next ? null : "profiles-page-2",
        },
      });
    });
    await page.setViewportSize({ width, height: 640 });
    await page.goto("/profiles");
    const list = page.getByRole("complementary", { name: "Profiles", exact: true });
    await expect(list.getByRole("link")).toHaveCount(35);
    const heading = page.getByRole("heading", { name: "Profiles", exact: true });
    const headingBox = await box(heading);
    const search = page.getByRole("searchbox", { name: "Search profiles", exact: true });
    const searchBox = await box(search);
    await wheelOverflow(page, list);
    await scrollToEnd(list);
    const more = list.getByRole("button", { name: "Load more profiles", exact: true });
    await expect(more).toBeInViewport({ ratio: 1 });
    await more.click();
    await expect(list.getByRole("link")).toHaveCount(36);
    await scrollToEnd(list);
    await expect(list.getByRole("link").last()).toBeInViewport({ ratio: 1 });
    await expectStationary(heading, headingBox);
    await expectStationary(search, searchBox);
    await expectContained(page);
    await list.getByRole("link").last().click();
    await expect(page).toHaveURL(new RegExp(`/profiles/${people[35]!.id}$`));
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      people[35]!.displayName,
    );
    const details = page.getByRole("region", { name: "Profile details", exact: true });
    const detailHeading = page.getByRole("heading", { name: people[35]!.displayName, exact: true });
    const detailHeadingBox = await box(detailHeading);
    if (width <= 1100) {
      await expect(list).toBeHidden();
      await expect(search).toBeHidden();
    } else {
      await expect(list).toBeVisible();
      const before = await list.evaluate((element) => element.scrollTop);
      await wheelOverflow(page, details);
      expect(await list.evaluate((element) => element.scrollTop)).toBe(before);
      const detailScroll = await details.evaluate((element) => element.scrollTop);
      await list.evaluate((element) => {
        element.scrollTop = 0;
      });
      await wheelOverflow(page, list);
      expect(await details.evaluate((element) => element.scrollTop)).toBe(detailScroll);
    }
    await scrollToEnd(details);
    const save = details.getByRole("button", { name: "Save profile", exact: true });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport({ ratio: 1 });
    await expect(
      details.getByRole("button", { name: "Delete profile", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expectStationary(detailHeading, detailHeadingBox);
    await expectContained(page);
    if (width === 1101) await attachLayout(page, "desktop-profiles-independent-scroll");
  });
}
