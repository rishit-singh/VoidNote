import { and, eq, isNull, sql } from "drizzle-orm";

import type { ResearchRunExecutionKey } from "../../contracts/research/runs";
import { WorkspaceError } from "../../contracts/workspace";
import { contactDetails } from "../contact-schema";
import type { Database } from "../repository";
import { researchAgentOperations } from "../research-agent-schema";
import { researchRuns } from "../research-runs-schema";
import { notes, people, workspaceMemberships, workspaces } from "../schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type ResearchAgentOperationKey = ResearchRunExecutionKey & { operationId: string };
export type ResearchAgentOperation = typeof researchAgentOperations.$inferSelect;

type OperationInput = {
  kind: "model" | "tool";
  /** Include native tool-call IDs here; the identity is immutable on replay. */
  payload: unknown;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function assertBound(value: unknown, maxBytes: number, label: string) {
  if (new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength > maxBytes) {
    throw new WorkspaceError("conflict", `Research operation ${label} exceeds its storage limit.`);
  }
}

async function lockLiveRun(tx: Transaction, key: ResearchRunExecutionKey) {
  const [hint] = await tx
    .select({
      actorId: researchRuns.actorId,
      noteId: researchRuns.noteId,
      personId: researchRuns.personId,
      personRevision: researchRuns.personRevision,
      contactRevision: researchRuns.contactRevision,
    })
    .from(researchRuns)
    .where(and(eq(researchRuns.workspaceId, key.workspaceId), eq(researchRuns.id, key.runId)))
    .limit(1);

  if (!hint) {
    return null;
  }

  const [membership] = await tx
    .select({ userId: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, key.workspaceId),
        eq(workspaceMemberships.userId, hint.actorId),
        isNull(workspaceMemberships.revokedAt),
        isNull(workspaces.deletedAt),
      ),
    )
    .for("share", { of: [workspaceMemberships, workspaces] })
    .limit(1);

  if (!membership) {
    return null;
  }

  if (hint.noteId) {
    const [note] = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(
        and(
          eq(notes.workspaceId, key.workspaceId),
          eq(notes.id, hint.noteId),
          isNull(notes.deletedAt),
        ),
      )
      .for("share")
      .limit(1);

    if (!note) {
      return null;
    }
  }

  if (hint.personId) {
    const [person] = await tx
      .select({ revision: people.revision })
      .from(people)
      .where(
        and(
          eq(people.workspaceId, key.workspaceId),
          eq(people.id, hint.personId),
          isNull(people.deletedAt),
        ),
      )
      .for("share")
      .limit(1);

    if (!person) {
      return null;
    }

    const [contact] = await tx
      .select({ revision: contactDetails.revision })
      .from(contactDetails)
      .where(
        and(
          eq(contactDetails.workspaceId, key.workspaceId),
          eq(contactDetails.personId, hint.personId),
        ),
      )
      .for("share")
      .limit(1);

    if (
      person.revision !== hint.personRevision ||
      (contact?.revision ?? 0) !== hint.contactRevision
    ) {
      return null;
    }
  }

  const [run] = await tx
    .select()
    .from(researchRuns)
    .where(and(eq(researchRuns.workspaceId, key.workspaceId), eq(researchRuns.id, key.runId)))
    .for("update")
    .limit(1);

  return run &&
    run.actorId === hint.actorId &&
    run.noteId === hint.noteId &&
    run.personId === hint.personId &&
    run.personRevision === hint.personRevision &&
    run.contactRevision === hint.contactRevision &&
    run.status === "running"
    ? run
    : null;
}

