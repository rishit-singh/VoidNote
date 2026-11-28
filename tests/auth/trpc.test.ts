import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { build } from "esbuild";
import type { CorrectionResult } from "../../src/contracts/transcript-corrections.ts";
import type { Principal } from "../../src/contracts/workspace.ts";
import type { AnalysisJob } from "../../src/contracts/analysis/index.ts";
import type { AssistantOutputScope } from "../../src/contracts/assistant/index.ts";

type Backend = typeof import("../../src/server/trpc/context.ts") &
  typeof import("../../src/ai/runtime/index.ts") &
  typeof import("../../src/server/trpc/http.ts") &
  typeof import("../../src/server/trpc/router.ts") &
  typeof import("../../src/contracts/workspace.ts") &
  Pick<typeof import("../../src/auth/server.ts"), "AuthError"> & {
    correctionsPOST: typeof import("../../src/app/api/workspaces/[workspaceId]/notes/[noteId]/processing/[runId]/corrections/route.ts").POST;
  };

const origin = "https://voidnote.test";
const user: Principal = { id: "d0512bb8-a3a6-4114-a12e-113c17035db6", email: null };
const workspaceId = "c44a5492-f55a-44fc-925e-7c77e01bcb56";
const noteId = "538f976c-394c-4706-a01e-2af014b7409a";
const runId = "4ce501f0-7277-4788-bcff-57e7bcf5eb64";
const correctionResult: CorrectionResult = {
  receipt: {
    id: "68db2ed6-b6b3-4e1a-a76d-a2a3f9cdc144",
    commandId: "6500f063-9be1-4c8e-9ace-c51c8a27a674",
    kind: "split",
    affectedCount: 1,
    createdAt: "2026-11-14T12:00:00.000Z",
    undoOf: null,
  },
  current: {
    items: [
      {
        id: "e620bb2c-5679-49fa-b2b8-345487462b5c",
        runId,
        recordingId: "7a020399-0666-4f7a-944c-05b8d3c14931",
        sequence: 0,
        orderKey: "01",
        sourceUtteranceId: noteId,
        parentId: noteId,
        revision: 4,
        attributionRevision: 2,
        startSeconds: 1,
        endSeconds: 2,
        text: "Current corrected speech",
        speakerLabel: "SPEAKER_00",
        assignment: { kind: "unknown" },
        assignmentSource: "manual",
        personName: null,
        reviewState: "confirmed",
        providerScore: null,
        sampleSuitability: "invalidated",
        originalText: "Original source speech",
        originalStartSeconds: 0,
        originalEndSeconds: 3,
      },
    ],
    removed: [{ id: noteId, revision: 3, attributionRevision: 2 }],
    complete: true,
  },
};
let backend: Backend;
let authentications = 0;
let opened = 0;
let closed = 0;
let calls: { method: string; args: unknown[] }[] = [];
let authenticate: () => Promise<Principal>;
let repositoryResult: (method: string, args: unknown[]) => unknown;
let summaryEnabled = true;
let summaryNotifications: { workspaceId: string; jobId: string; cancel: boolean }[] = [];
let evidenceReads = 0;
let assistantLeaseCalls: { principal: Principal; scope: AssistantOutputScope }[] = [];
let mintAssistantOutputLease: (
  principal: Principal,
  scope: AssistantOutputScope,
) => Promise<{ ticket: string; expiresAt: string }>;
const assistantOutputScope: AssistantOutputScope = {
  workspaceId,
  threadId: "116909d2-a678-4b5b-82d1-49e65368f9e9",
  turnId: "e620bb2c-5679-49fa-b2b8-345487462b5c",
};
const assistantOutputLease = {
  ticket: "a".repeat(64),
  expiresAt: "2026-11-25T12:00:30.000Z",
};

function unexpectedRuntimeService(): never {
  throw new Error("Unexpected application runtime service access in auth fixture.");
}

