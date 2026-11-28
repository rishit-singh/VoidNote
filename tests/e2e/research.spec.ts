import type { Page, Route } from "@playwright/test";
import { z } from "zod";

import { contactDetailsSchema } from "../../src/contracts/contacts";
import {
  requestResearchSchema,
  researchBatchSchema,
  researchScopeSchema,
  retryResearchSchema,
  type RequestResearch,
  type ResearchBatch,
  type ResearchStatus,
} from "../../src/contracts/research";
import { expect, test, timestamp, workspaceId, type WorkspaceFixture } from "./workspace-fixture";

const sourceUrl = "https://example.test/team/alex";
const additionalUrl = "https://example.test/speakers/alex";
const question = "What is Alex's current role?";
const answer = "Alex is the engineering director.";
const excerpt = "Alex Rivera is our engineering director.";
const scopeSchema = z.object({ workspaceId: z.uuid() }).strict();
const personScopeSchema = scopeSchema.extend({ personId: z.uuid().optional() });
const availabilitySchema = z
  .object({ enabled: z.boolean(), reason: z.string().nullable() })
  .strict();

type Retry = z.infer<typeof retryResearchSchema>;
type BatchScope = z.infer<typeof researchScopeSchema>;

/** Browser/query recovery evidence only: every research/contact RPC is local,
 * all DTOs are schema-checked, and no source site or model is contacted. */
