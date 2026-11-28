/// <reference lib="dom" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { build } from "esbuild";
import type { ProcessingRun, RecordingInput } from "../../src/contracts/recording-processing";
import type { LocalRecordingSession } from "../../src/lib/recording-schemas";

type Subject = typeof import("../../src/lib/recording-media") &
  Pick<
    typeof import("../../src/lib/recording-processing-client"),
    | "queueRecordingProcessing"
    | "submitRecordingProcessing"
    | "recordingProcessingView"
    | "watchProcessingQueue"
    | "useProcessingJobs"
  >;

void describe("recording MIME import and local retry (no database)", { concurrency: false }, () => {
  let subject: Subject;
  let local: LocalRecordingSession;
  let writes: LocalRecordingSession[];
  let commands: RecordingInput[];
  let uploads: Blob[];
  let processingIds: string[];
  let initializationLost: boolean;
  let processingLost: boolean;
  let beforeProcessingResponse: (() => void) | undefined;
  let beforeManifestWrite: (() => void) | undefined;
  let sessions: Record<string, LocalRecordingSession>;
  let remotelyReady: boolean;
  let videoMode: "audio" | "video" | "error";
  let released: number;
  let loaded: number;
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const scope = {
    user: { id: randomUUID() },
    workspace: { id: randomUUID() },
  };
  const noteId = randomUUID();
  let state = {
    epoch: 1,
    session: scope,
    ensureNote: async () => {},
  };
  const runtime = {
    scope: "test",
    identity: { userId: scope.user.id, workspaceId: scope.workspace.id, epoch: 1 },
    queryClient: { cancelQueries: async () => {} },
    trpc: { recordings: { overview: { queryFilter: () => ({}) } } },
    client: {
      recordings: {
        initialize: {
          mutate: ({ command }: { command: RecordingInput }) => {
            commands.push(command);
            if (initializationLost) return Promise.reject(new Error("Response lost"));
            return Promise.resolve({
              ...command,
              status: remotelyReady ? "ready" : "upload_pending",
            });
          },
        },
      },
      processing: {
        start: {
          mutate: ({ command }: { command: { id: string; recordingId: string } }) => {
            assert.equal(command.id, local.id);
            assert.equal(command.recordingId, local.id);
            processingIds.push(command.id);
            if (processingLost) return Promise.reject(new Error("Accepted response lost"));
            const run: ProcessingRun = {
              id: local.id,
              recordingId: local.id,
              workspaceId: local.workspaceId,
              noteId: local.noteId,
              status: "queued",
              providerJobId: null,
              error: null,
              createdAt: local.createdAt,
              updatedAt: local.updatedAt,
            };
            beforeProcessingResponse?.();
            return Promise.resolve(run);
          },
        },
      },
    },
  };
  class FakeMedia {
    duration = 310.54;
    videoWidth = 0;
    videoHeight = 0;
    onloadedmetadata: (() => void) | null = null;
    onloadeddata: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => {
        if (videoMode === "error") this.onerror?.();
        else {
          if (videoMode === "video") this.videoWidth = 1920;
          this.onloadedmetadata?.();
          this.onloadeddata?.();
        }
      });
    }
    removeAttribute() {}
    load() {
      loaded++;
    }
  }

  before(async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const mocks: Record<string, unknown> = {
      "@/lib/query-runtime": {
        getQueryRuntime: () => runtime,
        notifyQueryChange: async () => {},
      },
      "@/stores/use-note-store": {
        useNoteStore: { getState: () => state, subscribe: () => () => {} },
      },
      "@/stores/use-recording-store": {
        isOwnedSession: () => true,
        useRecordingStore: {
          getState: () => ({ sessions }),
          subscribe: () => () => {},
          setState: (
            update: (state: { sessions: typeof sessions }) => { sessions: typeof sessions },
          ) => {
            sessions = update({ sessions }).sessions;
          },
        },
      },
      "@/lib/idb-recordings": {
        getRecordingSession: (id: string) => {
          assert.equal(id, local.id);
          return Promise.resolve(structuredClone(local));
        },
        buildRecordingBlob: (id: string, mimeType: string) => {
          assert.equal(id, local.id);
          return Promise.resolve(new Blob([bytes], { type: mimeType }));
        },
        acknowledgeRecordingProcessing: (owner: LocalRecordingSession) => {
          assert.equal(owner.id, local.id);
          const session = { ...local, processing: "submitted" as const };
          writes.push(session);
          beforeManifestWrite?.();
          return Promise.resolve(session);
        },
      },
    };
    const result = await build({
      stdin: {
        resolveDir: root,
        contents: `
          export * from './src/lib/recording-media';
          export { queueRecordingProcessing, submitRecordingProcessing, recordingProcessingView, watchProcessingQueue, useProcessingJobs } from './src/lib/recording-processing-client';
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
          name: "local-recording-boundaries",
          setup(build) {
            build.onResolve({ filter: /^@\// }, ({ path }) =>
              path in mocks ? { path, external: true } : undefined,
            );
          },
        },
      ],
    });
    const output = result.outputFiles[0];
    assert.ok(output);
    const bundledModule: { exports: unknown } = { exports: {} };
    const require = createRequire(import.meta.url);
    const evaluate = compileFunction(output.text, [
      "require",
      "module",
      "exports",
      "document",
      "Audio",
      "navigator",
      "fetch",
      "URL",
      "window",
    ]) as (...args: unknown[]) => void;
    evaluate(
      (name: string): unknown => mocks[name] ?? (require(name) as unknown),
      bundledModule,
      bundledModule.exports,
      { createElement: () => new FakeMedia() },
      FakeMedia,
      {},
      (path: string, init: RequestInit) => {
        assert.equal(path.endsWith(`/recordings/${local.id}/audio`), true);
        assert.equal(new Headers(init.headers).get("Content-Type"), "audio/mp4");
        assert.ok(init.body instanceof Blob);
        uploads.push(init.body);
        return Promise.resolve(
          Response.json({
            ...commands.at(-1),
            workspaceId: local.workspaceId,
            noteId,
            status: "ready",
            createdAt: local.createdAt,
          }),
        );
      },
      {
        createObjectURL: (blob: Blob) => URL.createObjectURL(blob),
        revokeObjectURL: (url: string) => {
          released++;
          URL.revokeObjectURL(url);
        },
      },
      { addEventListener() {}, removeEventListener() {} },
    );
    subject = bundledModule.exports as Subject;
  });

  beforeEach(() => {
    local = {
      id: randomUUID(),
      noteId,
      userId: scope.user.id,
      workspaceId: scope.workspace.id,
      mimeType: "audio/x-m4a",
      source: "file",
      status: "finalized",
      processing: "pending",
      chunkCount: 1,
      byteCount: bytes.length,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writes = [];
    commands = [];
    uploads = [];
    processingIds = [];
    initializationLost = false;
    processingLost = false;
    beforeProcessingResponse = undefined;
    beforeManifestWrite = undefined;
    state = { ...state, epoch: 1 };
    sessions = { [local.id]: structuredClone(local) };
    subject.useProcessingJobs.setState({ jobs: {} });
    remotelyReady = false;
    videoMode = "audio";
    released = 0;
    loaded = 0;
  });

  void it("normalizes browser aliases but preserves every previously accepted wire type", () => {
    for (const [alias, canonical] of [
      ["audio/x-m4a", "audio/mp4"],
      ["audio/m4a", "audio/mp4"],
      ["audio/mp3", "audio/mpeg"],
      ["audio/x-mp3", "audio/mpeg"],
      ["audio/x-flac", "audio/flac"],
      [" Audio/X-M4A ; codecs=mp4a.40.2", "audio/mp4"],
    ]) {
      assert.equal(subject.recordingMimeType(alias!), canonical);
    }
    for (const type of [
      "audio/webm",
      "audio/ogg",
      "audio/mp4",
      "audio/mpeg",
      "audio/wav",
      "audio/flac",
      "audio/x-wav",
    ]) {
      assert.equal(subject.recordingMimeType(`${type};codecs=test`), type);
    }
    for (const type of [
      "video/mp4",
      "video/webm",
      "application/octet-stream",
      "audio/unknown",
      "",
    ]) {
      assert.throws(() => subject.recordingMimeType(type), /supported audio/);
    }
  });

  void it("accepts an audio-only MP4 only after playable browser data, and releases media", async () => {
    assert.equal(
      await subject.importedRecordingMimeType(new Blob([bytes], { type: "video/mp4" })),
      "audio/mp4",
    );
    assert.equal(released, 1);
    assert.equal(loaded, 1);
  });

  void it("imports m4a aliases under the canonical MIME before local persistence", async () => {
    for (const type of ["audio/x-m4a", "audio/m4a"]) {
      assert.equal(
        await subject.importedRecordingMimeType(new Blob([bytes], { type })),
        "audio/mp4",
      );
    }
    assert.equal(released, 0);
  });

  void it("rejects video tracks, decoding errors, empty files and other video containers", async () => {
    const file = new Blob([bytes], { type: "video/mp4" });
    videoMode = "video";
    await assert.rejects(subject.importedRecordingMimeType(file), /audio-only/);
    videoMode = "error";
    await assert.rejects(subject.importedRecordingMimeType(file), /cannot decode/);
    await assert.rejects(
      subject.importedRecordingMimeType(new Blob([], { type: "audio/mp4" })),
      /non-empty/,
    );
    await assert.rejects(
      subject.importedRecordingMimeType(new Blob([bytes], { type: "video/webm" })),
      /supported audio/,
    );
    assert.equal(released, 2);
    assert.equal(loaded, 2);
  });

  void it("retries a legacy m4a manifest with the same identity and bytes, without rewriting it", async () => {
    const original = structuredClone(local);
    await subject.queueRecordingProcessing(local.id);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.id, local.id);
    assert.equal(commands[0]?.mimeType, "audio/mp4");
    assert.equal(commands[0]?.bytes, bytes.length);
    assert.equal(uploads.length, 1);
    assert.deepEqual(new Uint8Array(await uploads[0]!.arrayBuffer()), bytes);
    assert.deepEqual(local, original);
    assert.deepEqual(writes, [{ ...original, processing: "submitted" }]);
    assert.deepEqual(processingIds, [local.id]);
  });

  void it("replays the exact initialization after a lost response and skips already-ready audio", async () => {
    initializationLost = true;
    await subject.queueRecordingProcessing(local.id);
    assert.equal(writes.length, 0);
    assert.equal(uploads.length, 0);
    assert.equal(processingIds.length, 0);
    initializationLost = false;
    remotelyReady = true;
    await subject.queueRecordingProcessing(local.id);
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[1], commands[0]);
    assert.equal(uploads.length, 0);
    assert.deepEqual(processingIds, [local.id]);
    assert.equal(writes.length, 1);
  });

  void it("leaves an unsupported legacy manifest intact without sending initialization", async () => {
    local.mimeType = "video/mp4";
    const original = structuredClone(local);
    await subject.queueRecordingProcessing(local.id);
    assert.deepEqual(local, original);
    assert.deepEqual(commands, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(uploads, []);
  });

  void it("reloads lost processing acceptance with the same durable command and recording identity", async () => {
    const saved = structuredClone(local);
    remotelyReady = true;
    processingLost = true;
    await subject.queueRecordingProcessing(local.id);
    assert.deepEqual(local, saved);
    assert.equal(writes.length, 0);
    assert.equal(
      Object.values(subject.useProcessingJobs.getState().jobs).at(-1)?.stage,
      "uncertain",
    );

    // Reload discards ephemeral command evidence, but the persisted pending manifest survives.
    subject.useProcessingJobs.setState({ jobs: {} });
    local = structuredClone(saved);
    processingLost = false;
    await subject.queueRecordingProcessing(local.id);
    assert.deepEqual(processingIds, [saved.id, saved.id]);
    assert.deepEqual(commands[1], commands[0]);
    assert.deepEqual(writes, [{ ...saved, processing: "submitted" }]);
  });

  void it("acknowledges against the latest disk manifest and preserves newer in-memory recovery fields", async () => {
    beforeProcessingResponse = () => {
      local = { ...local, updatedAt: "2026-11-27T10:00:00.000Z", error: "New disk metadata" };
    };
    beforeManifestWrite = () => {
      sessions[local.id] = {
        ...sessions[local.id]!,
        updatedAt: "2026-11-27T10:01:00.000Z",
        error: "Newer memory metadata",
      };
    };
    await subject.queueRecordingProcessing(local.id);
    assert.equal(writes[0]?.error, "New disk metadata");
    assert.equal(writes[0]?.updatedAt, "2026-11-27T10:00:00.000Z");
    assert.equal(sessions[local.id]?.error, "Newer memory metadata");
    assert.equal(sessions[local.id]?.updatedAt, "2026-11-27T10:01:00.000Z");
    assert.equal(sessions[local.id]?.processing, "submitted");
  });

  void it("does not write acknowledgement into local recovery after an account generation change", async () => {
    beforeProcessingResponse = () => {
      state = { ...state, epoch: state.epoch + 1 };
    };
    await subject.queueRecordingProcessing(local.id);
    assert.equal(writes.length, 0);
    assert.equal(sessions[local.id]?.processing, "pending");
    assert.equal(
      Object.values(subject.useProcessingJobs.getState().jobs)[0]?.acceptance,
      undefined,
    );
  });

  void it("settles the durable pending intent when an explicit start retry succeeds after a lost response", async () => {
    const original = structuredClone(local);
    remotelyReady = true;
    processingLost = true;
    await subject.queueRecordingProcessing(local.id);
    assert.equal(writes.length, 0);
    processingLost = false;
    const key = `1:${scope.user.id}:${scope.workspace.id}:${noteId}`;
    await subject.submitRecordingProcessing(
      runtime as unknown as Parameters<Subject["submitRecordingProcessing"]>[0],
      { workspaceId: local.workspaceId, noteId: local.noteId, recordingId: local.id },
      key,
      () => true,
    );
    assert.deepEqual(processingIds, [original.id, original.id]);
    assert.deepEqual(writes, [{ ...original, processing: "submitted" }]);

    // Reload only the committed disk manifest. A missing server projection asks
    // for status reconciliation, not another start command.
    local = structuredClone(writes[0]!);
    sessions = { [local.id]: local };
    subject.useProcessingJobs.setState({ jobs: {} });
    const recovered = subject.recordingProcessingView({
      run: undefined,
      recording: undefined,
      local,
      job: undefined,
      loaded: true,
      loading: false,
      dataUpdatedAt: Date.now(),
      statusError: undefined,
      mutationPending: false,
      mutationError: undefined,
    });
    assert.deepEqual(recovered, { phase: "uncertain", retryAction: "status" });
    const stop = subject.watchProcessingQueue();
    await new Promise<void>((resolve) => setImmediate(resolve));
    stop();
    assert.deepEqual(subject.useProcessingJobs.getState().jobs, {});
    assert.equal(processingIds.length, 2);
  });
});
