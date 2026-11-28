import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { before, test, type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response, type Request } from "miniflare";
import { z } from "zod";

import type { AssistantToolOutput } from "../../src/ai/assistant/services.ts";
import { assistantPolicySchema, type AssistantPolicy } from "../../src/config/assistant.ts";
import type { WorkspaceError } from "../../src/contracts/workspace.ts";
import type { AssistantMessage, AssistantSource } from "../../src/contracts/assistant/index.ts";
import {
  assistantSourceSchema,
  assistantToolResultSchema,
} from "../../src/contracts/assistant/index.ts";
import {
  assistantToolSchemaForVersion,
  assistantToolsForVersion,
} from "../../src/ai/assistant/tools.ts";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const threadId = "10000000-0000-4000-8000-000000000002";
const turnId = "10000000-0000-4000-8000-000000000003";
const budgetId = "10000000-0000-4000-8000-000000000004";
const noteId = "10000000-0000-4000-8000-000000000005";
const policy = assistantPolicySchema.parse({
  version: "assistant-v1",
  skillVersion: "assistant-skills-v1",
  model: "@cf/fixture/local-only",
  budgetId,
  rateVersionId: "10000000-0000-4000-8000-000000000006",
  timeoutMs: 10_000,
});
let script: string;

before(async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
    entryPoints: ["tests/worker/assistant-runtime.fixture.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    mainFields: ["browser", "module", "main"],
    conditions: ["workerd", "react-server"],
    external: ["node:*", "cloudflare:*"],
    target: "es2022",
    plugins: [
      {
        name: "node-builtins",
        setup(builder) {
          builder.onResolve({ filter: /^[a-z_]+$/ }, (args) =>
            builtinModules.includes(args.path)
              ? { path: `node:${args.path}`, external: true }
              : undefined,
          );
        },
      },
    ],
  });
  assert.ok(result.outputFiles[0]);
  script = result.outputFiles[0].text;
});

const inspectionSchema = z.object({
  state: z.object({
    active: z
      .object({
        turnId: z.string(),
        requestedSteps: z.array(z.number()),
        pending: z.unknown().nullable(),
        tools: z.array(z.unknown()),
      })
      .nullable(),
  }),
  submissions: z.array(z.object({ status: z.string() })),
});

function fixture(
  t: TestContext,
  options: {
    enabled?: boolean;
    denyBudget?: boolean;
    exportOutage?: boolean;
    tool?: { name: string; input: unknown };
    holdModel?: boolean;
    holdAdmission?: boolean;
    maxSteps?: number;
    holdBegin?: boolean;
    holdBeforeSubmit?: boolean;
    publicationRejection?: "conflict" | "not_found" | "forbidden" | "command_reused";
    failureOutage?: boolean;
    history?: AssistantMessage[];
    tools?: Array<{ name: string; input: unknown }>;
    toolSteps?: Array<Array<{ name: string; input: unknown }>>;
    holdFirstTool?: boolean;
    firstWriteError?: { code: WorkspaceError["code"]; message: string };
    toolOutputs?: AssistantToolOutput[];
    rejectedSources?: AssistantSource[];
    contextSummary?: unknown;
    skillVersion?: AssistantPolicy["skillVersion"];
    finalText?: string;
    respectToolChoice?: boolean;
    toolErrors?: Array<{ code: WorkspaceError["code"]; message: string; untyped?: boolean } | null>;
    userText?: string;
  } = {},
) {
  const statuses = new Map<string, string>([[turnId, "queued"]]);
  let exportOutage = options.exportOutage ?? false;
  let publicationRejection = options.publicationRejection;
  let failureOutage = options.failureOutage ?? false;
  const modelCalls: unknown[] = [];
  const reservations: unknown[] = [];
  const completions: unknown[] = [];
  const toolCalls: unknown[] = [];
  let writeCalls = 0;
  const failures: unknown[] = [];
  const events: string[] = [];
  const unexpected: string[] = [];
  const serviceCalls: string[] = [];
  let revoked = false;
  const modelStarted = Promise.withResolvers<void>();
  const releaseModel = Promise.withResolvers<void>();
  const admissionStarted = Promise.withResolvers<void>();
  const releaseAdmission = Promise.withResolvers<void>();
  const beginStarted = Promise.withResolvers<void>();
  const releaseBegin = Promise.withResolvers<void>();
  const beforeSubmit = Promise.withResolvers<void>();
  const releaseBeforeSubmit = Promise.withResolvers<void>();
  const firstToolStarted = Promise.withResolvers<void>();
  const readToolStarted = Promise.withResolvers<void>();
  const releaseFirstTool = Promise.withResolvers<void>();
  if (!options.holdModel) releaseModel.resolve();
  if (!options.holdAdmission) releaseAdmission.resolve();
  if (!options.holdBegin) releaseBegin.resolve();
  if (!options.holdBeforeSubmit) releaseBeforeSubmit.resolve();
  if (!options.holdFirstTool) releaseFirstTool.resolve();

  async function outbound(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== "https://assistant-service.test") {
      unexpected.push(request.url);

      return new Response("Unexpected external call", { status: 502 });
    }
    const args = z.array(z.unknown()).parse(await request.json());
    const operationTurnId = typeof args[1] === "string" ? args[1] : turnId;
    const status = statuses.get(operationTurnId) ?? "queued";
    serviceCalls.push(url.pathname);
    if (revoked && ["/execution", "/admitModelRequest", "/executeTool"].includes(url.pathname)) {
      return new Response("Access revoked", {
        status: 403,
        headers: { "x-fixture-workspace-code": "forbidden" },
      });
    }
    switch (url.pathname) {
      case "/execution":
        return Response.json({
          principal: { id: workspaceId, email: null },
          thread: {
            id: threadId,
            noteId,
            title: "Test",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
          turn: {
            id: operationTurnId,
            threadId,
            status,
            error: null,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
          text: options.userText ?? "Hello!",
          policy: {
            ...policy,
            maxSteps: options.maxSteps ?? policy.maxSteps,
            skillVersion: options.skillVersion ?? policy.skillVersion,
          },
        });
      case "/beginTurn":
        if (status !== "queued") return Response.json(false);
        statuses.set(operationTurnId, "running");
        beginStarted.resolve();
        await releaseBegin.promise;

        return Response.json(true);
      case "/history":
        return Response.json(options.history ?? []);
      case "/contextSummary":
        return Response.json(options.contextSummary ?? null);
      case "/authorize":
        return Response.json(null);
      case "/isCancelled":
        beforeSubmit.resolve();
        await releaseBeforeSubmit.promise;

        return Response.json(status === "cancelled");
      case "/cancelTurn":
        statuses.set(operationTurnId, "cancelled");

        return Response.json(null);
      case "/admitModelRequest":
        reservations.push(args[0]);
        events.push("admit");
        if (options.denyBudget) return new Response("Denied", { status: 409 });
        admissionStarted.resolve();
        await releaseAdmission.promise;

        return Response.json(null);
      case "/model":
        modelCalls.push(args[0]);
        events.push("model");
        modelStarted.resolve();
        await releaseModel.promise;

        if (
          options.respectToolChoice &&
          z.object({ tool_choice: z.unknown().optional() }).parse(args[0]).tool_choice === "none"
        ) {
          return Response.json({ text: options.finalText ?? "Answer from the inspected pages." });
        }

        if (options.toolSteps) {
          const step = options.toolSteps[modelCalls.length - 1];
          return Response.json(
            step?.length
              ? {
                  tools: step.map((entry, index) => ({
                    ...entry,
                    id: `fixture-tool-${modelCalls.length}-${index}`,
                  })),
                }
              : { text: options.finalText ?? "Hello! How can I help?" },
          );
        }

        return Response.json(
          (options.tools ?? (options.tool ? [options.tool] : []))[modelCalls.length - 1]
            ? {
                tool: {
                  ...(options.tools ?? [options.tool])[modelCalls.length - 1],
                  id: `fixture-tool-${modelCalls.length}`,
                },
              }
            : { text: options.finalText ?? "Hello! How can I help?" },
        );
      case "/executeTool": {
        toolCalls.push(args);
        const index = toolCalls.length - 1;
        const isWrite = [
          "memory_revise",
          "memory_invalidate",
          "memory_remember",
          "artifact_create",
          "research_dispatch",
          "research_cancel",
        ].includes(String(args[0]));
        const firstWrite = isWrite && writeCalls++ === 0;
        if (firstWrite) {
          firstToolStarted.resolve();
          await releaseFirstTool.promise;
        }
        if (args[0] === "memory_recall") readToolStarted.resolve();
        const error =
          firstWrite && options.firstWriteError
            ? options.firstWriteError
            : options.toolErrors?.[index];
        if (error) {
          return new Response(error.message, {
            status: 409,
            headers: {
              ["untyped" in error && error.untyped
                ? "x-fixture-error-code"
                : "x-fixture-workspace-code"]: error.code,
            },
          });
        }

        return Response.json(
          options.toolOutputs?.[index] ?? {
            summary: "Read the meeting evidence.",
            data: { text: "No Friday commitment was made." },
            sources: [{ kind: "note", id: noteId, label: "Meeting", revision: 1 }],
          },
        );
      }
      case "/completeTurn":
        completions.push(args[2]);
        if (exportOutage) return new Response("Unavailable", { status: 503 });
        if (publicationRejection)
          return new Response("Definitive rejection", {
            status: 409,
            headers: { "x-fixture-error-code": publicationRejection },
          });
        if (options.rejectedSources?.length) {
          const completion = z
            .object({
              sources: z.array(assistantSourceSchema),
              tools: z.array(assistantToolResultSchema),
            })
            .parse(args[2]);
          const sources = [
            ...completion.sources,
            ...completion.tools.flatMap((entry) => entry.sources),
          ];
          if (
            sources.some((source) =>
              options.rejectedSources!.some(
                (invalid) =>
                  source.kind === invalid.kind &&
                  source.id === invalid.id &&
                  source.revision === invalid.revision,
              ),
            )
          ) {
            return new Response("Source changed", {
              status: 409,
              headers: { "x-fixture-error-code": "conflict" },
            });
          }
        }
        if (status !== "cancelled") statuses.set(operationTurnId, "succeeded");

        return Response.json(null);
      case "/failTurn":
        failures.push(args);
        if (exportOutage || failureOutage) return new Response("Unavailable", { status: 503 });
        if (status === "queued" || status === "running")
          statuses.set(operationTurnId, String(args[2]));

        return Response.json(null);
      default:
        unexpected.push(request.url);

        return new Response("Unknown operation", { status: 502 });
    }
  }

  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "assistant-runtime-test",
          compatibilityDate: "2026-11-13",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: script } },
          },
          exports: { AssistantAgent: { type: "durable-object", storage: "sqlite" } },
          env: {
            ASSISTANT_ENABLED: { type: "text", value: String(options.enabled ?? true) },
            ASSISTANT_TEST_CONTEXT_SUMMARY: {
              type: "text",
              value: String(options.contextSummary !== undefined),
            },
            ASSISTANT_MODEL: { type: "text", value: policy.model },
            ASSISTANT_BUDGET_ID: { type: "text", value: budgetId },
            ASSISTANT_RATE_VERSION_ID: { type: "text", value: policy.rateVersionId },
            ASSISTANT_AGENT: {
              type: "durable-object",
              worker: "assistant-runtime-test",
              exportName: "AssistantAgent",
            },
          },
        },
        dev: { outboundService: { type: "fetcher", handler: outbound } },
      },
    ],
  });
  t.after(async () => {
    releaseModel.resolve();
    releaseAdmission.resolve();
    releaseBegin.resolve();
    releaseBeforeSubmit.resolve();
    releaseFirstTool.resolve();
    await mf.dispose();
    assert.deepEqual(unexpected, []);
  });

  async function dispatch(
    path: string,
    expectedStatus = 200,
    requestedThread = threadId,
    requestedTurn = turnId,
  ) {
    const response = await mf.dispatchFetch(
      `https://fixture.test${path}?workspaceId=${workspaceId}&threadId=${requestedThread}&turnId=${requestedTurn}`,
    );
    const body: unknown = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(body));

    return body;
  }

  async function settled() {
    for (let attempt = 0; attempt < 250; attempt++) {
      const inspection = inspectionSchema.parse(await dispatch("/inspect"));
      if (
        inspection.submissions.length &&
        inspection.submissions.every((submission) =>
          ["completed", "error", "aborted", "skipped"].includes(submission.status),
        )
      ) {
        return inspection;
      }
      await setTimeout(20);
    }
    assert.fail(`Turn did not settle: ${JSON.stringify(await dispatch("/inspect"))}`);
  }

  return {
    dispatch,
    settled,
    modelCalls,
    reservations,
    completions,
    toolCalls,
    failures,
    events,
    serviceCalls,
    queueTurn: (id: string) => statuses.set(id, "queued"),
    setSkillVersion: (version: AssistantPolicy["skillVersion"]) => {
      options.skillVersion = version;
    },
    revoke: () => {
      revoked = true;
    },
    cancelRemotely: () => {
      statuses.set(turnId, "cancelled");
    },
    admissionStarted: admissionStarted.promise,
    releaseAdmission: () => releaseAdmission.resolve(),
    status: (id = turnId) => statuses.get(id) ?? "queued",
    setExportOutage: (value: boolean) => {
      exportOutage = value;
    },
    modelStarted: modelStarted.promise,
    releaseModel: () => releaseModel.resolve(),
    beginStarted: beginStarted.promise,
    releaseBegin: () => releaseBegin.resolve(),
    beforeSubmit: beforeSubmit.promise,
    releaseBeforeSubmit: () => releaseBeforeSubmit.resolve(),
    firstToolStarted: firstToolStarted.promise,
    readToolStarted: readToolStarted.promise,
    releaseFirstTool: () => releaseFirstTool.resolve(),
    setPublicationRejection: (code: typeof publicationRejection) => {
      publicationRejection = code;
    },
    setFailureOutage: (value: boolean) => {
      failureOutage = value;
    },
  };
}