async function researchFixture(page: Page, workspace: WorkspaceFixture) {
  const person = workspace.seedPerson({ displayName: "Alex Rivera", revision: 4 });
  const contact = contactDetailsSchema.parse({
    personId: person.id,
    organization: "Example",
    role: "",
    links: [{ label: "Team profile", url: sourceUrl }],
    revision: 2,
    updatedAt: timestamp,
  });
  const state = {
    batches: [] as ResearchBatch[],
    requests: [] as RequestResearch[],
    cancellations: [] as BatchScope[],
    retries: [] as Retry[],
    loseRequestResponse: false,
    loseCancellationResponse: false,
    loseRetryResponse: false,
  };
  const requestReceipts = new Map<string, { input: RequestResearch; batchId: string }>();
  const retryReceipts = new Map<string, Retry>();
  const batchById = (id: string) => {
    const batch = state.batches.find((entry) => entry.id === id);
    if (!batch) throw new Error(`Unknown fixture research batch: ${id}`);
    return batch;
  };
  const latest = () => {
    const batch = state.batches.at(-1);
    if (!batch) throw new Error("The fixture has no accepted research request.");
    return batch;
  };
  const setStatus = (batch: ResearchBatch, status: ResearchStatus) => {
    const item = batch.items[0]!;
    batch.status = status;
    item.status = status;
    item.updatedAt = "2026-11-13T12:01:00.000Z";
    item.retryable = status === "failed";
    item.error =
      status === "failed" ? "Source retrieval failed before inference. You can retry." : null;
  };
  const fulfillBatch = (route: Route, batch: ResearchBatch) =>
    route.fulfill({ json: { result: { data: researchBatchSchema.parse(batch) } } });

  await page.route("**/api/contacts.*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expect(url.pathname).toBe("/api/contacts.get");
    expect(request.method()).toBe("GET");
    expect(url.searchParams.has("batch")).toBe(false);
    const input = scopeSchema
      .extend({ personId: z.uuid() })
      .parse(JSON.parse(url.searchParams.get("input") ?? "{}") as unknown);
    expect(input).toEqual({ workspaceId, personId: person.id });
    await route.fulfill({ json: { result: { data: contactDetailsSchema.parse(contact) } } });
  });

  await page.route("**/api/research.*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expect(url.searchParams.has("batch")).toBe(false);
    const raw: unknown =
      request.method() === "GET"
        ? JSON.parse(url.searchParams.get("input") ?? "{}")
        : request.postDataJSON();
    // These are regular queryOptions, not infiniteQueryOptions. Like the strict
    // router inputs, the mocks reject direction/cursor and recovery-only fields.
    switch (url.pathname) {
      case "/api/research.availability": {
        expect(request.method()).toBe("GET");
        expect(scopeSchema.parse(raw)).toEqual({ workspaceId });
        return route.fulfill({
          json: { result: { data: availabilitySchema.parse({ enabled: true, reason: null }) } },
        });
      }
      case "/api/research.list": {
        expect(request.method()).toBe("GET");
        expect(personScopeSchema.parse(raw)).toEqual({ workspaceId, personId: person.id });
        return route.fulfill({
          json: {
            result: { data: z.array(researchBatchSchema).parse([...state.batches].reverse()) },
          },
        });
      }
      case "/api/research.get": {
        expect(request.method()).toBe("GET");
        const input = researchScopeSchema.parse(raw);
        expect(input.workspaceId).toBe(workspaceId);
        return fulfillBatch(route, batchById(input.batchId));
      }
      case "/api/research.request": {
        expect(request.method()).toBe("POST");
        const input = requestResearchSchema.parse(raw);
        expect(input.workspaceId).toBe(workspaceId);
        expect(input.people).toHaveLength(1);
        const selected = input.people[0]!;
        expect(selected.personId).toBe(person.id);
        expect(selected.expectedProfileRevision).toBe(person.revision);
        expect(selected.expectedContactRevision).toBe(contact.revision);
        state.requests.push(input);
        const receipt = requestReceipts.get(input.requestId);
        let batch: ResearchBatch;
        if (receipt) {
          expect(input).toEqual(receipt.input);
          batch = batchById(receipt.batchId);
        } else {
          // The actual repository uses requestId as the batch ID.
          batch = researchBatchSchema.parse({
            id: input.requestId,
            workspaceId,
            status: "queued",
            createdAt: timestamp,
            items: [
              {
                personId: person.id,
                profileRevision: selected.expectedProfileRevision,
                contactRevision: selected.expectedContactRevision,
                displayName: person.displayName,
                generation: 1,
                status: "queued",
                requestedFacts: selected.requestedFacts,
                sourceUrls: selected.sourceUrls,
                findings: [],
                error: null,
                retryable: false,
                updatedAt: timestamp,
              },
            ],
          });
          requestReceipts.set(input.requestId, { input, batchId: batch.id });
          state.batches.push(batch);
        }
        if (state.loseRequestResponse) {
          state.loseRequestResponse = false;
          return route.abort("failed");
        }
        return fulfillBatch(route, batch);
      }
      case "/api/research.cancel": {
        expect(request.method()).toBe("POST");
        const input = researchScopeSchema.parse(raw);
        expect(input.workspaceId).toBe(workspaceId);
        state.cancellations.push(input);
        const batch = batchById(input.batchId);
        // As in the repository, cancelling retains completed findings.
        if (batch.status !== "completed") setStatus(batch, "cancelled");
        if (state.loseCancellationResponse) {
          state.loseCancellationResponse = false;
          return route.abort("failed");
        }
        return fulfillBatch(route, batch);
      }
      case "/api/research.retry": {
        expect(request.method()).toBe("POST");
        const input = retryResearchSchema.parse(raw);
        expect(input.workspaceId).toBe(workspaceId);
        expect(input.personId).toBe(person.id);
        state.retries.push(input);
        const batch = batchById(input.batchId);
        const receipt = retryReceipts.get(input.requestId);
        if (receipt) {
          // Exact replay is resolved before generation validation, as on the server.
          expect(input).toEqual(receipt);
        } else {
          const item = batch.items[0]!;
          expect(item.retryable).toBe(true);
          expect(item.generation).toBe(input.expectedGeneration);
          expect(item.status).toBe("failed");
          item.generation++;
          setStatus(batch, "queued");
          retryReceipts.set(input.requestId, input);
        }
        if (state.loseRetryResponse) {
          state.loseRetryResponse = false;
          return route.abort("failed");
        }
        return fulfillBatch(route, batch);
      }
      default:
        throw new Error(`Unexpected research procedure: ${url.pathname}`);
    }
  });

  const panel = page.getByRole("region", { name: "Contact research", exact: true });
  const open = async () => {
    await page.goto(`/profiles/${person.id}`);
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: "Add saved profile links" })).toBeEnabled();
  };
  const start = async () => {
    await panel.getByRole("textbox", { name: "Questions to check" }).fill(question);
    await panel.getByRole("button", { name: "Add saved profile links" }).click();
    await panel.getByRole("button", { name: "Research this contact", exact: true }).click();
    await expect(panel.getByText("Queued", { exact: true })).toBeVisible();
  };
  const finish = () => {
    const batch = latest();
    const item = batch.items[0]!;
    setStatus(batch, "completed");
    item.findings = item.requestedFacts.map((fact) => ({
      key: fact.key,
      question: fact.question,
      status: "supported",
      answer,
      explanation: "The supplied team profile explicitly identifies Alex's role.",
      citations: [
        {
          sourceId: "team-profile",
          url: sourceUrl,
          excerpt,
          retrievedAt: "2026-11-13T12:00:30.000Z",
          asOf: "2026-11-01T00:00:00.000Z",
        },
      ],
    }));
    researchBatchSchema.parse(batch);
  };
  return { state, panel, person, contact, open, start, finish, latest, setStatus };
}

