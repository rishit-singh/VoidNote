import { and, eq } from "drizzle-orm";

import type { AssistantToolResult } from "../../contracts/assistant";
import type { AssistantMemoryMutation } from "../../contracts/assistant/lineage";
import { type Principal, WorkspaceError } from "../../contracts/workspace";
import { assistantMemoryRevisions, assistantOperationReceipts } from "../assistant-schema";
import { fingerprint, type MemorySupersession, type Transaction } from "./shared";

/** A completion cannot grant itself an exception to source validation. Verify
 * exact acknowledged inputs against receipts bound to this actor and turn, then
 * allow only a contiguous sequence of those mutations ending at today's revision.
 */
export async function verifiedMemorySupersessions(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  turnId: string,
  mutations: AssistantMemoryMutation[],
  tools: AssistantToolResult[],
): Promise<Map<string, MemorySupersession>> {
  const groups = new Map<
    string,
    Array<{
      before: number;
      after: number;
      status: string;
      label: string;
    }>
  >();

  for (const mutation of mutations) {
    const tool = tools.find((entry) => entry.id === mutation.operationId);

    if (tool?.status !== "succeeded" || tool.name !== mutation.name) {
      throw new WorkspaceError("conflict", "Memory supersession requires an acknowledged mutation");
    }

    const { memoryId: id, ...values } = mutation.input;

    const kind = mutation.name === "memory_revise" ? "revise-memory" : "invalidate-memory";

    const input = { id, ...values, operationId: mutation.operationId };

    const hash = fingerprint({
      actorId: principal.id,
      workspaceId,
      kind,
      version: 1,
      input,
      turnId,
    });

    const [receipt] = await tx
      .select()
      .from(assistantOperationReceipts)
      .where(
        and(
          eq(assistantOperationReceipts.workspaceId, workspaceId),
          eq(assistantOperationReceipts.operationId, mutation.operationId),
        ),
      )
      .limit(1);

    const [revision] = await tx
      .select()
      .from(assistantMemoryRevisions)
      .where(
        and(
          eq(assistantMemoryRevisions.workspaceId, workspaceId),
          eq(assistantMemoryRevisions.operationId, mutation.operationId),
        ),
      )
      .limit(1);

    if (
      !receipt ||
      receipt.actorId !== principal.id ||
      receipt.kind !== kind ||
      receipt.resultId !== id ||
      receipt.fingerprint !== hash ||
      !revision ||
      revision.actorId !== principal.id ||
      revision.memoryId !== id ||
      revision.before?.revision !== mutation.input.expectedRevision ||
      revision.after.revision !== mutation.input.expectedRevision + 1
    ) {
      throw new WorkspaceError("conflict", "Memory supersession receipt does not match this turn");
    }

    const group = groups.get(id) ?? [];

    group.push({
      before: revision.before.revision,
      after: revision.after.revision,
      status: revision.after.status,
      label: revision.after.kind,
    });
    groups.set(id, group);
  }

  const supersessions = new Map<string, MemorySupersession>();

  for (const [id, revisions] of groups) {
    revisions.sort((a, b) => a.before - b.before);
    const final = revisions.at(-1)!;

    if (
      (final.status !== "active" && final.status !== "invalidated") ||
      revisions.some((entry, index) => index > 0 && revisions[index - 1]!.after !== entry.before)
    ) {
      throw new WorkspaceError("conflict", "Memory changed after the acknowledged mutation");
    }

    supersessions.set(id, {
      revisions: new Set(revisions.map((entry) => entry.before)),
      revision: final.after,
      status: final.status,
      replacement:
        final.status === "active"
          ? [{ kind: "memory", id, label: final.label, revision: final.after }]
          : [],
    });
  }

  return supersessions;
}
