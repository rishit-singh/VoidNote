import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { build } from "esbuild";
import type { Principal } from "../../src/contracts/workspace.ts";
import type { AppRouter } from "../../src/server/trpc/router.ts";

type Backend = typeof import("../../src/server/trpc/http.ts") &
  typeof import("../../src/server/trpc/router.ts") &
  typeof import("../../src/server/recording-api.ts") &
  typeof import("../../src/contracts/workspace.ts") &
  typeof import("../../src/lib/api-error.ts") &
  Pick<typeof import("../../src/auth/config.ts"), "AuthError"> &
  typeof import("@trpc/client") & {
    processingPOST: typeof import("../../src/app/api/workspaces/[workspaceId]/notes/[noteId]/processing/route.ts").POST;
    retryPOST: typeof import("../../src/app/api/workspaces/[workspaceId]/notes/[noteId]/processing/[runId]/retry/route.ts").POST;
  };

const origin = "https://voidnote.test";
const user: Principal = { id: "d0512bb8-a3a6-4114-a12e-113c17035db6", email: null };
const workspaceId = "c44a5492-f55a-44fc-925e-7c77e01bcb56";
const noteId = "538f976c-394c-4706-a01e-2af014b7409a";
const recordingId = "7a020399-0666-4f7a-944c-05b8d3c14931";
const runId = "4ce501f0-7277-4788-bcff-57e7bcf5eb64";
const command = { id: recordingId, recordingId };
const message =
  "Transcription is not configured for this environment. Uploaded audio remains available; retry after setup.";
const run = {
  id: runId,
  workspaceId,
  noteId,
  recordingId,
  status: "queued",
  providerJobId: null,
  error: null,
  createdAt: "2026-11-23T00:00:00.000Z",
  updatedAt: "2026-11-23T00:00:00.000Z",
};
let backend: Backend;
let env: Record<string, unknown>;
let envReads = 0;
let authentications = 0;
let opened = 0;
let closed = 0;
let workflowCalls = 0;
let calls: { method: string; args: unknown[] }[] = [];
let authenticate: () => Promise<Principal>;
let repositoryResult: (method: string) => unknown;
const repository = Object.fromEntries(
  ["requestProcessing", "dispatched", "overview"].map((method) => [
    method,
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(repositoryResult(method));
    },
  ]),
);

function unexpectedRuntimeService(): never {
  throw new Error("Unexpected application runtime service access in processing fixture.");
}

function post(path: string, input: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: requestOrigin },
    body: JSON.stringify(input),
  });
}

async function handle(request: Request) {
  const response = await backend.handleTRPCRequest(request, backend.appRouter);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return response;
}

async function start(transport: "tRPC" | "REST", requestOrigin = origin) {
  return transport === "tRPC"
    ? handle(post("processing.start", { workspaceId, noteId, command }, requestOrigin))
    : backend.processingPOST(
        post(`workspaces/${workspaceId}/notes/${noteId}/processing`, command, requestOrigin),
        { params: Promise.resolve({ workspaceId, noteId }) },
      );
}

async function assertUnavailable(response: Response, transport: "tRPC" | "REST") {
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  if (transport === "tRPC") {
    assert.deepEqual(body, {
      error: {
        message,
        code: -32603,
        data: {
          code: "SERVICE_UNAVAILABLE",
          httpStatus: 503,
          path: "processing.start",
          domainCode: "service_unavailable",
        },
      },
    });
  } else {
    assert.deepEqual(body, { error: message, code: "service_unavailable" });
  }
}