test("explicit contact research uses saved links and questions, then shows saved citations after reload", async ({
  page,
  workspace,
}) => {
  const f = await researchFixture(page, workspace);
  await f.open();
  await expect(f.panel.getByText("No research yet", { exact: true })).toBeVisible();
  expect(f.state.requests).toHaveLength(0);
  await f.panel.getByRole("textbox", { name: "Questions to check" }).fill(question);
  await expect(
    f.panel.getByRole("button", { name: "Research this contact", exact: true }),
  ).toBeDisabled();
  await f.panel.getByRole("textbox", { name: "Public source URLs" }).fill(additionalUrl);
  await f.panel.getByRole("button", { name: "Add saved profile links" }).click();
  await f.panel.getByRole("button", { name: "Add saved profile links" }).click();
  await expect(f.panel.getByRole("textbox", { name: "Public source URLs" })).toHaveValue(
    `${additionalUrl}\n${sourceUrl}`,
  );
  expect(f.state.requests).toHaveLength(0);
  await f.panel.getByRole("button", { name: "Research this contact", exact: true }).click();
  await expect(f.panel.getByText("Queued", { exact: true })).toBeVisible();
  await expect(f.panel.getByText(answer, { exact: true })).toBeHidden();
  await expect(f.panel.getByText("Complete", { exact: true })).toBeHidden();
  expect(f.state.requests[0]).toEqual({
    workspaceId,
    requestId: f.latest().id,
    people: [
      {
        personId: f.person.id,
        expectedProfileRevision: f.person.revision,
        expectedContactRevision: f.contact.revision,
        requestedFacts: [{ key: "fact_1", question }],
        sourceUrls: [additionalUrl, sourceUrl],
      },
    ],
  });
  f.finish();
  await expect(f.panel.getByText("Complete", { exact: true })).toBeVisible();
  await expect(f.panel.getByText(answer, { exact: true })).toBeVisible();
  await f.panel.locator("summary").filter({ hasText: "Sources (1)" }).click();
  await expect(f.panel.getByText(excerpt, { exact: true })).toBeVisible();
  const citation = f.panel.getByRole("link", { name: sourceUrl, exact: true });
  await expect(citation).toHaveAttribute("href", sourceUrl);
  await expect(citation).toHaveAttribute("target", "_blank");
  await expect(citation).toHaveAttribute("rel", "noopener noreferrer");
  await expect(f.panel.locator("time[datetime='2026-11-13T12:00:30.000Z']")).toBeVisible();
  await f.open();
  await expect(f.panel.getByText(answer, { exact: true })).toBeVisible();
  await f.panel.locator("summary").filter({ hasText: "Sources (1)" }).click();
  await expect(f.panel.getByText(excerpt, { exact: true })).toBeVisible();
  expect(f.state.requests).toHaveLength(1);
  expect(f.state.retries).toHaveLength(0);
  expect(f.state.cancellations).toHaveLength(0);
  expect(workspace.mutations).toHaveLength(0);
});

