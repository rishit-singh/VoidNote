import { randomUUID } from "node:crypto";
import { expect, test as base, type Route } from "@playwright/test";
import { z } from "zod";
import { recordingOverviewSchema } from "../../src/contracts/recording-processing";
import { personAppearancesSchema } from "../../src/contracts/transcript-corrections";
import { toPersonListItem } from "../../src/contracts/people";

import {
  deleteSchema,
  historySchema,
  noteListSchema,
  noteSchema,
  personListSchema,
  personSchema,
  saveNoteSchema,
  savePersonSchema,
  sessionSchema,
  type NoteRecord,
  type PersonRecord,
  type SaveNote,
  type SavePerson,
  type Session,
} from "../../src/contracts/workspace";

export const timestamp = "2026-11-13T12:00:00.000Z";
export const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Mutation = {
  collection: "notes" | "people";
  command: SaveNote | SavePerson;
  path: string;
};

export type FixtureRPCCall = {
  procedure: string;
  method: string;
  input: Record<string, unknown>;
};

/**
 * TEST ONLY: adapt non-batched httpLink calls to the suite's legacy HTTP mocks.
 * These are real browser fetches, so page.route overrides, abort signals and
 * lost-response route.abort failures retain their existing behavior. Every API
 * fetch is intercepted locally; an unmapped RPC reaches the fixture's deny rule.
 *
 * This verifies client/query behavior, NOT production tRPC transport or database
 * guarantees. tests/auth/trpc.test.ts exercises the actual server adapter/router.
 * Keep this function self-contained: Playwright serializes it into each document.
 */