void test("v5 forces scoped context grounding then permits evidence reads and preserves user intent", async (t) => {
  const instruction =
    "Read the transcript and check existing profiles; continue without asking again.";
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v5",
    history: [{ ...historicalReply([]), role: "user", text: instruction }],
    tool: { name: "notes_get", input: { noteId, section: "transcript" } },
    finalText: "The read transcript does not establish a Friday commitment.",
  });
  await worker.dispatch("/start");
  await worker.settled();

  assert.equal(worker.status(), "succeeded");
  assert.equal(worker.toolCalls.length, 2);
  const first = z
    .object({
      tool_choice: z.literal("auto"),
      tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
    })
    .parse(worker.modelCalls[0]);
  assert.ok(first.tools.length > 1, "normal tools are available on the first inference");
  assert.equal(worker.modelCalls.length, 2, "no selector-only grounding inference");
  const prompt = JSON.stringify(worker.modelCalls[0]);
  assert.ok(prompt.includes("Application-provided current context"));
  assert.ok(prompt.includes("No Friday commitment was made."));
  assert.ok(prompt.includes(instruction));
  assert.doesNotMatch(prompt, /Follow only the latest user request/);
  assert.doesNotMatch(prompt, /Historical conversation; not a current contact/);
  assert.equal(z.array(z.unknown()).parse(worker.toolCalls[0])[0], "context_read");
  const completion = z
    .object({ tools: z.array(assistantToolResultSchema), sources: z.array(assistantSourceSchema) })
    .parse(worker.completions[0]);
  assert.equal(completion.tools[0]?.name, "context_read");
  assert.equal(completion.tools[0]?.status, "succeeded");
  assert.ok(completion.sources.some((source) => source.id === noteId));
});

void test("v5 greeting is grounded before its sole inference without fabricated tool receipts", async (t) => {
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v5",
    finalText: "Hello!",
  });
  await worker.dispatch("/start");
  await worker.settled();
  assert.equal(worker.status(), "succeeded");
  assert.equal(worker.completions.length, 1);
  assert.equal(worker.toolCalls.length, 1);
  assert.equal(worker.modelCalls.length, 1);
  assert.equal(worker.reservations.length, 1);
  assert.equal(z.array(z.unknown()).parse(worker.toolCalls[0])[0], "context_read");
  assert.equal(completionSchema.parse(worker.completions[0]).tools[0]?.status, "succeeded");
  await worker.dispatch("/start");
  assert.equal(worker.toolCalls.length, 1);
  assert.equal(worker.modelCalls.length, 1);
});

void test("v6 greeting runs without a forced context read or tool receipt", async (t) => {
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v6",
    userText: "what up",
    finalText: "Hey! What’s up?",
  });
  await worker.dispatch("/start");
  await worker.settled();

  assert.equal(worker.status(), "succeeded");
  assert.equal(worker.modelCalls.length, 1);
  assert.equal(worker.toolCalls.length, 0);
  assert.equal(completionSchema.parse(worker.completions[0]).tools.length, 0);
  assert.match(JSON.stringify(worker.modelCalls[0]), /Authorized scope envelope/);
  assert.doesNotMatch(JSON.stringify(worker.modelCalls[0]), /Application-provided current context/);
});

