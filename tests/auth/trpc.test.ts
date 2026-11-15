import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { build } from "esbuild";
import type { Principal } from "../../src/contracts/workspace.ts";

type Backend = typeof import("../../src/server/trpc/context.ts") &
  typeof import("../../src/server/trpc/http.ts") &
  typeof import("../../src/server/trpc/router.ts") &
  typeof import("../../src/contracts/workspace.ts") &
  Pick<typeof import("../../src/auth/server.ts"), "AuthError">;

const origin = "https://voidnote.test";
const user: Principal = { id: "d0512bb8-a3a6-4114-a12e-113c17035db6", email: null };
const workspaceId = "c44a5492-f55a-44fc-925e-7c77e01bcb56";
const noteId = "538f976c-394c-4706-a01e-2af014b7409a";
const runId = "4ce501f0-7277-4788-bcff-57e7bcf5eb64";
let backend: Backend;
let authentications = 0;
let opened = 0;
let closed = 0;
let calls: { method: string; args: unknown[] }[] = [];
let authenticate: () => Promise<Principal>;
let repositoryResult: (method: string, args: unknown[]) => unknown;
const methods = [
  "ensureWorkspace",
  "listNotes",
  "getNote",
  "saveNote",
  "deleteNote",
  "listPeople",
  "getPerson",
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
  const url = new URL(`/api/trpc/${path}`, origin);
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
        export * from './src/contracts/workspace';
        export { AuthError } from './src/auth/server';
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
      if (name === "@/db/recording-repository")
        return { createRecordingRepository: () => repository };
      if (name === "@/db/transcript-correction-repository")
        return { createTranscriptCorrectionRepository: () => repository };
      if (name === "@/server/recording-api")
        return {
          recordingEnvironment: () => {
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
    authenticate = () => Promise.resolve(user);
    repositoryResult = (method) =>
      method === "ensureWorkspace"
        ? { id: workspaceId, name: "Workspace" }
        : { items: [], nextCursor: null };
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
    const body = (await response.json()) as ErrorBody[];
    assert.equal(body.length, 2);
    assert.ok(body.every((entry) => entry.error.data.domainCode === "unauthorized"));
    assert.equal(authentications, 1);
    assert.equal(opened, 0);
  });

  void it("rejects cross-origin mutations before auth or repository work", async () => {
    for (const headers of [{ origin: "https://evil.test" }, { "sec-fetch-site": "cross-site" }]) {
      const response = await handle(request("notes.delete", { workspaceId }, true, headers));
      assert.equal(response.status, 403);
      assert.equal(((await response.json()) as ErrorBody).error.data.domainCode, "forbidden");
    }
    assert.equal(authentications, 0);
    assert.equal(opened, 0);
  });

  void it("preserves repository conflict metadata and closes failed operations", async () => {
    repositoryResult = () => {
      throw new backend.WorkspaceError("conflict", "Newer correction exists.", 7, [noteId]);
    };
    const response = await handle(request("notes.get", { workspaceId, id: noteId }));
    assert.equal(response.status, 409);
    const body = (await response.json()) as ErrorBody;
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
    assert.equal(
      ((await unavailable.json()) as ErrorBody).error.data.domainCode,
      "auth_unavailable",
    );
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
});
