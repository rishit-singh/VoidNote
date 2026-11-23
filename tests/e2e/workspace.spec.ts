import { expect, test } from "./workspace-fixture";

test("new note titles autosave, survive navigation and reload, and hide internal history", async ({
  page,
  workspace,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New note", exact: true }).first().click();
  // Creation has its own autosave. Wait for that acknowledgement rather than
  // racing the first rename against the debounce and assuming two history rows.
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Untitled note (1)");
  await page.getByLabel("Title", { exact: true }).fill("Garden plan");
  await expect
    .poll(() => [...workspace.notes.values()].find((n) => n.title === "Garden plan")?.title)
    .toBe("Garden plan");
  const route = page.url();
  await page.getByLabel("Title", { exact: true }).fill("Updated garden plan");
  await page.getByRole("link", { name: "Profiles", exact: true }).first().click();
  await expect
    .poll(() => [...workspace.notes.values()].some((n) => n.title === "Updated garden plan"))
    .toBe(true);
  await page.goto(route);
  await page.reload();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Updated garden plan");
  await expect(page.getByRole("textbox", { name: "Transcript", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Save note|History/ })).toHaveCount(0);
  expect(workspace.history).toHaveLength(3);
});

test("renaming a profile preserves its identity", async ({ page, workspace }) => {
  const person = workspace.seedPerson({ displayName: "Alex" });
  await page.goto(`/profiles/${person.id}`);
  await page.getByLabel("Display name", { exact: true }).fill("Alex Rivera");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect.poll(() => workspace.people.get(person.id)?.displayName).toBe("Alex Rivera");
  await page.reload();
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue("Alex Rivera");
  expect(workspace.people.size).toBe(1);
});

test("conflicting autosave retains a draft until the user chooses which title to keep", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Shared note" });
  await page.goto(`/notes/${note.id}`);
  workspace.seedNote({ ...note, revision: 2, title: "Someone else's title" });
  workspace.nextMutation = "conflict";
  await page.getByLabel("Title", { exact: true }).fill("My title");
  await expect(page.getByText("This note changed elsewhere.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("My title");
  const rejected = workspace.mutations[0]!.command;
  await page.getByRole("button", { name: "Keep mine", exact: true }).click();
  await expect.poll(() => workspace.notes.get(note.id)?.title).toBe("My title");
  expect(workspace.mutations[1]!.command.expectedRevision).toBe(2);
  expect(workspace.mutations[1]!.command.commandId).not.toBe(rejected.commandId);
});

test("uncertain autosave replays its exact command while preserving newer typing", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote({ title: "Retry note" });
  await page.goto(`/notes/${note.id}`);
  workspace.nextMutation = "lost-response";
  await page.getByLabel("Title", { exact: true }).fill("Save once");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  const command = workspace.mutations[0]!.command;
  await page.getByLabel("Title", { exact: true }).fill("Newer title");
  await page.reload();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Newer title");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => workspace.notes.get(note.id)?.title).toBe("Newer title");
  expect(workspace.mutations[1]!.command).toEqual(command);
  expect(workspace.history).toHaveLength(2);
});

test("session expiry retains an account-scoped title draft", async ({ page, workspace }) => {
  const account = workspace.session!;
  const note = workspace.seedNote({ title: "Private note" });
  await page.goto(`/notes/${note.id}`);
  await page.getByLabel("Title", { exact: true }).fill("Private draft");
  workspace.session = null;
  await page.reload();
  await expect(page.getByRole("button", { name: "Send sign-in link", exact: true })).toBeVisible();
  workspace.session = {
    user: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", email: "other@example.test" },
    workspace: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Other" },
  };
  const otherNote = workspace.seedNote({
    workspaceId: workspace.session.workspace.id,
    title: "Other account note",
  });
  await page.goto("/");
  // A negative assertion alone can pass before authentication/list loading,
  // causing the fixture account to change while its scoped read is in flight.
  await expect(
    page
      .getByRole("list", { name: "Notes", exact: true })
      .getByRole("link", { name: new RegExp(otherNote.title) }),
  ).toBeVisible();
  await expect(page.getByText("Private draft", { exact: true })).toHaveCount(0);
  await expect(page.locator(`a[href="/notes/${note.id}"]`)).toHaveCount(0);
  workspace.session = account;
  await page.goto(`/notes/${note.id}`);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Private draft");
});

test("saved notes sign out directly without a draft decision", async ({ page, workspace }) => {
  const note = workspace.seedNote();
  await page.goto(`/notes/${note.id}`);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(note.title);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send sign-in link", exact: true })).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(workspace.signOutCount).toBe(1);
  expect(workspace.mutations).toHaveLength(0);
});

test("logout retains an uncertain title save for the same account without replaying it", async ({
  page,
  workspace,
}) => {
  const account = workspace.session;
  const note = workspace.seedNote();
  await page.goto(`/notes/${note.id}`);
  workspace.nextMutation = "lost-response";
  await page.getByLabel("Title", { exact: true }).fill("Pending title");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  const command = workspace.mutations[0]!.command;
  await page.getByLabel("Title", { exact: true }).fill("Newer local title");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send sign-in link", exact: true })).toBeVisible();
  expect(workspace.mutations).toHaveLength(1);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  workspace.session = account;
  await page.reload();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Newer local title");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => workspace.notes.get(note.id)?.title).toBe("Newer local title");
  expect(workspace.mutations[1]!.command).toEqual(command);
});

test("logout keeps unsaved profile edits local instead of implicitly saving them", async ({
  page,
  workspace,
}) => {
  const account = workspace.session;
  const person = workspace.seedPerson({ displayName: "Original name" });
  await page.goto(`/profiles/${person.id}`);
  await page.getByLabel("Display name", { exact: true }).fill("Unsaved profile name");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send sign-in link", exact: true })).toBeVisible();
  expect(workspace.mutations).toHaveLength(0);
  expect(workspace.people.get(person.id)?.displayName).toBe("Original name");
  workspace.session = account;
  await page.reload();
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Unsaved profile name",
  );
});