function installRPCFixtureAdapter({ origin }: { origin: string }) {
  const nativeFetch = window.fetch.bind(window);
  const observer = window as typeof window & {
    __voidnoteFixtureRpcCall: (call: FixtureRPCCall) => Promise<void>;
  };
  window.fetch = async (resource, options) => {
    const url = new URL(
      resource instanceof Request ? resource.url : String(resource),
      location.href,
    );
    if (url.origin !== origin || !/^\/api\/[^/]+\.[^/]+$/.test(url.pathname))
      return nativeFetch(resource, options);

    // The current client uses httpLink. Fail closed if batching is introduced
    // without updating this adapter, rather than silently simulating a batch.
    if (url.searchParams.has("batch")) return nativeFetch(resource, options);
    const request = new Request(resource, options);
    const procedure = decodeURIComponent(url.pathname.slice("/api/".length));
    const raw: unknown =
      request.method === "GET"
        ? JSON.parse(url.searchParams.get("input") ?? "null")
        : await request.clone().json();
    const input =
      raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const segment = (key: string) => encodeURIComponent(String(input[key]));
    const root = `/api/workspaces/${segment("workspaceId")}`;
    const note = `${root}/notes/${segment("noteId")}`;
    const correction = `${note}/processing/${segment("runId")}/corrections`;
    let path: string;
    let method = "GET";
    let body: unknown;
    let queryFields: string[] = [];
    switch (procedure) {
      case "workspace.session":
        path = "/api/session";
        break;
      case "workspace.history":
        path = `${root}/history`;
        queryFields = ["entityType", "entityId", "cursor", "limit"];
        break;
      case "notes.list":
      case "people.list":
        path = `${root}/${procedure.split(".")[0]}`;
        queryFields = ["cursor", "q", "limit"];
        break;
      case "notes.get":
      case "people.get":
        path = `${root}/${procedure.split(".")[0]}/${segment("id")}`;
        queryFields = ["includeDeleted"];
        break;
      case "notes.save":
      case "people.save":
        path = `${root}/${procedure.split(".")[0]}`;
        method = "POST";
        body = input.command;
        break;
      case "notes.delete":
      case "people.delete": {
        const command = input.command as { id: string };
        path = `${root}/${procedure.split(".")[0]}/${encodeURIComponent(command.id)}`;
        method = "DELETE";
        body = command;
        break;
      }
      case "people.appearances":
        path = `${root}/people/${segment("id")}/appearances`;
        queryFields = ["cursor"];
        break;
      case "recordings.overview":
        path = `${note}/recordings`;
        break;
      case "recordings.initialize":
        path = `${note}/recordings`;
        method = "POST";
        body = input.command;
        break;
      case "processing.start":
        path = `${note}/processing`;
        method = "POST";
        body = input.command;
        break;
      case "processing.retry":
        path = `${note}/processing/${segment("runId")}/retry`;
        method = "POST";
        break;
      case "transcripts.page":
        path = correction;
        queryFields = ["cursor"];
        break;
      case "transcripts.command":
        path = correction;
        method = "POST";
        body = input.command;
        break;
      case "transcripts.history":
        path = `${correction}/history`;
        queryFields = ["cursor"];
        break;
      case "transcripts.targets":
        path = `${correction}/targets`;
        queryFields = ["speakerLabel", "startSeconds", "endSeconds", "includeManual"];
        break;
      default:
        return nativeFetch(resource, options);
    }
    await observer.__voidnoteFixtureRpcCall({ procedure, method: request.method, input });
    const legacyUrl = new URL(path, origin);
    for (const key of queryFields) {
      const value = input[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
        throw new TypeError(`Unexpected fixture query field: ${key}`);
      legacyUrl.searchParams.set(key, String(value));
    }
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    if (body !== undefined) headers.set("content-type", "application/json");
    // Intentionally do not catch network errors: an uncertain mutation must stay
    // uncertain, not become a synthetic successful or retryable HTTP response.
    const response = await nativeFetch(legacyUrl, {
      method,
      headers,
      credentials: request.credentials,
      cache: "no-store",
      signal: request.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data: unknown = await response.json();
    request.signal.throwIfAborted();
    const responseHeaders = {
      "content-type": "application/json",
      "cache-control": "private, no-store",
    };
    if (response.ok)
      return new Response(JSON.stringify({ result: { data } }), {
        status: response.status,
        headers: responseHeaders,
      });
    const failure = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const statuses: Record<number, [string, number]> = {
      400: ["BAD_REQUEST", -32600],
      401: ["UNAUTHORIZED", -32001],
      403: ["FORBIDDEN", -32003],
      404: ["NOT_FOUND", -32004],
      405: ["METHOD_NOT_SUPPORTED", -32005],
      408: ["TIMEOUT", -32008],
      409: ["CONFLICT", -32009],
      413: ["PAYLOAD_TOO_LARGE", -32013],
      415: ["UNSUPPORTED_MEDIA_TYPE", -32015],
      429: ["TOO_MANY_REQUESTS", -32029],
      500: ["INTERNAL_SERVER_ERROR", -32603],
      503: ["SERVICE_UNAVAILABLE", -32603],
    };
    const [code, numericCode] = statuses[response.status] ?? ["INTERNAL_SERVER_ERROR", -32603];
    return new Response(
      JSON.stringify({
        error: {
          message: typeof failure.error === "string" ? failure.error : "Fixture request failed.",
          code: numericCode,
          data: {
            code,
            httpStatus: response.status,
            path: procedure,
            domainCode:
              typeof failure.code === "string"
                ? failure.code
                : response.status >= 500
                  ? "internal_error"
                  : "invalid_request",
            ...(failure.currentRevision === undefined
              ? {}
              : { currentRevision: failure.currentRevision }),
            ...(failure.affectedTargets === undefined
              ? {}
              : { affectedTargets: failure.affectedTargets }),
          },
        },
      }),
      { status: response.status, headers: responseHeaders },
    );
  };
}

/** Mocked browser transport; neither production tRPC nor PostgreSQL acceptance evidence. */
export class WorkspaceFixture {
  session: Session | null = {
    user: { id: userId, email: "reader@example.test" },
    workspace: { id: workspaceId, name: "Test workspace" },
  };
  notes = new Map<string, NoteRecord>();
  people = new Map<string, PersonRecord>();
  mutations: Mutation[] = [];
  requests: string[] = [];
  /** Logical RPC invocations, including those served by test-specific page routes. */
  rpcRequests: FixtureRPCCall[] = [];
  unexpectedRequests: string[] = [];
  pageErrors: string[] = [];
  history: z.infer<typeof historySchema>["items"] = [];
  nextMutation: "conflict" | "lost-response" | null = null;
  signOutCount = 0;
  signOutFails = false;
  private completed = new Map<string, NoteRecord | PersonRecord>();

  seedNote(content: Partial<NoteRecord> = {}): NoteRecord {
    const note = noteSchema.parse({
      id: randomUUID(),
      workspaceId,
      revision: 1,
      title: "Garden planning",
      transcript: "",
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
      ...content,
    });
    this.notes.set(note.id, note);
    return note;
  }

  seedPerson(content: Partial<PersonRecord> = {}): PersonRecord {
    const person = personSchema.parse({
      id: randomUUID(),
      workspaceId,
      revision: 1,
      displayName: "Alex",
      description: "",
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
      ...content,
    });
    this.people.set(person.id, person);
    return person;
  }

  async handle(route: Route, origin: string): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    const block = async () => {
      this.unexpectedRequests.push(`${method} ${url.href}`);
      await route.abort("blockedbyclient");
    };
    if (url.origin !== origin) return block();
    if (path !== "/api" && !path.startsWith("/api/")) {
      await route.continue();
      return;
    }
    this.requests.push(`${method} ${path}${url.search}`);
    if (path === "/api/session" && method === "GET") {
      await route.fulfill(
        this.session
          ? { json: sessionSchema.parse(this.session) }
          : { status: 401, json: { error: "Sign in required.", code: "unauthenticated" } },
      );
      return;
    }
    if (path === "/api/auth/sign-out" && method === "POST") {
      this.signOutCount += 1;
      if (this.signOutFails) {
        await route.fulfill({
          status: 503,
          json: { error: "Sign-out failed. Try again.", code: "unavailable" },
        });
        return;
      }
      this.session = null;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    const root = this.session && `/api/workspaces/${this.session.workspace.id}/`;
    if (!root || !path.startsWith(root)) return block();
    const [collection, id, extra] = path.slice(root.length).split("/");
    // Tests without a processing transport deliberately exercise recoverable offline upload.
    if (collection === "notes" && extra === "recordings" && method === "POST") {
      await route.fulfill({
        status: 503,
        json: { error: "Upload unavailable in this fixture. Retry to resume." },
      });
      return;
    }
    if (collection === "people" && id && extra === "appearances" && method === "GET") {
      const person = this.people.get(id);
      await route.fulfill(
        person && !person.deletedAt
          ? { json: personAppearancesSchema.parse({ items: [], nextCursor: null }) }
          : { status: 404, json: { error: "Profile not found.", code: "not_found" } },
      );
      return;
    }
    if (
      collection === "notes" &&
      id &&
      extra === "recordings" &&
      path.endsWith("/recordings") &&
      method === "GET"
    ) {
      const note = this.notes.get(id);
      await route.fulfill(
        note && note.workspaceId === this.session?.workspace.id && !note.deletedAt
          ? { json: recordingOverviewSchema.parse({ recordings: [], runs: [] }) }
          : { status: 404, json: { error: "Record not found.", code: "not_found" } },
      );
      return;
    }
    if (extra !== undefined) return block();
    if (collection === "history" && !id && method === "GET") {
      const entityId = url.searchParams.get("entityId");
      const entityType = url.searchParams.get("entityType");
      await route.fulfill({
        json: historySchema.parse({
          items: this.history.filter(
            (event) => event.entityId === entityId && event.entityType === entityType,
          ),
          nextCursor: null,
        }),
      });
      return;
    }
    if (collection !== "notes" && collection !== "people") return block();
    const records = collection === "notes" ? this.notes : this.people;
    if (method === "GET") {
      if (id) {
        const record = records.get(id);
        if (record && record.workspaceId !== this.session?.workspace.id) return block();
        await route.fulfill(
          record && (!record.deletedAt || url.searchParams.get("includeDeleted") === "true")
            ? { json: record }
            : { status: 404, json: { error: "Record not found.", code: "not_found" } },
        );
      } else {
        const recordsInScope = [...records.values()].filter(
          (record) => record.workspaceId === this.session?.workspace.id && !record.deletedAt,
        );
        const q = url.searchParams.get("q")?.toLowerCase();
        const items = recordsInScope.map((record) =>
          "displayName" in record ? toPersonListItem(record) : record,
        );
        const schema = collection === "notes" ? noteListSchema : personListSchema;
        await route.fulfill({
          json: schema.parse({
            items: q
              ? items.filter((record) =>
                  "displayName" in record
                    ? record.displayName.toLowerCase().startsWith(q)
                    : record.title.toLowerCase().startsWith(q),
                )
              : items,
            nextCursor: null,
          }),
        });
      }
      return;
    }
    if (method !== "POST" || id) {
      if (method === "DELETE" && id) {
        const command = deleteSchema.parse(request.postDataJSON());
        const record = records.get(id);
        if (!record || command.id !== id) return block();
        if (record.workspaceId !== this.session?.workspace.id) return block();
        const deleted = { ...record, revision: record.revision + 1, deletedAt: timestamp };
        if (collection === "notes") this.notes.set(id, noteSchema.parse(deleted));
        else this.people.set(id, personSchema.parse(deleted));
        this.history.push({
          id: randomUUID(),
          entityId: id,
          entityType: collection === "notes" ? "note" : "person",
          revision: deleted.revision,
          operation: "delete",
          operationVersion: 1,
          actorId: this.session.user.id,
          commandId: command.commandId,
          createdAt: timestamp,
        });
        await route.fulfill({ json: deleted });
        return;
      }
      return block();
    }
    const command =
      collection === "notes"
        ? saveNoteSchema.parse(request.postDataJSON())
        : savePersonSchema.parse(request.postDataJSON());
    this.mutations.push({ collection, command, path });
    const failure = this.nextMutation;
    this.nextMutation = null;
    if (failure === "conflict") {
      await route.fulfill({
        status: 409,
        json: {
          error: "This record changed in another session. Your draft has been retained.",
          code: "conflict",
          currentRevision: command.expectedRevision + 1,
        },
      });
      return;
    }
    const replay = this.completed.get(command.commandId);
    let record = replay;
    if (!record) {
      const previous = records.get(command.id);
      const fields = {
        ...command.content,
        id: command.id,
        workspaceId: this.session!.workspace.id,
        revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      };
      if (collection === "notes") {
        record = noteSchema.parse(fields);
        this.notes.set(record.id, record);
      } else {
        record = personSchema.parse(fields);
        this.people.set(record.id, record);
      }
      this.history.push({
        id: randomUUID(),
        entityId: record.id,
        entityType: collection === "notes" ? "note" : "person",
        revision: record.revision,
        operation: "save",
        operationVersion: 1,
        actorId: this.session!.user.id,
        commandId: command.commandId,
        createdAt: timestamp,
      });
    }
    this.completed.set(command.commandId, record);
    if (failure === "lost-response") await route.abort("connectionreset");
    else await route.fulfill({ json: record });
  }
}

export const test = base.extend<{ workspace: WorkspaceFixture }>({
  workspace: async ({ context, baseURL }, runTest) => {
    if (!baseURL) throw new Error("Workspace tests require the local Worker preview.");
    const workspace = new WorkspaceFixture();
    const origin = new URL(baseURL).origin;
    await context.exposeBinding("__voidnoteFixtureRpcCall", (_source, call: FixtureRPCCall) => {
      workspace.rpcRequests.push(call);
    });
    await context.addInitScript(installRPCFixtureAdapter, { origin });
    context.on("page", (page) =>
      page.on("pageerror", (error) => workspace.pageErrors.push(error.message)),
    );
    for (const page of context.pages()) {
      page.on("pageerror", (error) => workspace.pageErrors.push(error.message));
    }
    await context.route("**/*", (route) => workspace.handle(route, origin));
    await runTest(workspace);
    expect(workspace.unexpectedRequests, "All APIs must be explicitly fulfilled locally").toEqual(
      [],
    );
    expect(workspace.pageErrors, "The workspace must not throw browser errors").toEqual([]);
  },
  page: async ({ page, workspace }, runTest) => {
    // Depend on workspace so interception is installed before the first navigation.
    void workspace;
    await runTest(page);
  },
});

export { expect } from "@playwright/test";