test("lost research acceptance replays the same payload after reload and preserves newer input", async ({
  page,
  workspace,
}) => {
  const f = await researchFixture(page, workspace);
  f.state.loseRequestResponse = true;
  await f.open();
  await f.panel.getByRole("textbox", { name: "Questions to check" }).fill(question);
  await f.panel.getByRole("button", { name: "Add saved profile links" }).click();
  // Local persistence can render the recovery control before the first dispatch.
  // Observe the failed POST itself before capturing the accepted command.
  const lostResponse = page.waitForEvent(
    "requestfailed",
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/api/research.request",
  );
  await f.panel.getByRole("button", { name: "Research this contact", exact: true }).click();
  await lostResponse;
  expect(f.state.requests).toHaveLength(1);
  await expect(
    f.panel.getByRole("button", { name: "Retry saved request", exact: true }),
  ).toBeVisible();
  const original = f.state.requests[0]!;
  await f.panel
    .getByRole("textbox", { name: "Questions to check" })
    .fill("What conference will Alex speak at?");
  await f.panel.getByRole("textbox", { name: "Public source URLs" }).fill(additionalUrl);
  expect(f.state.requests).toHaveLength(1);
  await f.open();
  await expect.poll(() => f.state.requests.length).toBe(2);
  expect(f.state.requests[1]).toEqual(original);
  expect(f.state.batches).toHaveLength(1);
  expect(f.latest().items[0]?.generation).toBe(1);
  await expect(
    f.panel.getByRole("button", { name: "Retry saved request", exact: true }),
  ).toBeHidden();
  await expect(f.panel.getByRole("button", { name: "Stop research", exact: true })).toBeEnabled();
  await expect(f.panel.getByRole("textbox", { name: "Questions to check" })).toHaveValue(
    "What conference will Alex speak at?",
  );
  await expect(f.panel.getByRole("textbox", { name: "Public source URLs" })).toHaveValue(
    additionalUrl,
  );
});