void test("v6 can look up existing evidence before dispatching supplied-source research", async (t) => {
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v6",
    userText: "Check this claim using these sources.",
    toolSteps: [
      [{ name: "activate_skill", input: { name: "research-dispatch" } }],
      [{ name: "research_lookup", input: { query: "product X offline mode" } }],
      [
        {
          name: "research_dispatch",
          input: {
            question: "Does product X support offline mode?",
            sourceUrls: ["https://example.test/product-x"],
            discoverSources: false,
          },
        },
      ],
    ],
    toolOutputs: [
      {
        summary: "No matching saved evidence was found in this scoped lookup.",
        data: { runs: [], savedContactResearch: { items: [] } },
        sources: [],
      },
      {
        summary: "Research accepted; current status is queued.",
        data: { id: "10000000-0000-4000-8000-000000000020", status: "queued" },
        sources: [],
      },
    ],
    finalText: "I’ve queued the source-limited check; it isn’t complete yet.",
  });
  await worker.dispatch("/start");
  await worker.settled();

  const names = worker.toolCalls.map((call) => z.array(z.unknown()).parse(call)[0]);
  assert.deepEqual(names, ["research_lookup", "research_dispatch"]);
  assert.equal(worker.modelCalls.length, 4);
  assert.equal(worker.status(), "succeeded");
  assert.equal(names.filter((name) => name === "research_dispatch").length, 1);
  assert.equal(names.includes("context_read"), false);
  assert.match(JSON.stringify(worker.modelCalls[0]), /research_lookup first/i);
  assert.match(
    JSON.stringify(worker.modelCalls[0]),
    /Reuse saved research or dispatch bounded research for general questions/i,
  );
  assert.match(
    JSON.stringify(worker.modelCalls[1]),
    /General research does not require a contact identity/i,
  );
  assert.deepEqual(
    z
      .object({ discoverSources: z.boolean(), sourceUrls: z.array(z.string()) })
      .parse(z.array(z.unknown()).parse(worker.toolCalls[1])[1]),
    { discoverSources: false, sourceUrls: ["https://example.test/product-x"] },
  );
});

void test("native skill catalog refreshes across pinned-version transitions in one agent", async (t) => {
  const nextTurnId = "10000000-0000-4000-8000-000000000027";
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v5",
    toolSteps: [[], [{ name: "activate_skill", input: { name: "research-dispatch" } }]],
    finalText: "Done.",
  });

  await worker.dispatch("/start");
  await worker.settled();
  assert.match(JSON.stringify(worker.modelCalls[0]), /resolved contacts/i);

  worker.setSkillVersion("assistant-skills-v6");
  worker.queueTurn(nextTurnId);
  await worker.dispatch("/start", 200, threadId, nextTurnId);
  await worker.settled();

  assert.equal(worker.status(nextTurnId), "succeeded");
  assert.match(
    JSON.stringify(worker.modelCalls[1]),
    /Reuse saved research or dispatch bounded research for general questions/i,
  );
  assert.match(
    JSON.stringify(worker.modelCalls[2]),
    /General research does not require a contact identity/i,
  );
});

void test("v6 follow-up checks accepted work status without resubmitting research", async (t) => {
  const earlierRequest: AssistantMessage = {
    ...historicalReply([]),
    id: "10000000-0000-4000-8000-000000000021",
    role: "user",
    text: "Research whether product X supports offline mode.",
  };
  const earlierAcknowledgement: AssistantMessage = {
    ...historicalReply([]),
    id: "10000000-0000-4000-8000-000000000022",
    text: "The research request was accepted and queued as run R1.",
  };
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v6",
    userText: "hmm",
    history: [earlierRequest, earlierAcknowledgement],
    toolSteps: [
      [{ name: "work_list", input: { status: "active" } }],
      [
        {
          name: "research_status",
          input: { runId: "10000000-0000-4000-8000-000000000023" },
        },
      ],
    ],
    toolOutputs: [
      {
        summary: "Found one active task in this conversation.",
        data: [{ id: "10000000-0000-4000-8000-000000000023", status: "running" }],
        sources: [],
      },
      {
        summary: "Research is running; no report is published yet.",
        data: {
          id: "10000000-0000-4000-8000-000000000023",
          status: "running",
          stage: "retrieving",
        },
        sources: [],
      },
    ],
    finalText: "It’s still running; there isn’t a completed result yet.",
  });
  await worker.dispatch("/start");
  await worker.settled();

  const names = worker.toolCalls.map((call) => z.array(z.unknown()).parse(call)[0]);
  assert.deepEqual(names, ["work_list", "research_status"]);
  assert.equal(names.includes("research_dispatch"), false);
  assert.equal(worker.status(), "succeeded");
  assert.equal(worker.modelCalls.length, 3);
  assert.match(JSON.stringify(worker.modelCalls[0]), /research request was accepted and queued/i);
});

void test("v6 context_read honors the model-selected sections instead of bootstrapping all sections", async (t) => {
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v6",
    userText: "Read the authored text of the open note.",
    toolSteps: [[{ name: "context_read", input: { sections: ["note"] } }]],
    toolOutputs: [
      {
        summary: "Read selected note context.",
        data: {
          note: { note: { id: noteId, text: "Selected authored note text." } },
          sources: [{ kind: "note", id: noteId, label: "Meeting", revision: 1 }],
          includedSections: ["note"],
          omittedSections: ["identity", "transcript"],
        },
        sources: [{ kind: "note", id: noteId, label: "Meeting", revision: 1 }],
      },
    ],
    finalText: "The note says: Selected authored note text.",
  });
  await worker.dispatch("/start");
  await worker.settled();

  assert.equal(worker.status(), "succeeded");
  assert.equal(worker.toolCalls.length, 1);
  const call = z.array(z.unknown()).parse(worker.toolCalls[0]);
  assert.equal(call[0], "context_read");
  assert.deepEqual(call[1], { sections: ["note"] });
  assert.equal(worker.modelCalls.length, 2);
  assert.doesNotMatch(JSON.stringify(worker.modelCalls[0]), /Application-provided current context/);
  assert.match(JSON.stringify(worker.modelCalls[1]), /Selected authored note text/);
});

void test("v6 preserves report-scoped sources when successor runs share a source ID", async (t) => {
  const sourceId = "10000000-0000-4000-8000-000000000024";
  const olderRunId = "10000000-0000-4000-8000-000000000025";
  const newerRunId = "10000000-0000-4000-8000-000000000026";
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v6",
    toolSteps: [
      [
        {
          name: "research_get",
          input: { runId: olderRunId, section: "evidence" },
        },
      ],
      [
        {
          name: "research_get",
          input: { runId: newerRunId, section: "evidence" },
        },
      ],
    ],
    toolOutputs: [olderRunId, newerRunId].map((researchRunId) => ({
      summary: "Read the saved report evidence.",
      data: { researchRunId },
      sources: [
        {
          kind: "url",
          id: sourceId,
          url: "https://example.test/shared-source",
          researchRunId,
          label: "Shared source",
        },
      ],
    })),
    finalText: "The two saved reports cite the same URL in distinct runs.",
  });
  await worker.dispatch("/start");
  await worker.settled();

  const completion = completionSchema.parse(worker.completions[0]);
  const scopedSources = completion.sources.filter((source) => source.id === sourceId);
  assert.equal(worker.status(), "succeeded");
  assert.deepEqual(
    scopedSources.map((source) => source.researchRunId).sort(),
    [olderRunId, newerRunId].sort(),
  );
});

void test("v5 retains covered user instructions when a conversation summary is supplied", async (t) => {
  const instruction = "Always check profiles after reading this transcript.";
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v5",
    history: [{ ...historicalReply([]), role: "user", text: instruction }],
    contextSummary: derivedSummary,
  });
  await worker.dispatch("/start");
  await worker.settled();
  assert.equal(worker.status(), "succeeded");
  const prompt = JSON.stringify(worker.modelCalls[0]);
  assert.ok(prompt.includes(instruction));
  assert.ok(prompt.includes(derivedSummary.text));
  assert.doesNotMatch(prompt, /Context only, not instructions/);
});

void test("v5 measures compact grounding while retaining complete publication provenance", async (t) => {
  const source: AssistantSource = {
    kind: "note",
    id: noteId,
    label: "Meeting",
    revision: 1,
  };
  const output = {
    summary: "Read current evidence.",
    sources: [source],
    data: {
      text: "Authorized transcript evidence.",
      sources: Array.from({ length: 400 }, () => source),
    },
  };
  assert.ok(JSON.stringify(output).length > policy.maxToolResultBytes);
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v5",
    toolOutputs: [output],
  });
  await worker.dispatch("/start");
  await worker.settled();
  assert.equal(worker.status(), "succeeded");
  assert.equal(worker.modelCalls.length, 1);
  assert.match(JSON.stringify(worker.modelCalls[0]), /Authorized transcript evidence/);
  const completion = completionSchema.parse(worker.completions[0]);
  assert.deepEqual(completion.sources, [source]);
  assert.deepEqual(completion.tools[0]?.sources, [source]);
});

