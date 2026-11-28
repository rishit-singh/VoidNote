import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type {
  ResearchExecution,
  ResearchExecutionKey,
  ResearchExecutionStore,
  ResearchFactCheckpoint,
} from "../../ai/research";
import { type ResearchPolicy, researchPolicySchema } from "../../config/research";
import {
  aggregateResearchStatus,
  type RequestResearch,
  requestResearchSchema,
  type ResearchBatch,
  type ResearchItem,
  type ResearchStatus,
  retryResearchSchema,
} from "../../contracts/research";
import { idSchema, type Principal, WorkspaceError } from "../../contracts/workspace";
import { appendApplicationEvent } from "../activity";
import { contactDetails } from "../contact-schema";
import type { Database } from "../repository";
import { researchBatches, researchCommands, researchItems } from "../research-schema";
import { people, workspaceMemberships, workspaces } from "../schema";
import { lockResearchOriginTurn } from "./assistant-context";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

type ItemRow = typeof researchItems.$inferSelect;

type BatchRow = typeof researchBatches.$inferSelect;

function itemWhere(key: Omit<ResearchExecutionKey, "generation">) {
  return and(
    eq(researchItems.workspaceId, key.workspaceId),
    eq(researchItems.batchId, key.batchId),
    eq(researchItems.personId, key.personId),
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

async function authorize(tx: Transaction, actorId: string, workspaceId: string) {
  const [membership] = await tx
    .select({ id: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, actorId),
        isNull(workspaceMemberships.revokedAt),
        isNull(workspaces.deletedAt),
      ),
    )
    .for("share", { of: [workspaceMemberships, workspaces] })
    .limit(1);

  if (!membership) {
    throw new WorkspaceError("forbidden", "Workspace access denied.");
  }
}

function canRetry(row: ItemRow, policy: ResearchPolicy) {
  return (
    ["failed", "partial"].includes(row.status) &&
    row.generation < policy.maxAttempts &&
    row.discovery.state !== "started" &&
    !row.facts.some((fact) => fact.state === "started")
  );
}

function itemDto(row: ItemRow, policy: ResearchPolicy): ResearchItem {
  return {
    personId: row.personId,
    profileRevision: row.profileRevision,
    contactRevision: row.contactRevision,
    displayName: row.displayName,
    generation: row.generation,
    status: row.status,
    requestedFacts: row.request.requestedFacts,
    sourceUrls: row.request.sourceUrls,
    findings: row.facts.flatMap((fact) => (fact.finding ? [fact.finding] : [])),
    ...(row.discovery.state === "completed"
      ? { discoveryCreditsUsed: row.discovery.creditsUsed }
      : {}),
    error: row.error,
    retryable: canRetry(row, policy),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function readBatch(
  tx: Transaction,
  workspaceId: string,
  batchId: string,
): Promise<ResearchBatch> {
  const [batch] = await tx
    .select()
    .from(researchBatches)
    .where(and(eq(researchBatches.workspaceId, workspaceId), eq(researchBatches.id, batchId)))
    .limit(1);

  if (!batch) {
    throw new WorkspaceError("not_found", "Research batch not found.");
  }

  const rows = await tx
    .select()
    .from(researchItems)
    .where(and(eq(researchItems.workspaceId, workspaceId), eq(researchItems.batchId, batchId)))
    .orderBy(asc(researchItems.personId));

  const items = rows.map((row) => itemDto(row, batch.policy));

  return {
    id: batch.id,
    workspaceId,
    status: aggregateResearchStatus(items.map((item) => item.status)),
    items,
    createdAt: batch.createdAt.toISOString(),
  };
}

async function lockBatch(tx: Transaction, workspaceId: string, batchId: string) {
  const [batch] = await tx
    .select()
    .from(researchBatches)
    .where(and(eq(researchBatches.workspaceId, workspaceId), eq(researchBatches.id, batchId)))
    .for("update")
    .limit(1);

  if (!batch) {
    throw new WorkspaceError("not_found", "Research batch not found.");
  }

  return batch;
}

async function personAtRevision(
  tx: Transaction,
  workspaceId: string,
  personId: string,
  revision: number,
) {
  const [person] = await tx
    .select({
      id: people.id,
      revision: people.revision,
      displayName: people.displayName,
      description: people.description,
    })
    .from(people)
    .where(
      and(eq(people.workspaceId, workspaceId), eq(people.id, personId), isNull(people.deletedAt)),
    )
    .for("share")
    .limit(1);

  if (!person || person.revision !== revision) {
    throw new WorkspaceError(
      "conflict",
      "The selected person changed or was deleted.",
      person?.revision ?? 0,
    );
  }

  // Contact writes take an exclusive person lock, so the share lock above also
  // pins absent details and prevents a concurrent insert from escaping this read.
  const [details] = await tx
    .select({
      organization: contactDetails.organization,
      role: contactDetails.role,
      links: contactDetails.links,
      revision: contactDetails.revision,
    })
    .from(contactDetails)
    .where(and(eq(contactDetails.workspaceId, workspaceId), eq(contactDetails.personId, personId)))
    .limit(1);

  return {
    ...person,
    professional: details ?? { organization: "", role: "", links: [], revision: 0 },
  };
}

function executionDto(batch: BatchRow, row: ItemRow): ResearchExecution {
  return {
    workspaceId: row.workspaceId,
    batchId: row.batchId,
    actorId: batch.actorId,
    personId: row.personId,
    generation: row.generation,
    request: row.request,
    person: {
      id: row.personId,
      revision: row.profileRevision,
      displayName: row.displayName,
      description: row.description,
      professional: { ...row.contact, revision: row.contactRevision },
      verifiedAliases: row.request.verifiedAliases ?? [],
    },
    policy: researchPolicySchema.parse(batch.policy),
    status: row.status,
    sources: row.sources,
    facts: row.facts,
    discovery: row.discovery,
    deadline: row.deadline.toISOString(),
  };
}

export function createResearchRepository(db: Database) {
  async function get(principal: Principal, workspaceId: string, batchId: string) {
    return db.transaction(async (tx) => {
      await authorize(tx, principal.id, workspaceId);

      return readBatch(tx, workspaceId, batchId);
    });
  }

  async function request(
    principal: Principal,
    raw: RequestResearch,
    policy: ResearchPolicy | null,
    context?: { turnId: string },
  ) {
    const input = requestResearchSchema.parse(raw);

    // Preserve existing UI receipt shape; model-originated commands additionally
    // bind their authorized turn, so replay cannot switch or remove provenance.
    const origin = context ? { turnId: idSchema.parse(context.turnId) } : null;

    const payload = origin ? { ...input, context: origin } : input;

    return db.transaction(async (tx) => {
      await authorize(tx, principal.id, input.workspaceId);
      const turn = origin
        ? await lockResearchOriginTurn(tx, principal, input.workspaceId, origin.turnId)
        : null;

      // One command identity across concurrent accepts. A transaction advisory
      // lock avoids creating half a batch or racing an absent receipt.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`research:${input.workspaceId}:${input.requestId}`}, 0))`,
      );
      const [receipt] = await tx
        .select()
        .from(researchCommands)
        .where(
          and(
            eq(researchCommands.workspaceId, input.workspaceId),
            eq(researchCommands.requestId, input.requestId),
          ),
        )
        .limit(1);

      if (receipt) {
        if (receipt.actorId !== principal.id || canonical(receipt.payload) !== canonical(payload)) {
          throw new WorkspaceError(
            "conflict",
            "Research request ID was used with a different payload.",
          );
        }

        return readBatch(tx, input.workspaceId, receipt.batchId);
      }

      // The assistant locks remain held through batch/items/receipt commit.
      // A terminal turn may replay an accepted operation, never accept new work.
      if (turn && turn.status !== "running") {
        throw new WorkspaceError("conflict", "The assistant turn is no longer running.");
      }

      if (!policy) {
        throw new WorkspaceError(
          "conflict",
          "Research needs a configured provider, model and inference allowance.",
        );
      }

      const pinned = researchPolicySchema.parse(policy);

      if (
        pinned.sourceProvider !== "firecrawl" &&
        input.people.some((person) => person.discoverSources === true)
      ) {
        throw new WorkspaceError(
          "conflict",
          "Source discovery was requested, but discovery is not configured for this research policy.",
        );
      }

      const selected = [];

      // Stable order matches all research revision-locking paths.
      for (const person of [...input.people].sort((a, b) => a.personId.localeCompare(b.personId))) {
        const profile = await personAtRevision(
          tx,
          input.workspaceId,
          person.personId,
          person.expectedProfileRevision,
        );

        if (
          person.expectedContactRevision !== undefined &&
          person.expectedContactRevision !== profile.professional.revision
        ) {
          throw new WorkspaceError("conflict", "The selected contact details changed.");
        }

        selected.push({ request: person, profile });
      }

      await tx.insert(researchBatches).values({
        workspaceId: input.workspaceId,
        id: input.requestId,
        actorId: principal.id,
        request: input,
        policy: pinned,
      });
      await tx.insert(researchItems).values(
        selected.map(({ request: item, profile }) => ({
          workspaceId: input.workspaceId,
          batchId: input.requestId,
          personId: profile.id,
          request: item,
          profileRevision: profile.revision,
          contactRevision: profile.professional.revision,
          contact: {
            organization: profile.professional.organization,
            role: profile.professional.role,
            links: profile.professional.links,
          },
          displayName: profile.displayName,
          description: profile.description,
          deadline: new Date(Date.now() + pinned.deadlineMs),
          facts: item.requestedFacts.map((fact): ResearchFactCheckpoint => ({
            key: fact.key,
            state: "pending",
            // Generation deliberately excluded: retries never invent a new paid identity.
            operationId: crypto.randomUUID(),
            finding: null,
            usage: null,
            settled: false,
            failureCode: null,
          })),
          discovery: {
            state: "pending",
            operationId: crypto.randomUUID(),
            creditsUsed: null,
            settled: false,
          } as const,
        })),
      );
      await tx.insert(researchCommands).values({
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        batchId: input.requestId,
        actorId: principal.id,
        payload,
      });

      return readBatch(tx, input.workspaceId, input.requestId);
    });
  }

  async function retry(principal: Principal, raw: unknown) {
    const input = retryResearchSchema.parse(raw);

    return db.transaction(async (tx) => {
      await authorize(tx, principal.id, input.workspaceId);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`research:${input.workspaceId}:${input.requestId}`}, 0))`,
      );
      const [receipt] = await tx
        .select()
        .from(researchCommands)
        .where(
          and(
            eq(researchCommands.workspaceId, input.workspaceId),
            eq(researchCommands.requestId, input.requestId),
          ),
        )
        .limit(1);

      if (receipt) {
        if (receipt.actorId !== principal.id || canonical(receipt.payload) !== canonical(input)) {
          throw new WorkspaceError("conflict", "Research retry ID was used with another payload.");
        }

        return readBatch(tx, input.workspaceId, input.batchId);
      }

      const batch = await lockBatch(tx, input.workspaceId, input.batchId);

      const [item] = await tx
        .select()
        .from(researchItems)
        .where(itemWhere(input))
        .for("update")
        .limit(1);

      if (!item) {
        throw new WorkspaceError("not_found", "Research item not found.");
      }

      if (
        batch.cancelledAt ||
        item.generation !== input.expectedGeneration ||
        !canRetry(item, batch.policy)
      ) {
        throw new WorkspaceError(
          "conflict",
          "This item cannot be retried safely. Uncertain paid work is never replayed.",
        );
      }

      const profile = await personAtRevision(
        tx,
        input.workspaceId,
        item.personId,
        item.profileRevision,
      );

      if (profile.professional.revision !== item.contactRevision) {
        throw new WorkspaceError("conflict", "Contact details changed. Start a new request.");
      }

      await tx
        .update(researchItems)
        .set({
          generation: item.generation + 1,
          status: "queued",
          error: null,
          deadline: new Date(Date.now() + batch.policy.deadlineMs),
          dispatchCheckedAt: null,
          updatedAt: new Date(),
        })
        .where(itemWhere(input));
      await tx.insert(researchCommands).values({
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        batchId: input.batchId,
        actorId: principal.id,
        payload: input,
      });

      return readBatch(tx, input.workspaceId, input.batchId);
    });
  }

  async function cancel(principal: Principal, workspaceId: string, batchId: string) {
    return db.transaction(async (tx) => {
      await authorize(tx, principal.id, workspaceId);
      await lockBatch(tx, workspaceId, batchId);
      await tx
        .update(researchBatches)
        .set({ cancelledAt: new Date() })
        .where(and(eq(researchBatches.workspaceId, workspaceId), eq(researchBatches.id, batchId)));
      // Completed facts are retained; siblings already completed remain completed.
      await tx
        .update(researchItems)
        .set({
          status: "cancelled",
          dispatchCheckedAt: null,
          cleanupAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(researchItems.workspaceId, workspaceId),
            eq(researchItems.batchId, batchId),
            inArray(researchItems.status, [
              "queued",
              "running",
              "failed",
              "needs-input",
              "partial",
            ]),
          ),
        );

      return readBatch(tx, workspaceId, batchId);
    });
  }

  // Every execution write uses the same lock order: authority → batch → item →
  // person. Cancellation serializes on the batch; person edits on the row lock.
  async function mutateExecution<T>(
    key: ResearchExecutionKey,
    work: (tx: Transaction, row: ItemRow, batch: BatchRow) => Promise<T>,
    inactive: T,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      const [hint] = await tx
        .select({ actorId: researchBatches.actorId })
        .from(researchBatches)
        .where(
          and(
            eq(researchBatches.workspaceId, key.workspaceId),
            eq(researchBatches.id, key.batchId),
          ),
        )
        .limit(1);

      if (!hint) {
        return inactive;
      }

      try {
        await authorize(tx, hint.actorId, key.workspaceId);
      } catch (error) {
        if (!(error instanceof WorkspaceError)) {
          throw error;
        }

        // No source data is read after authority loss. Fence active work durably.
        await tx
          .update(researchItems)
          .set({
            status: "needs-input",
            error: "The submitting account no longer has access.",
            updatedAt: new Date(),
          })
          .where(
            and(
              itemWhere(key),
              eq(researchItems.generation, key.generation),
              inArray(researchItems.status, ["queued", "running"]),
            ),
          );

        return inactive;
      }

      const batch = await lockBatch(tx, key.workspaceId, key.batchId);

      const [row] = await tx
        .select()
        .from(researchItems)
        .where(itemWhere(key))
        .for("update")
        .limit(1);

      if (
        !row ||
        row.generation !== key.generation ||
        batch.cancelledAt ||
        !["queued", "running"].includes(row.status)
      ) {
        return inactive;
      }

      try {
        const profile = await personAtRevision(
          tx,
          key.workspaceId,
          row.personId,
          row.profileRevision,
        );

        if (profile.professional.revision !== row.contactRevision) {
          throw new WorkspaceError("conflict", "The selected contact details changed.");
        }
      } catch (error) {
        if (!(error instanceof WorkspaceError)) {
          throw error;
        }

        await tx
          .update(researchItems)
          .set({
            status: "needs-input",
            error:
              "The selected person changed or was deleted. Start a new request with the current revision.",
            updatedAt: new Date(),
          })
          .where(itemWhere(key));

        return inactive;
      }

      return work(tx, row, batch);
    });
  }

  const execution: ResearchExecutionStore = {
    load: (key) =>
      mutateExecution(key, (_tx, row, batch) => Promise.resolve(executionDto(batch, row)), null),
    start: (key) =>
      mutateExecution(
        key,
        async (tx) => {
          await tx
            .update(researchItems)
            .set({ status: "running", error: null, updatedAt: new Date() })
            .where(itemWhere(key));

          return true;
        },
        false,
      ),
    saveSource: (key, source) =>
      mutateExecution(
        key,
        async (tx, row, batch) => {
          const policy = researchPolicySchema.parse(batch.policy);

          if (
            (policy.sourceProvider === "direct" &&
              !row.request.sourceUrls.includes(source.requestedUrl)) ||
            new TextEncoder().encode(source.text).byteLength > batch.policy.maxSourceBytes ||
            row.sources.some(
              (existing) =>
                existing.id === source.id && existing.requestedUrl !== source.requestedUrl,
            )
          ) {
            throw new Error("Research source violates the pinned request.");
          }

          if (row.sources.some((existing) => existing.requestedUrl === source.requestedUrl)) {
            return true;
          }

          await tx
            .update(researchItems)
            .set({ sources: [...row.sources, source], updatedAt: new Date() })
            .where(itemWhere(key));

          return true;
        },
        false,
      ),
    claimDiscovery: (key) =>
      mutateExecution(
        key,
        async (tx, row, batch) => {
          const policy = researchPolicySchema.parse(batch.policy);

          if (policy.sourceProvider !== "firecrawl" || row.discovery.state !== "pending") {
            return false;
          }

          await tx
            .update(researchItems)
            .set({
              discovery: { ...row.discovery, state: "reserving" },
              updatedAt: new Date(),
            })
            .where(itemWhere(key));

          return true;
        },
        false,
      ),
    markDiscoveryReserved: (key) =>
      mutateExecution(
        key,
        async (tx, row) => {
          if (row.discovery.state !== "reserving") {
            return false;
          }

          await tx
            .update(researchItems)
            .set({
              discovery: { ...row.discovery, state: "reserved" },
              updatedAt: new Date(),
            })
            .where(itemWhere(key));

          return true;
        },
        false,
      ),
    resetDiscoveryReservation: (key) =>
      mutateExecution(
        key,
        async (tx, row) => {
          if (row.discovery.state !== "reserving") {
            return false;
          }

          await tx
            .update(researchItems)
            .set({
              discovery: { ...row.discovery, state: "pending" },
              updatedAt: new Date(),
            })
            .where(itemWhere(key));

          return true;
        },
        false,
      ),
    claimDiscoverySubmission: (key) =>
      mutateExecution(
        key,
        async (tx, row) => {
          if (row.discovery.state !== "reserved") {
            return false;
          }

          await tx
            .update(researchItems)
            .set({
              discovery: { ...row.discovery, state: "started" },
              updatedAt: new Date(),
            })
            .where(itemWhere(key));

          return true;
        },
        false,
      ),
    saveDiscoveredSources: (key, sources, creditsUsed) =>
      mutateExecution(
        key,
        async (tx, row, batch) => {
          const policy = researchPolicySchema.parse(batch.policy);

          if (
            policy.sourceProvider !== "firecrawl" ||
            row.discovery.state !== "started" ||
            (creditsUsed !== null && (!Number.isInteger(creditsUsed) || creditsUsed < 0)) ||
            sources.length > policy.maxDiscoveredSources ||
            sources.some(
              (source) => new TextEncoder().encode(source.text).byteLength > policy.maxSourceBytes,
            )
          ) {
            throw new Error("Discovered sources violate the pinned research policy.");
          }

          const merged = [...row.sources];

          for (const source of sources) {
            if (!merged.some((existing) => existing.url === source.url)) {
              merged.push(source);
            }
          }

          if (
            new TextEncoder().encode(JSON.stringify(merged)).byteLength >
            policy.maxDiscoveryBytes + policy.maxSourceBytes
          ) {
            throw new Error("Discovered source checkpoints exceed the pinned byte limit.");
          }

          await tx
            .update(researchItems)
            .set({
              sources: merged,
              discovery: {
                ...row.discovery,
                state: "completed",
                creditsUsed,
                settled: false,
              },
              updatedAt: new Date(),
            })
            .where(itemWhere(key));

          return true;
        },
        false,
      ),
    markDiscoverySettled: async (key) => {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(researchItems)
          .where(and(itemWhere(key), eq(researchItems.generation, key.generation)))
          .for("update")
          .limit(1);

        if (
          !row ||
          row.discovery.state !== "completed" ||
          row.discovery.creditsUsed === null ||
          row.discovery.settled
        ) {
          return;
        }

        await tx
          .update(researchItems)
          .set({
            discovery: { ...row.discovery, settled: true },
            updatedAt: new Date(),
          })
          .where(itemWhere(key));
      });
    },
    claimFact: (key, factKey) =>
      mutateExecution(
        key,
        async (tx, row) => {
          const fact = row.facts.find((entry) => entry.key === factKey);

          if (!fact || fact.state !== "pending") {
            return false;
          }

          await tx
            .update(researchItems)
            .set({
              facts: row.facts.map((entry) =>
                entry.key === factKey ? { ...entry, state: "started" as const } : entry,
              ),
              updatedAt: new Date(),
            })
            .where(itemWhere(key));

          return true;
        },
        false,
      ),
    saveFinding: (key, factKey, finding, usage) =>
      mutateExecution(
        key,
        async (tx, row) => {
          const fact = row.facts.find((entry) => entry.key === factKey);

          if (!fact || fact.state !== "started" || finding.key !== factKey) {
            return false;
          }

          await tx
            .update(researchItems)
            .set({
              facts: row.facts.map((entry) =>
                entry.key === factKey
                  ? { ...entry, state: "completed" as const, finding, usage, settled: false }
                  : entry,
              ),
              updatedAt: new Date(),
            })
            .where(itemWhere(key));

          return true;
        },
        false,
      ),
    saveRejectedFailure: async (key, factKey, failureCode, usage) =>
      db.transaction(async (tx) => {
        const [hint] = await tx
          .select({ actorId: researchBatches.actorId })
          .from(researchBatches)
          .where(
            and(
              eq(researchBatches.workspaceId, key.workspaceId),
              eq(researchBatches.id, key.batchId),
            ),
          )
          .limit(1);

        if (!hint) {
          return false;
        }

        try {
          await authorize(tx, hint.actorId, key.workspaceId);
        } catch (error) {
          if (error instanceof WorkspaceError) {
            return false;
          }

          throw error;
        }

        await lockBatch(tx, key.workspaceId, key.batchId);

        const [row] = await tx
          .select()
          .from(researchItems)
          .where(itemWhere(key))
          .for("update")
          .limit(1);

        if (!row || row.generation !== key.generation) {
          return false;
        }

        const fact = row.facts.find((entry) => entry.key === factKey);

        if (!fact || fact.state !== "started") {
          return false;
        }

        // This records only bounded validation metadata and provider accounting.
        // It intentionally does not read/publish source or profile data and is
        // allowed after cancellation or revision change, but still requires the
        // submitting account's current workspace authorization.
        await tx
          .update(researchItems)
          .set({
            facts: row.facts.map((entry) =>
              entry.key === factKey
                ? {
                    ...entry,
                    state: "rejected" as const,
                    finding: null,
                    usage,
                    settled: false,
                    failureCode,
                  }
                : entry,
            ),
            updatedAt: new Date(),
          })
          .where(itemWhere(key));

        return true;
      }),
    markSettled: markUsageSettled,
    finish: (key, status, error) =>
      mutateExecution(
        key,
        async (tx, row, batch) => {
          if (status === "completed" && row.facts.some((fact) => fact.state !== "completed")) {
            throw new Error("Cannot complete research with unfinished facts.");
          }

          const hasFindings = row.facts.some((fact) => fact.finding !== null);

          const next: ResearchStatus = hasFindings && status === "failed" ? "partial" : status;

          await tx
            .update(researchItems)
            .set({ status: next, error, updatedAt: new Date() })
            .where(itemWhere(key));
          await appendApplicationEvent(tx, {
            id: crypto.randomUUID(),
            workspaceId: key.workspaceId,
            type:
              next === "completed" || next === "partial" ? "research.completed" : "research.failed",
            actorId: batch.actorId,
            executor: "workflow",
            operationId: `${key.batchId}:${key.personId}:${key.generation}`,
            personId: key.personId,
            resultId: key.batchId,
          });
        },
        undefined,
      ),
  };

  // Accounting acknowledgement is independent of publication authorization:
  // cancellation/deletion cannot strand a complete usage receipt already saved
  // with a fact. It never adds or changes a generated finding.
  async function markUsageSettled(key: ResearchExecutionKey, factKey: string) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(researchItems)
        .where(and(itemWhere(key), eq(researchItems.generation, key.generation)))
        .for("update")
        .limit(1);

      if (!row) {
        return;
      }

      await tx
        .update(researchItems)
        .set({
          facts: row.facts.map((fact) =>
            fact.key === factKey && ["completed", "rejected"].includes(fact.state) && fact.usage
              ? { ...fact, settled: true }
              : fact,
          ),
        })
        .where(itemWhere(key));
    });
  }

  async function pendingUsage(limit = 20) {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({
          workspaceId: researchItems.workspaceId,
          batchId: researchItems.batchId,
          personId: researchItems.personId,
          generation: researchItems.generation,
          facts: researchItems.facts,
        })
        .from(researchItems)
        .where(
          sql`exists (
          select 1 from jsonb_array_elements(${researchItems.facts}) as fact
          where fact->>'state' in ('completed', 'rejected')
            and fact->'usage' <> 'null'::jsonb
            and fact->>'settled' = 'false'
        )`,
        )
        .orderBy(asc(sql`coalesce(${researchItems.dispatchCheckedAt}, ${researchItems.updatedAt})`))
        .limit(Math.max(1, Math.min(20, limit)))
        .for("update", { skipLocked: true });

      for (const row of rows) {
        await tx.update(researchItems).set({ dispatchCheckedAt: new Date() }).where(itemWhere(row));
      }

      return rows.flatMap(({ facts, ...key }) =>
        facts.flatMap((fact) =>
          ["completed", "rejected"].includes(fact.state) && fact.usage && !fact.settled
            ? [{ ...key, factKey: fact.key, operationId: fact.operationId, usage: fact.usage }]
            : [],
        ),
      );
    });
  }

  async function pendingDispatch(limit = 20) {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({
          workspaceId: researchItems.workspaceId,
          batchId: researchItems.batchId,
          personId: researchItems.personId,
          generation: researchItems.generation,
          status: researchItems.status,
        })
        .from(researchItems)
        .where(
          or(
            inArray(researchItems.status, ["queued", "running"]),
            and(eq(researchItems.status, "cancelled"), isNull(researchItems.cleanupAt)),
          ),
        )
        .orderBy(asc(sql`coalesce(${researchItems.dispatchCheckedAt}, ${researchItems.updatedAt})`))
        .limit(Math.max(1, Math.min(100, limit)))
        .for("update", { skipLocked: true });

      for (const row of rows) {
        // Rotate even failed notification attempts so one broken binding cannot
        // starve healthy work or cancelled runtime cleanup.
        await tx.update(researchItems).set({ dispatchCheckedAt: new Date() }).where(itemWhere(row));
      }

      return rows;
    });
  }

  return {
    request,
    get,
    retry,
    cancel,
    execution,
    pendingDispatch,
    pendingUsage,
    async list(principal: Principal, workspaceId: string, personId?: string) {
      return db.transaction(async (tx) => {
        await authorize(tx, principal.id, workspaceId);
        const rows = await tx
          .selectDistinct({
            id: researchBatches.id,
            createdAt: researchBatches.createdAt,
          })
          .from(researchBatches)
          .innerJoin(
            researchItems,
            and(
              eq(researchItems.workspaceId, researchBatches.workspaceId),
              eq(researchItems.batchId, researchBatches.id),
            ),
          )
          .where(
            and(
              eq(researchBatches.workspaceId, workspaceId),
              personId ? eq(researchItems.personId, personId) : undefined,
            ),
          )
          .orderBy(desc(researchBatches.createdAt), asc(researchBatches.id))
          .limit(20);

        return Promise.all(rows.map((row) => readBatch(tx, workspaceId, row.id)));
      });
    },
    async acknowledgeCleanup(key: ResearchExecutionKey) {
      await db
        .update(researchItems)
        .set({ cleanupAt: new Date() })
        .where(
          and(
            itemWhere(key),
            eq(researchItems.generation, key.generation),
            eq(researchItems.status, "cancelled"),
          ),
        );
    },
    /** Internal Workflow outcome read; execution.load deliberately fences terminal work. */
    async executionOutcome(key: ResearchExecutionKey) {
      const [row] = await db
        .select({ status: researchItems.status })
        .from(researchItems)
        .where(and(itemWhere(key), eq(researchItems.generation, key.generation)))
        .limit(1);

      return row ?? { status: "unavailable" };
    },
  };
}
