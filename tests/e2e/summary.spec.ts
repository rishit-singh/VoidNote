import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";

import type { AnalysisJob, SavedSummary } from "../../src/contracts/analysis";
import {
  requestSummarySchema,
  savedSummarySchema,
  summaryHistoryInputSchema,
} from "../../src/contracts/analysis";
import { expect, test, timestamp, workspaceId, type WorkspaceFixture } from "./workspace-fixture";

async function summaryFixture(page: Page, workspace: WorkspaceFixture) {
  const note = workspace.seedNote({ title: "Summary acceptance" });
  const source = { noteId: note.id, recordingId: randomUUID(), runId: randomUUID(), generation: 1 };
  const owner = workspace.seedPerson({ displayName: "Maya" });
  const state = {
    jobs: [] as AnalysisJob[],
    saved: [] as SavedSummary[],
    commands: [] as { commandId: string; noteId: string }[],
    lostResponse: false,
    canGenerate: true,
    freshness: "current" as "current" | "stale",
    prematureResultReads: 0,
    resultGates: new Map<string, Promise<void>>(),
    resultReads: [] as string[],
  };
  const finish = (text = "The team agreed to ship on Friday.") => {
    const statement = {
      text,
      citations: [{ evidenceId: randomUUID(), quote: text }],
    };
    const job = state.jobs.at(-1)!;
    job.status = "succeeded";
    job.resultId = randomUUID();
    state.saved.push(
      savedSummarySchema.parse({
        id: job.resultId,
        noteId: note.id,
        jobId: job.id,
        version: state.saved.length + 1,
        snapshotId: job.id,
        source,
        analysis: {
          quickSummary: [statement],
          detailedSummary: [statement],
          keywords: ["release"],
          decisions: [statement],
          nextSteps: [{ action: statement, ownerPersonId: owner.id, dueDate: null }],
          keyMoments: [],
          participants: [],
          engagement: { observations: [], limitations: [] },
          agendaAssessment: [],
          memoryCandidates: [],
          overlapFindings: [],
          uncertainties: ["The release time still needs confirmation."],
        },
        provenance: {
          model: "@cf/fixture/model",
          promptVersion: "summary-v2",
          schemaVersion: "summary-v1",
          policyVersion: "summary-proof-v1",
        },
        createdAt: timestamp,
      }),
    );
  };
  await page.route("**/api/summaries.*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const raw: unknown =
      request.method() === "GET"
        ? JSON.parse(url.searchParams.get("input") ?? "{}")
        : request.postDataJSON();
    const input = z
      .object({
        workspaceId: z.string(),
        jobId: z.string().optional(),
        command: z.unknown().optional(),
      })
      .parse(raw);
    expect(input.workspaceId).toBe(workspaceId);
    const ok = (data: unknown) => route.fulfill({ json: { result: { data } } });
    const unavailable = () =>
      route.fulfill({
        status: 409,
        json: {
          error: {
            message: "Summary is not available.",
            code: -32009,
            data: { code: "CONFLICT", httpStatus: 409 },
          },
        },
      });
    switch (url.pathname) {
      case "/api/summaries.overview":
        return ok({
          latestJob: state.jobs.at(-1) ?? null,
          latestSummaryJobId: state.saved.at(-1)?.jobId ?? null,
          canGenerate: state.canGenerate,
          unavailableReason: state.canGenerate ? null : "Finish transcription first.",
        });
      case "/api/summaries.history":
        summaryHistoryInputSchema.parse(raw);
        return ok({
          items: [...state.saved]
            .reverse()
            .map(({ jobId, version, createdAt }) => ({ jobId, version, createdAt })),
          nextCursor: null,
        });
      case "/api/summaries.request": {
        const command = requestSummarySchema.parse(input.command);
        state.commands.push(command);
        let job = state.jobs.find((item) => item.commandId === command.commandId);
        if (!job) {
          job = {
            id: command.commandId,
            noteId: note.id,
            commandId: command.commandId,
            source,
            status: "queued",
            resultId: null,
            error: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          state.jobs.push(job);
        }
        if (state.lostResponse) {
          state.lostResponse = false;
          return route.abort("failed");
        }
        return ok({ job });
      }
      case "/api/summaries.job":
        return ok(state.jobs.find((item) => item.id === input.jobId));
      case "/api/summaries.cancel": {
        const job = state.jobs.find((item) => item.id === input.jobId)!;
        job.status = "cancelled";
        return ok(job);
      }
      case "/api/summaries.result": {
        const summary = state.saved.find((item) => item.jobId === input.jobId);
        if (!summary) {
          state.prematureResultReads++;
          return unavailable();
        }
        state.resultReads.push(summary.jobId);
        await state.resultGates.get(summary.jobId);
        return ok({ summary, freshness: state.freshness });
      }
      case "/api/summaries.evidence": {
        const summary = state.saved.find((item) => item.jobId === input.jobId)!;
        const citation = summary.analysis.quickSummary[0]!.citations[0]!;
        const evidenceId = citation.evidenceId;
        const startSeconds = (summary.version - 1) * 60 + 2;
        return ok({
          snapshotId: input.jobId,
          source,
          passages: [
            {
              evidenceId,
              segmentId: evidenceId,
              segmentRevision: 0,
              attributionRevision: 0,
              sourceUtteranceId: evidenceId,
              sequence: 0,
              orderKey: "",
              providerTrackId: "SPEAKER_00",
              assignment: { kind: "unassigned" },
              text: citation.quote,
              startSeconds,
              endSeconds: startSeconds + 4,
            },
          ],
        });
      }
      default:
        return route.abort("failed");
    }
  });
  const open = async () => {
    await page.goto(`/notes/${note.id}`);
    await page.getByRole("tab", { name: "Summary", exact: true }).click();
  };
  return { state, finish, open, owner };
}

