import { saveNoteSchema } from "../../src/contracts/workspace";
import { expect, test } from "./workspace-fixture";

// These journeys verify browser autosave and reconciliation against mocked
// transport. Allocation concurrency/durability belong to the real DB suite.
test("creation autosaves numbered titles across reload and does not reuse a deleted title", async ({
  page,
  workspace,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New note", exact: true }).click();
  const title = page.getByLabel("Title", { exact: true });
  await expect(title).toHaveValue("Untitled note (1)");
  const firstRoute = page.url();
  await expect.poll(() => workspace.notes.size).toBe(1);
  expect(workspace.mutations[0]!.command.expectedRevision).toBe(0);
  expect(saveNoteSchema.parse(workspace.mutations[0]!.command).content.title).toBe("");

  await page.reload();
  await expect(title).toHaveValue("Untitled note (1)");
  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await expect(
    page.getByRole("list", { name: "Notes", exact: true }).getByRole("link"),
  ).toContainText("Untitled note (1)");
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(title).toHaveValue("Untitled note (2)");
  await page.getByRole("button", { name: "Note actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete note", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect
    .poll(() => [...workspace.notes.values()].filter((note) => note.deletedAt).length)
    .toBe(1);
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(title).toHaveValue("Untitled note (3)");
  await page.goto(firstRoute);
  await expect(title).toHaveValue("Untitled note (1)");
});

for (const initialTitle of ["Field interview", "   "]) {
  test(`first save handles ${initialTitle.trim() ? "a custom title without allocating a number" : "whitespace as an unnamed note"}`, async ({
    page,
    workspace,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "New note", exact: true })).toBeEnabled();
    // Freeze the debounce so typing is guaranteed to precede the first save.
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.getByRole("button", { name: "New note", exact: true }).click();
    const title = page.getByLabel("Title", { exact: true });
    await title.fill(initialTitle);
    expect(workspace.mutations).toHaveLength(0);
    await page.clock.resume();
    const expected = initialTitle.trim() ? initialTitle : "Untitled note (1)";
    await expect.poll(() => [...workspace.notes.values()][0]?.title).toBe(expected);
    await expect(title).toHaveValue(expected);
    expect(saveNoteSchema.parse(workspace.mutations[0]!.command).content.title).toBe(initialTitle);
    await page.reload();
    await expect(title).toHaveValue(expected);
    await page.getByRole("link", { name: "Home", exact: true }).first().click();
    await page.getByRole("button", { name: "New note", exact: true }).click();
    await expect(title).toHaveValue(
      initialTitle.trim() ? "Untitled note (1)" : "Untitled note (2)",
    );
  });
}

test("an allocated title arriving late preserves newer typing and saves the rename", async ({
  page,
  workspace,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstCommand: ReturnType<typeof saveNoteSchema.parse> | undefined;
  await page.route("**/api/workspaces/*/notes", async (route) => {
    if (route.request().method() === "POST" && !firstCommand) {
      firstCommand = saveNoteSchema.parse(route.request().postDataJSON());
      await held;
    }
    await route.fallback();
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "New note", exact: true }).click();
    await expect.poll(() => firstCommand?.content.title).toBe("");
    await page.getByLabel("Title", { exact: true }).fill("Rename while saving");
  } finally {
    release();
  }
  await expect.poll(() => workspace.notes.get(firstCommand!.id)?.title).toBe("Rename while saving");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Rename while saving");
  expect(
    workspace.mutations.map(({ command }) => saveNoteSchema.parse(command).content.title),
  ).toEqual(["", "Rename while saving"]);
  expect(workspace.mutations[1]!.command.expectedRevision).toBe(1);
  await page.reload();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Rename while saving");
  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Untitled note (2)");
});

test("opening and reloading a historical blank title does not backfill or consume a number", async ({
  page,
  workspace,
}) => {
  const historical = workspace.seedNote({ title: "" });
  await page.goto(`/notes/${historical.id}`);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("");
  await page.reload();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("");
  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Untitled note (1)");
  expect(workspace.notes.get(historical.id)).toEqual(historical);
  expect(workspace.mutations.some(({ command }) => command.id === historical.id)).toBe(false);
});

test("an uncertain first save replays one allocation after reload", async ({ page, workspace }) => {
  workspace.nextMutation = "lost-response";
  await page.goto("/");
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  const command = workspace.mutations[0]!.command;
  expect(workspace.notes.get(command.id)?.title).toBe("Untitled note (1)");
  await page.reload();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Untitled note (1)");
  expect(workspace.mutations[1]!.command).toEqual(command);
  expect(workspace.history).toHaveLength(1);
  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Untitled note (2)");
});