const summaryJob: AnalysisJob = {
  id: "116909d2-a678-4b5b-82d1-49e65368f9e9",
  commandId: "116909d2-a678-4b5b-82d1-49e65368f9e9",
  noteId,
  status: "queued",
  source: {
    noteId,
    runId,
    recordingId: "7a020399-0666-4f7a-944c-05b8d3c14931",
    generation: 1,
  },
  resultId: null,
  error: null,
  createdAt: "2026-11-22T00:00:00.000Z",
  updatedAt: "2026-11-22T00:00:00.000Z",
};
const savedEvidence = {
  snapshotId: summaryJob.id,
  source: summaryJob.source,
  passages: [
    {
      evidenceId: summaryJob.id,
      segmentId: summaryJob.id,
      segmentRevision: 0,
      attributionRevision: 0,
      sourceUtteranceId: summaryJob.id,
      sequence: 0,
      orderKey: "",
      providerTrackId: "SPEAKER_00",
      assignment: { kind: "unassigned" },
      text: "Send the proposal.",
      startSeconds: 0,
      endSeconds: 1,
    },
  ],
};
const methods = [
  "ensureWorkspace",
  "listNotes",
  "getNote",
  "saveNote",
  "deleteNote",
  "listPeople",
  "getPerson",
  "getSelfProfile",
  "createSelfProfile",
  "linkSelfProfile",
  "savePerson",
  "deletePerson",
  "history",
  "appearances",
  "overview",
  "initialize",
  "transcript",
  "command",
  "targets",
];
const repository = Object.fromEntries(
  methods.map((method) => [
    method,
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return await Promise.resolve(repositoryResult(method, args));
    },
  ]),
);

function request(
  path: string,
  input?: unknown,
  mutation = false,
  headers: Record<string, string> = {},
) {
  const url = new URL(`/api/${path}`, origin);
  if (!mutation && input !== undefined) url.searchParams.set("input", JSON.stringify(input));
  return new Request(
    url,
    mutation
      ? {
          method: "POST",
          headers: { "content-type": "application/json", origin, ...headers },
          body: JSON.stringify(input),
        }
      : { headers },
  );
}