test("an uncertain Stop is recovered after reload without restarting cancelled research", async ({
  page,
  workspace,
}) => {
  const f = await researchFixture(page, workspace);
  await f.open();
  await f.start();
  f.state.loseCancellationResponse = true;
  const lostResponse = page.waitForEvent(
    "requestfailed",
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/api/research.cancel",
  );
  await f.panel.getByRole("button", { name: "Stop research", exact: true }).click();
  await lostResponse;
  expect(f.state.cancellations).toHaveLength(1);
  await expect(
    f.panel.getByRole("button", { name: "Retry saved request", exact: true }),
  ).toBeVisible();
  expect(f.latest().status).toBe("cancelled");
  await f.panel
    .getByRole("textbox", { name: "Questions to check" })
    .fill("Keep this next research question.");
  await f.open();
  await expect.poll(() => f.state.cancellations.length).toBe(2);
  expect(f.state.cancellations).toEqual([
    { workspaceId, batchId: f.latest().id },
    { workspaceId, batchId: f.latest().id },
  ]);
  await expect(f.panel.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(
    f.panel.getByRole("button", { name: "Retry saved request", exact: true }),
  ).toBeHidden();
  await expect(f.panel.getByRole("button", { name: "Stop research", exact: true })).toBeHidden();
  await expect(f.panel.getByRole("button", { name: "Retry research", exact: true })).toBeHidden();
  await expect(f.panel.getByRole("textbox", { name: "Questions to check" })).toHaveValue(
    "Keep this next research question.",
  );
  await f.open();
  await expect(f.panel.getByText("Stopped", { exact: true })).toBeVisible();
  expect(f.state.requests).toHaveLength(1);
  expect(f.state.retries).toHaveLength(0);
  expect(f.state.cancellations).toHaveLength(2);
});

test("failed research retries its original generation exactly after a lost retry response", async ({
  page,
  workspace,
}) => {
  const f = await researchFixture(page, workspace);
  await f.open();
  await f.start();
  f.setStatus(f.latest(), "failed");
  await f.open();
  await expect(f.panel.getByText("Failed", { exact: true })).toBeVisible();
  await expect(
    f.panel.getByText("Source retrieval failed before inference. You can retry.", { exact: true }),
  ).toBeVisible();
  await expect(f.panel.getByRole("button", { name: "Retry research", exact: true })).toBeEnabled();
  f.state.loseRetryResponse = true;
  const lostResponse = page.waitForEvent(
    "requestfailed",
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/api/research.retry",
  );
  await f.panel.getByRole("button", { name: "Retry research", exact: true }).click();
  await lostResponse;
  expect(f.state.retries).toHaveLength(1);
  await expect(
    f.panel.getByRole("button", { name: "Retry saved request", exact: true }),
  ).toBeVisible();
  const retry = f.state.retries[0]!;
  expect(retry).toEqual({
    workspaceId,
    batchId: f.latest().id,
    personId: f.person.id,
    expectedGeneration: 1,
    requestId: retry.requestId,
  });
  expect(retry.requestId).not.toBe(f.state.requests[0]!.requestId);
  await f.panel
    .getByRole("textbox", { name: "Questions to check" })
    .fill("Do not replace this newer draft.");
  await f.open();
  await expect.poll(() => f.state.retries.length).toBe(2);
  expect(f.state.retries[1]).toEqual(retry);
  expect(f.latest().items[0]?.generation).toBe(2);
  expect(f.latest().items[0]?.requestedFacts).toEqual([{ key: "fact_1", question }]);
  expect(f.latest().items[0]?.sourceUrls).toEqual([sourceUrl]);
  await expect(
    f.panel.getByRole("button", { name: "Retry saved request", exact: true }),
  ).toBeHidden();
  await expect(f.panel.getByRole("textbox", { name: "Questions to check" })).toHaveValue(
    "Do not replace this newer draft.",
  );
  f.finish();
  await expect(f.panel.getByText("Complete", { exact: true })).toBeVisible();
  await expect(f.panel.getByText(answer, { exact: true })).toBeVisible();
  expect(f.state.requests).toHaveLength(1);
  expect(f.state.batches).toHaveLength(1);
});

test("latest saved findings remain the default while a newer attempt fails", async ({
  page,
  workspace,
}) => {
  const f = await researchFixture(page, workspace);
  await f.open();
  await f.start();
  f.finish();
  await expect(f.panel.getByText(answer, { exact: true })).toBeVisible();

  await f.panel
    .getByRole("textbox", { name: "Questions to check" })
    .fill("What is Alex working on?");
  await f.panel.getByRole("button", { name: "Add saved profile links" }).click();
  await f.panel.getByRole("button", { name: "Research this contact", exact: true }).click();
  await expect(f.panel.getByText("Queued", { exact: true })).toBeVisible();
  f.setStatus(f.latest(), "failed");

  await expect(f.panel.getByRole("region", { name: "Latest research attempt" })).toContainText(
    "Source retrieval failed before inference. You can retry.",
  );
  await expect(f.panel.getByText(answer, { exact: true })).toBeVisible();
  await expect(f.panel.getByRole("button", { name: "Retry research", exact: true })).toBeEnabled();
  const history = f.panel.getByText("Research history (2)");
  await expect(history).toBeVisible();
  await history.click();
  const historyDetails = f.panel.locator("details").filter({
    has: page.locator("summary", { hasText: "Research history (2)" }),
  });
  const failedAttempt = historyDetails.getByRole("button", { name: "View attempt", exact: true });
  await expect(failedAttempt).toBeVisible();
  await failedAttempt.click();
  await expect(f.panel.getByRole("heading", { name: "Saved research", exact: true })).toBeVisible();
  await expect(f.panel.getByText("Failed", { exact: true })).toBeVisible();
  await expect(
    f.panel.getByText("Source retrieval failed before inference. You can retry.", { exact: true }),
  ).toBeVisible();
});
