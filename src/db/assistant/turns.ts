import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  type AssistantHistory,
  assistantHistoryInputSchema,
  type AssistantMessage,
  assistantMessageSchema,
  type AssistantThread,
  type AssistantTurn,
  openAssistantThreadSchema,
  sendAssistantTurnSchema,
} from "../../contracts/assistant";
import {
  assistantMemoryMutationSchema,
  assistantProfileMutationSchema,
} from "../../contracts/assistant/lineage";
import { idSchema, type Principal, WorkspaceError } from "../../contracts/workspace";
import {
  assistantArtifactPublications,
  assistantArtifacts,
  assistantMessages,
  assistantThreads,
  assistantTurns,
} from "../assistant-schema";
import type { Database } from "../repository";
import { notes } from "../schema";
import { verifiedMemorySupersessions } from "./lineage";
import { verifiedProfileSupersessions } from "./profile-lineage";
import {
  active,
  authorize,
  deterministicId,
  fingerprint,
  publicMessage,
  publicThread,
  publicTurn,
  requireNote,
  requireThread,
  requireTurn,
  sourceValidationBudget,
  type Transaction,
  turnScope,
  validateSources,
} from "./shared";

const cursorSchema = z.object({
  v: z.literal(1),
  workspaceId: idSchema,
  actorId: idSchema,
  threadId: idSchema,
  before: z.number().int().positive(),
});

const publicOutputSchema = assistantMessageSchema.pick({ text: true, tools: true, sources: true });

const outputSchema = publicOutputSchema.extend({
  memoryMutations: z.array(assistantMemoryMutationSchema).max(50).optional(),
  profileMutations: z.array(assistantProfileMutationSchema).max(50).optional(),
});

export type AssistantTurnOutput = z.infer<typeof outputSchema>;
const policySchema = z
  .json()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32_768,
    "Assistant policy exceeds its persisted byte bound",
  );

async function nextSequence(tx: Transaction, workspaceId: string, threadId: string) {
  const [last] = await tx
    .select({ sequence: assistantMessages.sequence })
    .from(assistantMessages)
    .where(
      and(eq(assistantMessages.workspaceId, workspaceId), eq(assistantMessages.threadId, threadId)),
    )
    .orderBy(desc(assistantMessages.sequence))
    .limit(1);

  return (last?.sequence ?? 0) + 1;
}

// Runtime methods never trust their previously captured Principal. Reconstruct
// ownership from the persisted turn, then recheck membership and note lifecycle.
async function executionRows(tx: Transaction, workspaceId: string, turnId: string, lock: boolean) {
  idSchema.parse(workspaceId);
  idSchema.parse(turnId);
  const [candidate] = await tx
    .select({ actorId: assistantTurns.actorId })
    .from(assistantTurns)
    .where(turnScope(workspaceId, turnId))
    .limit(1);

  if (!candidate) {
    return null;
  }

  const principal: Principal = { id: candidate.actorId, email: null };

  try {
    await authorize(tx, principal, workspaceId);
    const rows = await requireTurn(tx, principal, workspaceId, turnId, lock);

    return { principal, ...rows };
  } catch (error) {
    if (
      error instanceof WorkspaceError &&
      (error.code === "not_found" || error.code === "forbidden")
    ) {
      // Retire inaccessible work so the bounded dispatcher cannot be starved by
      // a deleted note or revoked member. Never publish its output.
      await tx
        .update(assistantTurns)
        .set({
          status: "interrupted",
          error: "Conversation access is no longer available",
          updatedAt: new Date(),
        })
        .where(
          and(
            turnScope(workspaceId, turnId),
            inArray(assistantTurns.status, ["queued", "running"]),
          ),
        );

      return null;
    }

    throw error;
  }
}