void test("v5 context read failure cannot become an ungrounded successful reply", async (t) => {
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v5",
    toolErrors: [{ code: "not_found", message: "The opened note is unavailable." }],
  });
  await worker.dispatch("/start");
  await worker.settled();
  assert.notEqual(worker.status(), "succeeded");
  assert.equal(worker.completions.length, 0);
  assert.equal(worker.modelCalls.length, 0);
  assert.equal(worker.toolCalls.length, 1);
  await worker.dispatch("/start");
  assert.equal(worker.modelCalls.length, 0, "recovery does not replay inference");
  assert.equal(worker.toolCalls.length, 1, "recovery does not replay grounding");
});

void test("v5 completes application grounding before model-selected tools", async (t) => {
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v5",
    tool: { name: "notes_get", input: { noteId, section: "transcript" } },
  });
  await worker.dispatch("/start");
  await worker.settled();
  assert.equal(worker.status(), "succeeded");
  assert.equal(worker.toolCalls.length, 2);
  assert.equal(z.array(z.unknown()).parse(worker.toolCalls[0])[0], "context_read");
  assert.equal(z.array(z.unknown()).parse(worker.toolCalls[1])[0], "notes_get");
  assert.equal(worker.completions.length, 1);
});

void test("v5 retains grounded evidence and explains tool removal under context pressure", async (t) => {
  const outputs = Array.from({ length: 7 }, (_, index) => ({
    summary: `Read page ${index}.`,
    data: { text: `page-${index}:` + "e".repeat(20_000) },
    sources: [{ kind: "note" as const, id: noteId, label: "Meeting", revision: 1 }],
  }));
  const worker = fixture(t, {
    maxSteps: 8,
    skillVersion: "assistant-skills-v5",
    tools: [
      ...outputs.slice(1).map(() => ({
        name: "notes_get",
        input: { noteId, section: "transcript" },
      })),
    ],
    toolOutputs: outputs,
    respectToolChoice: true,
  });
  await worker.dispatch("/start");
  await worker.settled();
  assert.equal(worker.status(), "succeeded");
  assert.ok(worker.toolCalls.length >= 2);
  assert.ok(worker.modelCalls.length < 8);
  assert.match(JSON.stringify(worker.modelCalls.at(-1)), /context limit was reached/);
  assert.match(JSON.stringify(worker.modelCalls.at(-1)), /State any missing evidence/);
});

void test(
  "paged evidence switches to synthesis before exhausting the pinned context cap",
  { timeout: 30_000 },
  async (t) => {
    const outputs = Array.from({ length: 7 }, (_, index) => ({
      summary: `Read page ${index}.`,
      data: { text: `page-${index}:` + "e".repeat(20_000) },
      sources: [{ kind: "note" as const, id: noteId, label: "Meeting", revision: 1 }],
    }));
    const worker = fixture(t, {
      maxSteps: 8,
      skillVersion: "assistant-skills-v4",
      tools: outputs.map(() => ({
        name: "notes_get",
        input: { noteId, section: "transcript", length: 12_000 },
      })),
      toolOutputs: outputs,
      respectToolChoice: true,
    });

    await worker.dispatch("/start");
    await worker.settled();

    assert.equal(worker.status(), "succeeded");
    assert.equal(worker.failures.length, 0);
    assert.ok(worker.toolCalls.length >= 2, "exercise accumulated evidence, not a greeting");
    assert.ok(worker.modelCalls.length < 8, "context pressure ends retrieval before the step cap");
    assert.equal(worker.modelCalls.length, worker.toolCalls.length + 1);
    assert.equal(worker.reservations.length, worker.modelCalls.length);
    const finalRequest = z
      .object({ tool_choice: z.literal("none"), tools: z.array(z.unknown()).length(0) })
      .passthrough()
      .parse(worker.modelCalls.at(-1));
    const serialized = JSON.stringify(finalRequest);
    for (const output of outputs.slice(0, worker.toolCalls.length)) {
      assert.ok(serialized.includes(output.data.text), "retain every exact inspected page");
    }
    for (const reservation of worker.reservations) {
      assert.ok(
        z.object({ inputTokenBound: z.number() }).parse(reservation).inputTokenBound <=
          policy.maxContextBytes + 2048,
        "the synthesis request still passes the original admission cap",
      );
    }
  },
);

void test(
  "oversized concurrent evidence still refuses the next admission without replay",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, {
      maxSteps: 8,
      skillVersion: "assistant-skills-v4",
      toolSteps: [
        Array.from({ length: 5 }, () => ({
          name: "notes_get",
          input: { noteId, section: "transcript", length: 12_000 },
        })),
      ],
      toolOutputs: Array.from({ length: 5 }, () => ({
        summary: "Read bounded evidence.",
        data: { text: "e".repeat(22_000) },
        sources: [{ kind: "note" as const, id: noteId, label: "Meeting", revision: 1 }],
      })),
      respectToolChoice: true,
    });

    await worker.dispatch("/start");
    await worker.settled();

    assert.equal(worker.status(), "interrupted");
    assert.equal(worker.toolCalls.length, 5);
    assert.equal(worker.modelCalls.length, 1);
    assert.equal(worker.reservations.length, 1);
    assert.equal(worker.completions.length, 0);
    await worker.dispatch("/start");
    assert.equal(worker.modelCalls.length, 1);
  },
);

void test(
  "real Think programmatic greeting is admitted once and exported idempotently",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t);
    await Promise.all([worker.dispatch("/start"), worker.dispatch("/start")]);
    await worker.settled();
    assert.equal(worker.status(), "succeeded");
    assert.equal(worker.modelCalls.length, 1);
    assert.equal(worker.reservations.length, 1);
    assert.deepEqual(worker.events, ["admit", "model"]);
    assert.equal(worker.toolCalls.length, 0);
    assert.equal(worker.completions.length, 1);
    await worker.dispatch("/start");
    assert.equal(worker.modelCalls.length, 1);
  },
);

void test(
  "export outage retains exact completion and recovery never calls inference",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, { exportOutage: true });
    await worker.dispatch("/start");
    const inspection = await worker.settled();
    assert.ok(inspection.state.active?.pending);
    assert.equal(worker.status(), "running");
    worker.setExportOutage(false);
    assert.equal(await worker.dispatch("/export"), true);
    assert.equal(worker.status(), "succeeded");
    assert.deepEqual(worker.completions.at(-1), worker.completions[0]);
    assert.equal(worker.modelCalls.length, 1);
  },
);

void test(
  "each model step requires admission and tool summaries/sources survive export",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, { tool: { name: "notes_get", input: { noteId } } });
    await worker.dispatch("/start");
    await worker.settled();
    assert.equal(worker.status(), "succeeded");
    assert.equal(worker.modelCalls.length, 2);
    assert.equal(worker.reservations.length, 2);
    assert.deepEqual(worker.events, ["admit", "model", "admit", "model"]);
    assert.equal(worker.toolCalls.length, 1);
    const completion = z
      .object({
        tools: z.array(z.object({ name: z.string(), status: z.string() })),
        sources: z.array(z.object({ id: z.string() })),
      })
      .parse(worker.completions[0]);
    assert.deepEqual(
      completion.tools.map((tool) => [tool.name, tool.status]),
      [["notes_get", "succeeded"]],
    );
    assert.equal(completion.sources[0]?.id, noteId);
  },
);

void test("rejected budget admission sends no provider request", { timeout: 30_000 }, async (t) => {
  const worker = fixture(t, { denyBudget: true });
  await worker.dispatch("/start");
  await worker.settled();
  assert.equal(worker.modelCalls.length, 0);
  assert.equal(worker.reservations.length, 1);
  assert.equal(worker.status(), "interrupted");
  await worker.dispatch("/start");
  assert.equal(worker.modelCalls.length, 0);
});

void test(
  "disabled execution and wrong thread identity fail before admission",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, { enabled: false });
    await worker.dispatch("/start", 500);
    await worker.dispatch("/start", 500, noteId);
    assert.equal(worker.modelCalls.length, 0);
    assert.equal(worker.reservations.length, 0);
  },
);

void test("cancel before start prevents model execution", { timeout: 30_000 }, async (t) => {
  const worker = fixture(t);
  await worker.dispatch("/cancel");
  await worker.dispatch("/start");
  assert.equal(worker.status(), "cancelled");
  assert.equal(worker.modelCalls.length, 0);
});

void test(
  "uncertain paid execution recovery records interruption and refuses continuation",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, { holdModel: true, exportOutage: true });
    await worker.dispatch("/start");
    await worker.modelStarted;
    assert.deepEqual(await worker.dispatch("/recover"), { continue: false });
    const inspection = inspectionSchema.parse(await worker.dispatch("/inspect"));
    assert.ok(inspection.state.active?.pending);
    worker.setExportOutage(false);
    await worker.dispatch("/export");
    worker.releaseModel();
    await worker.settled();
    assert.equal(worker.status(), "interrupted");
    assert.equal(worker.completions.length, 0);
    assert.equal(worker.modelCalls.length, 1);
  },
);

