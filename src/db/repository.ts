import { Buffer } from "node:buffer";
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import {
  PERSON_DESCRIPTION_PREVIEW_LENGTH,
  peopleQuerySchema,
  personSchema,
  savePersonSchema,
  type PeopleQuery,
  type PersonRecord,
} from "../contracts/people";
import {
  deleteSchema,
  idSchema,
  notesQuerySchema,
  listQuerySchema,
  noteSchema,
  saveNoteSchema,
  WorkspaceError,
  type DeleteCommand,
  type NotesQuery,
  type ListQuery,
  type NoteRecord,
  type Principal,
  type SaveNote,
  type SavePerson,
  type Session,
} from "../contracts/workspace";
import type * as schema from "./schema";
import {
  commandReceipts,
  DEFAULT_BRANCH,
  domainEvents,
  notes,
  outbox,
  people,
  userProfiles,
  workspaceMemberships,
  workspaces,
} from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type EntityType = "note" | "person";

const noteListColumns = {
  id: notes.id,
  workspaceId: notes.workspaceId,
  revision: notes.revision,
  title: notes.title,
  createdAt: notes.createdAt,
  updatedAt: notes.updatedAt,
  deletedAt: notes.deletedAt,
};
const noteColumns = {
  ...noteListColumns,
  transcript: notes.transcript,
};
const personMetadataColumns = {
  id: people.id,
  workspaceId: people.workspaceId,
  revision: people.revision,
  displayName: people.displayName,
  createdAt: people.createdAt,
  updatedAt: people.updatedAt,
  deletedAt: people.deletedAt,
};
const personColumns = {
  ...personMetadataColumns,
  description: people.description,
};
const personListColumns = {
  ...personMetadataColumns,
  descriptionPreview: sql<string>`left(${people.description}, ${PERSON_DESCRIPTION_PREVIEW_LENGTH})`,
};

function recordDates<T extends { createdAt: Date; updatedAt: Date; deletedAt: Date | null }>(
  row: T,
) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

const cursorBase = z.object({ v: z.literal(1), workspaceId: idSchema });
const noteCursor = cursorBase.extend({
  kind: z.literal("notes"),
  id: idSchema,
  updatedAt: z.iso.datetime(),
  queryHash: z.string().length(64),
});
// Unbound legacy people cursors are rejected: restart at page one after this cutover.
// Accepting them cannot guarantee continuation within the original exact search.
const personCursor = cursorBase.extend({
  kind: z.literal("people"),
  id: idSchema,
  queryHash: z.string().length(64),
});
const historyCursor = cursorBase.extend({
  kind: z.literal("history"),
  entityType: z.enum(["note", "person"]),
  entityId: idSchema,
  revision: z.number().int().positive(),
});

