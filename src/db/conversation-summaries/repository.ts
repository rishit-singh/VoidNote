import { and, asc, desc, eq, inArray, lte, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import type { AssistantSource } from "../../contracts/assistant";
import {
  buildConversationSummaryPrompt,
  type ConversationSummary,
  type ConversationSummaryExecution,
  type ConversationSummaryPolicy,
  conversationSummaryPolicySchema,
  conversationSummarySchema,
} from "../../contracts/conversation-summaries";
import { idSchema, type Principal, WorkspaceError } from "../../contracts/workspace";
import {
  authorize,
  deterministicId,
  requireThread,
  sourceValidationBudget,
  type Transaction,
  validateSources,
} from "../assistant/shared";
import { assistantMessages, assistantThreads, assistantTurns } from "../assistant-schema";
import { conversationSummaryJobs, conversationSummaryScans } from "../conversation-summary-schema";
import { inferenceReceipts } from "../inference-schema";
import type { Database } from "../repository";

export type Key = { workspaceId: string; threadId: string; jobId: string };
export type PendingKey = Key & { recoveryOnly?: true };

type Job = typeof conversationSummaryJobs.$inferSelect;

const MAX_SNAPSHOT_MESSAGES = 50;

const DISCOVERY_LOCK = "voidnote:conversation-summary:discovery-v1";

const keySchema = z.object({ workspaceId: idSchema, threadId: idSchema, jobId: idSchema });

const active = (job: Job) => job.status === "queued" || job.status === "running";

const jobScope = (key: Key) =>
  and(
    eq(conversationSummaryJobs.workspaceId, key.workspaceId),
    eq(conversationSummaryJobs.threadId, key.threadId),
    eq(conversationSummaryJobs.id, key.jobId),
  );

const threadScope = (workspaceId: string, threadId: string) =>
  and(eq(assistantMessages.workspaceId, workspaceId), eq(assistantMessages.threadId, threadId));

function keyOf(job: Job): Key {
  return { workspaceId: job.workspaceId, threadId: job.threadId, jobId: job.id };
}

function publicSummary(job: Job): ConversationSummary {
  return conversationSummarySchema.parse({
    id: job.id,
    threadId: job.threadId,
    status: job.status,
    fromSequence: job.fromSequence,
    throughSequence: job.throughSequence,
    messageCount: job.messageCount,
    // Original text is retained internally as an audit record after invalidation.
    text: job.status === "stale" ? null : job.text,
    sources: job.sources,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  });
}

function unavailable(error: unknown) {
  return (
    error instanceof WorkspaceError && ["forbidden", "not_found", "conflict"].includes(error.code)
  );
}

async function stale(tx: Transaction, key: Key) {
  await tx
    .update(conversationSummaryJobs)
    .set({
      status: "stale",
      error: "Conversation summary sources are no longer current",
      completedAt: new Date(),
    })
    .where(
      and(
        jobScope(key),
        inArray(conversationSummaryJobs.status, ["queued", "running", "succeeded"]),
      ),
    );
}

async function lockedJob(tx: Transaction, key: Key, validate = true): Promise<Job | null> {
  keySchema.parse(key);
  const [identity] = await tx
    .select({ actorId: conversationSummaryJobs.actorId })
    .from(conversationSummaryJobs)
    .where(jobScope(key))
    .limit(1);

  if (!identity) {
    return null;
  }

  const principal: Principal = { id: identity.actorId, email: null };

  try {
    // Same lock order as assistant writes: membership/workspace -> note -> thread
    // -> job. Dispatch scans only lock jobs and release them before runtime work.
    await authorize(tx, principal, key.workspaceId);
    await requireThread(tx, principal, key.workspaceId, key.threadId, true);
    const [job] = await tx
      .select()
      .from(conversationSummaryJobs)
      .where(jobScope(key))
      .for("update")
      .limit(1);

    if (!job) {
      return null;
    }

    if (validate && (active(job) || job.status === "succeeded")) {
      await validateSources(tx, principal, key.workspaceId, job.sources);
    }

    return job;
  } catch (error) {
    if (unavailable(error)) {
      await stale(tx, key);

      return null;
    }

    throw error;
  }
}

async function latestCutoff(tx: Transaction, workspaceId: string, threadId: string) {
  const [accepted] = await tx
    .select({ through: conversationSummaryJobs.throughSequence })
    .from(conversationSummaryJobs)
    .where(
      and(
        eq(conversationSummaryJobs.workspaceId, workspaceId),
        eq(conversationSummaryJobs.threadId, threadId),
      ),
    )
    .orderBy(desc(conversationSummaryJobs.throughSequence))
    .limit(1);

  // Failed and stale accepted ranges count too; inference needs a new range,
  // never an automatic retry of the same failed input on every scheduled scan.
  return accepted?.through ?? 0;
}

async function candidatePage(db: Database, limit: number) {
  return db.transaction(async (tx) => {
    // Serialize only the short identity-page claim, never snapshot validation or
    // job acceptance. The existing checked-at index is the durable scan cursor.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${DISCOVERY_LOCK}, 0))`);
    const [cursor] = await tx
      .select()
      .from(conversationSummaryScans)
      .orderBy(
        desc(conversationSummaryScans.checkedAt),
        desc(conversationSummaryScans.workspaceId),
        desc(conversationSummaryScans.threadId),
      )
      .limit(1);

    const page = (where: SQL | undefined, count: number) =>
      tx
        .select({
          workspaceId: assistantThreads.workspaceId,
          threadId: assistantThreads.id,
          actorId: assistantThreads.actorId,
        })
        .from(assistantThreads)
        .where(where)
        .orderBy(asc(assistantThreads.workspaceId), asc(assistantThreads.id))
        .limit(count);

    const after = cursor
      ? sql`(${assistantThreads.workspaceId}, ${assistantThreads.id}) > (${cursor.workspaceId}::uuid, ${cursor.threadId}::uuid)`
      : undefined;

    const rows = await page(after, limit);

    if (cursor && rows.length < limit) {
      rows.push(
        ...(await page(
          sql`(${assistantThreads.workspaceId}, ${assistantThreads.id}) <= (${cursor.workspaceId}::uuid, ${cursor.threadId}::uuid)`,
          limit - rows.length,
        )),
      );
    }

    if (rows.length === 0) {
      return rows;
    }

    const checkedAt = Math.max(Date.now(), (cursor?.checkedAt.getTime() ?? 0) + 1);

    // Commit rotation for the entire bounded page before attempting any
    // candidate. Monotonic per-row times preserve the cursor across wraparound.
    await tx
      .insert(conversationSummaryScans)
      .values(
        rows.map((row, index) => ({
          workspaceId: row.workspaceId,
          threadId: row.threadId,
          checkedAt: new Date(checkedAt + index),
        })),
      )
      .onConflictDoUpdate({
        target: [conversationSummaryScans.workspaceId, conversationSummaryScans.threadId],
        set: { checkedAt: sql`excluded.checked_at` },
      });

    return rows;
  });
}

async function snapshot(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  threadId: string,
  throughSequence: number,
  policy: ConversationSummaryPolicy,
) {
  const rows = await tx
    .select({
      id: assistantMessages.id,
      role: assistantMessages.role,
      text: sql<string | null>`case
        when octet_length(${assistantMessages.text}) <= ${policy.maxInputBytes}
        then ${assistantMessages.text}
        else null
      end`,
      sequence: assistantMessages.sequence,
    })
    .from(assistantMessages)
    .where(
      and(threadScope(workspaceId, threadId), lte(assistantMessages.sequence, throughSequence)),
    )
    .orderBy(desc(assistantMessages.sequence))
    // Each included message retains a direct reference, including user statements.
    // Read/validate at most fifty candidates even when some are stale.
    .limit(Math.min(policy.maxMessages, MAX_SNAPSHOT_MESSAGES));

  const messages: ConversationSummaryExecution["messages"] = [];

  const sources: AssistantSource[] = [];

  const budget = sourceValidationBudget();

  let fromSequence = throughSequence;

  let inputBytes = 0;

  for (const row of rows) {
    // Apply the size check inside the bounded projection, not WHERE before
    // LIMIT: a long oversized tail must not cause an unbounded history walk.
    if (row.text === null) {
      continue;
    }

    const source: AssistantSource = {
      kind: "message",
      id: row.id,
      label: `Conversation message ${row.sequence}`,
    };

    const message = { id: row.id, role: row.role, text: row.text };

    const bytes = buildConversationSummaryPrompt({
      policy,
      messages: [...messages, message].reverse(),
    }).inputBytes;

    if (bytes > policy.maxInputBytes) {
      continue;
    }

    try {
      await validateSources(tx, principal, workspaceId, [source], budget);
    } catch (error) {
      if (unavailable(error)) {
        continue;
      }

      throw error;
    }

    messages.push(message);
    sources.push(source);
    fromSequence = row.sequence;
    inputBytes = bytes;
  }

  return {
    messages: messages.reverse(),
    sources: sources.reverse(),
    fromSequence,
    inputBytes,
  };
}

export function createConversationSummaryRepository(db: Database) {
  async function latest(
    principal: Principal,
    workspaceId: string,
    threadId: string,
  ): Promise<ConversationSummary | null> {
    return db.transaction(async (tx) => {
      await authorize(tx, principal, workspaceId);
      await requireThread(tx, principal, workspaceId, threadId);
      const [job] = await tx
        .select()
        .from(conversationSummaryJobs)
        .where(
          and(
            eq(conversationSummaryJobs.workspaceId, workspaceId),
            eq(conversationSummaryJobs.threadId, threadId),
          ),
        )
        .orderBy(desc(conversationSummaryJobs.throughSequence))
        .limit(1);

      if (!job) {
        return null;
      }

      // A read returns the stored job status or historical summary snapshot.
      // Execution/publication own current-evidence checks and status changes;
      // polling or loading conversation context must not revalidate old claims.
      return publicSummary(job);
    });
  }

  return {
    latest,

    async contextSummary(
      workspaceId: string,
      threadId: string,
    ): Promise<ConversationSummary | null> {
      idSchema.parse(workspaceId);
      idSchema.parse(threadId);
      const [thread] = await db
        .select({ actorId: assistantThreads.actorId })
        .from(assistantThreads)
        .where(
          and(eq(assistantThreads.workspaceId, workspaceId), eq(assistantThreads.id, threadId)),
        )
        .limit(1);

      if (!thread) {
        return null;
      }

      try {
        return await latest({ id: thread.actorId, email: null }, workspaceId, threadId);
      } catch (error) {
        if (unavailable(error)) {
          return null;
        }

        throw error;
      }
    },

    async enqueueIdle(policyValue: ConversationSummaryPolicy, limit = 10): Promise<Key[]> {
      const policy = conversationSummaryPolicySchema.parse(policyValue);

      z.number().int().min(1).max(100).parse(limit);
      const cutoff = new Date(Date.now() - policy.idleMs);

      const candidates = await candidatePage(db, limit);

      const keys: Key[] = [];

      for (const candidate of candidates) {
        try {
          const key = await db.transaction(async (tx) => {
            const principal: Principal = { id: candidate.actorId, email: null };

            try {
              await authorize(tx, principal, candidate.workspaceId);
              await requireThread(tx, principal, candidate.workspaceId, candidate.threadId, true);
            } catch (error) {
              if (unavailable(error)) {
                return null;
              }

              throw error;
            }

            const acceptedThrough = await latestCutoff(
              tx,
              candidate.workspaceId,
              candidate.threadId,
            );

            const newMessages = await tx
              .select({
                sequence: assistantMessages.sequence,
                createdAt: assistantMessages.createdAt,
              })
              .from(assistantMessages)
              .where(
                and(
                  threadScope(candidate.workspaceId, candidate.threadId),
                  sql`${assistantMessages.sequence} > ${acceptedThrough}`,
                ),
              )
              .orderBy(desc(assistantMessages.sequence))
              .limit(policy.minNewMessages);

            const [turn] = await tx
              .select({ id: assistantTurns.id })
              .from(assistantTurns)
              .where(
                and(
                  eq(assistantTurns.workspaceId, candidate.workspaceId),
                  eq(assistantTurns.threadId, candidate.threadId),
                  sql`${assistantTurns.status} in ('queued', 'running')`,
                ),
              )
              .limit(1);

            if (
              turn ||
              newMessages.length < policy.minNewMessages ||
              newMessages.some((message) => message.createdAt > cutoff)
            ) {
              return null;
            }

            const throughSequence = newMessages[0]!.sequence;

            const source = await snapshot(
              tx,
              principal,
              candidate.workspaceId,
              candidate.threadId,
              throughSequence,
              policy,
            );

            if (source.messages.length === 0) {
              return null;
            }

            const id = deterministicId(
              candidate.workspaceId,
              candidate.threadId,
              `conversation-summary:${throughSequence}`,
            );

            const [job] = await tx
              .insert(conversationSummaryJobs)
              .values({
                workspaceId: candidate.workspaceId,
                threadId: candidate.threadId,
                id,
                actorId: candidate.actorId,
                fromSequence: source.fromSequence,
                throughSequence,
                messageCount: source.messages.length,
                messages: source.messages,
                sources: source.sources,
                inputBytes: source.inputBytes,
                policy,
              })
              .onConflictDoNothing()
              .returning();

            return job ? keyOf(job) : null;
          });

          if (key) {
            keys.push(key);
          }
        } catch {
          // Rotation already committed. One unexpected candidate/SQL failure
          // must not abort healthy later candidates or expose private inputs.
          continue;
        }
      }

      return keys;
    },

    async pending(limit = 20): Promise<PendingKey[]> {
      z.number().int().min(1).max(100).parse(limit);

      return db.transaction(async (tx) => {
        const lane = (where: SQL, count: number) =>
          tx
            .select()
            .from(conversationSummaryJobs)
            .where(where)
            .orderBy(
              asc(
                sql`coalesce(${conversationSummaryJobs.dispatchCheckedAt}, ${conversationSummaryJobs.createdAt})`,
              ),
              asc(conversationSummaryJobs.workspaceId),
              asc(conversationSummaryJobs.id),
            )
            .limit(count)
            .for("update", { skipLocked: true });

        const activeRows = await lane(
          sql`${conversationSummaryJobs.status} in ('queued', 'running')`,
          limit,
        );

        const recoveryLimit = limit - Math.min(activeRows.length, Math.ceil(limit / 2));

        const recoveryRows =
          recoveryLimit > 0
            ? await lane(
                sql`(
              ${conversationSummaryJobs.status} in ('stale', 'failed', 'succeeded')
              and exists (
                select 1 from ${inferenceReceipts}
                where ${inferenceReceipts.workspaceId} = ${conversationSummaryJobs.workspaceId}
                  and ${inferenceReceipts.requestId} = ${conversationSummaryJobs.id}
                  and ${inferenceReceipts.settledAt} is null
                  and ${inferenceReceipts.budgetId}::text = ${conversationSummaryJobs.policy}->>'budgetId'
                  and ${inferenceReceipts.rateVersionId}::text = ${conversationSummaryJobs.policy}->>'rateVersionId'
                  and ${inferenceReceipts.model} = ${conversationSummaryJobs.policy}->>'model'
              )
          )`,
                recoveryLimit,
              )
            : [];

        const selectedActive = activeRows.slice(0, limit - recoveryRows.length);

        const rows = [...selectedActive, ...recoveryRows];

        for (const row of rows) {
          await tx
            .update(conversationSummaryJobs)
            .set({ dispatchCheckedAt: new Date() })
            .where(jobScope(keyOf(row)));
        }

        return [
          ...selectedActive.map(keyOf),
          ...recoveryRows.map((row): PendingKey => ({ ...keyOf(row), recoveryOnly: true })),
        ];
      });
    },

    async load(key: Key): Promise<ConversationSummaryExecution | null> {
      return db.transaction(async (tx) => {
        const job = await lockedJob(tx, key);

        if (!job || !active(job)) {
          return null;
        }

        return {
          ...keyOf(job),
          policy: conversationSummaryPolicySchema.parse(job.policy),
          messages: job.messages,
          sources: job.sources,
        };
      });
    },

    async begin(key: Key): Promise<boolean> {
      return db.transaction(async (tx) => {
        const job = await lockedJob(tx, key);

        if (!job || job.status !== "queued") {
          return false;
        }

        const [started] = await tx
          .update(conversationSummaryJobs)
          .set({ status: "running" })
          .where(and(jobScope(key), eq(conversationSummaryJobs.status, "queued")))
          .returning({ id: conversationSummaryJobs.id });

        return !!started;
      });
    },

    async publish(key: Key, text: string): Promise<void> {
      const output = z.string().trim().min(1).max(8000).parse(text);

      const published = await db.transaction(async (tx) => {
        const job = await lockedJob(tx, key);

        if (!job) {
          return false;
        }

        if (job.status === "succeeded") {
          if (job.text !== output) {
            throw new WorkspaceError("command_reused", "Summary already has a different output");
          }

          return true;
        }

        if (job.status !== "running") {
          return false;
        }

        await tx
          .update(conversationSummaryJobs)
          .set({ status: "succeeded", text: output, error: null, completedAt: new Date() })
          .where(jobScope(key));

        return true;
      });

      if (!published) {
        throw new WorkspaceError("conflict", "Conversation summary is no longer publishable");
      }
    },

    async fail(key: Key, error: string): Promise<void> {
      const message = z.string().parse(error).slice(0, 1000);

      await db.transaction(async (tx) => {
        const job = await lockedJob(tx, key, false);

        if (!job || !active(job)) {
          return;
        }

        await tx
          .update(conversationSummaryJobs)
          .set({ status: "failed", error: message, completedAt: new Date() })
          .where(jobScope(key));
      });
    },
  };
}
