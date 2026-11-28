import { and, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import type {
  AssistantArtifact,
  AssistantSource,
  AssistantToolResult,
} from "../../contracts/assistant";
import { idSchema, type Principal, WorkspaceError } from "../../contracts/workspace";
import { assistantMessages, assistantThreads } from "../assistant-schema";
import type { Database } from "../repository";
import {
  authorize,
  fingerprint,
  publicArtifact,
  requireArtifact,
  requireThread,
  sourceValidationBudget,
  validateSources,
} from "./shared";

const MESSAGE_TEXT_LIMIT = 4_000;

const TOOL_SUMMARY_LIMIT = 1_000;

const TOOL_HIT_LIMIT = 8;

const EXCERPT_LEADING_CONTEXT = 500;

const PAGE_BYTE_LIMIT = 65_536;

export type AssistantHistoryToolHit = {
  id: string;
  name: string;
  status: AssistantToolResult["status"];
  summary: string;
  summaryTruncated: boolean;
  sources: AssistantSource[];
  // The persisted tool outcome contract has no raw result-data field.
  data: null;
};

export type AssistantHistoryHit = {
  id: string;
  threadId: string;
  turnId: string;
  role: "user" | "assistant";
  createdAt: string;
  text: string;
  textTruncated: boolean;
  tools: AssistantHistoryToolHit[];
  toolsTruncated: boolean;
  // Includes dependencies of omitted tools too. Truncating display content must
  // never silently drop evidence required to validate the retained assistant text.
  sources: AssistantSource[];
};

export type AssistantHistoryRetrieval = {
  hits: AssistantHistoryHit[];
  order: "newest-first";
  nextCursor: string | null;
  omittedCount: number;
};

const cursorSchema = z.object({
  v: z.literal(1),
  kind: z.literal("assistant-retrieval"),
  workspaceId: idSchema,
  actorId: idSchema,
  threadId: idSchema,
  queryHash: z.string().regex(/^[0-9a-f]{64}$/),
  before: z.number().int().positive(),
});

function decodeCursor(
  value: string | undefined,
  expected: Pick<
    z.infer<typeof cursorSchema>,
    "workspaceId" | "actorId" | "threadId" | "queryHash"
  >,
) {
  if (value === undefined) {
    return undefined;
  }

  try {
    if (value.length > 2_000 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error("Invalid cursor encoding");
    }

    const parsed = cursorSchema.parse(
      JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/"))) as unknown,
    );

    if (
      parsed.workspaceId !== expected.workspaceId ||
      parsed.actorId !== expected.actorId ||
      parsed.threadId !== expected.threadId ||
      parsed.queryHash !== expected.queryHash
    ) {
      throw new Error("Cursor scope changed");
    }

    return parsed.before;
  } catch {
    throw new WorkspaceError("invalid_cursor", "Invalid history retrieval cursor");
  }
}

function encodeCursor(value: z.infer<typeof cursorSchema>) {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function toolHit(tool: AssistantToolResult, query: string): AssistantHistoryToolHit {
  const match = tool.summary.toLowerCase().indexOf(query.toLowerCase());

  const start = Math.max(0, match - Math.floor(TOOL_SUMMARY_LIMIT / 4));

  return {
    id: tool.id,
    name: tool.name,
    status: tool.status,
    summary: tool.summary.slice(start, start + TOOL_SUMMARY_LIMIT),
    summaryTruncated: tool.summary.length > TOOL_SUMMARY_LIMIT,
    sources: tool.sources,
    data: null,
  };
}

function preservedSources(sources: AssistantSource[]) {
  const unique = new Map<string, AssistantSource>();

  for (const source of sources) {
    unique.set(fingerprint(source), source);
  }

  return [...unique.values()];
}

export function createRetrievalOperations(db: Database) {
  return {
    async getContextArtifact(
      principal: Principal,
      workspaceId: string,
      id: string,
    ): Promise<AssistantArtifact> {
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        const artifact = await requireArtifact(tx, principal, workspaceId, id);

        await validateSources(tx, principal, workspaceId, artifact.sources);

        return publicArtifact(artifact);
      });
    },

    async retrieveHistory(
      principal: Principal,
      workspaceId: string,
      threadId: string,
      query: string,
      cursor?: string,
      limit = 10,
    ): Promise<AssistantHistoryRetrieval> {
      idSchema.parse(threadId);
      const search = z.string().max(300).parse(query);

      z.number().int().min(1).max(10).parse(limit);
      const queryHash = fingerprint({ query: search });

      const binding = { workspaceId, actorId: principal.id, threadId, queryHash };

      const before = decodeCursor(cursor, binding);

      const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        await requireThread(tx, principal, workspaceId, threadId);
        await tx
          .select({ id: assistantThreads.id })
          .from(assistantThreads)
          .where(
            and(eq(assistantThreads.workspaceId, workspaceId), eq(assistantThreads.id, threadId)),
          )
          .for("share");

        // SQL filters the complete stored text/outcome before LIMIT. The selected
        // text is only a bounded excerpt around the literal match; tools remain
        // bounded by their existing publication contract.
        const start = sql<number>`greatest(1, strpos(lower(${assistantMessages.text}), lower(${search})) - ${EXCERPT_LEADING_CONTEXT})`;

        const rows = await tx
          .select({
            id: assistantMessages.id,
            threadId: assistantMessages.threadId,
            turnId: assistantMessages.turnId,
            role: assistantMessages.role,
            createdAt: assistantMessages.createdAt,
            sequence: assistantMessages.sequence,
            text: sql<string>`substring(${assistantMessages.text} from ${start} for ${MESSAGE_TEXT_LIMIT})`,
            textTruncated: sql<boolean>`char_length(${assistantMessages.text}) > ${MESSAGE_TEXT_LIMIT}`,
            tools: assistantMessages.tools,
            sources: assistantMessages.sources,
          })
          .from(assistantMessages)
          .where(
            and(
              eq(assistantMessages.workspaceId, workspaceId),
              eq(assistantMessages.threadId, threadId),
              before === undefined ? undefined : lt(assistantMessages.sequence, before),
              or(
                ilike(assistantMessages.text, pattern),
                sql`exists (
                  select 1 from jsonb_array_elements(${assistantMessages.tools}) as outcome
                  where outcome->>'summary' ilike ${pattern}
                    or outcome->>'name' ilike ${pattern}
                    or outcome->>'status' ilike ${pattern}
                )`,
              ),
            ),
          )
          .orderBy(desc(assistantMessages.sequence))
          .limit(limit + 1);

        const budget = sourceValidationBudget();

        const hits: AssistantHistoryHit[] = [];

        let omittedCount = 0;

        let consumed = 0;

        // Reserve room for cursor/envelope so the serialized result stays bounded.
        let remainingBytes = PAGE_BYTE_LIMIT - 2_048;

        for (const row of rows.slice(0, limit)) {
          const sources = preservedSources([
            ...row.sources,
            ...row.tools.flatMap((tool) => tool.sources),
          ]);

          if (row.role === "assistant") {
            try {
              await validateSources(tx, principal, workspaceId, sources, budget);
            } catch (error) {
              if (
                error instanceof WorkspaceError &&
                ["not_found", "conflict", "forbidden"].includes(error.code)
              ) {
                consumed += 1;
                omittedCount += 1;

                continue;
              }

              throw error;
            }
          }

          const literal = search.toLowerCase();

          const matchingTools = row.tools.filter((tool) =>
            [tool.name, tool.status, tool.summary].some((value) =>
              value.toLowerCase().includes(literal),
            ),
          );

          const selectedTools = (matchingTools.length > 0 ? matchingTools : row.tools).slice(
            0,
            TOOL_HIT_LIMIT,
          );

          const hit: AssistantHistoryHit = {
            id: row.id,
            threadId: row.threadId,
            turnId: row.turnId,
            role: row.role,
            createdAt: row.createdAt.toISOString(),
            text: row.text,
            textTruncated: row.textTruncated,
            tools: selectedTools.map((tool) => toolHit(tool, search)),
            toolsTruncated: row.tools.length > selectedTools.length,
            sources,
          };

          const bytes = new TextEncoder().encode(JSON.stringify(hit)).byteLength + 1;

          if (bytes > PAGE_BYTE_LIMIT - 2_048) {
            // A source-heavy result cannot be made safe by dropping provenance.
            // Consume it explicitly so repeated cursors cannot loop forever.
            consumed += 1;
            omittedCount += 1;

            continue;
          }

          if (bytes > remainingBytes) {
            break;
          }

          remainingBytes -= bytes;
          consumed += 1;
          hits.push(hit);
        }

        const last = rows[consumed - 1];

        return {
          hits,
          order: "newest-first",
          omittedCount,
          nextCursor:
            rows.length > consumed && last
              ? encodeCursor({
                  ...binding,
                  v: 1,
                  kind: "assistant-retrieval",
                  before: last.sequence,
                })
              : null,
        };
      });
    },
  };
}
