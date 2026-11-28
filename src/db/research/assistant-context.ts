import { and, eq, isNull } from "drizzle-orm";

import { idSchema, type Principal, WorkspaceError } from "../../contracts/workspace";
import { assistantThreads, assistantTurns } from "../assistant-schema";
import type { Database } from "../repository";
import { notes } from "../schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Called after the research transaction locks membership/workspace. Match the
 * assistant's lifecycle order: note -> thread -> turn. In particular, never
 * acquire the research command lock first and then upgrade assistant authority.
 */
export async function lockResearchOriginTurn(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  turnId: string,
) {
  idSchema.parse(turnId);

  const turnScope = and(
    eq(assistantTurns.workspaceId, workspaceId),
    eq(assistantTurns.id, turnId),
    eq(assistantTurns.actorId, principal.id),
  );

  const [candidate] = await tx
    .select({ threadId: assistantTurns.threadId })
    .from(assistantTurns)
    .where(turnScope)
    .limit(1);

  if (!candidate) {
    throw new WorkspaceError("not_found", "Assistant turn not found.");
  }

  const threadScope = and(
    eq(assistantThreads.workspaceId, workspaceId),
    eq(assistantThreads.id, candidate.threadId),
    eq(assistantThreads.actorId, principal.id),
  );

  const [threadHint] = await tx
    .select({ noteId: assistantThreads.noteId })
    .from(assistantThreads)
    .where(threadScope)
    .limit(1);

  if (!threadHint) {
    throw new WorkspaceError("not_found", "Assistant conversation not found.");
  }

  if (threadHint.noteId) {
    const [note] = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(
        and(
          eq(notes.workspaceId, workspaceId),
          eq(notes.id, threadHint.noteId),
          isNull(notes.deletedAt),
        ),
      )
      .for("share")
      .limit(1);

    if (!note) {
      throw new WorkspaceError("not_found", "Assistant note is unavailable.");
    }
  }

  const [thread] = await tx
    .select({ noteId: assistantThreads.noteId })
    .from(assistantThreads)
    .where(threadScope)
    .for("update")
    .limit(1);

  if (!thread || thread.noteId !== threadHint.noteId) {
    throw new WorkspaceError("conflict", "Assistant conversation scope changed.");
  }

  // Re-read status after the lifecycle locks. A cancellation that committed
  // while this transaction waited must win over the earlier candidate read.
  const [turn] = await tx
    .select({ status: assistantTurns.status })
    .from(assistantTurns)
    .where(and(turnScope, eq(assistantTurns.threadId, candidate.threadId)))
    .for("update")
    .limit(1);

  if (!turn) {
    throw new WorkspaceError("not_found", "Assistant turn not found.");
  }

  return turn;
}