void describe("processing configuration boundary", { concurrency: false }, () => {
  before(async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const result = await build({
      stdin: {
        resolveDir: root,
        contents: `
          export * from './src/server/trpc/http';
          export * from './src/server/trpc/router';
          export * from './src/server/recording-api';
          export * from './src/contracts/workspace';
          export * from './src/lib/api-error';
          export { AuthError } from './src/auth/config';
          export { createTRPCClient, httpLink } from '@trpc/client';
          export { POST as processingPOST } from './src/app/api/workspaces/[workspaceId]/notes/[noteId]/processing/route';
          export { POST as retryPOST } from './src/app/api/workspaces/[workspaceId]/notes/[noteId]/processing/[runId]/retry/route';
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
          name: "runtime-boundaries",
          setup(build) {
            build.onResolve({ filter: /^(?:@\/|\.\.\/)(?:db\/|auth\/server$)/ }, (args) => ({
              path: args.path.replace(/^\.\.\//, "@/"),
              external: true,
            }));
            // The real routers stay bundled; provider/runtime composition does not.
            build.onResolve({ filter: /^@\/server\/(?:analysis|assistant|research)$/ }, (args) => ({
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
      if (name === "server-only" || name === "@/server/analysis") return {};
      if (name === "@/server/assistant") {
        return {
          assistantPolicy: unexpectedRuntimeService,
          notifyAssistantTurn: unexpectedRuntimeService,
          createAssistantOutputLease: unexpectedRuntimeService,
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
      if (name === "@opennextjs/cloudflare") {
        return {
          getCloudflareContext: () => {
            envReads++;
            return { env };
          },
        };
      }
      if (name === "@/auth/server") {
        return {
          get AuthError() {
            return backend.AuthError;
          },
          requirePrincipal: () => {
            authentications++;
            return authenticate();
          },
        };
      }
      if (name === "@/db/client") {
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
      }
      if (name.startsWith("@/db/")) {
        return {
          createWorkspaceRepository: () => repository,
          createRecordingRepository: () => repository,
          createTranscriptCorrectionRepository: () => repository,
          createAnalysisRepository: () => repository,
          createAssistantRepository: unexpectedRuntimeService,
          createInferenceRepository: unexpectedRuntimeService,
          createContactRepository: unexpectedRuntimeService,
        };
      }
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
    envReads = authentications = opened = closed = workflowCalls = 0;
    calls = [];
    authenticate = () => Promise.resolve(user);
    repositoryResult = (method) => (method === "overview" ? { runs: [run] } : run);
    env = {
      PYANNOTE_API_KEY: "synthetic-test-provider-key",
      RECORDING_CAPABILITY_SECRET: "synthetic-test-capability-secret-32",
      RECORDING_ARTIFACTS: {
        head() {},
        get() {},
        put() {},
      },
      PROCESS_RECORDING: {
        createBatch: (input: unknown) => {
          workflowCalls++;
          assert.equal(calls.at(-1)?.method, "requestProcessing");
          assert.deepEqual(input, {
            instances: [{ id: runId, params: { workspaceId, runId } }],
          });
          return Promise.resolve({ created: [{ id: runId }], errors: [] });
        },
        get() {
          workflowCalls++;
          throw new Error("Unexpected Workflow lookup");
        },
      },
    };
  });

  for (const transport of ["tRPC", "REST"] as const) {
    void it(`${transport} returns a safe 503 for missing/blank provider or invalid capability credentials before acceptance`, async () => {
      const configured = { ...env };
      for (const missing of [
        { PYANNOTE_API_KEY: undefined },
        { PYANNOTE_API_KEY: "" },
        { PYANNOTE_API_KEY: " \n\t " },
        { RECORDING_CAPABILITY_SECRET: undefined },
        { RECORDING_CAPABILITY_SECRET: "" },
        { RECORDING_CAPABILITY_SECRET: " ".repeat(40) },
        { RECORDING_CAPABILITY_SECRET: "too-short" },
        { PYANNOTE_API_KEY: undefined, RECORDING_CAPABILITY_SECRET: undefined },
      ]) {
        env = { ...configured, ...missing };
        await assertUnavailable(await start(transport), transport);
        assert.deepEqual(calls, []);
        assert.equal(workflowCalls, 0);
        assert.equal(opened, closed);
      }
    });

    void it(`${transport} keeps authentication and same-origin checks ahead of configuration`, async () => {
      env = {};
      authenticate = () =>
        Promise.reject(new backend.AuthError("unauthorized", "Sign in to continue.", 401));
      assert.equal((await start(transport, "https://evil.test")).status, 403);
      assert.equal(authentications, 0);
      assert.equal((await start(transport)).status, 401);
      assert.equal(authentications, 1);
      assert.equal(envReads, 0);
      assert.equal(opened, 0);
      assert.deepEqual(calls, []);
      assert.equal(workflowCalls, 0);
    });

    void it(`${transport} accepts the same command after configuration and dispatches only after acceptance`, async () => {
      const key = env.PYANNOTE_API_KEY;
      delete env.PYANNOTE_API_KEY;
      await assertUnavailable(await start(transport), transport);
      env.PYANNOTE_API_KEY = key;
      assert.equal((await start(transport)).status, 200);
      assert.deepEqual(calls, [
        { method: "requestProcessing", args: [user, workspaceId, noteId, recordingId, command.id] },
        { method: "dispatched", args: [workspaceId, runId] },
      ]);
      assert.equal(workflowCalls, 1);
      assert.equal(opened, closed);
    });

    void it(`${transport} retains repository authorization and sanitizes unexpected failures`, async () => {
      repositoryResult = () => {
        throw new backend.WorkspaceError("forbidden", "Workspace access denied.");
      };
      assert.equal((await start(transport)).status, 403);
      repositoryResult = () => {
        throw new Error("private provider credentials and database detail");
      };
      const response = await start(transport);
      assert.equal(response.status, 500);
      assert.doesNotMatch(await response.text(), /private provider|database detail|stack/);
      assert.equal(workflowCalls, 0);
      assert.equal(opened, closed);
    });
  }

  void it("preserves the 503 and actionable message through the real tRPC client adapter", async () => {
    delete env.PYANNOTE_API_KEY;
    const client = backend.createTRPCClient<AppRouter>({
      links: [
        backend.httpLink({
          url: `${origin}/api`,
          headers: { origin },
          fetch: (input, init) =>
            handle(new Request(input, { ...init, signal: init?.signal ?? null })),
        }),
      ],
    });
    await assert.rejects(
      backend.rpcCall(() => client.processing.start.mutate({ workspaceId, noteId, command })),
      (error: unknown) =>
        error instanceof backend.ApiError &&
        error.status === 503 &&
        error.code === "service_unavailable" &&
        error.message === message,
    );
  });

  void it("blocks retry dispatch without credentials after authorizing the existing run", async () => {
    delete env.PYANNOTE_API_KEY;
    const rpc = await handle(post("processing.retry", { workspaceId, noteId, runId }));
    const rest = await backend.retryPOST(
      post(`workspaces/${workspaceId}/notes/${noteId}/processing/${runId}/retry`, {}),
      { params: Promise.resolve({ workspaceId, noteId, runId }) },
    );
    assert.equal(rpc.status, 503);
    assert.equal(rest.status, 503);
    assert.deepEqual(calls, [
      { method: "overview", args: [user, workspaceId, noteId] },
      { method: "overview", args: [user, workspaceId, noteId] },
    ]);
    assert.equal(workflowCalls, 0);
    assert.equal(opened, closed);
  });

  void it("keeps upload binding validation independent of provider setup and strict about the capability secret", () => {
    delete env.PYANNOTE_API_KEY;
    assert.equal(backend.recordingEnvironment().RECORDING_ARTIFACTS, env.RECORDING_ARTIFACTS);
    delete env.RECORDING_CAPABILITY_SECRET;
    assert.throws(() => backend.recordingEnvironment(), { name: "ZodError" });
  });
});
