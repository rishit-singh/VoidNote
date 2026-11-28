import { and, desc, eq, ilike, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";

import { idSchema, type Principal, WorkspaceError } from "../../contracts/workspace";
import type { Database } from "../repository";
import { notes, workspaceMemberships, workspaces } from "../schema";

const searchInputSchema = z
  .object({
    q: z.string().trim().min(1).max(300),
    limit: z.number().int().min(1).max(50).default(20),
    match: z.enum(["content", "title-or-content"]).default("title-or-content"),
    cursor: z.string().max(2000).optional(),
  })
  .strict();

const searchCursorSchema = z
  .object({
    v: z.literal(1),
    workspaceId: idSchema,
    query: z.string().max(300),
    match: z.enum(["content", "title-or-content"]),
    updatedAt: z.iso.datetime({ offset: true }),
    id: idSchema,
  })
  .strict();

function encodeCursor(cursor: z.infer<typeof searchCursorSchema>): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(
  cursor: string | undefined,
  workspaceId: string,
  query: string,
  match: "content" | "title-or-content",
) {
  if (!cursor) {
    return null;
  }

  try {
    const decoded = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));

    const parsed = searchCursorSchema.parse(JSON.parse(decoded) as unknown);

    if (parsed.workspaceId !== workspaceId || parsed.query !== query || parsed.match !== match) {
      throw new Error("Cursor scope mismatch");
    }

    return parsed;
  } catch {
    throw new WorkspaceError("invalid_cursor", "Invalid note-search cursor.");
  }
}

export function createAssistantEvidenceRepository(db: Database) {
  return {
    async searchNotes(
      principal: Principal,
      workspaceId: string,
      value: z.input<typeof searchInputSchema>,
    ): Promise<{
      items: Array<{ id: string; title: string; revision: number; updatedAt: string }>;
      nextCursor: string | null;
      match: "content" | "title-or-content";
    }> {
      const input = searchInputSchema.parse(value);

      idSchema.parse(principal.id);
      idSchema.parse(workspaceId);
      const after = decodeCursor(input.cursor, workspaceId, input.q, input.match);

      const escaped = input.q.replace(/[\\%_]/g, "\\$&");

      const pattern = `%${escaped}%`;

      return db.transaction(async (tx) => {
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
          .for("share")
          .limit(1);

        if (!membership) {
          throw new WorkspaceError("forbidden", "Workspace access denied.");
        }

        const rows = await tx
          .select({
            id: notes.id,
            title: notes.title,
            revision: notes.revision,
            updatedAt: notes.updatedAt,
          })
          .from(notes)
          .where(
            and(
              eq(notes.workspaceId, workspaceId),
              isNull(notes.deletedAt),
              input.match === "content"
                ? ilike(notes.transcript, pattern)
                : or(ilike(notes.title, pattern), ilike(notes.transcript, pattern)),
              after
                ? or(
                    lt(notes.updatedAt, new Date(after.updatedAt)),
                    and(eq(notes.updatedAt, new Date(after.updatedAt)), lt(notes.id, after.id)),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(notes.updatedAt), desc(notes.id))
          .limit(input.limit + 1);

        const items = rows.slice(0, input.limit).map((row) => ({
          id: row.id,
          title: row.title,
          revision: row.revision,
          updatedAt: row.updatedAt.toISOString(),
        }));

        const last = items.at(-1);

        return {
          items,
          nextCursor:
            rows.length > input.limit && last
              ? encodeCursor({
                  v: 1,
                  workspaceId,
                  query: input.q,
                  match: input.match,
                  updatedAt: last.updatedAt,
                  id: last.id,
                })
              : null,
          match: input.match,
        };
      });
    },
  };
}