async function handle(req: Request) {
  const response = await backend.handleTRPCRequest(req, backend.appRouter, (request) =>
    backend.createTRPCContext(request, async () => {
      authentications++;
      return authenticate();
    }),
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return response;
}

type ErrorBody = {
  error: {
    message: string;
    data: {
      code: string;
      domainCode: string;
      currentRevision?: number;
      affectedTargets?: string[];
      stack?: string;
    };
  };
};

void describe("tRPC request boundary", { concurrency: false }, () => {
  before(async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const result = await build({
      stdin: {
        resolveDir: root,
        contents: `
        export * from './src/server/trpc/context';
        export * from './src/server/trpc/http';
        export * from './src/server/trpc/router';
        export * from './src/ai/runtime';
        export * from './src/contracts/workspace';
        export { AuthError } from './src/auth/server';
        export { POST as correctionsPOST } from './src/app/api/workspaces/[workspaceId]/notes/[noteId]/processing/[runId]/corrections/route';
      `,
      },
      tsconfig: `${root}tsconfig.json`,
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      packages: "external",
      plugins: [
        {
          name: "database-boundary",
          setup(build) {
            build.onResolve({ filter: /^@\/db\// }, (args) => ({
              path: args.path,
              external: true,
            }));
            build.onResolve({ filter: /^@\/server\/recording-api$/ }, (args) => ({
              path: args.path,
              external: true,
            }));
            // Keep real routers/auth contracts, replacing only runtime composition.
            build.onResolve(
              {
                filter:
                  /^@\/server\/(?:analysis|assistant|research|research-runs|activity|connectors)$/,
              },
              (args) => ({
                path: args.path,
                external: true,
              }),
            );
            build.onResolve({ filter: /^@\/server\/transcript-correction-api$/ }, (args) => ({
              path: args.path,
              external: true,
            }));
          },
        },
      ],
    });
    const output = result.outputFiles[0];
    assert.ok(output);
    const bundledModule: { exports: unknown } = { exports: {} };
    const require = createRequire(import.meta.url);
    const load = (name: string): unknown => {
      if (name === "server-only") return {};
      if (name === "@/db/client")
        return {
          withDatabase: async (work: (db: object) => Promise<unknown>) => {
            opened++;
            try {
              return await work({});
            } finally {
              closed++;
            }
          },
        };
      if (name === "@/db/repository") return { createWorkspaceRepository: () => repository };
      if (name === "@/db/assistant") {
        return { createAssistantRepository: unexpectedRuntimeService };
      }
      if (name === "@/db/activity") {
        return {
          createActivityRepository: () => ({
            list: (...args: unknown[]) => {
              calls.push({ method: "activity.list", args });
              return Promise.resolve({ items: [], nextCursor: null, unreadCount: 0 });
            },
            changes: (...args: unknown[]) => {
              calls.push({ method: "activity.changes", args });
              return Promise.resolve({ items: [], cursor: "0", hasMore: false });
            },
            markRead: (...args: unknown[]) => {
              calls.push({ method: "activity.markRead", args });
              return Promise.resolve({ acknowledged: true });
            },
          }),
        };
      }
      if (name === "@/server/activity") {
        return {
          notifyApplicationEvents: () => {},
          createActivitySubscription: unexpectedRuntimeService,
        };
      }
      if (name === "@/server/connectors") {
        return {
          getSlackConnectorStatus: unexpectedRuntimeService,
          createSlackConnection: unexpectedRuntimeService,
          shareSavedBrief: unexpectedRuntimeService,
        };
      }
      if (name === "@/db/conversation-summaries") {
        return {
          createConversationSummaryRepository: () => ({
            latest: (...args: unknown[]) => {
              calls.push({ method: "conversationSummary.latest", args });
              return Promise.resolve(null);
            },
          }),
        };
      }
      if (name === "@/db/inference") {
        return { createInferenceRepository: unexpectedRuntimeService };
      }
      if (name === "@/db/contacts") {
        return { createContactRepository: unexpectedRuntimeService };
      }
      if (name === "@/server/assistant") {
        return {
          assistantPolicy: unexpectedRuntimeService,
          notifyAssistantTurn: unexpectedRuntimeService,
          createAssistantOutputLease: (principal: Principal, scope: AssistantOutputScope) => {
            assistantLeaseCalls.push({ principal, scope });
            return mintAssistantOutputLease(principal, scope);
          },
        };
      }
      if (name === "@/server/research-runs") {
        return {
          requestResearchRun: unexpectedRuntimeService,
          readResearchRun: unexpectedRuntimeService,
          listResearchRuns: unexpectedRuntimeService,
          cancelResearchRun: unexpectedRuntimeService,
        };
      }
      if (name === "@/server/research") {
        return {
          researchPolicy: unexpectedRuntimeService,
          requestContactResearch: unexpectedRuntimeService,
          readContactResearch: unexpectedRuntimeService,
          listContactResearch: unexpectedRuntimeService,
          cancelContactResearch: unexpectedRuntimeService,
          retryContactResearch: unexpectedRuntimeService,
        };
      }
      if (name === "@/db/analysis") {
        return {
          createAnalysisRepository: () =>
            Object.fromEntries(
              ["request", "get", "result", "cancel", "evidence"].map((method) => [
                method,
                async (...args: unknown[]) => {
                  calls.push({ method: `analysis.${method}`, args });
                  return await Promise.resolve(repositoryResult(`analysis.${method}`, args));
                },
              ]),
            ),
        };
      }
      if (name === "@/server/analysis") {
        return {
          traceSummaryAcceptance: (
            _workspaceId: string,
            _commandId: string,
            work: () => Promise<unknown>,
          ) => work(),
          analysisPolicy: () => {
            if (!summaryEnabled) {
              return null;
            }
            return backend.summaryPolicy("@cf/test/model");
          },
          notifySummaryJob: (workspaceId: string, jobId: string, cancel = false) => {
            summaryNotifications.push({ workspaceId, jobId, cancel });
          },
          summaryEvidence: (scope: string, id: string) => {
            assert.equal(scope, workspaceId);
            assert.equal(id, summaryJob.id);
            evidenceReads++;
            return savedEvidence;
          },
        };
      }
      if (name === "@/db/recording-repository")
        return { createRecordingRepository: () => repository };
      if (name === "@/db/transcript-correction-repository")
        return { createTranscriptCorrectionRepository: () => repository };
      // Exercise the REST route's real input/output validation and serialization;
      // its authenticated repository boundary is replaced just like tRPC's DB.
      if (name === "@/server/transcript-correction-api")
        return {
          transcriptCorrectionResponse: async (
            _request: Request,
            _workspaceId: string,
            work: (repo: typeof repository, principal: Principal) => Promise<unknown>,
          ) => Response.json(await work(repository, user)),
        };
      if (name === "@/server/recording-api")
        return {
          processingEnvironment: () => {
            throw new Error("Unexpected provider access");
          },
        };
      return require(name) as unknown;
    };
    const evaluate = compileFunction(output.text, ["module", "exports", "require"]) as (
      module: { exports: unknown },
      exports: unknown,
      require: (name: string) => unknown,
    ) => void;
    evaluate(bundledModule, bundledModule.exports, load);
    backend = bundledModule.exports as Backend;
  });

  beforeEach(() => {
    authentications = opened = closed = 0;
    calls = [];
    summaryEnabled = true;
    summaryNotifications = [];
    evidenceReads = 0;
    assistantLeaseCalls = [];
    mintAssistantOutputLease = () => Promise.resolve(assistantOutputLease);
    authenticate = () => Promise.resolve(user);
    repositoryResult = (method) =>
      method === "ensureWorkspace"
        ? { id: workspaceId, name: "Workspace" }
        : { items: [], nextCursor: null };
  });

  void it("authenticates self-profile reads and mutations with strict public inputs", async () => {
    repositoryResult = () => null;
    const get = await handle(request("selfProfile.get", { workspaceId }));
    assert.equal(get.status, 200);
    assert.deepEqual(calls[0], { method: "getSelfProfile", args: [user, workspaceId] });
    const record = {
      workspaceId,
      id: noteId,
      displayName: "Me",
      description: "",
      revision: 1,
      createdAt: "2026-11-26T00:00:00.000Z",
      updatedAt: "2026-11-26T00:00:00.000Z",
      deletedAt: null,
    };
    repositoryResult = () => record;
    const create = { workspaceId, commandId: runId, displayName: "Me" };
    assert.equal((await handle(request("selfProfile.create", create, true))).status, 200);
    assert.deepEqual(calls.at(-1), { method: "createSelfProfile", args: [user, create] });
    const link = {
      workspaceId,
      commandId: runId,
      personId: noteId,
      expectedRevision: 1,
      expectedSelfId: null,
    };
    assert.equal((await handle(request("selfProfile.link", link, true))).status, 200);
    assert.deepEqual(calls.at(-1), { method: "linkSelfProfile", args: [user, link] });
    const count = calls.length;
    assert.equal(
      (await handle(request("selfProfile.link", { ...link, accountId: user.id }, true))).status,
      400,
    );
    assert.equal(calls.length, count);
    authenticate = () =>
      Promise.reject(new backend.AuthError("unauthorized", "Sign in to continue.", 401));
    assert.equal((await handle(request("selfProfile.get", { workspaceId }))).status, 401);
    assert.equal(calls.length, count);
  });

  void it("deduplicates verified identity within a batch, isolates requests, and closes each database operation", async () => {
    const batch = request("workspace.session,notes.list", { 1: { workspaceId } });
    const url = new URL(batch.url);
    url.searchParams.set("batch", "1");
    const response = await handle(new Request(url));
    assert.equal(response.status, 200);
    assert.equal(authentications, 1);
    assert.equal(opened, 2);
    assert.equal(closed, 2);
    assert.deepEqual(calls[1], {
      method: "listNotes",
      args: [user, workspaceId, { workspaceId, q: "", limit: 30 }],
    });
    const nextUser = { ...user, id: noteId };
    authenticate = () => Promise.resolve(nextUser);
    await handle(request("workspace.session"));
    assert.equal(authentications, 2);
    assert.deepEqual(calls[2]?.args[0], nextUser);
  });

  void it("deduplicates rejected auth and does not open a database for unauthenticated calls", async () => {
    authenticate = () =>
      Promise.reject(new backend.AuthError("unauthorized", "Sign in to continue.", 401));
    const url = new URL(request("workspace.session,workspace.session").url);
    url.searchParams.set("batch", "1");
    const response = await handle(new Request(url));
    assert.equal(response.status, 401);
    const body = await response.json<ErrorBody[]>();
    assert.equal(body.length, 2);
    assert.ok(body.every((entry) => entry.error.data.domainCode === "unauthorized"));
    assert.equal(authentications, 1);
    assert.equal(opened, 0);
  });

  void it("rejects unauthenticated research run requests and reads before runtime services", async () => {
    authenticate = () =>
      Promise.reject(new backend.AuthError("unauthorized", "Sign in to continue.", 401));
    const requests = [
      request(
        "researchRuns.request",
        { workspaceId, commandId: runId, question: "What evidence supports this claim?" },
        true,
      ),
      request("researchRuns.get", { workspaceId, runId }),
      request("researchRuns.list", { workspaceId }),
    ];
    for (const req of requests) {
      const response = await handle(req);
      assert.equal(response.status, 401);
      assert.equal((await response.json<ErrorBody>()).error.data.domainCode, "unauthorized");
    }
    assert.equal(authentications, requests.length);
    assert.equal(opened, 0);
    assert.deepEqual(calls, []);
  });

  void it("rejects cross-origin mutations before auth or repository work", async () => {
    for (const headers of [{ origin: "https://evil.test" }, { "sec-fetch-site": "cross-site" }]) {
      const response = await handle(request("notes.delete", { workspaceId }, true, headers));
      assert.equal(response.status, 403);
      assert.equal((await response.json<ErrorBody>()).error.data.domainCode, "forbidden");
    }
    assert.equal(authentications, 0);
    assert.equal(opened, 0);
  });

  void it("authorizes derived summary reads with the verified principal and strict thread scope", async () => {
    const scope = { workspaceId, threadId: assistantOutputScope.threadId };
    const verified = { ...user, id: noteId };
    authenticate = () => Promise.resolve(verified);
    const response = await handle(request("assistant.conversationSummary", scope));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: { data: null } });
    assert.deepEqual(calls, [
      {
        method: "conversationSummary.latest",
        args: [verified, scope.workspaceId, scope.threadId],
      },
    ]);
    assert.equal(opened, closed);
    assert.equal(
      (await handle(request("assistant.conversationSummary", { ...scope, actorId: user.id })))
        .status,
      400,
    );
    authenticate = () =>
      Promise.reject(new backend.AuthError("unauthorized", "Sign in to continue.", 401));
    assert.equal((await handle(request("assistant.conversationSummary", scope))).status, 401);
    assert.equal(calls.length, 1);
  });

  void it("scopes activity reads to verified identity and rejects caller-selected recipients", async () => {
    const verified = { ...user, id: noteId };
    authenticate = () => Promise.resolve(verified);
    const response = await handle(request("activity.list", { workspaceId, limit: 20 }));
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      {
        method: "activity.list",
        args: [verified, workspaceId, undefined, 20],
      },
    ]);
    assert.equal(
      (await handle(request("activity.list", { workspaceId, userId: user.id }))).status,
      400,
    );
    assert.equal(calls.length, 1);
  });

  void it("rejects unauthenticated or cross-origin activity tickets before minting", async () => {
    const response = await handle(
      request("activity.subscribe", { workspaceId }, true, {
        origin: "https://evil.test",
      }),
    );
    assert.equal(response.status, 403);
    assert.equal(authentications, 0);
    authenticate = () =>
      Promise.reject(new backend.AuthError("unauthorized", "Sign in to continue.", 401));
    assert.equal((await handle(request("activity.subscribe", { workspaceId }, true))).status, 401);
    assert.equal(opened, 0);
  });

  void it("never mints an assistant output lease for unauthenticated requests", async () => {
    authenticate = () =>
      Promise.reject(new backend.AuthError("unauthorized", "Sign in to continue.", 401));
    const response = await handle(request("assistant.outputLease", assistantOutputScope, true));
    assert.equal(response.status, 401);
    assert.equal((await response.json<ErrorBody>()).error.data.domainCode, "unauthorized");
    assert.equal(authentications, 1);
    assert.deepEqual(assistantLeaseCalls, []);
    assert.equal(opened, 0);
  });

  void it("rejects cross-origin assistant output leases before authentication or minting", async () => {
    for (const headers of [{ origin: "https://evil.test" }, { "sec-fetch-site": "cross-site" }]) {
      const response = await handle(
        request("assistant.outputLease", assistantOutputScope, true, headers),
      );
      assert.equal(response.status, 403);
      assert.equal((await response.json<ErrorBody>()).error.data.domainCode, "forbidden");
    }
    assert.equal(authentications, 0);
    assert.deepEqual(assistantLeaseCalls, []);
    assert.equal(opened, 0);
  });

  void it("passes only the verified principal and validated scope to output-lease minting", async () => {
    const verified = { ...user, id: noteId };
    authenticate = () => Promise.resolve(verified);
    const response = await handle(request("assistant.outputLease", assistantOutputScope, true));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: { data: assistantOutputLease } });
    assert.deepEqual(assistantLeaseCalls, [{ principal: verified, scope: assistantOutputScope }]);
    assert.equal(authentications, 1);

    for (const input of [
      { ...assistantOutputScope, actorId: user.id },
      { ...assistantOutputScope, turnId: "not-a-turn-id" },
    ]) {
      assert.equal((await handle(request("assistant.outputLease", input, true))).status, 400);
    }
    assert.equal(assistantLeaseCalls.length, 1);
    assert.equal(opened, 0);
  });

  void it("preserves output-lease service authorization failures and rejects invalid lease output", async () => {
    mintAssistantOutputLease = () => {
      throw new backend.WorkspaceError("forbidden", "Thread access denied.");
    };
    const denied = await handle(request("assistant.outputLease", assistantOutputScope, true));
    assert.equal(denied.status, 403);
    assert.equal((await denied.json<ErrorBody>()).error.data.domainCode, "forbidden");
    mintAssistantOutputLease = () =>
      Promise.resolve({ ...assistantOutputLease, ticket: "private-invalid-ticket" });
    const invalid = await handle(request("assistant.outputLease", assistantOutputScope, true));
    assert.equal(invalid.status, 500);
    assert.doesNotMatch(await invalid.text(), /private-invalid-ticket|stack/);
  });

  void it("serves the authenticated overview contract and rejects unauthenticated access", async () => {
    const overview = {
      notes: 7,
      profiles: 2,
      recordings: 3,
      recordedSeconds: 125.5,
      recentRecordings: [],
    };
    repositoryResult = () => ({ ...overview, privateField: "must not escape" });
    const response = await handle(request("workspace.overview", { workspaceId }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: { data: overview } });
    assert.deepEqual(calls, [{ method: "overview", args: [user, workspaceId] }]);
    assert.equal(opened, closed);
    authenticate = () => Promise.reject(new backend.AuthError("unauthorized", "Sign in.", 401));
    const denied = await handle(request("workspace.overview", { workspaceId }));
    assert.equal(denied.status, 401);
    assert.equal(calls.length, 1);
  });

  void it("accepts an authorized summary and only notifies after durable acceptance", async () => {
    repositoryResult = () => {
      assert.deepEqual(summaryNotifications, []);
      return summaryJob;
    };
    const command = { commandId: summaryJob.commandId, noteId };
    const response = await handle(request("summaries.request", { workspaceId, command }, true));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: { data: { job: summaryJob } } });
    assert.deepEqual(calls[0]?.args.slice(0, 3), [user, workspaceId, command]);
    assert.deepEqual(summaryNotifications, [{ workspaceId, jobId: summaryJob.id, cancel: false }]);
    assert.equal(opened, closed);
  });

  void it("replays terminal summary acceptance without restarting inference", async () => {
    summaryEnabled = false;
    const failed = { ...summaryJob, status: "failed", error: "Generation interrupted." };
    repositoryResult = () => failed;
    const response = await handle(
      request(
        "summaries.request",
        { workspaceId, command: { commandId: summaryJob.commandId, noteId } },
        true,
      ),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: { data: { job: failed } } });
    assert.deepEqual(summaryNotifications, []);
  });

  void it("fences summary cancellation in persistence before notifying the runtime", async () => {
    repositoryResult = () => {
      assert.deepEqual(summaryNotifications, []);
      return { ...summaryJob, status: "cancelled" };
    };
    const response = await handle(
      request("summaries.cancel", { workspaceId, jobId: summaryJob.id }, true),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      { method: "analysis.cancel", args: [user, workspaceId, summaryJob.id] },
    ]);
    assert.deepEqual(summaryNotifications, [{ workspaceId, jobId: summaryJob.id, cancel: true }]);
  });

  void it("authorizes historical evidence before reading private snapshots", async () => {
    repositoryResult = () => {
      assert.equal(evidenceReads, 0);
      return {};
    };
    const input = { workspaceId, jobId: summaryJob.id };
    const response = await handle(request("summaries.evidence", input));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: { data: savedEvidence } });
    assert.deepEqual(calls[0], {
      method: "analysis.evidence",
      args: [user, workspaceId, summaryJob.id],
    });
    assert.equal(evidenceReads, 1);

    repositoryResult = () => {
      throw new backend.WorkspaceError("forbidden", "Workspace access denied.");
    };
    assert.equal((await handle(request("summaries.evidence", input))).status, 403);
    assert.equal(evidenceReads, 1);
  });

  void it("does not admit summaries without auth, cross-origin permission or enabled policy", async () => {
    const input = { workspaceId, command: { commandId: summaryJob.commandId, noteId } };
    const crossOrigin = await handle(
      request("summaries.request", input, true, { origin: "https://evil.test" }),
    );
    assert.equal(crossOrigin.status, 403);
    authenticate = () => Promise.reject(new backend.AuthError("unauthorized", "Sign in.", 401));
    assert.equal((await handle(request("summaries.request", input, true))).status, 401);
    authenticate = () => Promise.resolve(user);
    summaryEnabled = false;
    repositoryResult = (_method, args) => {
      assert.equal(args[3], null);
      throw new backend.WorkspaceError("conflict", "Summary generation is not enabled.");
    };
    assert.equal((await handle(request("summaries.request", input, true))).status, 409);
    assert.equal(opened, 1);
    assert.deepEqual(summaryNotifications, []);
  });

  void it("preserves repository conflict metadata and closes failed operations", async () => {
    repositoryResult = () => {
      throw new backend.WorkspaceError("conflict", "Newer correction exists.", 7, [noteId]);
    };
    const response = await handle(request("notes.get", { workspaceId, id: noteId }));
    assert.equal(response.status, 409);
    const body = await response.json<ErrorBody>();
    assert.equal(body.error.data.code, "CONFLICT");
    assert.equal(body.error.data.domainCode, "conflict");
    assert.equal(body.error.data.currentRevision, 7);
    assert.deepEqual(body.error.data.affectedTargets, [noteId]);
    assert.equal(body.error.data.stack, undefined);
    assert.equal(opened, 1);
    assert.equal(closed, 1);
  });

  void it("maps auth outages separately and hides unexpected exception details", async () => {
    authenticate = () =>
      Promise.reject(
        new backend.AuthError("auth_unavailable", "Sign-in is temporarily unavailable.", 503),
      );
    const unavailable = await handle(request("workspace.session"));
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json<ErrorBody>()).error.data.domainCode, "auth_unavailable");
    authenticate = () => Promise.resolve(user);
    repositoryResult = () => {
      throw new Error("postgres credentials/private query");
    };
    const failed = await handle(request("workspace.session"));
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /credentials|private query|stack/);
    assert.equal(opened, closed);
  });

  void it("bounds streamed body bytes, URL input, and batch work before authentication", async () => {
    const large = await handle(
      request("notes.save", "x".repeat(backend.MAX_TRPC_BODY_BYTES), true),
    );
    assert.equal(large.status, 413);
    const longUrl = await handle(request("notes.list", { q: "x".repeat(65_536) }));
    assert.equal(longUrl.status, 413);
    const batch = new URL(
      request(
        Array(backend.MAX_TRPC_BATCH_SIZE + 1)
          .fill("workspace.session")
          .join(","),
      ).url,
    );
    batch.searchParams.set("batch", "1");
    assert.equal((await handle(new Request(batch))).status, 400);
    assert.equal(authentications, 0);
    assert.equal(opened, 0);
  });

  void it("validates targets and forwards only repository target filters with the verified scope", async () => {
    const input = {
      workspaceId,
      noteId,
      runId,
      startSeconds: 1,
      endSeconds: 4,
      includeManual: true,
    };
    repositoryResult = () => ({ targets: [], excludedManualCount: 0 });
    assert.equal((await handle(request("transcripts.targets", input))).status, 200);
    assert.deepEqual(calls[0], {
      method: "targets",
      args: [
        user,
        workspaceId,
        noteId,
        runId,
        { startSeconds: 1, endSeconds: 4, includeManual: true },
      ],
    });
    assert.equal(
      (await handle(request("transcripts.targets", { ...input, speakerLabel: "SPEAKER_1" })))
        .status,
      400,
    );
    assert.equal(calls.length, 1);
  });

  void it("serializes current correction rows, ordering and revision-bearing removals through tRPC and REST", async () => {
    const command = {
      kind: "assign",
      commandId: correctionResult.receipt.commandId,
      targets: [{ id: noteId, expectedAttributionRevision: 0 }],
      assignment: { kind: "unknown" },
    };
    repositoryResult = () => ({
      ...correctionResult,
      receipt: { ...correctionResult.receipt, fingerprint: "private command fingerprint" },
      current: {
        ...correctionResult.current,
        items: correctionResult.current.items.map((turn) => ({
          ...turn,
          active: true,
          workspaceId,
        })),
      },
    });
    const response = await handle(
      request("transcripts.command", { workspaceId, noteId, runId, command }, true),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: { data: correctionResult } });
    assert.deepEqual(calls[0], {
      method: "command",
      args: [user, workspaceId, noteId, runId, command],
    });
    const rest = await backend.correctionsPOST(
      request(
        `workspaces/${workspaceId}/notes/${noteId}/processing/${runId}/corrections`,
        command,
        true,
      ),
      { params: Promise.resolve({ workspaceId, noteId, runId }) },
    );
    assert.equal(rest.status, 200);
    assert.deepEqual(await rest.json(), correctionResult);
    assert.deepEqual(calls[1], calls[0]);
  });

  void it("preserves successful receipt-only fallback and rejects current rows missing their ordering key", async () => {
    const input = {
      workspaceId,
      noteId,
      runId,
      command: {
        kind: "undo",
        commandId: correctionResult.receipt.commandId,
        correctionId: correctionResult.receipt.id,
      },
    };
    const incomplete = {
      receipt: correctionResult.receipt,
      current: { items: [], removed: [], complete: false },
    };
    repositoryResult = () => incomplete;
    const fallback = await handle(request("transcripts.command", input, true));
    assert.equal(fallback.status, 200);
    assert.deepEqual(await fallback.json(), { result: { data: incomplete } });
    repositoryResult = () => ({
      ...correctionResult,
      current: {
        ...correctionResult.current,
        items: correctionResult.current.items.map((turn) => ({ ...turn, orderKey: undefined })),
      },
    });
    const invalid = await handle(request("transcripts.command", input, true));
    assert.equal(invalid.status, 500);
    assert.equal((await invalid.json<ErrorBody>()).error.data.domainCode, "internal_error");
  });

  void it("exposes list metadata without transcript while retaining the full authorized detail", async () => {
    const note = {
      id: noteId,
      workspaceId,
      title: "Private transcript",
      transcript: "Source speech retained only in detail",
      revision: 2,
      createdAt: "2026-11-14T12:00:00.000Z",
      updatedAt: "2026-11-14T12:00:00.000Z",
      deletedAt: null,
    };
    repositoryResult = (method) =>
      method === "listNotes" ? { items: [note], nextCursor: null } : note;
    const list = await handle(request("notes.list", { workspaceId }));
    assert.equal(list.status, 200);
    const text = await list.text();
    assert.doesNotMatch(text, /"transcript"|Source speech/);
    const detail = await handle(request("notes.get", { workspaceId, id: noteId }));
    assert.equal(detail.status, 200);
    assert.deepEqual(await detail.json(), { result: { data: note } });
  });

  void it("returns bounded person previews and preserves full profile detail", async () => {
    const person = {
      id: noteId,
      workspaceId,
      displayName: "Profile",
      description: "Full description ".repeat(200),
      revision: 2,
      createdAt: "2026-11-14T12:00:00.000Z",
      updatedAt: "2026-11-14T12:00:00.000Z",
      deletedAt: null,
    };
    const descriptionPreview = person.description.slice(0, 160);
    repositoryResult = (method) =>
      method === "listPeople"
        ? { items: [{ ...person, descriptionPreview }], nextCursor: null }
        : person;
    const list = await handle(request("people.list", { workspaceId }));
    assert.equal(list.status, 200);
    const text = await list.text();
    assert.doesNotMatch(text, /"description":/);
    assert.ok(text.includes(descriptionPreview));
    const detail = await handle(request("people.get", { workspaceId, id: noteId }));
    assert.equal(detail.status, 200);
    assert.deepEqual(await detail.json(), { result: { data: person } });
  });
});