export function createResearchAgentOperationsRepository(db: Database | Transaction) {
  async function prepare(key: ResearchAgentOperationKey, input: OperationInput) {
    assertBound(input.payload, 50_000, "payload");

    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`research-agent:${key.workspaceId}:${key.runId}:${key.operationId}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(researchAgentOperations)
        .where(
          and(
            eq(researchAgentOperations.workspaceId, key.workspaceId),
            eq(researchAgentOperations.runId, key.runId),
            eq(researchAgentOperations.operationId, key.operationId),
          ),
        )
        .limit(1);

      if (existing) {
        if (
          existing.kind !== input.kind ||
          canonical(existing.payload) !== canonical(input.payload)
        ) {
          throw new WorkspaceError(
            "conflict",
            "Research operation ID was used with another payload.",
          );
        }

        return existing;
      }

      if (!(await lockLiveRun(tx, key))) {
        throw new WorkspaceError("conflict", "Research run is not accepting new operations.");
      }

      const [created] = await tx
        .insert(researchAgentOperations)
        .values({
          workspaceId: key.workspaceId,
          runId: key.runId,
          operationId: key.operationId,
          kind: input.kind,
          payload: input.payload,
        })
        .returning();

      return created;
    });
  }

  /** Only `claimed` authorizes external I/O. Submitted/uncertain are never reclaimed. */
  async function claim(key: ResearchAgentOperationKey) {
    return db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(researchAgentOperations)
        .where(
          and(
            eq(researchAgentOperations.workspaceId, key.workspaceId),
            eq(researchAgentOperations.runId, key.runId),
            eq(researchAgentOperations.operationId, key.operationId),
          ),
        )
        .for("update")
        .limit(1);

      if (!operation) {
        return { status: "missing" as const, operation: null };
      }

      if (operation.state === "completed") {
        return { status: "completed" as const, operation };
      }

      if (operation.state !== "pending" || !(await lockLiveRun(tx, key))) {
        return {
          status: operation.state === "uncertain" ? ("uncertain" as const) : ("blocked" as const),
          operation,
        };
      }

      const [claimed] = await tx
        .update(researchAgentOperations)
        .set({ state: "submitted", updatedAt: new Date() })
        .where(
          and(
            eq(researchAgentOperations.workspaceId, key.workspaceId),
            eq(researchAgentOperations.runId, key.runId),
            eq(researchAgentOperations.operationId, key.operationId),
            eq(researchAgentOperations.state, "pending"),
          ),
        )
        .returning();

      return claimed
        ? { status: "claimed" as const, operation: claimed }
        : { status: "blocked" as const, operation };
    });
  }

  async function complete(
    key: ResearchAgentOperationKey,
    input: { result: unknown; usage?: unknown },
  ) {
    assertBound(input.result, 100_000, "result");

    if (input.usage !== undefined && input.usage !== null) {
      assertBound(input.usage, 10_000, "usage");
    }

    return db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(researchAgentOperations)
        .where(
          and(
            eq(researchAgentOperations.workspaceId, key.workspaceId),
            eq(researchAgentOperations.runId, key.runId),
            eq(researchAgentOperations.operationId, key.operationId),
          ),
        )
        .for("update")
        .limit(1);

      if (!operation) {
        return null;
      }

      if (operation.state === "completed") {
        if (
          canonical(operation.result) !== canonical(input.result) ||
          canonical(operation.usage) !== canonical(input.usage ?? null)
        ) {
          throw new WorkspaceError(
            "conflict",
            "Completed research operation receipt is immutable.",
          );
        }

        return operation;
      }

      if (operation.state !== "submitted" && operation.state !== "uncertain") {
        return null;
      }

      const [saved] = await tx
        .update(researchAgentOperations)
        .set({
          state: "completed",
          result: input.result,
          usage: input.usage ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(researchAgentOperations.workspaceId, key.workspaceId),
            eq(researchAgentOperations.runId, key.runId),
            eq(researchAgentOperations.operationId, key.operationId),
            eq(researchAgentOperations.state, operation.state),
          ),
        )
        .returning();

      return saved ?? null;
    });
  }

  async function markUncertain(key: ResearchAgentOperationKey) {
    const [operation] = await db
      .update(researchAgentOperations)
      .set({ state: "uncertain", updatedAt: new Date() })
      .where(
        and(
          eq(researchAgentOperations.workspaceId, key.workspaceId),
          eq(researchAgentOperations.runId, key.runId),
          eq(researchAgentOperations.operationId, key.operationId),
          eq(researchAgentOperations.state, "submitted"),
        ),
      )
      .returning();

    return operation ?? null;
  }

  async function get(key: ResearchAgentOperationKey) {
    const [operation] = await db
      .select()
      .from(researchAgentOperations)
      .where(
        and(
          eq(researchAgentOperations.workspaceId, key.workspaceId),
          eq(researchAgentOperations.runId, key.runId),
          eq(researchAgentOperations.operationId, key.operationId),
        ),
      )
      .limit(1);

    return operation ?? null;
  }

  async function pendingSettlement(limit: number) {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(researchAgentOperations)
        .where(
          and(
            eq(researchAgentOperations.state, "completed"),
            sql`${researchAgentOperations.usage} is not null`,
            isNull(researchAgentOperations.usageSettledAt),
          ),
        )
        .orderBy(
          researchAgentOperations.updatedAt,
          researchAgentOperations.workspaceId,
          researchAgentOperations.runId,
          researchAgentOperations.operationId,
        )
        .limit(Math.max(1, Math.min(limit, 50)))
        .for("update", { skipLocked: true });

      for (const row of rows) {
        await tx
          .update(researchAgentOperations)
          .set({
            updatedAt: sql`greatest(clock_timestamp(), ${researchAgentOperations.updatedAt} + interval '1 millisecond')`,
          })
          .where(
            and(
              eq(researchAgentOperations.workspaceId, row.workspaceId),
              eq(researchAgentOperations.runId, row.runId),
              eq(researchAgentOperations.operationId, row.operationId),
              eq(researchAgentOperations.state, "completed"),
              isNull(researchAgentOperations.usageSettledAt),
            ),
          );
      }

      return rows;
    });
  }

  async function markUsageSettled(key: ResearchAgentOperationKey) {
    const [operation] = await db
      .update(researchAgentOperations)
      .set({ usageSettledAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(researchAgentOperations.workspaceId, key.workspaceId),
          eq(researchAgentOperations.runId, key.runId),
          eq(researchAgentOperations.operationId, key.operationId),
          eq(researchAgentOperations.state, "completed"),
          sql`${researchAgentOperations.usage} is not null`,
          isNull(researchAgentOperations.usageSettledAt),
        ),
      )
      .returning({ operationId: researchAgentOperations.operationId });

    return Boolean(operation);
  }

  return { prepare, claim, complete, markUncertain, get, pendingSettlement, markUsageSettled };
}
