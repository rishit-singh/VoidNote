import {
  selfProfileCreateSchema,
  selfProfileGetSchema,
  selfProfileLinkSchema,
  type SelfProfileCreate,
} from "../../src/contracts/self-profile";
import { test, expect, workspaceId } from "./workspace-fixture";

for (const width of [1440, 390]) {
  test(`an existing saved profile can become My profile without changing its identity at ${width}px`, async ({
    page,
    workspace,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const person = workspace.seedPerson({ displayName: "Taylor" });
    const linked: string[] = [];
    await page.route("**/api/selfProfile.link", async (route) => {
      const command = selfProfileLinkSchema.parse(route.request().postDataJSON());
      expect(command.workspaceId).toBe(workspaceId);
      expect(command.expectedSelfId).toBeNull();
      expect(command.expectedRevision).toBe(person.revision);
      linked.push(command.personId);
      workspace.selfPersonId = command.personId;
      await route.fulfill({ json: { result: { data: person } } });
    });

    await page.goto("/my-profile");
    await expect(
      page.getByRole("button", { name: "Create My profile", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => workspace.requests.filter((request) => request.includes("selfProfile.create")))
      .toHaveLength(0);
    await page.getByRole("button", { name: "Use an existing profile" }).click();
    await page.getByRole("searchbox", { name: "Search profiles" }).fill("Tay");
    await page.getByRole("button", { name: "Taylor", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue(
      "Taylor",
    );
    expect(linked).toEqual([person.id]);
    expect(workspace.people.size).toBe(1);
    const navigation =
      width === 390
        ? page.getByRole("navigation", { name: "Mobile workspace navigation" })
        : page.getByRole("complementary", { name: "Primary navigation" });
    await expect(
      navigation.getByRole("link", {
        name: "My profile",
        exact: true,
      }),
    ).toHaveAttribute("href", "/my-profile");
  });
}

test("a lost create response followed by forbidden keeps the exact command across reload", async ({
  page,
  workspace,
}) => {
  const commands: SelfProfileCreate[] = [];
  let person: ReturnType<typeof workspace.seedPerson> | undefined;
  await page.route("**/api/selfProfile.create", async (route) => {
    const command = selfProfileCreateSchema.parse(route.request().postDataJSON());
    commands.push(command);
    person ??= workspace.seedPerson({ displayName: command.displayName });
    workspace.selfPersonId = person.id;
    if (commands.length === 1) {
      await route.abort("failed");
      return;
    }
    if (commands.length === 2) {
      await route.fulfill({
        status: 403,
        json: {
          error: {
            message: "Workspace access was revoked before receipt lookup.",
            code: -32003,
            data: { code: "FORBIDDEN", httpStatus: 403, path: "selfProfile.create" },
          },
        },
      });
      return;
    }
    await route.fulfill({ json: { result: { data: person } } });
  });

  await page.goto("/my-profile");
  await page.getByRole("textbox", { name: "Your name" }).fill("Taylor");
  await page.getByRole("button", { name: "Create My profile", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry profile change" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Retry profile change" }).click();
  await expect(page.getByText("Workspace access was revoked before receipt lookup.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry profile change" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Retry profile change" }).click();
  await expect(page.getByText(/Profile change saved\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry profile change" })).toHaveCount(0);
  expect(commands).toHaveLength(3);
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[2]).toEqual(commands[0]);
  expect(workspace.people.size).toBe(1);
});

for (const kind of ["create", "link"] as const) {
  test(`acknowledged ${kind} disables duplicate changes while current self is refreshing`, async ({
    page,
    workspace,
  }) => {
    let person = kind === "link" ? workspace.seedPerson({ displayName: "Taylor" }) : undefined;
    let submitted = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    await page.route("**/api/selfProfile.get?*", async (route) => {
      const url = new URL(route.request().url());
      selfProfileGetSchema.parse(JSON.parse(url.searchParams.get("input") ?? "null"));
      if (submitted) {
        await refreshGate;
      }
      await route.fulfill({ json: { result: { data: submitted ? person : null } } });
    });
    await page.route(`**/api/selfProfile.${kind}`, async (route) => {
      const input: unknown = route.request().postDataJSON();
      if (kind === "create") {
        const command = selfProfileCreateSchema.parse(input);
        person = workspace.seedPerson({ displayName: command.displayName });
      } else {
        const command = selfProfileLinkSchema.parse(input);
        expect(command.personId).toBe(person!.id);
      }
      submitted += 1;
      workspace.selfPersonId = person!.id;
      await route.fulfill({ json: { result: { data: person } } });
    });

    try {
      await page.goto("/my-profile");
      if (kind === "create") {
        await page.getByRole("textbox", { name: "Your name" }).fill("Taylor");
      } else {
        await page.getByRole("button", { name: "Use an existing profile" }).click();
      }
      const action = page.getByRole("button", {
        name: kind === "create" ? "Create My profile" : "Taylor",
        exact: true,
      });
      await action.click();
      await expect(page.getByText(/Profile change saved\./)).toBeVisible();
      await expect(page.getByRole("button", { name: "Use an existing profile" })).toBeDisabled();
      await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveCount(0);
      expect(submitted).toBe(1);
    } finally {
      releaseRefresh();
    }
    await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue(
      "Taylor",
    );
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`My profile opens the shared editor directly at ${viewport.width}px`, async ({
    page,
    workspace,
  }) => {
    await page.setViewportSize(viewport);
    const person = workspace.seedPerson({
      displayName: "Me",
      description: "My workspace biography",
    });
    workspace.selfPersonId = person.id;
    await page.goto("/");
    await page
      .getByRole("link", { name: "My profile", exact: true })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(/\/my-profile$/);
    await expect(page.getByRole("heading", { name: "My profile", exact: true })).toBeVisible();
    await expect(page.getByText("Test workspace", { exact: true })).toBeVisible();
    const name = page.getByRole("textbox", { name: "Display name", exact: true });
    await expect(name).toHaveValue("Me");
    await expect(page.getByRole("textbox", { name: "Description", exact: true })).toHaveValue(
      "My workspace biography",
    );
    await name.fill("My chosen name");
    await expect(name).toHaveValue("My chosen name");
    await expect(page.getByRole("button", { name: "Delete profile", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create My profile" })).toHaveCount(0);
    await expect(page.getByRole("searchbox", { name: "Search profiles" })).toHaveCount(0);
  });

  test(`unlinked setup asks for a name at ${viewport.width}px`, async ({ page, workspace }) => {
    await page.setViewportSize(viewport);
    let createdName = "";
    await page.route("**/api/selfProfile.create", async (route) => {
      const command = selfProfileCreateSchema.parse(route.request().postDataJSON());
      createdName = command.displayName;
      const person = workspace.seedPerson({ displayName: command.displayName });
      workspace.selfPersonId = person.id;
      await route.fulfill({ json: { result: { data: person } } });
    });
    await page.goto("/my-profile");
    const name = page.getByRole("textbox", { name: "Your name" });
    await expect(name).toHaveValue("");
    await expect(page.getByRole("button", { name: "Create My profile" })).toBeDisabled();
    await name.fill("Taylor");
    await page.getByRole("button", { name: "Create My profile" }).click();
    await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue(
      "Taylor",
    );
    expect(createdName).toBe("Taylor");
    expect(workspace.people.size).toBe(1);
  });
}

test("replacing My profile explicitly confirms and preserves both person identities", async ({
  page,
  workspace,
}) => {
  const original = workspace.seedPerson({ displayName: "Me" });
  const replacement = workspace.seedPerson({ displayName: "Taylor" });
  workspace.selfPersonId = original.id;
  let linked = false;
  await page.route("**/api/selfProfile.link", async (route) => {
    const command = selfProfileLinkSchema.parse(route.request().postDataJSON());
    expect(command.expectedSelfId).toBe(original.id);
    expect(command.personId).toBe(replacement.id);
    expect(command.expectedRevision).toBe(replacement.revision);
    linked = true;
    workspace.selfPersonId = replacement.id;
    await route.fulfill({ json: { result: { data: replacement } } });
  });
  await page.goto("/my-profile");
  await page.getByRole("button", { name: "Use an existing profile" }).click();
  await page.getByRole("button", { name: "Taylor", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Replace My profile?" })).toBeVisible();
  expect(linked).toBe(false);
  await page.getByRole("button", { name: "Replace My profile", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue(
    "Taylor",
  );
  expect(workspace.people.has(original.id)).toBe(true);
  expect(workspace.people.has(replacement.id)).toBe(true);
  await page.goto(`/profiles/${original.id}`);
  await expect(page.getByRole("button", { name: "Delete profile", exact: true })).toBeVisible();
});

test("pending profile setup remains private to its account and workspace", async ({
  page,
  workspace,
}) => {
  const owner = workspace.session!;
  const commands: SelfProfileCreate[] = [];
  await page.route("**/api/selfProfile.create", async (route) => {
    commands.push(selfProfileCreateSchema.parse(route.request().postDataJSON()));
    await route.abort("failed");
  });
  await page.goto("/my-profile");
  await page.getByRole("textbox", { name: "Your name" }).fill("Private name");
  await page.getByRole("button", { name: "Create My profile" }).click();
  await expect(page.getByRole("button", { name: "Retry profile change" })).toBeVisible();
  workspace.session = {
    user: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", email: "other@example.test" },
    workspace: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Other workspace" },
  };
  await page.reload();
  await expect(page.getByText("Other workspace", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Your name" })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Retry profile change" })).toHaveCount(0);
  expect(commands).toHaveLength(1);
  workspace.session = owner;
  await page.reload();
  await page.getByRole("button", { name: "Retry profile change" }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual(commands[0]);
});

test("an exact retry receipt never replaces the current linked profile", async ({
  page,
  workspace,
}) => {
  let historical: ReturnType<typeof workspace.seedPerson> | undefined;
  let submitted = 0;
  await page.route("**/api/selfProfile.create", async (route) => {
    const command = selfProfileCreateSchema.parse(route.request().postDataJSON());
    historical ??= workspace.seedPerson({ displayName: command.displayName });
    submitted++;
    if (submitted === 1) {
      workspace.selfPersonId = historical.id;
      await route.abort("failed");
      return;
    }
    await route.fulfill({ json: { result: { data: historical } } });
  });
  await page.goto("/my-profile");
  await page.getByRole("textbox", { name: "Your name" }).fill("Historical name");
  await page.getByRole("button", { name: "Create My profile" }).click();
  await expect(page.getByRole("button", { name: "Retry profile change" })).toBeVisible();
  const current = workspace.seedPerson({ displayName: "Current identity" });
  workspace.selfPersonId = current.id;
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue(
    "Current identity",
  );
  await page.getByRole("button", { name: "Retry profile change" }).click();
  await expect(page.getByText(/Profile change saved\./)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue(
    "Current identity",
  );
  await expect(page.getByRole("button", { name: "Retry profile change" })).toHaveCount(0);
});

test("a late acknowledgement cannot cross a live account and workspace change", async ({
  page,
  workspace,
}) => {
  const owner = workspace.session!;
  const commands: SelfProfileCreate[] = [];
  const person = workspace.seedPerson({ displayName: "Owner profile" });
  let releaseAcknowledgement!: () => void;
  const acknowledgementGate = new Promise<void>((resolve) => {
    releaseAcknowledgement = resolve;
  });
  await page.route("**/api/selfProfile.create", async (route) => {
    commands.push(selfProfileCreateSchema.parse(route.request().postDataJSON()));
    if (commands.length === 1) {
      await acknowledgementGate;
    }
    await route.fulfill({ json: { result: { data: person } } });
  });

  await page.goto("/my-profile");
  await page.getByRole("textbox", { name: "Your name" }).fill("Owner profile");
  await page.getByRole("button", { name: "Create My profile" }).click();
  await expect(page.getByText("Updating My profile…", { exact: true })).toBeVisible();
  await expect.poll(() => commands.length).toBe(1);

  try {
    workspace.session = {
      user: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", email: "other@example.test" },
      workspace: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Other workspace" },
    };
    // Exercise the shell's actual focus/session refresh without replacing the document.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("Other workspace", { exact: true })).toBeVisible();
    const name = page.getByRole("textbox", { name: "Your name" });
    await expect(name).toHaveValue("");
    await name.fill("New account draft");
    const acknowledgement = page.waitForResponse("**/api/selfProfile.create");
    releaseAcknowledgement();
    await acknowledgement;
    await expect(name).toHaveValue("New account draft");
    await expect(page.getByText(/Profile change saved\./)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry profile change" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveCount(0);

    // The outgoing runtime must not clear its durable intent on a late response.
    workspace.session = owner;
    workspace.selfPersonId = person.id;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("Test workspace", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Retry profile change" }).click();
    await expect(page.getByText(/Profile change saved\./)).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue(
      "Owner profile",
    );
  } finally {
    releaseAcknowledgement();
  }
});