void test(
  "built-in workspace tool bypass is excluded from the actual provider tool set",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t);
    await worker.dispatch("/start");
    await worker.settled();
    const request = z
      .object({
        tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
      })
      .parse(worker.modelCalls[0]);
    const names = request.tools.map((tool) => tool.function.name);
    assert.ok(names.includes("notes_get"));
    assert.ok(names.includes("activate_skill"));
    for (const name of ["bash", "execute", "read", "write", "set_context", "run_skill_script"]) {
      assert.ok(!names.includes(name), name);
    }
  },
);

void test(
  "native skill activation loads the bundled versioned instructions",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, { tool: { name: "activate_skill", input: { name: "contacts" } } });
    await worker.dispatch("/start");
    await worker.settled();
    assert.equal(worker.status(), "succeeded");
    assert.equal(worker.modelCalls.length, 2);
    assert.ok(JSON.stringify(worker.modelCalls[1]).includes("Batch all relevant IDs"));
    assert.equal(
      worker.toolCalls.length,
      0,
      "Native skill reads never dispatch application side effects",
    );
  },
);

void test(
  "v4 conversation skill is bundled and activated without application tool dispatch",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, {
      skillVersion: "assistant-skills-v4",
      tool: { name: "activate_skill", input: { name: "conversation" } },
    });
    await worker.dispatch("/start");
    await worker.settled();
    assert.equal(worker.status(), "succeeded");
    assert.equal(worker.modelCalls.length, 2);
    const instructions = JSON.stringify(worker.modelCalls[1]);
    assert.match(instructions, /common typos/);
    assert.match(instructions, /current external facts/);
    assert.match(instructions, /Preparing interview questions/);
    assert.equal(worker.toolCalls.length, 0);
  },
);

void test(
  "cancellation wins over a pending completed-answer export",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, { exportOutage: true });
    await worker.dispatch("/start");
    await worker.settled();
    await worker.dispatch("/cancel");
    const beforeRetry = worker.completions.length;
    worker.setExportOutage(false);
    await worker.dispatch("/export");
    assert.equal(worker.status(), "cancelled");
    assert.equal(worker.completions.length, beforeRetry);
    assert.equal(worker.modelCalls.length, 1);
  },
);

for (const [name, expected] of [
  ["creation", "noteId MUST be null"],
  ["memory", "NEVER contain the target memory"],
]) {
  void test(`native v2 activation exposes corrected ${name} instructions`, async (t) => {
    const worker = fixture(t, {
      skillVersion: "assistant-skills-v2",
      tool: { name: "activate_skill", input: { name } },
    });
    await worker.dispatch("/start");
    await worker.settled();
    assert.equal(worker.modelCalls.length, 2);
    assert.ok(JSON.stringify(worker.modelCalls[1]).includes(expected!));
    assert.equal(worker.toolCalls.length, 0);
  });
}

void test(
  "the final admitted model step cannot start additional tool work",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, { maxSteps: 1 });
    await worker.dispatch("/start");
    await worker.settled();
    const request = z
      .object({ tools: z.array(z.unknown()).optional() })
      .parse(worker.modelCalls[0]);
    assert.equal(request.tools?.length ?? 0, 0);
    assert.equal(worker.reservations.length, 1);
    assert.equal(worker.status(), "succeeded");
  },
);

void test("v3 preserves historical notes_get input while adding sectioned bounded reads", () => {
  const historical = assistantToolsForVersion("assistant-skills-v1");
  const versionTwo = assistantToolsForVersion("assistant-skills-v2");
  const versionThree = assistantToolsForVersion("assistant-skills-v3");
  const current = assistantToolsForVersion("assistant-skills-v4");

  assert.deepEqual(historical.schemas.notes_get.parse({ noteId }), { noteId });
  assert.deepEqual(versionTwo.schemas.notes_get.parse({ noteId }), { noteId });
  assert.deepEqual(versionThree.schemas.notes_get.parse({ noteId }), {
    noteId,
    section: "transcript",
    length: 12_000,
  });
  assert.deepEqual(current.schemas.notes_get.parse({ noteId }), {
    noteId,
    section: "transcript",
    length: 12_000,
  });
  assert.deepEqual(
    assistantToolSchemaForVersion("assistant-skills-v3", "notes_get").parse({
      noteId,
      section: "authored",
      offset: 12_000,
      length: 8000,
    }),
    { noteId, section: "authored", offset: 12_000, length: 8000 },
  );
  assert.throws(() =>
    assistantToolSchemaForVersion("assistant-skills-v3", "notes_get").parse({
      noteId,
      section: "authored",
      length: 20_000,
    }),
  );
  assert.deepEqual(
    assistantToolSchemaForVersion("assistant-skills-v4", "notes_get").parse({
      noteId,
      section: "summary",
      offset: 100,
    }),
    { noteId, section: "summary", offset: 100, length: 12_000 },
  );
  assert.ok("contacts_create" in current.schemas);
  assert.ok("contacts_update" in current.schemas);
});

void test(
  "v3 reserves a tool-free synthesis step after seven evidence pages",
  { timeout: 30_000 },
  async (t) => {
    const evidencePages = Array.from({ length: 7 }, (_, index) => [
      {
        name: "notes_get",
        input: { noteId, section: "transcript", ...(index ? { cursor: `cursor-${index}` } : {}) },
      },
    ]);
    const worker = fixture(t, {
      skillVersion: "assistant-skills-v3",
      maxSteps: 8,
      toolSteps: evidencePages,
      finalText:
        "The clip discusses the launch after the first minute and returns to pricing near the end. I could not verify a single agreed price because the transcript sources conflict.",
    });
    await worker.dispatch("/start");
    await worker.settled();

    assert.equal(worker.status(), "succeeded");
    assert.equal(worker.toolCalls.length, 7);
    assert.equal(worker.modelCalls.length, 8);
    assert.equal(worker.reservations.length, 8);
    const finalRequest = z
      .object({ tools: z.array(z.unknown()).optional() })
      .parse(worker.modelCalls.at(-1));
    assert.equal(finalRequest.tools?.length ?? 0, 0);
    assert.match(completionSchema.parse(worker.completions[0]).text, /pricing near the end/);
  },
);

void test(
  "evidence reads followed only by an investigation introduction fail instead of publishing as an answer",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, {
      skillVersion: "assistant-skills-v3",
      tool: { name: "notes_get", input: { noteId, section: "transcript" } },
      finalText: "I'll review the rest of the podcast and report back.",
    });
    await worker.dispatch("/start");
    await worker.settled();

    assert.equal(worker.status(), "failed");
    assert.equal(worker.completions.length, 0);
    assert.equal(worker.failures.length, 1);
    assert.match(JSON.stringify(worker.failures[0]), /without producing an evidence-based answer/);
  },
);

void test("saved-summary lineage is tied to its job and note, not a fake segment", () => {
  const source = assistantSourceSchema.parse({
    kind: "summary",
    id: "10000000-0000-4000-8000-000000000099",
    noteId,
    label: "Summary v3 · Podcast",
    revision: 3,
  });
  assert.equal(source.kind, "summary");
  assert.notEqual(source.id, noteId);
  assert.equal(source.noteId, noteId);
});

const nextTurnId = "10000000-0000-4000-8000-000000000007";
const memoryId = "10000000-0000-4000-8000-000000000008";
const personId = "10000000-0000-4000-8000-000000000009";
const noteSource: AssistantSource = { kind: "note", id: noteId, label: "Meeting", revision: 1 };
const memorySource: AssistantSource = {
  kind: "memory",
  id: memoryId,
  label: "Preference",
  revision: 1,
};
const personSource: AssistantSource = { kind: "person", id: personId, label: "Sam", revision: 3 };
const completionSchema = z.object({
  text: z.string(),
  tools: z.array(assistantToolResultSchema),
  sources: z.array(assistantSourceSchema),
});

for (const version of [
  "assistant-skills-v1",
  "assistant-skills-v2",
  "assistant-skills-v3",
] as const) {
  void test(`native model instructions and tool fields retain pinned ${version}`, async (t) => {
    const worker = fixture(t, { skillVersion: version });
    await worker.dispatch("/start");
    await worker.settled();
    const request = JSON.stringify(worker.modelCalls[0]);
    if (version === "assistant-skills-v2" || version === "assistant-skills-v3") {
      assert.match(request, /Keep internal UUIDs/);
      assert.match(request, /MUST be null/);
      assert.match(request, /NEVER include the target memoryId/);
      assert.match(request, /shorter phrase/);
      assert.match(request, /source-supported memory still requires evidence/);
    } else {
      assert.doesNotMatch(
        request,
        /Keep internal UUIDs|MUST be null|NEVER include the target memoryId/,
      );
    }
  });
}