test("failed sign-out keeps the current title recoverable", async ({ page, workspace }) => {
  const note = workspace.seedNote();
  await page.goto(`/notes/${note.id}`);
  await page.getByLabel("Title", { exact: true }).fill("Keep my work");
  workspace.signOutFails = true;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("alertdialog").getByRole("alert")).toContainText(
    "Sign-out could not be confirmed",
  );
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Keep my work");
});

test("home search stays bounded to title prefixes", async ({ page, workspace }) => {
  const note = workspace.seedNote({ title: "Garden planning" });
  workspace.seedNote({ title: "Library visit" });
  await page.goto("/");
  await page.getByLabel("Search notes", { exact: true }).fill("Gar");
  await expect(
    page.getByRole("list", { name: "Notes", exact: true }).getByRole("link"),
  ).toHaveCount(1);
  await page.getByRole("list", { name: "Notes", exact: true }).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/notes/${note.id}$`));
});

for (const entity of ["note", "profile"] as const) {
  test(`deleting a ${entity} preserves audit history and cannot resurrect on reload`, async ({
    page,
    workspace,
  }) => {
    const note = entity === "note";
    const record = note ? workspace.seedNote() : workspace.seedPerson();
    const route = `/${note ? "notes" : "profiles"}/${record.id}`;
    await page.goto(route);
    if (note) {
      await page.getByRole("button", { name: "Note actions" }).click();
      await page.getByRole("menuitem", { name: "Delete note", exact: true }).click();
    } else await page.getByRole("button", { name: "Delete profile", exact: true }).click();
    await expect
      .poll(() =>
        workspace.history.some((h) => h.entityId === record.id && h.operation === "delete"),
      )
      .toBe(true);
    await page.goto(route);
    await expect(page.getByLabel(note ? "Title" : "Display name", { exact: true })).toHaveCount(0);
  });
}

test("unavailable draft storage prevents an uncheckpointed autosave", async ({
  page,
  workspace,
}) => {
  const note = workspace.seedNote();
  await page.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("voidnote:recovery:"))
        throw new DOMException("Storage full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page.goto(`/notes/${note.id}`);
  await page.getByLabel("Title", { exact: true }).fill("Keep visible");
  const recoveryAlert = page
    .getByRole("main")
    .getByRole("alert")
    .filter({ hasText: "Draft recovery could not be loaded" });
  await expect(recoveryAlert).toContainText("Storage full");
  await recoveryAlert.getByRole("button", { name: "Retry recovery", exact: true }).click();
  await expect(
    recoveryAlert.getByRole("button", { name: "Retry recovery", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Keep visible");
  expect(workspace.mutations).toHaveLength(0);
  expect(workspace.rpcRequests.filter((call) => call.procedure === "notes.save")).toHaveLength(0);
  expect(workspace.notes.get(note.id)?.title).toBe(note.title);
});

test("note actions omit Duplicate and Start over saves a new title without changing the original", async ({
  page,
  workspace,
}) => {
  const original = workspace.seedNote({ title: "Original conversation" });
  await page.goto(`/notes/${original.id}`);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(original.title);
  await page.getByRole("button", { name: "Note actions" }).click();
  await expect(page.getByRole("menuitem", { name: /Duplicate/i })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Start over in a new note", exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(`/notes/${original.id}$`));
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Untitled note (1)");
  await expect.poll(() => workspace.notes.size).toBe(2);
  expect(workspace.notes.get(original.id)).toEqual(original);
  const replacement = [...workspace.notes.values()].find((note) => note.id !== original.id)!;
  expect(replacement.transcript).toBe("");
  expect(replacement.title).toBe("Untitled note (1)");
  await page.reload();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(replacement.title);
  await page.goto(`/notes/${original.id}`);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(original.title);
});