export function createTurnOperations(db: Database) {
  return {
    async openThread(
      principal: Principal,
      workspaceId: string,
      threadId: string,
      noteId: string | null,
    ): Promise<AssistantThread> {
      openAssistantThreadSchema.parse({ workspaceId, threadId, noteId });

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);

        if (noteId) {
          await requireNote(tx, workspaceId, noteId);
        }

        await tx
          .insert(assistantThreads)
          .values({ workspaceId, id: threadId, actorId: principal.id, noteId })
          .onConflictDoNothing();
        const thread = await requireThread(tx, principal, workspaceId, threadId);

        if (thread.noteId !== noteId) {
          throw new WorkspaceError("command_reused", "Conversation ID has a different scope");
        }

        return publicThread(thread);
      });
    },

    async listThreads(
      principal: Principal,
      workspaceId: string,
      noteId?: string,
    ): Promise<AssistantThread[]> {
      if (noteId) {
        idSchema.parse(noteId);
      }

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);

        if (noteId) {
          await requireNote(tx, workspaceId, noteId);
        }

        const rows = await tx
          .select({ thread: assistantThreads })
          .from(assistantThreads)
          .leftJoin(
            notes,
            and(eq(notes.workspaceId, workspaceId), eq(notes.id, assistantThreads.noteId)),
          )
          .where(
            and(
              eq(assistantThreads.workspaceId, workspaceId),
              eq(assistantThreads.actorId, principal.id),
              noteId ? eq(assistantThreads.noteId, noteId) : undefined,
              or(isNull(assistantThreads.noteId), isNull(notes.deletedAt)),
            ),
          )
          .orderBy(desc(assistantThreads.updatedAt), desc(assistantThreads.id))
          .limit(100);

        return rows.map(({ thread }) => publicThread(thread));
      });
    },

    async contextHistory(
      workspaceId: string,
      threadId: string,
      limit = 30,
    ): Promise<AssistantMessage[]> {
      idSchema.parse(workspaceId);
      idSchema.parse(threadId);
      z.number().int().min(1).max(50).parse(limit);

      return db.transaction(async (tx) => {
        const [candidate] = await tx
          .select({ actorId: assistantThreads.actorId })
          .from(assistantThreads)
          .where(
            and(eq(assistantThreads.workspaceId, workspaceId), eq(assistantThreads.id, threadId)),
          )
          .limit(1);

        if (!candidate) {
          throw new WorkspaceError("not_found", "Conversation not found");
        }

        const principal: Principal = { id: candidate.actorId, email: null };

        await authorize(tx, principal, workspaceId);
        await requireThread(tx, principal, workspaceId, threadId);
        await tx
          .select({ id: assistantThreads.id })
          .from(assistantThreads)
          .where(
            and(eq(assistantThreads.workspaceId, workspaceId), eq(assistantThreads.id, threadId)),
          )
          .for("share");

        const rows = await tx
          .select()
          .from(assistantMessages)
          .where(
            and(
              eq(assistantMessages.workspaceId, workspaceId),
              eq(assistantMessages.threadId, threadId),
            ),
          )
          .orderBy(desc(assistantMessages.sequence))
          .limit(limit);

        // Published replies are historical conversation, not newly retrieved
        // evidence. Keep their original metadata for audit; current evidence is
        // checked separately when retrieved and when a new reply is published.
        return rows.map(publicMessage).reverse();
      });
    },

    async history(
      principal: Principal,
      workspaceId: string,
      threadId: string,
      cursor?: string,
      limit = 30,
    ): Promise<AssistantHistory> {
      assistantHistoryInputSchema.parse({ workspaceId, threadId, cursor, limit });
      let before: number | undefined;

      if (cursor !== undefined) {
        try {
          const decoded = cursorSchema.parse(
            JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))) as unknown,
          );

          if (
            decoded.workspaceId !== workspaceId ||
            decoded.actorId !== principal.id ||
            decoded.threadId !== threadId
          ) {
            throw new Error("Cursor scope changed");
          }

          before = decoded.before;
        } catch {
          throw new WorkspaceError("invalid_cursor", "Invalid conversation cursor");
        }
      }

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        // A shared thread lock makes messages and active turn one consistent
        // snapshot, while commands serialize through its update lock.
        await requireThread(tx, principal, workspaceId, threadId);
        const [thread] = await tx
          .select()
          .from(assistantThreads)
          .where(
            and(eq(assistantThreads.workspaceId, workspaceId), eq(assistantThreads.id, threadId)),
          )
          .for("share");

        const rows = await tx
          .select()
          .from(assistantMessages)
          .where(
            and(
              eq(assistantMessages.workspaceId, workspaceId),
              eq(assistantMessages.threadId, threadId),
              before === undefined ? undefined : lt(assistantMessages.sequence, before),
            ),
          )
          .orderBy(desc(assistantMessages.sequence))
          .limit(limit + 1);

        const [turn] = await tx
          .select()
          .from(assistantTurns)
          .where(
            and(
              eq(assistantTurns.workspaceId, workspaceId),
              eq(assistantTurns.threadId, threadId),
              inArray(assistantTurns.status, ["queued", "running"]),
            ),
          )
          .limit(1);

        // Acceptance sequence, rather than wall-clock ties or completion time,
        // identifies the latest user turn deterministically.
        const [latest] = await tx
          .select({ turn: assistantTurns })
          .from(assistantTurns)
          .innerJoin(
            assistantMessages,
            and(
              eq(assistantMessages.workspaceId, workspaceId),
              eq(assistantMessages.turnId, assistantTurns.id),
              eq(assistantMessages.role, "user"),
            ),
          )
          .where(
            and(eq(assistantTurns.workspaceId, workspaceId), eq(assistantTurns.threadId, threadId)),
          )
          .orderBy(desc(assistantMessages.sequence))
          .limit(1);

        const page = rows.slice(0, limit);

        const oldest = page.at(-1);

        return {
          thread: publicThread(thread!),
          messages: page.reverse().map(publicMessage),
          activeTurn: turn ? publicTurn(turn) : null,
          latestTurn: latest ? publicTurn(latest.turn) : null,
          nextCursor:
            rows.length > limit && oldest
              ? btoa(
                  JSON.stringify({
                    v: 1,
                    workspaceId,
                    actorId: principal.id,
                    threadId,
                    before: oldest.sequence,
                  }),
                )
                  .replaceAll("+", "-")
                  .replaceAll("/", "_")
                  .replace(/=+$/, "")
              : null,
        };
      });
    },

    async requestTurn(
      principal: Principal,
      workspaceId: string,
      threadId: string,
      turnId: string,
      text: string,
      policy: unknown,
    ): Promise<AssistantTurn> {
      const input = sendAssistantTurnSchema.parse({ workspaceId, threadId, turnId, text });

      const hash = fingerprint({ actorId: principal.id, ...input });

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        const thread = await requireThread(tx, principal, workspaceId, threadId, true);

        const [previous] = await tx
          .select()
          .from(assistantTurns)
          .where(turnScope(workspaceId, turnId))
          .limit(1);

        if (previous) {
          if (previous.actorId !== principal.id || previous.fingerprint !== hash) {
            throw new WorkspaceError("command_reused", "Turn ID was used for different inputs");
          }

          return publicTurn(previous);
        }

        if (policy === null || policy === undefined) {
          throw new WorkspaceError("service_unavailable", "Assistant inference is disabled");
        }

        const pinnedPolicy = policySchema.parse(policy);

        const [pending] = await tx
          .select({ id: assistantTurns.id })
          .from(assistantTurns)
          .where(
            and(
              eq(assistantTurns.workspaceId, workspaceId),
              eq(assistantTurns.threadId, threadId),
              inArray(assistantTurns.status, ["queued", "running"]),
            ),
          )
          .limit(1);

        if (pending) {
          throw new WorkspaceError("conflict", "Wait for the active assistant turn");
        }

        const now = new Date();

        const [turn] = await tx
          .insert(assistantTurns)
          .values({
            workspaceId,
            id: turnId,
            actorId: principal.id,
            threadId,
            text: input.text,
            policy: pinnedPolicy,
            fingerprint: hash,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning();

        if (!turn) {
          // Same ID concurrently accepted in another thread; no UUID-existence
          // details are exposed and this transaction has no accepted message.
          throw new WorkspaceError("command_reused", "Turn ID was used for different inputs");
        }

        await tx.insert(assistantMessages).values({
          workspaceId,
          id: deterministicId(workspaceId, turnId, "user-message"),
          threadId,
          turnId,
          role: "user",
          text: input.text,
          sequence: await nextSequence(tx, workspaceId, threadId),
          createdAt: now,
        });
        await tx
          .update(assistantThreads)
          .set({
            title: thread.title === "New conversation" ? input.text.slice(0, 100) : thread.title,
            updatedAt: now,
          })
          .where(
            and(eq(assistantThreads.workspaceId, workspaceId), eq(assistantThreads.id, threadId)),
          );

        return publicTurn(turn);
      });
    },

    async getTurn(principal: Principal, workspaceId: string, turnId: string) {
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);

        return publicTurn((await requireTurn(tx, principal, workspaceId, turnId)).turn);
      });
    },

    async cancelTurn(principal: Principal, workspaceId: string, turnId: string) {
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        const { turn } = await requireTurn(tx, principal, workspaceId, turnId, true);

        if (!active(turn)) {
          return publicTurn(turn);
        }

        const [cancelled] = await tx
          .update(assistantTurns)
          .set({ status: "cancelled", error: null, updatedAt: new Date() })
          .where(turnScope(workspaceId, turnId))
          .returning();

        await tx
          .update(assistantArtifactPublications)
          .set({ cancelledAt: new Date() })
          .where(
            and(
              eq(assistantArtifactPublications.workspaceId, workspaceId),
              isNull(assistantArtifactPublications.publishedAt),
              inArray(
                assistantArtifactPublications.artifactId,
                tx
                  .select({ id: assistantArtifacts.id })
                  .from(assistantArtifacts)
                  .where(
                    and(
                      eq(assistantArtifacts.workspaceId, workspaceId),
                      eq(assistantArtifacts.turnId, turnId),
                    ),
                  ),
              ),
            ),
          );

        return publicTurn(cancelled!);
      });
    },

    async execution(workspaceId: string, turnId: string) {
      return db.transaction(async (tx) => {
        const execution = await executionRows(tx, workspaceId, turnId, false);

        if (!execution) {
          return null;
        }

        return {
          principal: execution.principal,
          thread: publicThread(execution.thread),
          turn: publicTurn(execution.turn),
          text: execution.turn.text,
          policy: execution.turn.policy,
        };
      });
    },

    async beginTurn(workspaceId: string, turnId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const execution = await executionRows(tx, workspaceId, turnId, true);

        if (!execution || execution.turn.status !== "queued") {
          return false;
        }

        const [started] = await tx
          .update(assistantTurns)
          .set({ status: "running", updatedAt: new Date() })
          .where(and(turnScope(workspaceId, turnId), eq(assistantTurns.status, "queued")))
          .returning({ id: assistantTurns.id });

        return !!started;
      });
    },

    async completeTurn(workspaceId: string, turnId: string, value: AssistantTurnOutput) {
      const output = outputSchema.parse(value);

      // Tool schemas bound each result, and this aggregate cap bounds the complete
      // SQL publication independently of future tool count configuration.
      if (new TextEncoder().encode(JSON.stringify(output)).byteLength > 1_048_576) {
        throw new WorkspaceError("conflict", "Assistant output exceeds the publication limit");
      }

      const hash = fingerprint(output);

      return db.transaction(async (tx) => {
        const execution = await executionRows(tx, workspaceId, turnId, true);

        if (!execution) {
          return null;
        }

        const { principal, thread, turn } = execution;

        if (turn.status === "succeeded") {
          if (turn.outputFingerprint !== hash) {
            throw new WorkspaceError("command_reused", "Turn already has a different output");
          }

          return publicTurn(turn);
        }

        if (turn.status !== "running") {
          return publicTurn(turn);
        }

        // This cache lives only for this locked publication transaction. Its
        // verified supersession maps remain fixed throughout source validation.
        const budget = sourceValidationBudget(true);

        budget.memorySupersessions = await verifiedMemorySupersessions(
          tx,
          principal,
          workspaceId,
          turnId,
          output.memoryMutations ?? [],
          output.tools,
        );
        budget.profileSupersessions = await verifiedProfileSupersessions(
          tx,
          principal,
          workspaceId,
          turnId,
          output.profileMutations ?? [],
          output.tools,
        );
        const sources = await validateSources(tx, principal, workspaceId, output.sources, budget);

        const tools = [];

        for (const tool of output.tools) {
          tools.push({
            ...tool,
            sources: await validateSources(tx, principal, workspaceId, tool.sources, budget),
          });
        }

        const published = publicOutputSchema.safeParse({ text: output.text, tools, sources });

        if (!published.success) {
          throw new WorkspaceError("conflict", "Reconciled reply exceeds its source bounds");
        }

        const now = new Date();

        await tx.insert(assistantMessages).values({
          workspaceId,
          id: deterministicId(workspaceId, turnId, "assistant-message"),
          threadId: thread.id,
          turnId,
          role: "assistant",
          ...published.data,
          sequence: await nextSequence(tx, workspaceId, thread.id),
          createdAt: now,
        });
        const [completed] = await tx
          .update(assistantTurns)
          .set({ status: "succeeded", outputFingerprint: hash, error: null, updatedAt: now })
          .where(turnScope(workspaceId, turnId))
          .returning();

        await tx
          .update(assistantThreads)
          .set({ updatedAt: now })
          .where(
            and(eq(assistantThreads.workspaceId, workspaceId), eq(assistantThreads.id, thread.id)),
          );

        return publicTurn(completed!);
      });
    },

    async failTurn(
      workspaceId: string,
      turnId: string,
      status: "failed" | "interrupted",
      error: string,
    ) {
      z.enum(["failed", "interrupted"]).parse(status);
      const message = z.string().parse(error).slice(0, 1000);

      return db.transaction(async (tx) => {
        const execution = await executionRows(tx, workspaceId, turnId, true);

        if (!execution) {
          return null;
        }

        if (!active(execution.turn)) {
          return publicTurn(execution.turn);
        }

        const [failed] = await tx
          .update(assistantTurns)
          .set({ status, error: message, updatedAt: new Date() })
          .where(turnScope(workspaceId, turnId))
          .returning();

        return publicTurn(failed!);
      });
    },

    async pendingTurns(limit = 20) {
      z.number().int().min(1).max(100).parse(limit);

      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(assistantTurns)
          .where(
            or(
              inArray(assistantTurns.status, ["queued", "running"]),
              and(
                eq(assistantTurns.status, "cancelled"),
                isNull(assistantTurns.cancellationDispatchedAt),
              ),
            ),
          )
          .orderBy(
            asc(sql`coalesce(${assistantTurns.dispatchCheckedAt}, ${assistantTurns.createdAt})`),
            asc(assistantTurns.workspaceId),
            asc(assistantTurns.id),
          )
          .limit(limit)
          .for("update", { skipLocked: true });

        // Persist scan rotation before external dispatch, including failed checks.
        // No thread lock here: dispatch never takes lifecycle locks while owning
        // turn rows, so it cannot invert the publication lock order.
        for (const row of rows) {
          await tx
            .update(assistantTurns)
            .set({ dispatchCheckedAt: new Date() })
            .where(turnScope(row.workspaceId, row.id));
        }

        return rows.map((row) => ({
          workspaceId: row.workspaceId,
          turnId: row.id,
          status: row.status,
        }));
      });
    },

    async acknowledgeCancellation(workspaceId: string, turnId: string) {
      idSchema.parse(workspaceId);
      idSchema.parse(turnId);
      await db
        .update(assistantTurns)
        .set({ cancellationDispatchedAt: new Date() })
        .where(and(turnScope(workspaceId, turnId), eq(assistantTurns.status, "cancelled")));
    },
  };
}