void test("definitive new-note rejection allows corrected call without rewriting submitted inputs", async (t) => {
  const invalid = {
    kind: "note",
    noteId,
    name: "Interview outline",
    mediaType: "text/plain",
    content: "Prepare examples.",
    sources: [],
  };
  const corrected = { ...invalid, noteId: null };
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v2",
    tools: [
      { name: "artifact_create", input: invalid },
      { name: "artifact_create", input: corrected },
    ],
    toolErrors: [{ code: "conflict", message: "New authored notes require an empty note ID" }],
  });
  await worker.dispatch("/start");
  await worker.settled();
  const completion = completionSchema.parse(worker.completions[0]);
  assert.deepEqual(
    completion.tools.map((entry) => entry.status),
    ["failed", "succeeded"],
  );
  assert.match(completion.tools[0]!.summary, /empty note ID.*corrected new call/);
  const calls = z
    .array(z.tuple([z.string(), z.unknown(), z.object({ operationId: z.string() })]))
    .parse(worker.toolCalls);
  assert.deepEqual(
    calls.map((call) => call[1]),
    [invalid, corrected],
  );
  assert.notEqual(calls[0]![2].operationId, calls[1]![2].operationId);
  assert.match(JSON.stringify(worker.modelCalls[1]), /Rejected \(conflict\)/);
});

void test("self-dependent memory revision fails definitively and user-stated correction can use empty sources", async (t) => {
  const invalid = {
    memoryId,
    expectedRevision: 1,
    content: "Use short bullet points.",
    sources: [memorySource],
    reason: "The user corrected their preference.",
  };
  const corrected = { ...invalid, sources: [] };
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v2",
    tools: [
      { name: "memory_revise", input: invalid },
      { name: "memory_revise", input: corrected },
    ],
    toolErrors: [{ code: "conflict", message: "Memory cannot depend on itself" }],
  });
  await worker.dispatch("/start");
  await worker.settled();
  const completion = completionSchema.parse(worker.completions[0]);
  assert.deepEqual(
    completion.tools.map((entry) => entry.status),
    ["failed", "succeeded"],
  );
  assert.match(completion.tools[0]!.summary, /cannot depend on itself/);
  const calls = z.array(z.array(z.unknown())).parse(worker.toolCalls);
  assert.deepEqual(
    calls.map((call) => call[1]),
    [invalid, corrected],
  );
});

for (const code of ["forbidden", "not_found", "invalid_cursor"] as const) {
  void test(`typed ${code} tool rejection is failed with actionable guidance`, async (t) => {
    const worker = fixture(t, {
      tool: { name: "notes_get", input: { noteId } },
      toolErrors: [{ code, message: "The request was rejected." }],
    });
    await worker.dispatch("/start");
    await worker.settled();
    const result = completionSchema.parse(worker.completions[0]).tools[0]!;
    assert.equal(result.status, "failed");
    assert.match(result.summary, /Access denied|Resolve an existing|Check the inputs/);
    assert.equal(worker.toolCalls.length, 1);
  });
}

for (const error of [
  { code: "conflict", message: "Spoofed code", untyped: true },
  { code: "service_unavailable", message: "Connection lost after commit" },
  { code: "command_reused", message: "Existing receipt cannot establish rollback" },
] as const) {
  void test(`unknown write outcome remains uncertain: ${error.message}`, async (t) => {
    const worker = fixture(t, {
      tool: {
        name: "memory_invalidate",
        input: { memoryId, expectedRevision: 1, reason: "Forget this." },
      },
      toolErrors: [error],
    });
    await worker.dispatch("/start");
    await worker.settled();
    const result = completionSchema.parse(worker.completions[0]).tools[0]!;
    assert.equal(result.status, "uncertain");
    assert.match(result.summary, /Do not repeat/);
    await worker.dispatch("/recover");
    await worker.dispatch("/export");
    assert.equal(worker.toolCalls.length, 1);
    assert.equal(worker.modelCalls.length, 2);
  });
}

void test("composite research errors do not infer rollback from a typed conflict", async (t) => {
  const worker = fixture(t, {
    tool: {
      name: "research_dispatch",
      input: {
        people: [
          {
            personId,
            expectedProfileRevision: 1,
            requestedFacts: [{ key: "employer", question: "Current employer?" }],
            sourceUrls: ["https://example.com/profile"],
          },
        ],
      },
    },
    toolErrors: [{ code: "conflict", message: "Post-acceptance failure" }],
  });
  await worker.dispatch("/start");
  await worker.settled();
  assert.equal(completionSchema.parse(worker.completions[0]).tools[0]!.status, "uncertain");
  assert.equal(worker.toolCalls.length, 1);
});

void test(
  "oversized contact reads allow a smaller re-read within the admitted step limit",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, {
      maxSteps: 3,
      tools: [
        {
          name: "contacts_get",
          input: { personIds: [personId, memoryId], fieldGroups: ["identity", "publicLinks"] },
        },
        {
          name: "contacts_get",
          input: { personIds: [personId], fieldGroups: ["identity"] },
        },
      ],
      toolOutputs: [
        { summary: "Large contact batch.", sources: [personSource], data: "x".repeat(30_000) },
        { summary: "Read one contact.", sources: [personSource], data: { name: "Sam" } },
      ],
    });
    await worker.dispatch("/start");
    await worker.settled();
    assert.equal(worker.status(), "succeeded");
    const completion = completionSchema.parse(worker.completions[0]);
    assert.equal(completion.tools[0]?.status, "failed");
    assert.match(
      completion.tools[0]?.summary ?? "",
      /Result exceeds limit; request fewer contacts/,
    );
    assert.doesNotMatch(completion.tools[0]?.summary ?? "", /uncertain|Do not repeat/i);
    assert.deepEqual(completion.tools[0]?.sources, []);
    assert.equal(completion.tools[1]?.status, "succeeded");
    assert.equal(worker.toolCalls.length, 2);
    assert.equal(worker.modelCalls.length, 3);
    assert.equal(worker.reservations.length, 3);
    assert.ok(JSON.stringify(worker.modelCalls[1]).includes("Result exceeds limit"));
    assert.ok(!JSON.stringify(worker.modelCalls[1]).includes("x".repeat(100)));
  },
);

void test(
  "oversized write acknowledgements remain uncertain and do not suggest repeating mutations",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, {
      tool: {
        name: "memory_invalidate",
        input: { memoryId, expectedRevision: 1, reason: "Forget this preference." },
      },
      toolOutputs: [
        {
          summary: "Invalidation acknowledged.",
          sources: [],
          data: "x".repeat(30_000),
          invalidatedSources: [{ kind: "memory", id: memoryId }],
        },
      ],
    });
    await worker.dispatch("/start");
    await worker.settled();
    const completion = completionSchema.parse(worker.completions[0]);
    assert.equal(completion.tools[0]?.status, "uncertain");
    assert.match(completion.tools[0]?.summary ?? "", /Do not repeat/);
    assert.equal(worker.toolCalls.length, 1);
    assert.equal(worker.modelCalls.length, 2);
  },
);

void test("uncertain writes block a new mutation invocation but allow reconciliation reads", async (t) => {
  const mutation = {
    name: "memory_invalidate",
    input: { memoryId, expectedRevision: 1, reason: "Forget this." },
  };
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v2",
    tools: [
      mutation,
      mutation,
      { name: "memory_recall", input: { subjectId: null, query: "", limit: 10 } },
    ],
    toolErrors: [{ code: "service_unavailable", message: "Connection lost after commit" }],
  });
  await worker.dispatch("/start");
  await worker.settled();
  const calls = z.array(z.array(z.unknown())).parse(worker.toolCalls);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["memory_invalidate", "memory_recall"],
  );
  assert.match(JSON.stringify(worker.modelCalls[2]), /uncertain outcome/);
  assert.deepEqual(
    completionSchema.parse(worker.completions[0]).tools.map((entry) => entry.status),
    ["uncertain", "succeeded"],
  );
});

void test("literal recall can broaden a zero-match query without changing its scope or parameters", async (t) => {
  const queries = ["interview preparation format preference", "interview preparation", ""];
  const worker = fixture(t, {
    skillVersion: "assistant-skills-v2",
    tools: queries.map((query) => ({
      name: "memory_recall",
      input: { subjectId: null, query, limit: 10 },
    })),
    toolOutputs: queries.map(() => ({
      summary: "No literal matches; try a shorter phrase or empty query before asserting absence.",
      data: [],
      sources: [],
    })),
  });
  await worker.dispatch("/start");
  await worker.settled();
  const calls = z
    .array(
      z.tuple([
        z.string(),
        z.object({
          query: z.string(),
          subjectId: z.null(),
          limit: z.number(),
        }),
        z.unknown(),
      ]),
    )
    .parse(worker.toolCalls);
  assert.deepEqual(
    calls.map((call) => call[1].query),
    queries,
  );
  assert.match(JSON.stringify(worker.modelCalls[1]), /before asserting absence/);
});