test("summary owners link to profiles and uncertainties remain available", async ({
  page,
  workspace,
}) => {
  const { finish, open, owner } = await summaryFixture(page, workspace);
  await open();
  await page.getByRole("button", { name: "Generate summary", exact: true }).click();
  await expect(page.getByText("Summary is queued…")).toBeVisible();
  finish();
  await expect(page.getByRole("link", { name: "Assigned person", exact: true })).toHaveAttribute(
    "href",
    `/profiles/${owner.id}`,
  );
  const clarification = page.getByText("The release time still needs confirmation.", {
    exact: true,
  });
  await expect(clarification).toBeHidden();
  await page.getByText("What needs clarification", { exact: true }).click();
  await expect(clarification).toBeVisible();
});

test("history loading keeps citations attached to the displayed summary", async ({
  page,
  workspace,
}) => {
  const { state, finish, open } = await summaryFixture(page, workspace);
  await open();
  await page.getByRole("button", { name: "Generate summary", exact: true }).click();
  await expect(page.getByText("Summary is queued…")).toBeVisible();
  finish("Earlier release decision.");
  await expect(page.getByText("Earlier release decision.", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Regenerate summary", exact: true }).click();
  await expect.poll(() => state.jobs.length).toBe(2);
  finish("Latest release decision.");
  await open();
  const latestCitation = page
    .getByRole("button", { name: "Play source: Latest release decision.", exact: true })
    .first();
  await expect(latestCitation).toHaveText("↗ 1:02");
  const earlierJobId = state.saved[0]!.jobId;
  let releaseResult!: () => void;
  state.resultGates.set(
    earlierJobId,
    new Promise<void>((resolve) => {
      releaseResult = resolve;
    }),
  );
  const previousReads = state.resultReads.filter((id) => id === earlierJobId).length;
  try {
    await page.getByText(/Summary history/).click();
    await page.getByLabel("Saved summaries", { exact: true }).getByRole("button").nth(1).click();
    await expect
      .poll(() => state.resultReads.filter((id) => id === earlierJobId).length)
      .toBeGreaterThan(previousReads);
    await expect(page.getByText("Loading selected summary…")).toBeVisible();
    await expect(latestCitation).toHaveText("↗ 1:02");
    await expect(
      page.getByRole("button", { name: "Play source: Earlier release decision.", exact: true }),
    ).toHaveCount(0);
  } finally {
    releaseResult();
  }
  await expect(page.getByText("Loading selected summary…")).toBeHidden();
  await expect(
    page
      .getByRole("button", { name: "Play source: Earlier release decision.", exact: true })
      .first(),
  ).toHaveText("↗ 0:02");
  await expect(latestCitation).toHaveCount(0);
});

test("generation is explicit; pending completion and saved versions survive reload", async ({
  page,
  workspace,
}) => {
  const { state, finish, open } = await summaryFixture(page, workspace);
  await open();
  await expect(page.getByRole("button", { name: "Generate summary", exact: true })).toBeEnabled();
  expect(state.commands).toHaveLength(0);
  await page.getByRole("button", { name: "Generate summary", exact: true }).click();
  await expect(page.getByText("Summary is queued…")).toBeVisible();
  expect(state.prematureResultReads).toBe(0);
  finish();
  await expect(page.getByText("The team agreed to ship on Friday.").first()).toBeVisible();
  await open();
  await expect(page.getByText("The team agreed to ship on Friday.").first()).toBeVisible();
  expect(state.commands).toHaveLength(1);
  await page.getByRole("button", { name: "Regenerate summary" }).click();
  await expect(page.getByRole("region", { name: "Latest summary attempt" })).toContainText(
    "Queued",
  );
  await expect(page.getByText("The team agreed to ship on Friday.").first()).toBeVisible();
  await open();
  await expect(page.getByRole("button", { name: "Cancel generation" })).toBeVisible();
  finish();
  await page.getByText(/Summary history/).click();
  const savedSummaries = page.getByLabel("Saved summaries", { exact: true });
  await expect(savedSummaries.getByRole("button", { name: /^Latest · / })).toBeVisible();
  const earlierSummary = savedSummaries.getByRole("button").nth(1);
  await earlierSummary.click();
  await expect(earlierSummary).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Summary provenance", { exact: true })).toHaveCount(0);
  await expect(page.getByText("@cf/fixture/model", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Version 1", { exact: true })).toHaveCount(0);
  expect(state.commands).toHaveLength(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Key moments", exact: true })).toBeVisible();
  await expect(page.getByText("No key moments were identified.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("a failed newer attempt stays visible without replacing the latest useful summary", async ({
  page,
  workspace,
}) => {
  const { state, finish, open } = await summaryFixture(page, workspace);
  await open();
  await page.getByRole("button", { name: "Generate summary", exact: true }).click();
  await expect(page.getByText("Summary is queued…")).toBeVisible();
  finish();
  await expect(page.getByText("The team agreed to ship on Friday.").first()).toBeVisible();

  await page.getByRole("button", { name: "Regenerate summary", exact: true }).click();
  await expect.poll(() => state.jobs.length).toBe(2);
  const failedAttempt = state.jobs.at(-1)!;
  failedAttempt.status = "failed";
  failedAttempt.error = "The Summary provider failed before a valid answer was produced.";
  state.freshness = "stale";
  await page.reload();
  await page.getByRole("tab", { name: "Summary", exact: true }).click();

  await expect(page.getByRole("region", { name: "Latest summary attempt" })).toContainText(
    "The latest summary could not be completed.",
  );
  await expect(
    page.getByText("Your saved transcript and speaker changes are unaffected.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("The team agreed to ship on Friday.").first()).toBeVisible();
  await expect(
    page.getByText("Transcript changed since this summary", { exact: true }),
  ).toBeVisible();
  await page.getByText(/Summary history/).click();
  await expect(page.getByRole("button", { name: /^Latest · / })).toBeVisible();
  expect(state.saved).toHaveLength(1);
});

test("lost acceptance is retried with the exact durable command after reload", async ({
  page,
  workspace,
}) => {
  const { state, open } = await summaryFixture(page, workspace);
  state.lostResponse = true;
  await open();
  await page.getByRole("button", { name: "Generate summary", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry saved request" })).toBeVisible();
  await open();
  await page.getByRole("button", { name: "Retry saved request" }).click();
  await expect(page.getByRole("button", { name: "Retry saved request" })).toBeHidden();
  await expect(page.getByText("Summary is queued…")).toBeVisible();
  await expect.poll(() => state.commands.length).toBe(2);
  expect(state.commands[1]).toEqual(state.commands[0]);
  expect(state.jobs).toHaveLength(1);
});

test("no transcript cannot generate, and cancellation cannot silently regenerate", async ({
  page,
  workspace,
}) => {
  const { state, open } = await summaryFixture(page, workspace);
  state.canGenerate = false;
  await open();
  await expect(page.getByRole("button", { name: "Generate summary", exact: true })).toBeDisabled();
  expect(state.commands).toHaveLength(0);
  state.canGenerate = true;
  await open();
  await page.getByRole("button", { name: "Generate summary", exact: true }).click();
  await page.getByRole("button", { name: "Cancel generation" }).click();
  await expect.poll(() => state.jobs.at(-1)?.status).toBe("cancelled");
  await open();
  await expect(
    page.getByText("Summary stopped. You can generate another when you’re ready."),
  ).toBeVisible();
  expect(state.commands).toHaveLength(1);
});