function encodeCursor(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor<T extends { workspaceId: string }>(
  value: string | undefined,
  validator: z.ZodType<T>,
  workspaceId: string,
): T | undefined {
  if (value === undefined) return undefined;
  try {
    if (value.length > 500 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
    const parsed = validator.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown,
    );
    if (parsed.workspaceId !== workspaceId) throw new Error("Wrong workspace");
    return parsed;
  } catch {
    throw new WorkspaceError("invalid_cursor", "Invalid pagination cursor");
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function fingerprint(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return Buffer.from(digest).toString("hex");
}

async function authorize(tx: Transaction, principal: Principal, workspaceId: string) {
  idSchema.parse(principal.id);
  idSchema.parse(workspaceId);
  const [membership] = await tx
    .select({ userId: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.id),
        isNull(workspaceMemberships.revokedAt),
        isNull(workspaces.deletedAt),
      ),
    )
    // Prevent membership revocation during an authorized transaction. Only lock
    // membership here: upgrading shared workspace locks would deadlock writers.
    .for("share", { of: workspaceMemberships })
    .limit(1);
  if (!membership) throw new WorkspaceError("forbidden", "Workspace access denied");
}

function checkRevision(
  current: { revision: number; deletedAt: string | null } | undefined,
  expected: number,
) {
  if ((current?.revision ?? 0) !== expected || current?.deletedAt != null) {
    throw new WorkspaceError("conflict", "The record has changed", current?.revision ?? 0);
  }
}

async function readNote(tx: Transaction, workspaceId: string, id: string) {
  const [row] = await tx
    .select(noteColumns)
    .from(notes)
    .where(and(eq(notes.workspaceId, workspaceId), eq(notes.id, id)))
    .limit(1);
  return row ? recordDates(row) : undefined;
}

async function readPerson(tx: Transaction, workspaceId: string, id: string) {
  const [row] = await tx
    .select(personColumns)
    .from(people)
    .where(and(eq(people.workspaceId, workspaceId), eq(people.id, id)))
    .limit(1);
  return row ? recordDates(row) : undefined;
}

export function createWorkspaceRepository(db: Database) {
  async function read<T>(
    principal: Principal,
    workspaceId: string,
    work: (tx: Transaction) => Promise<T>,
  ) {
    return db.transaction(async (tx) => {
      await authorize(tx, principal, workspaceId);
      return work(tx);
    });
  }

  async function command<T extends NoteRecord | PersonRecord>(
    principal: Principal,
    workspaceId: string,
    entityType: EntityType,
    operation: string,
    input: DeleteCommand | SaveNote | SavePerson,
    resultSchema: z.ZodType<T>,
    work: (tx: Transaction) => Promise<{ result: T; changed: boolean }>,
  ): Promise<T> {
    return db.transaction(
      async (tx) => {
        await authorize(tx, principal, workspaceId);
        // MVP serialization boundary. READ COMMITTED reads following this lock see
        // the previous writer's committed receipt and projection, including retries.
        const [workspace] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
          .for("update")
          .limit(1);
        if (!workspace) throw new WorkspaceError("forbidden", "Workspace access denied");
        const hash = await fingerprint({
          actorId: principal.id,
          workspaceId,
          entityType,
          operation,
          operationVersion: 1,
          input,
        });
        const [receipt] = await tx
          .select({ fingerprint: commandReceipts.fingerprint, result: commandReceipts.result })
          .from(commandReceipts)
          .where(
            and(
              eq(commandReceipts.workspaceId, workspaceId),
              eq(commandReceipts.commandId, input.commandId),
            ),
          )
          .limit(1);
        if (receipt) {
          if (receipt.fingerprint !== hash)
            throw new WorkspaceError(
              "command_reused",
              "Command ID was already used for different inputs",
            );
          return resultSchema.parse(receipt.result);
        }

        // Revision checks deliberately happen in work(), after the receipt lookup.
        const { result, changed } = await work(tx);
        await tx.insert(commandReceipts).values({
          workspaceId,
          commandId: input.commandId,
          actorId: principal.id,
          fingerprint: hash,
          result,
        });
        if (changed) {
          const eventId = crypto.randomUUID();
          await tx.insert(domainEvents).values({
            workspaceId,
            id: eventId,
            entityType,
            entityId: result.id,
            noteId: entityType === "note" ? result.id : null,
            personId: entityType === "person" ? result.id : null,
            branchId: DEFAULT_BRANCH,
            revision: result.revision,
            operation,
            operationVersion: 1,
            actorId: principal.id,
            commandId: input.commandId,
            payload: result,
            createdAt: new Date(result.updatedAt),
          });
          await tx.insert(outbox).values({
            workspaceId,
            eventId,
            kind: `${entityType}.${operation === "delete" ? "delete" : "changed"}`,
          });
        }
        return result;
      },
      { isolationLevel: "read committed" },
    );
  }

  return {
    async ensureWorkspace(principal: Principal): Promise<Session["workspace"]> {
      idSchema.parse(principal.id);
      return db.transaction(async (tx) => {
        // The profile upsert serializes concurrent first sign-ins for this owner.
        await tx
          .insert(userProfiles)
          .values({ id: principal.id, email: principal.email })
          .onConflictDoUpdate({
            target: userProfiles.id,
            set: { email: principal.email, updatedAt: new Date() },
          });
        await tx
          .insert(workspaces)
          .values({ ownerId: principal.id })
          .onConflictDoNothing({ target: workspaces.ownerId });
        const [workspace] = await tx
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(and(eq(workspaces.ownerId, principal.id), isNull(workspaces.deletedAt)))
          .limit(1);
        if (!workspace) throw new WorkspaceError("forbidden", "Workspace access denied");
        await tx
          .insert(workspaceMemberships)
          .values({ workspaceId: workspace.id, userId: principal.id, role: "owner" })
          .onConflictDoNothing({
            target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
          });
        await authorize(tx, principal, workspace.id);
        return workspace;
      });
    },

    async listNotes(principal: Principal, workspaceId: string, query: ListQuery | NotesQuery) {
      return read(principal, workspaceId, async (tx) => {
        const { limit, cursor, q } = notesQuerySchema.parse(query);
        const after = decodeCursor(cursor, noteCursor, workspaceId);
        const queryHash = await fingerprint(q);
        if (after && after.queryHash !== queryHash)
          throw new WorkspaceError("invalid_cursor", "Cursor belongs to another search");
        const prefix = q.toLowerCase().replace(/[\\%_]/g, "\\$&");
        const rows = await tx
          .select(noteListColumns)
          .from(notes)
          .where(
            and(
              eq(notes.workspaceId, workspaceId),
              isNull(notes.deletedAt),
              q ? sql`lower(${notes.title}) like ${`${prefix}%`}` : undefined,
              after
                ? or(
                    lt(notes.updatedAt, new Date(after.updatedAt)),
                    and(eq(notes.updatedAt, new Date(after.updatedAt)), lt(notes.id, after.id)),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(notes.updatedAt), desc(notes.id))
          .limit(limit + 1);
        const items = rows.slice(0, limit).map(recordDates);
        const last = items.at(-1);
        return {
          items,
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({
                  v: 1,
                  kind: "notes",
                  workspaceId,
                  id: last.id,
                  updatedAt: last.updatedAt,
                  queryHash,
                })
              : null,
        };
      });
    },

    async getNote(
      principal: Principal,
      workspaceId: string,
      id: string,
      includeDeleted = false,
    ): Promise<NoteRecord> {
      return read(principal, workspaceId, async (tx) => {
        const row = await readNote(tx, workspaceId, idSchema.parse(id));
        if (!row || (row.deletedAt && !includeDeleted))
          throw new WorkspaceError("not_found", "Note not found");
        return row;
      });
    },

    async saveNote(
      principal: Principal,
      workspaceId: string,
      value: SaveNote,
    ): Promise<NoteRecord> {
      const input = saveNoteSchema.parse(value);
      return command(principal, workspaceId, "note", "save", input, noteSchema, async (tx) => {
        const current = await readNote(tx, workspaceId, input.id);
        checkRevision(current, input.expectedRevision);
        const now = new Date();
        const values = { ...input.content, revision: (current?.revision ?? 0) + 1, updatedAt: now };
        const [row] = current
          ? await tx
              .update(notes)
              .set(values)
              .where(and(eq(notes.workspaceId, workspaceId), eq(notes.id, input.id)))
              .returning(noteColumns)
          : await tx
              .insert(notes)
              .values({ ...values, workspaceId, id: input.id, createdAt: now })
              .returning(noteColumns);
        if (!row) throw new Error("Note mutation returned no row");
        return { result: recordDates(row), changed: true };
      });
    },

    async deleteNote(
      principal: Principal,
      workspaceId: string,
      value: DeleteCommand,
    ): Promise<NoteRecord> {
      const input = deleteSchema.parse(value);
      return command(principal, workspaceId, "note", "delete", input, noteSchema, async (tx) => {
        const current = await readNote(tx, workspaceId, input.id);
        if (!current) throw new WorkspaceError("not_found", "Note not found");
        checkRevision(current, input.expectedRevision);
        const now = new Date();
        const [row] = await tx
          .update(notes)
          .set({ revision: current.revision + 1, updatedAt: now, deletedAt: now })
          .where(and(eq(notes.workspaceId, workspaceId), eq(notes.id, input.id)))
          .returning(noteColumns);
        if (!row) throw new Error("Note deletion returned no row");
        return { result: recordDates(row), changed: true };
      });
    },

    async listPeople(principal: Principal, workspaceId: string, query: ListQuery | PeopleQuery) {
      return read(principal, workspaceId, async (tx) => {
        const { limit, cursor, q } = peopleQuerySchema.parse(query);
        const after = decodeCursor(cursor, personCursor, workspaceId);
        const queryHash = await fingerprint(q);
        if (after && after.queryHash !== queryHash) {
          throw new WorkspaceError("invalid_cursor", "Cursor belongs to another search");
        }

        const prefix = q.toLowerCase().replace(/[\\%_]/g, "\\$&");
        const rows = await tx
          .select(personListColumns)
          .from(people)
          .where(
            and(
              eq(people.workspaceId, workspaceId),
              isNull(people.deletedAt),
              after ? gt(people.id, after.id) : undefined,
              q ? sql`lower(${people.displayName}) like ${`${prefix}%`}` : undefined,
            ),
          )
          .orderBy(asc(people.id))
          .limit(limit + 1);
        const items = rows.slice(0, limit).map(recordDates);
        const last = items.at(-1);
        return {
          items,
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ v: 1, kind: "people", workspaceId, id: last.id, queryHash })
              : null,
        };
      });
    },

    async getPerson(
      principal: Principal,
      workspaceId: string,
      id: string,
      includeDeleted = false,
    ): Promise<PersonRecord> {
      return read(principal, workspaceId, async (tx) => {
        const row = await readPerson(tx, workspaceId, idSchema.parse(id));
        if (!row || (row.deletedAt && !includeDeleted))
          throw new WorkspaceError("not_found", "Person not found");
        return row;
      });
    },

    async savePerson(
      principal: Principal,
      workspaceId: string,
      value: SavePerson,
    ): Promise<PersonRecord> {
      const input = savePersonSchema.parse(value);
      return command(principal, workspaceId, "person", "save", input, personSchema, async (tx) => {
        const current = await readPerson(tx, workspaceId, input.id);
        checkRevision(current, input.expectedRevision);
        const now = new Date();
        const values = { ...input.content, revision: (current?.revision ?? 0) + 1, updatedAt: now };
        const [row] = current
          ? await tx
              .update(people)
              .set(values)
              .where(and(eq(people.workspaceId, workspaceId), eq(people.id, input.id)))
              .returning(personColumns)
          : await tx
              .insert(people)
              .values({ ...values, workspaceId, id: input.id, createdAt: now })
              .returning(personColumns);
        if (!row) throw new Error("Person mutation returned no row");
        return { result: recordDates(row), changed: true };
      });
    },

    async deletePerson(
      principal: Principal,
      workspaceId: string,
      value: DeleteCommand,
    ): Promise<PersonRecord> {
      const input = deleteSchema.parse(value);
      return command(
        principal,
        workspaceId,
        "person",
        "delete",
        input,
        personSchema,
        async (tx) => {
          const current = await readPerson(tx, workspaceId, input.id);
          if (!current) throw new WorkspaceError("not_found", "Person not found");
          checkRevision(current, input.expectedRevision);
          const now = new Date();
          const [row] = await tx
            .update(people)
            .set({ revision: current.revision + 1, updatedAt: now, deletedAt: now })
            .where(and(eq(people.workspaceId, workspaceId), eq(people.id, input.id)))
            .returning(personColumns);
          if (!row) throw new Error("Person deletion returned no row");
          return { result: recordDates(row), changed: true };
        },
      );
    },

    async history(
      principal: Principal,
      workspaceId: string,
      entityType: EntityType,
      entityId: string,
      query: ListQuery,
    ) {
      return read(principal, workspaceId, async (tx) => {
        idSchema.parse(entityId);
        z.enum(["note", "person"]).parse(entityType);
        const { limit, cursor } = listQuerySchema.parse(query);
        const after = decodeCursor(cursor, historyCursor, workspaceId);
        if (after && (after.entityId !== entityId || after.entityType !== entityType))
          throw new WorkspaceError("invalid_cursor", "Cursor belongs to another history");
        // Tombstones retain readable history; nonexistent entities are not empty histories.
        const entityTable = entityType === "note" ? notes : people;
        const [entity] = await tx
          .select({ id: entityTable.id })
          .from(entityTable)
          .where(and(eq(entityTable.workspaceId, workspaceId), eq(entityTable.id, entityId)))
          .limit(1);
        if (!entity) throw new WorkspaceError("not_found", "Record not found");
        const rows = await tx
          .select({
            id: domainEvents.id,
            entityId: domainEvents.entityId,
            entityType: domainEvents.entityType,
            revision: domainEvents.revision,
            operation: domainEvents.operation,
            operationVersion: domainEvents.operationVersion,
            actorId: domainEvents.actorId,
            commandId: domainEvents.commandId,
            createdAt: domainEvents.createdAt,
          })
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.workspaceId, workspaceId),
              eq(domainEvents.entityType, entityType),
              eq(domainEvents.entityId, entityId),
              eq(domainEvents.branchId, DEFAULT_BRANCH),
              after ? lt(domainEvents.revision, after.revision) : undefined,
            ),
          )
          .orderBy(desc(domainEvents.revision))
          .limit(limit + 1);
        const items = rows
          .slice(0, limit)
          .map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
        const last = items.at(-1);
        return {
          items,
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({
                  v: 1,
                  kind: "history",
                  workspaceId,
                  entityType,
                  entityId,
                  revision: last.revision,
                })
              : null,
        };
      });
    },
  };
}