void test(
  "same-step mutations serialize their actual outcomes while reads remain parallel",
  { timeout: 30_000 },
  async (t) => {
    const mutation = {
      name: "memory_invalidate",
      input: { memoryId, expectedRevision: 1, reason: "Forget this." },
    };
    const worker = fixture(t, {
      skillVersion: "assistant-skills-v2",
      holdFirstTool: true,
      firstWriteError: {
        code: "service_unavailable",
        message: "Lost acknowledgement after commit",
      },
      toolSteps: [
        [
          mutation,
          mutation,
          { name: "memory_recall", input: { subjectId: null, query: "", limit: 10 } },
        ],
      ],
    });
    await worker.dispatch("/start");
    await Promise.all([worker.firstToolStarted, worker.readToolStarted]);
    const calls = () => z.array(z.array(z.unknown())).parse(worker.toolCalls);
    assert.deepEqual(
      calls()
        .map((call) => call[0])
        .sort(),
      ["memory_invalidate", "memory_recall"],
    );
    worker.releaseFirstTool();
    await worker.settled();
    assert.equal(worker.status(), "succeeded");
    assert.equal(worker.toolCalls.length, 2);
    assert.equal(worker.modelCalls.length, 2);
    assert.match(JSON.stringify(worker.modelCalls[1]), /uncertain outcome/);
    assert.equal(
      completionSchema
        .parse(worker.completions[0])
        .tools.filter((entry) => entry.name === mutation.name).length,
      1,
    );
  },
);

void test(
  "cancellation fences a queued same-step mutation before its service boundary",
  { timeout: 30_000 },
  async (t) => {
    const mutation = {
      name: "memory_invalidate",
      input: { memoryId, expectedRevision: 1, reason: "Forget this." },
    };
    const worker = fixture(t, { holdFirstTool: true, toolSteps: [[mutation, mutation]] });
    await worker.dispatch("/start");
    await worker.firstToolStarted;
    await worker.dispatch("/cancel");
    worker.releaseFirstTool();
    await worker.settled();
    assert.equal(worker.status(), "cancelled");
    assert.equal(worker.toolCalls.length, 1);
    assert.equal(worker.modelCalls.length, 1);
    assert.equal(worker.completions.length, 0);
  },
);

void test("model and tool boundaries avoid redundant execution reloads", async (t) => {
  const worker = fixture(t, { tool: { name: "notes_get", input: { noteId } } });
  await worker.dispatch("/start");
  await worker.settled();
  assert.equal(worker.status(), "succeeded");
  assert.equal(worker.modelCalls.length, 2);
  assert.equal(worker.toolCalls.length, 1);
  const count = (name: string) => worker.serviceCalls.filter((call) => call === name).length;
  // Start + two history boundaries + two per model + one serialized tool boundary.
  assert.equal(count("/execution"), 8);
  assert.equal(count("/authorize"), 0);
  // Before initial submission and before final publication only.
  assert.equal(count("/isCancelled"), 2);
  assert.equal(count("/admitModelRequest"), 2);
  assert.equal(count("/executeTool"), 1);
});

void test("access revoked during inference fences the subsequent tool boundary", async (t) => {
  const worker = fixture(t, {
    holdModel: true,
    tool: { name: "notes_get", input: { noteId } },
  });
  await worker.dispatch("/start");
  await worker.modelStarted;
  worker.revoke();
  worker.releaseModel();
  await worker.settled();
  assert.equal(worker.toolCalls.length, 0);
  assert.equal(worker.modelCalls.length, 1);
  assert.equal(worker.completions.length, 0);
});

for (const change of ["cancellation", "revocation"] as const) {
  void test(`remote ${change} during admission prevents provider I/O without a DO notification`, async (t) => {
    const worker = fixture(t, { holdAdmission: true });
    await worker.dispatch("/start");
    await worker.admissionStarted;
    if (change === "cancellation") {
      worker.cancelRemotely();
    } else {
      worker.revoke();
    }
    worker.releaseAdmission();
    await worker.settled();
    assert.equal(worker.reservations.length, 1, "preserve the admitted reservation");
    assert.equal(worker.modelCalls.length, 0);
    assert.equal(worker.toolCalls.length, 0);
    assert.equal(worker.completions.length, 0);
    await worker.dispatch("/recover");
    assert.equal(worker.reservations.length, 1, "recovery never reserves again");
    assert.equal(worker.modelCalls.length, 0);
  });
}

function historicalReply(sources: AssistantSource[]): AssistantMessage {
  return {
    id: "10000000-0000-4000-8000-000000000010",
    threadId,
    turnId: "10000000-0000-4000-8000-000000000011",
    role: "assistant",
    text: "Sam's profile listed Acme at the time of the earlier conversation.",
    tools: [],
    sources,
    createdAt: new Date(0).toISOString(),
  };
}

const summaryMessageSource: AssistantSource = {
  kind: "message",
  id: "10000000-0000-4000-8000-000000000010",
  label: "Earlier conversation message",
};
const derivedSummary = {
  id: "10000000-0000-4000-8000-000000000012",
  threadId,
  status: "succeeded",
  fromSequence: 1,
  throughSequence: 1,
  messageCount: 1,
  text: "Sam asked about project status; no commitment was recorded.",
  sources: [summaryMessageSource],
  error: null,
  createdAt: new Date(0).toISOString(),
  completedAt: new Date(1).toISOString(),
};

void test("hydrated summary and exact memory revision proof survive completion export recovery", async (t) => {
  const input = {
    memoryId,
    expectedRevision: 1,
    content: "Use short bullet points.",
    sources: [],
    reason: "The user corrected their preference.",
  };
  const replacement = { ...memorySource, revision: 2 };
  const worker = fixture(t, {
    exportOutage: true,
    history: [historicalReply([memorySource, personSource])],
    contextSummary: derivedSummary,
    tool: { name: "memory_revise", input },
    toolOutputs: [
      {
        summary: "Updated the memory.",
        data: {},
        sources: [replacement],
        invalidatedSources: [{ kind: "memory", id: memoryId }],
      },
    ],
  });
  await worker.dispatch("/start");
  await worker.settled();
  const completion = z
    .object({
      sources: z.array(assistantSourceSchema),
      memoryMutations: z.array(
        z.object({
          name: z.string(),
          operationId: z.string(),
          input: z.unknown(),
        }),
      ),
    })
    .parse(worker.completions[0]);
  const calls = z
    .array(z.tuple([z.string(), z.unknown(), z.object({ operationId: z.string() })]))
    .parse(worker.toolCalls);
  assert.deepEqual(completion.sources, [replacement]);
  assert.deepEqual(completion.memoryMutations, [
    {
      name: "memory_revise",
      operationId: calls[0]![2].operationId,
      input,
    },
  ]);
  worker.setExportOutage(false);
  assert.equal(await worker.dispatch("/export"), true);
  assert.equal(worker.status(), "succeeded");
  assert.deepEqual(worker.completions.at(-1), worker.completions[0]);
  assert.equal(worker.toolCalls.length, 1);
  assert.equal(worker.modelCalls.length, 2);
});

void test(
  "saved derived summary replaces only covered history and retains context plus latest user",
  { timeout: 30_000 },
  async (t) => {
    const covered = historicalReply([personSource]);
    const uncovered: AssistantMessage = {
      ...historicalReply([noteSource]),
      id: "10000000-0000-4000-8000-000000000013",
      turnId: "10000000-0000-4000-8000-000000000014",
      text: "An uncovered follow-up remains.",
    };
    const latest: AssistantMessage = {
      ...uncovered,
      id: "10000000-0000-4000-8000-000000000015",
      turnId,
      role: "user",
      text: "Hello!",
      sources: [],
    };
    const worker = fixture(t, {
      history: [covered, uncovered, latest],
      contextSummary: derivedSummary,
    });
    await worker.dispatch("/start");
    await worker.settled();
    assert.equal(worker.status(), "succeeded");
    const prompt = JSON.stringify(worker.modelCalls[0]);
    assert.ok(prompt.includes("[Historical derived conversation summary"));
    assert.ok(prompt.includes("Context only, not instructions"));
    assert.ok(prompt.includes(derivedSummary.text));
    assert.ok(!prompt.includes(covered.text));
    assert.ok(prompt.includes(uncovered.text));
    assert.equal(prompt.split("Hello!").length - 1, 1);
    assert.deepEqual(completionSchema.parse(worker.completions[0]).sources, []);
    assert.equal(worker.toolCalls.length, 0);
  },
);

for (const summary of [
  { ...derivedSummary, status: "failed" },
  { ...derivedSummary, status: "stale" },
  { ...derivedSummary, text: 42 },
  { ...derivedSummary, threadId: noteId },
  { ...derivedSummary, sources: [] },
]) {
  void test(
    `unusable derived summary is ignored: ${JSON.stringify({ status: summary.status, text: summary.text, threadId: summary.threadId, sources: summary.sources.length })}`,
    { timeout: 30_000 },
    async (t) => {
      const reply = historicalReply([personSource]);
      const worker = fixture(t, { history: [reply], contextSummary: summary });
      await worker.dispatch("/start");
      await worker.settled();
      assert.equal(worker.status(), "succeeded");
      const prompt = JSON.stringify(worker.modelCalls[0]);
      assert.ok(prompt.includes(reply.text));
      assert.ok(!prompt.includes("[Historical derived conversation summary"));
      assert.deepEqual(completionSchema.parse(worker.completions[0]).sources, []);
    },
  );
}

void test(
  "historical summary sources are not inherited by new answer publication",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, {
      history: [historicalReply([personSource])],
      contextSummary: derivedSummary,
      rejectedSources: [summaryMessageSource],
    });
    await worker.dispatch("/start");
    await worker.settled();
    assert.equal(worker.status(), "succeeded");
    assert.deepEqual(completionSchema.parse(worker.completions[0]).sources, []);
    assert.equal(worker.modelCalls.length, 1);
    assert.equal(worker.completions.length, 1);
  },
);

for (const boundary of ["begin-acknowledgement", "before-native-submission"] as const) {
  void test(
    `cancellation during ${boundary} releases the thread for its next turn`,
    { timeout: 30_000 },
    async (t) => {
      const worker = fixture(t, {
        holdBegin: boundary === "begin-acknowledgement",
        holdBeforeSubmit: boundary === "before-native-submission",
      });
      const start = worker.dispatch("/start");
      await (boundary === "begin-acknowledgement" ? worker.beginStarted : worker.beforeSubmit);
      await worker.dispatch("/cancel");
      worker.releaseBegin();
      worker.releaseBeforeSubmit();
      assert.equal(await start, null);
      const cancelled = inspectionSchema.parse(await worker.dispatch("/inspect"));
      assert.equal(cancelled.state.active, null);
      assert.equal(cancelled.submissions.length, 0);
      assert.equal(worker.status(), "cancelled");
      assert.equal(worker.modelCalls.length, 0);
      await worker.dispatch("/start", 200, threadId, nextTurnId);
      await worker.settled();
      assert.equal(worker.status(nextTurnId), "succeeded");
      assert.equal(worker.modelCalls.length, 1);
    },
  );
}

for (const code of ["conflict", "not_found", "forbidden", "command_reused"] as const) {
  void test(
    `definitive publication ${code} terminalizes instead of replaying completion`,
    { timeout: 30_000 },
    async (t) => {
      const worker = fixture(t, { publicationRejection: code });
      await worker.dispatch("/start");
      const result = await worker.settled();
      assert.equal(worker.status(), "failed");
      assert.equal(result.state.active, null);
      assert.equal(worker.completions.length, 1);
      assert.equal(worker.failures.length, 1);
      await worker.dispatch("/export");
      await worker.dispatch("/reconcile");
      assert.equal(worker.completions.length, 1);
      assert.equal(worker.modelCalls.length, 1);
      worker.setPublicationRejection(undefined);
      await worker.dispatch("/start", 200, threadId, nextTurnId);
      await worker.settled();
      assert.equal(worker.status(nextTurnId), "succeeded");
    },
  );
}

void test(
  "a transient terminal-write outage retries only failure after a permanent publication conflict",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, { publicationRejection: "conflict", failureOutage: true });
    await worker.dispatch("/start");
    const result = await worker.settled();
    const pending = z
      .object({ kind: z.literal("fail"), status: z.literal("failed") })
      .parse(result.state.active?.pending);
    assert.equal(pending.kind, "fail");
    assert.equal(worker.status(), "running");
    assert.equal(worker.completions.length, 1);
    await worker.dispatch("/reconcile");
    assert.equal(worker.completions.length, 1);
    worker.setFailureOutage(false);
    assert.equal(await worker.dispatch("/export"), true);
    assert.equal(worker.status(), "failed");
    assert.equal(worker.modelCalls.length, 1);
  },
);

void test(
  "history-only follow-up retains historical text without inheriting its evidence dependencies",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, { history: [historicalReply([personSource, noteSource])] });
    await worker.dispatch("/start");
    await worker.settled();
    const completion = completionSchema.parse(worker.completions[0]);
    assert.deepEqual(completion.sources, []);
    assert.equal(worker.toolCalls.length, 0);
    assert.ok(JSON.stringify(worker.modelCalls[0]).includes("not a current contact/profile read"));
  },
);

void test(
  "a historical source changing after hydration does not block an unrelated new answer",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, {
      history: [historicalReply([personSource, noteSource])],
      rejectedSources: [personSource],
    });
    await worker.dispatch("/start");
    const result = await worker.settled();
    assert.equal(worker.status(), "succeeded");
    assert.equal(result.state.active, null);
    const attempted = completionSchema.parse(worker.completions[0]);
    assert.deepEqual(attempted.sources, []);
    await worker.dispatch("/reconcile");
    assert.equal(worker.completions.length, 1);
    assert.equal(worker.modelCalls.length, 1);
  },
);

void test(
  "a fresh contact read supplies current answer evidence without unrelated historical sources",
  { timeout: 30_000 },
  async (t) => {
    const refreshed = { ...personSource, revision: 4 };
    const worker = fixture(t, {
      history: [historicalReply([personSource, noteSource])],
      tool: {
        name: "contacts_get",
        input: { personIds: [personId], fieldGroups: ["professional"] },
      },
      toolOutputs: [{ summary: "Read the current profile.", sources: [refreshed], data: {} }],
      rejectedSources: [personSource],
    });
    await worker.dispatch("/start");
    await worker.settled();
    assert.equal(worker.status(), "succeeded");
    const completion = completionSchema.parse(worker.completions[0]);
    assert.deepEqual(completion.sources, [refreshed]);
  },
);

for (const operation of ["memory_invalidate", "memory_revise"] as const) {
  void test(
    `recall then ${operation} removes only explicitly invalidated earlier sources`,
    { timeout: 30_000 },
    async (t) => {
      const replacement = { ...memorySource, revision: 2 };
      const sources = operation === "memory_revise" ? [replacement] : [];
      const worker = fixture(t, {
        history: [historicalReply([memorySource, personSource])],
        tools: [
          { name: "memory_recall", input: { subjectId: null, query: "preference", limit: 10 } },
          {
            name: operation,
            input:
              operation === "memory_revise"
                ? {
                    memoryId,
                    expectedRevision: 1,
                    content: "Prefers concise replies.",
                    sources: [],
                    reason: "User correction.",
                  }
                : { memoryId, expectedRevision: 1, reason: "User requested forgetting." },
          },
        ],
        toolOutputs: [
          { summary: "Recalled prior preference.", sources: [memorySource, noteSource], data: {} },
          {
            summary: "Memory operation acknowledged.",
            sources,
            data: {},
            invalidatedSources: [{ kind: "memory", id: memoryId }],
          },
        ],
        rejectedSources: [memorySource],
      });
      await worker.dispatch("/start");
      await worker.settled();
      assert.equal(worker.status(), "succeeded");
      const completion = completionSchema.parse(worker.completions[0]);
      assert.deepEqual(completion.sources, [noteSource, ...sources]);
      assert.deepEqual(completion.tools[0]?.sources, [noteSource]);
      assert.deepEqual(completion.tools[1]?.sources, sources);
      assert.equal(worker.toolCalls.length, 2);
      assert.equal(worker.modelCalls.length, 3);
    },
  );
}

void test(
  "an acknowledged mutation cannot erase an unrelated source conflict",
  { timeout: 30_000 },
  async (t) => {
    const worker = fixture(t, {
      history: [historicalReply([memorySource, personSource])],
      tools: [
        { name: "memory_recall", input: { subjectId: null, query: "", limit: 10 } },
        {
          name: "memory_invalidate",
          input: { memoryId, expectedRevision: 1, reason: "Forget this." },
        },
      ],
      toolOutputs: [
        { summary: "Read current evidence.", sources: [memorySource, personSource], data: {} },
        {
          summary: "Memory invalidated.",
          sources: [],
          data: {},
          invalidatedSources: [{ kind: "memory", id: memoryId }],
        },
      ],
      rejectedSources: [personSource],
    });
    await worker.dispatch("/start");
    await worker.settled();
    assert.equal(worker.status(), "failed");
    assert.deepEqual(completionSchema.parse(worker.completions[0]).sources, [personSource]);
    assert.equal(worker.completions.length, 1);
  },
);
