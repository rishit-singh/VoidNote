import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { ResearchRunPolicy } from "../../config/research-runs";
import { researchRunPolicySchema } from "../../config/research-runs";
import {
  type RequestResearchRun,
  requestResearchRunSchema,
  type ResearchRunDetail,
  researchRunDetailSchema,
  type ResearchRunExecutionKey,
  researchRunFindingSchema,
  type ResearchRunListInput,
  researchRunListInputSchema,
  type ResearchRunLookupCandidate,
  type ResearchRunLookupInput,
  researchRunLookupInputSchema,
} from "../../contracts/research/runs";
import { type Principal, WorkspaceError } from "../../contracts/workspace";
import { appendApplicationEvent } from "../activity";
import { assistantThreads, assistantTurns } from "../assistant-schema";
import { contactDetails } from "../contact-schema";
import type { Database } from "../repository";
import {
  researchRunCommands,
  researchRunDiscoveries,
  researchRunFindingEvidence,
  researchRunFindings,
  researchRunQuestions,
  researchRuns,
  researchRunSources,
} from "../research-runs-schema";
import { notes, people, workspaceMemberships, workspaces } from "../schema";
import { lockResearchOriginTurn } from "./assistant-context";
import { createResearchEvidenceRepository } from "./evidence";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

type ResearchRunSourceInput = {
  id: string;
  requestedUrl: string;
  url: string;
  title?: string;
  publishedAt?: string | null;
  originSourceId?: string | null;
  disposition?: "retrieved" | "reused";
  digest: string;
  retrievedAt: string;
  text: string;
};

type SaveResearchRunSourceResult =
  { status: "saved" | "existing"; id: string } | { status: "capacity"; id: null };

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

function normalizedQuestion(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function requestIdentity(value: unknown) {
  const payload = value as Record<string, unknown>;

  const rest = { ...payload };

  delete rest.commandId;
  delete rest.originTurnId;

  return typeof rest.question === "string"
    ? { ...rest, question: normalizedQuestion(rest.question) }
    : rest;
}

async function authorize(tx: Transaction, principal: Principal, workspaceId: string) {
  const [membership] = await tx
    .select({ id: workspaceMemberships.userId })
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
    .for("share", { of: [workspaceMemberships, workspaces] })
    .limit(1);

  if (!membership) {
    throw new WorkspaceError("forbidden", "Workspace access denied.");
  }
}

async function lockLiveRunScope(
  tx: Transaction,
  key: ResearchRunExecutionKey,
  statuses: Array<"queued" | "running">,
) {
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
    .select({ id: workspaceMemberships.userId })
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
      .select({ id: people.id, revision: people.revision })
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

  if (
    !run ||
    run.actorId !== hint.actorId ||
    run.noteId !== hint.noteId ||
    run.personId !== hint.personId ||
    run.personRevision !== hint.personRevision ||
    run.contactRevision !== hint.contactRevision ||
    !statuses.includes(run.status as "queued" | "running")
  ) {
    return null;
  }

  return run;
}

async function detail(
  tx: Transaction,
  workspaceId: string,
  runId: string,
): Promise<ResearchRunDetail> {
  const [run] = await tx
    .select()
    .from(researchRuns)
    .where(and(eq(researchRuns.workspaceId, workspaceId), eq(researchRuns.id, runId)))
    .limit(1);

  if (!run) {
    throw new WorkspaceError("not_found", "Research run not found.");
  }

  const [questions, findings] = await Promise.all([
    tx
      .select()
      .from(researchRunQuestions)
      .where(
        and(
          eq(researchRunQuestions.workspaceId, workspaceId),
          eq(researchRunQuestions.runId, runId),
        ),
      )
      .orderBy(asc(researchRunQuestions.ordinal)),
    tx
      .select()
      .from(researchRunFindings)
      .where(
        and(eq(researchRunFindings.workspaceId, workspaceId), eq(researchRunFindings.runId, runId)),
      ),
  ]);

  const byId = new Map(questions.map((question) => [question.id, question.question]));

  const mapped = findings.map((finding) => ({
    id: finding.id,
    questionId: finding.questionId,
    question: byId.get(finding.questionId) ?? "",
    outcome: finding.outcome,
    statement: finding.statement,
    classification: finding.classification,
    explanation: finding.explanation,
    citations: finding.citations,
  }));

  const quality = run.report?.quality ?? null;

  const gaps = questions
    .filter((question) => question.outcome === "pending" || question.outcome === "failed")
    .map((question) => question.error ?? question.question);

  return researchRunDetailSchema.parse({
    id: run.id,
    workspaceId,
    noteId: run.noteId,
    personId: run.personId,
    question: run.question,
    status: run.status,
    stage: run.stage,
    report: run.report,
    quality,
    findings: mapped,
    gaps,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  });
}

export function createResearchRunsRepository(db: Database | Transaction) {
  async function request(
    principal: Principal,
    raw: RequestResearchRun,
    policy: ResearchRunPolicy | null,
    originTurnId?: string,
  ) {
    const input = requestResearchRunSchema.parse(raw);

    const payload = { ...input, originTurnId: originTurnId ?? null };

    return db.transaction(async (tx) => {
      await authorize(tx, principal, input.workspaceId);
      const origin = originTurnId
        ? await lockResearchOriginTurn(tx, principal, input.workspaceId, originTurnId)
        : null;

      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`research-run:${input.workspaceId}:${input.commandId}`}, 0))`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`research-run-dedup:${input.workspaceId}:${principal.id}:${canonical(requestIdentity(payload))}`}, 0))`,
      );
      const [receipt] = await tx
        .select()
        .from(researchRunCommands)
        .where(
          and(
            eq(researchRunCommands.workspaceId, input.workspaceId),
            eq(researchRunCommands.commandId, input.commandId),
          ),
        )
        .limit(1);

      if (receipt) {
        if (receipt.actorId !== principal.id || canonical(receipt.payload) !== canonical(payload)) {
          throw new WorkspaceError(
            "conflict",
            "Research command ID was used with another payload.",
          );
        }

        return detail(tx, input.workspaceId, receipt.runId);
      }

      const recent = await tx
        .select()
        .from(researchRuns)
        .where(
          and(
            eq(researchRuns.workspaceId, input.workspaceId),
            eq(researchRuns.actorId, principal.id),
            input.noteId ? eq(researchRuns.noteId, input.noteId) : isNull(researchRuns.noteId),
            input.personId
              ? eq(researchRuns.personId, input.personId)
              : isNull(researchRuns.personId),
            or(
              eq(researchRuns.status, "queued"),
              eq(researchRuns.status, "running"),
              eq(researchRuns.status, "completed"),
            ),
          ),
        )
        .orderBy(desc(researchRuns.createdAt))
        .limit(50);

      const duplicate = recent.find(
        (run) => canonical(requestIdentity(run.payload)) === canonical(requestIdentity(payload)),
      );

      if (
        duplicate &&
        policy &&
        canonical(researchRunPolicySchema.parse(duplicate.policy)) ===
          canonical(researchRunPolicySchema.parse(policy))
      ) {
        const sameRequest =
          canonical(requestIdentity(duplicate.payload)) === canonical(requestIdentity(payload));

        const reusableActive = sameRequest && ["queued", "running"].includes(duplicate.status);

        const reusableReport =
          sameRequest && duplicate.status === "completed" && duplicate.report !== null;

        if (reusableActive || reusableReport) {
          await tx.insert(researchRunCommands).values({
            workspaceId: input.workspaceId,
            commandId: input.commandId,
            runId: duplicate.id,
            actorId: principal.id,
            payload,
          });

          return detail(tx, input.workspaceId, duplicate.id);
        }
      }

      if (origin && origin.status !== "running") {
        throw new WorkspaceError(
          "conflict",
          "The originating assistant turn is no longer running.",
        );
      }

      if (!policy) {
        throw new WorkspaceError("conflict", "Research is not configured.");
      }

      const pinnedPolicy = researchRunPolicySchema.parse(policy);

      if (input.subquestions.length + 1 > pinnedPolicy.maxQuestions) {
        throw new WorkspaceError("conflict", "Research request exceeds the pinned question limit.");
      }

      if (input.noteId) {
        const [note] = await tx
          .select({ id: notes.id })
          .from(notes)
          .where(
            and(
              eq(notes.workspaceId, input.workspaceId),
              eq(notes.id, input.noteId),
              isNull(notes.deletedAt),
            ),
          )
          .for("share")
          .limit(1);

        if (!note) {
          throw new WorkspaceError("not_found", "Research note was not found.");
        }
      }

      let personContext: { personRevision: number; contactRevision: number } | null = null;

      if (input.personId) {
        const [person] = await tx
          .select({
            id: people.id,
            revision: people.revision,
          })
          .from(people)
          .where(
            and(
              eq(people.workspaceId, input.workspaceId),
              eq(people.id, input.personId),
              isNull(people.deletedAt),
            ),
          )
          .for("share", { of: [people] })
          .limit(1);

        if (!person) {
          throw new WorkspaceError("not_found", "Research person was not found.");
        }

        const [contact] = await tx
          .select({ revision: contactDetails.revision })
          .from(contactDetails)
          .where(
            and(
              eq(contactDetails.workspaceId, input.workspaceId),
              eq(contactDetails.personId, input.personId),
            ),
          )
          .for("share")
          .limit(1);

        personContext = {
          personRevision: person.revision,
          contactRevision: contact?.revision ?? 0,
        };
      }

      if (originTurnId && input.noteId) {
        const [thread] = await tx
          .select({ noteId: assistantThreads.noteId })
          .from(assistantTurns)
          .innerJoin(
            assistantThreads,
            and(
              eq(assistantThreads.workspaceId, assistantTurns.workspaceId),
              eq(assistantThreads.id, assistantTurns.threadId),
            ),
          )
          .where(
            and(
              eq(assistantTurns.workspaceId, input.workspaceId),
              eq(assistantTurns.id, originTurnId),
              eq(assistantTurns.actorId, principal.id),
            ),
          )
          .limit(1);

        if (thread?.noteId !== input.noteId) {
          throw new WorkspaceError(
            "conflict",
            "Research note does not match the originating conversation.",
          );
        }
      }

      if (input.discoverSources && pinnedPolicy.sourceProvider !== "firecrawl") {
        throw new WorkspaceError(
          "conflict",
          "Requested source discovery is unavailable; submit supplied sources instead.",
        );
      }

      if (
        !input.discoverSources &&
        pinnedPolicy.sourceProvider === "direct" &&
        input.sourceUrls.length === 0
      ) {
        throw new WorkspaceError("conflict", "No supplied source URLs were provided.");
      }

      const questions = [input.question, ...input.subquestions];

      await tx.insert(researchRuns).values({
        workspaceId: input.workspaceId,
        id: input.commandId,
        actorId: principal.id,
        originTurnId: originTurnId ?? null,
        noteId: input.noteId ?? null,
        personId: input.personId ?? null,
        personRevision: personContext?.personRevision ?? null,
        contactRevision: personContext?.contactRevision ?? null,
        question: input.question,
        payload,
        policy: pinnedPolicy,
        status: "queued",
        stage: "queued",
      });
      await tx.insert(researchRunQuestions).values(
        questions.map((question, ordinal) => ({
          workspaceId: input.workspaceId,
          runId: input.commandId,
          id: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          ordinal,
          question,
        })),
      );

      if (input.discoverSources) {
        await tx.insert(researchRunDiscoveries).values([
          {
            workspaceId: input.workspaceId,
            runId: input.commandId,
            ordinal: 0,
            operationId: crypto.randomUUID(),
            query: input.question.slice(0, 500),
          },
          {
            workspaceId: input.workspaceId,
            runId: input.commandId,
            ordinal: 1,
            operationId: crypto.randomUUID(),
          },
        ]);
      }

      await tx.insert(researchRunCommands).values({
        workspaceId: input.workspaceId,
        commandId: input.commandId,
        runId: input.commandId,
        actorId: principal.id,
        payload,
      });

      return detail(tx, input.workspaceId, input.commandId);
    });
  }

  async function get(principal: Principal, workspaceId: string, runId: string) {
    return db.transaction(async (tx) => {
      await authorize(tx, principal, workspaceId);

      return detail(tx, workspaceId, runId);
    });
  }

  async function cancel(
    principal: Principal,
    workspaceId: string,
    runId: string,
    originTurnId?: string,
  ) {
    return db.transaction(async (tx) => {
      await authorize(tx, principal, workspaceId);

      if (originTurnId) {
        await lockResearchOriginTurn(tx, principal, workspaceId, originTurnId);
      }

      const [current] = await tx
        .select()
        .from(researchRuns)
        .where(
          and(
            eq(researchRuns.workspaceId, workspaceId),
            eq(researchRuns.id, runId),
            eq(researchRuns.actorId, principal.id),
          ),
        )
        .for("update")
        .limit(1);

      if (!current) {
        throw new WorkspaceError("not_found", "Research run not found.");
      }

      if (["completed", "failed", "cancelled"].includes(current.status)) {
        return detail(tx, workspaceId, runId);
      }

      await tx
        .update(researchRuns)
        .set({ status: "cancelled", stage: "finished", updatedAt: new Date() })
        .where(
          and(
            eq(researchRuns.workspaceId, workspaceId),
            eq(researchRuns.id, runId),
            or(eq(researchRuns.status, "queued"), eq(researchRuns.status, "running")),
          ),
        );

      return detail(tx, workspaceId, runId);
    });
  }

  async function lookup(
    principal: Principal,
    workspaceId: string,
    raw: ResearchRunLookupInput,
  ): Promise<ResearchRunLookupCandidate[]> {
    const input = researchRunLookupInputSchema.parse(raw);

    return db.transaction(async (tx) => {
      await authorize(tx, principal, workspaceId);
      const rows = await tx
        .select({
          runId: researchRuns.id,
          question: researchRuns.question,
          status: researchRuns.status,
          updatedAt: researchRuns.updatedAt,
        })
        .from(researchRuns)
        .where(
          and(
            eq(researchRuns.workspaceId, workspaceId),
            input.personIds.length ? inArray(researchRuns.personId, input.personIds) : undefined,
            input.noteId ? eq(researchRuns.noteId, input.noteId) : undefined,
            input.query.length
              ? or(
                  sql`position(lower(${input.query}) in lower(${researchRuns.question})) > 0`,
                  inArray(
                    researchRuns.id,
                    tx
                      .select({ runId: researchRunFindings.runId })
                      .from(researchRunFindings)
                      .where(
                        and(
                          eq(researchRunFindings.workspaceId, workspaceId),
                          sql`position(lower(${input.query}) in lower(coalesce(${researchRunFindings.statement}, ''))) > 0`,
                        ),
                      ),
                  ),
                )
              : undefined,
            !input.includeActiveRuns
              ? or(
                  eq(researchRuns.status, "completed"),
                  eq(researchRuns.status, "failed"),
                  eq(researchRuns.status, "cancelled"),
                )
              : undefined,
          ),
        )
        .orderBy(desc(researchRuns.updatedAt))
        .limit(input.limit);

      const statements =
        rows.length && input.query.length
          ? await tx
              .select({
                runId: researchRunFindings.runId,
                statement: researchRunFindings.statement,
              })
              .from(researchRunFindings)
              .where(
                and(
                  eq(researchRunFindings.workspaceId, workspaceId),
                  inArray(
                    researchRunFindings.runId,
                    rows.map((row) => row.runId),
                  ),
                  sql`position(lower(${input.query}) in lower(coalesce(${researchRunFindings.statement}, ''))) > 0`,
                ),
              )
          : [];

      const statementByRun = new Map<string, string>();

      for (const finding of statements) {
        if (finding.statement && !statementByRun.has(finding.runId)) {
          statementByRun.set(finding.runId, finding.statement);
        }
      }

      return rows.map((row) => ({
        runId: row.runId,
        question: row.question,
        status: row.status,
        freshness: "unknown",
        updatedAt: row.updatedAt.toISOString(),
        statement: statementByRun.get(row.runId) ?? null,
      }));
    });
  }

  async function list(
    principal: Principal,
    workspaceId: string,
    raw: ResearchRunListInput,
  ): Promise<ResearchRunDetail[]> {
    const input = researchRunListInputSchema.parse(raw);

    return db.transaction(async (tx) => {
      await authorize(tx, principal, workspaceId);
      const rows = await tx
        .select({ id: researchRuns.id })
        .from(researchRuns)
        .leftJoin(
          assistantTurns,
          and(
            eq(assistantTurns.workspaceId, researchRuns.workspaceId),
            eq(assistantTurns.id, researchRuns.originTurnId),
          ),
        )
        .leftJoin(
          assistantThreads,
          and(
            eq(assistantThreads.workspaceId, assistantTurns.workspaceId),
            eq(assistantThreads.id, assistantTurns.threadId),
          ),
        )
        .where(
          and(
            eq(researchRuns.workspaceId, workspaceId),
            eq(researchRuns.actorId, principal.id),
            input.noteId ? eq(researchRuns.noteId, input.noteId) : undefined,
            input.threadId
              ? or(
                  eq(assistantThreads.id, input.threadId),
                  inArray(
                    researchRuns.id,
                    tx
                      .select({ runId: researchRunCommands.runId })
                      .from(researchRunCommands)
                      .innerJoin(
                        assistantTurns,
                        and(
                          eq(assistantTurns.workspaceId, researchRunCommands.workspaceId),
                          sql`${assistantTurns.id}::text = ${researchRunCommands.payload}->>'originTurnId'`,
                        ),
                      )
                      .where(
                        and(
                          eq(researchRunCommands.workspaceId, workspaceId),
                          eq(researchRunCommands.actorId, principal.id),
                          eq(assistantTurns.threadId, input.threadId),
                        ),
                      ),
                  ),
                )
              : undefined,
            input.status === "active"
              ? or(eq(researchRuns.status, "queued"), eq(researchRuns.status, "running"))
              : input.status === "finished"
                ? or(
                    eq(researchRuns.status, "completed"),
                    eq(researchRuns.status, "failed"),
                    eq(researchRuns.status, "cancelled"),
                  )
                : undefined,
          ),
        )
        .orderBy(desc(researchRuns.createdAt), desc(researchRuns.id))
        .limit(input.limit);

      return Promise.all(rows.map((row) => detail(tx, workspaceId, row.id)));
    });
  }

  async function pendingDispatch(limit: number): Promise<ResearchRunExecutionKey[]> {
    const cutoff = new Date(Date.now() - 120_000);

    const rows = await db
      .select({ workspaceId: researchRuns.workspaceId, runId: researchRuns.id })
      .from(researchRuns)
      .where(
        and(
          or(eq(researchRuns.status, "queued"), eq(researchRuns.status, "running")),
          or(isNull(researchRuns.dispatchCheckedAt), lt(researchRuns.dispatchCheckedAt, cutoff)),
        ),
      )
      .orderBy(asc(researchRuns.dispatchCheckedAt), asc(researchRuns.createdAt))
      .limit(Math.max(1, Math.min(limit, 100)));

    await Promise.all(
      rows.map((key) =>
        db
          .update(researchRuns)
          .set({ dispatchCheckedAt: new Date() })
          .where(
            and(
              eq(researchRuns.workspaceId, key.workspaceId),
              eq(researchRuns.id, key.runId),
              or(eq(researchRuns.status, "queued"), eq(researchRuns.status, "running")),
            ),
          ),
      ),
    );

    return rows;
  }

  async function pendingDiscoverySettlement(limit: number) {
    return db
      .select({
        workspaceId: researchRuns.workspaceId,
        operationId: researchRunDiscoveries.operationId,
        creditsUsed: researchRunDiscoveries.creditsUsed,
      })
      .from(researchRunDiscoveries)
      .innerJoin(
        researchRuns,
        and(
          eq(researchRuns.workspaceId, researchRunDiscoveries.workspaceId),
          eq(researchRuns.id, researchRunDiscoveries.runId),
        ),
      )
      .where(
        and(
          eq(researchRunDiscoveries.state, "completed"),
          sql`${researchRunDiscoveries.creditsUsed} is not null`,
        ),
      )
      .orderBy(asc(researchRuns.updatedAt))
      .limit(Math.max(1, Math.min(limit, 50)));
  }

  async function pendingInferenceSettlement(limit: number) {
    return db
      .select({
        workspaceId: researchRunQuestions.workspaceId,
        runId: researchRunQuestions.runId,
        questionId: researchRunQuestions.id,
        operationId: researchRunQuestions.operationId,
        usage: researchRunQuestions.inferenceUsage,
      })
      .from(researchRunQuestions)
      .where(
        and(
          eq(researchRunQuestions.inferenceState, "submitted"),
          sql`${researchRunQuestions.inferenceResult} is not null`,
          sql`${researchRunQuestions.inferenceUsage} is not null`,
        ),
      )
      .orderBy(asc(researchRunQuestions.id))
      .limit(Math.max(1, Math.min(limit, 50)));
  }

  async function claim(key: ResearchRunExecutionKey) {
    return db.transaction(async (tx) => {
      const run = await lockLiveRunScope(tx, key, ["queued", "running"]);

      if (!run) {
        return false;
      }

      if (run.status === "running") {
        return true;
      }

      await tx
        .update(researchRuns)
        .set({
          status: "running",
          stage: "retrieving",
          dispatchCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(researchRuns.workspaceId, key.workspaceId),
            eq(researchRuns.id, key.runId),
            eq(researchRuns.status, "queued"),
          ),
        );

      return true;
    });
  }

  async function setStage(key: ResearchRunExecutionKey, stage: ResearchRunDetail["stage"]) {
    return db.transaction(async (tx) => {
      const run = await lockLiveRunScope(tx, key, ["running"]);

      if (!run) {
        return false;
      }

      await tx
        .update(researchRuns)
        .set({ stage, updatedAt: new Date() })
        .where(
          and(
            eq(researchRuns.workspaceId, key.workspaceId),
            eq(researchRuns.id, key.runId),
            eq(researchRuns.status, "running"),
          ),
        );

      return true;
    });
  }

  async function saveSources(
    key: ResearchRunExecutionKey,
    sources: ResearchRunSourceInput[],
  ): Promise<SaveResearchRunSourceResult[] | null> {
    return db.transaction(async (tx) => {
      const run = await lockLiveRunScope(tx, key, ["running"]);

      if (!run) {
        return null;
      }

      const policy = researchRunPolicySchema.parse(run.policy);

      const maxSnapshotBytes = Math.min(
        policy.maxDiscoveryBytes,
        policy.maxSourceBytes * policy.maxSources,
      );

      const existingDigests = new Map<string, string>();

      const existingIds = new Set<string>();

      const existingRows = await tx
        .select({
          id: researchRunSources.id,
          digest: researchRunSources.digest,
          content: researchRunSources.content,
        })
        .from(researchRunSources)
        .where(
          and(
            eq(researchRunSources.workspaceId, key.workspaceId),
            eq(researchRunSources.runId, key.runId),
          ),
        );

      const encoder = new TextEncoder();

      let sourceCount = existingRows.length;

      let sourceBytes = 0;

      for (const source of existingRows) {
        existingDigests.set(source.digest, source.id);
        existingIds.add(source.id);
        sourceBytes += encoder.encode(source.content).byteLength;
      }

      const results: SaveResearchRunSourceResult[] = [];

      for (const source of sources) {
        const existingId = existingDigests.get(source.digest);

        if (existingId) {
          results.push({ status: "existing", id: existingId });
          continue;
        }

        if (existingIds.has(source.id)) {
          throw new WorkspaceError(
            "conflict",
            "Research source ID was reused with another digest.",
          );
        }

        const bytes = encoder.encode(source.text).byteLength;

        if (
          sourceCount >= policy.maxSources ||
          bytes > policy.maxSourceBytes ||
          sourceBytes + bytes > maxSnapshotBytes
        ) {
          results.push({ status: "capacity", id: null });
          continue;
        }

        await tx.insert(researchRunSources).values({
          workspaceId: key.workspaceId,
          runId: key.runId,
          id: source.id,
          requestedUrl: source.requestedUrl,
          url: source.url,
          title: source.title ?? null,
          publishedAt: source.publishedAt ? new Date(source.publishedAt) : null,
          originSourceId: source.originSourceId ?? null,
          digest: source.digest,
          retrievedAt: new Date(source.retrievedAt),
          content: source.text,
          disposition: source.disposition ?? "retrieved",
        });

        existingDigests.set(source.digest, source.id);
        existingIds.add(source.id);
        sourceCount += 1;
        sourceBytes += bytes;
        results.push({ status: "saved", id: source.id });
      }

      return results;
    });
  }

  async function saveSource(key: ResearchRunExecutionKey, source: ResearchRunSourceInput) {
    const [result] = (await saveSources(key, [source])) ?? [];

    return result !== undefined && result.status !== "capacity";
  }

  async function loadWork(key: ResearchRunExecutionKey) {
    const [run] = await db
      .select()
      .from(researchRuns)
      .where(and(eq(researchRuns.workspaceId, key.workspaceId), eq(researchRuns.id, key.runId)))
      .limit(1);

    if (!run) {
      return null;
    }

    const [person] = run.personId
      ? await db
          .select({
            displayName: people.displayName,
            revision: people.revision,
            description: people.description,
          })
          .from(people)
          .where(
            and(
              eq(people.workspaceId, key.workspaceId),
              eq(people.id, run.personId),
              isNull(people.deletedAt),
            ),
          )
          .limit(1)
      : [undefined];

    const [questions, sources, findings, discoveries] = await Promise.all([
      db
        .select()
        .from(researchRunQuestions)
        .where(
          and(
            eq(researchRunQuestions.workspaceId, key.workspaceId),
            eq(researchRunQuestions.runId, key.runId),
          ),
        )
        .orderBy(asc(researchRunQuestions.ordinal)),
      db
        .select()
        .from(researchRunSources)
        .where(
          and(
            eq(researchRunSources.workspaceId, key.workspaceId),
            eq(researchRunSources.runId, key.runId),
          ),
        ),
      db
        .select()
        .from(researchRunFindings)
        .where(
          and(
            eq(researchRunFindings.workspaceId, key.workspaceId),
            eq(researchRunFindings.runId, key.runId),
          ),
        ),
      db
        .select()
        .from(researchRunDiscoveries)
        .where(
          and(
            eq(researchRunDiscoveries.workspaceId, key.workspaceId),
            eq(researchRunDiscoveries.runId, key.runId),
          ),
        )
        .orderBy(asc(researchRunDiscoveries.ordinal)),
    ]);

    const questionById = new Map(questions.map((question) => [question.id, question.question]));

    const request = {
      ...(run.payload as RequestResearchRun & { originTurnId?: string | null }),
    };

    delete request.originTurnId;

    return {
      status: run.status,
      quality: run.report?.quality ?? null,
      actorId: run.actorId,
      personName: person?.displayName ?? null,
      originTurnId: run.originTurnId,
      input: request,
      policy: run.policy,
      discoveryState: run.discoveryState,
      discoveries,
      questions: questions.map((question) => ({
        id: question.id,
        operationId: question.operationId,
        question: question.question,
        outcome: question.outcome,
        inferenceState: question.inferenceState,
        inferenceResult: question.inferenceResult,
        inferenceUsage: question.inferenceUsage,
      })),
      findings: findings.map((finding) =>
        researchRunFindingSchema.parse({
          id: finding.id,
          questionId: finding.questionId,
          question: questionById.get(finding.questionId) ?? "",
          outcome: finding.outcome,
          statement: finding.statement,
          classification: finding.classification,
          explanation: finding.explanation,
          citations: finding.citations,
        }),
      ),
      sources: sources.map((source) => ({
        id: source.id,
        requestedUrl: source.requestedUrl,
        url: source.url,
        title: source.title,
        publishedAt: source.publishedAt?.toISOString() ?? null,
        originSourceId: source.originSourceId,
        disposition: source.disposition,
        digest: source.digest,
        retrievedAt: source.retrievedAt.toISOString(),
        text: source.content,
      })),
    };
  }

  async function claimDiscovery(key: ResearchRunExecutionKey, ordinal: number, query: string) {
    return db.transaction(async (tx) => {
      const run = await lockLiveRunScope(tx, key, ["running"]);

      if (!run) {
        return null;
      }

      const [row] = await tx
        .update(researchRunDiscoveries)
        .set({
          state: "submitted",
          query: query.slice(0, 500),
        })
        .where(
          and(
            eq(researchRunDiscoveries.workspaceId, key.workspaceId),
            eq(researchRunDiscoveries.runId, key.runId),
            eq(researchRunDiscoveries.ordinal, ordinal),
            eq(researchRunDiscoveries.state, "pending"),
          ),
        )
        .returning({ operationId: researchRunDiscoveries.operationId });

      return row ?? null;
    });
  }

  async function markDiscoveryCompleted(
    key: ResearchRunExecutionKey,
    ordinal: number,
    creditsUsed: number | null,
    candidates: unknown[],
  ) {
    const [row] = await db
      .update(researchRunDiscoveries)
      .set({
        state: "completed",
        creditsUsed,
        candidates,
      })
      .where(
        and(
          eq(researchRunDiscoveries.workspaceId, key.workspaceId),
          eq(researchRunDiscoveries.runId, key.runId),
          eq(researchRunDiscoveries.ordinal, ordinal),
          eq(researchRunDiscoveries.state, "submitted"),
        ),
      )
      .returning({ id: researchRunDiscoveries.operationId });

    return Boolean(row);
  }

  async function saveQuestionFinding(
    key: ResearchRunExecutionKey,
    questionId: string,
    finding: ResearchRunDetail["findings"][number],
  ) {
    return db.transaction(async (tx) => {
      const run = await lockLiveRunScope(tx, key, ["running"]);

      if (!run) {
        return false;
      }

      const [question] = await tx
        .select()
        .from(researchRunQuestions)
        .where(
          and(
            eq(researchRunQuestions.workspaceId, key.workspaceId),
            eq(researchRunQuestions.runId, key.runId),
            eq(researchRunQuestions.id, questionId),
          ),
        )
        .for("update")
        .limit(1);

      if (!question || question.outcome !== "pending") {
        return false;
      }

      for (const citation of finding.citations) {
        const [source] = await tx
          .select()
          .from(researchRunSources)
          .where(
            and(
              eq(researchRunSources.workspaceId, key.workspaceId),
              eq(researchRunSources.runId, key.runId),
              eq(researchRunSources.id, citation.sourceId),
            ),
          )
          .limit(1);

        if (
          !source ||
          source.url !== citation.url ||
          source.retrievedAt.toISOString() !== citation.retrievedAt ||
          source.content.slice(citation.startOffset, citation.endOffset) !== citation.excerpt
        ) {
          await tx
            .update(researchRunQuestions)
            .set({
              outcome: "failed",
              error: "Citation failed deterministic source validation.",
            })
            .where(
              and(
                eq(researchRunQuestions.workspaceId, key.workspaceId),
                eq(researchRunQuestions.runId, key.runId),
                eq(researchRunQuestions.id, questionId),
              ),
            );

          return false;
        }
      }

      await tx.insert(researchRunFindings).values({
        workspaceId: key.workspaceId,
        runId: key.runId,
        id: finding.id,
        questionId,
        outcome: finding.outcome,
        statement: finding.statement,
        classification: finding.classification,
        explanation: finding.explanation,
        citations: finding.citations,
      });

      if (finding.citations.length) {
        await tx.insert(researchRunFindingEvidence).values(
          finding.citations.map((citation) => ({
            workspaceId: key.workspaceId,
            runId: key.runId,
            findingId: finding.id,
            sourceId: citation.sourceId,
            relation: finding.classification === "deduction" ? "premise" : "supports",
            startOffset: citation.startOffset,
            endOffset: citation.endOffset,
            excerpt: citation.excerpt,
          })),
        );
      }

      await tx
        .update(researchRunQuestions)
        .set({
          outcome: finding.outcome,
        })
        .where(
          and(
            eq(researchRunQuestions.workspaceId, key.workspaceId),
            eq(researchRunQuestions.runId, key.runId),
            eq(researchRunQuestions.id, questionId),
          ),
        );

      return true;
    });
  }

  async function claimQuestionInference(key: ResearchRunExecutionKey, questionId: string) {
    return db.transaction(async (tx) => {
      const run = await lockLiveRunScope(tx, key, ["running"]);

      if (!run) {
        return null;
      }

      const [question] = await tx
        .update(researchRunQuestions)
        .set({
          inferenceState: "submitted",
        })
        .where(
          and(
            eq(researchRunQuestions.workspaceId, key.workspaceId),
            eq(researchRunQuestions.runId, key.runId),
            eq(researchRunQuestions.id, questionId),
            eq(researchRunQuestions.outcome, "pending"),
            eq(researchRunQuestions.inferenceState, "pending"),
          ),
        )
        .returning({ id: researchRunQuestions.id, operationId: researchRunQuestions.operationId });

      return question ?? null;
    });
  }

  async function saveInferenceResult(
    key: ResearchRunExecutionKey,
    questionId: string,
    result: unknown,
    usage: { inputTokens: number; outputTokens: number } | null,
  ) {
    const [question] = await db
      .update(researchRunQuestions)
      .set({
        inferenceResult: result,
        inferenceUsage: usage,
      })
      .where(
        and(
          eq(researchRunQuestions.workspaceId, key.workspaceId),
          eq(researchRunQuestions.runId, key.runId),
          eq(researchRunQuestions.id, questionId),
          eq(researchRunQuestions.inferenceState, "submitted"),
          isNull(researchRunQuestions.inferenceResult),
        ),
      )
      .returning({ id: researchRunQuestions.id });

    return Boolean(question);
  }

  async function settleQuestionInference(key: ResearchRunExecutionKey, questionId: string) {
    await db
      .update(researchRunQuestions)
      .set({ inferenceState: "settled" })
      .where(
        and(
          eq(researchRunQuestions.workspaceId, key.workspaceId),
          eq(researchRunQuestions.runId, key.runId),
          eq(researchRunQuestions.id, questionId),
          eq(researchRunQuestions.inferenceState, "submitted"),
        ),
      );
  }

  async function failQuestion(key: ResearchRunExecutionKey, questionId: string, code: string) {
    await db
      .update(researchRunQuestions)
      .set({
        outcome: "failed",
        error: code.slice(0, 160),
      })
      .where(
        and(
          eq(researchRunQuestions.workspaceId, key.workspaceId),
          eq(researchRunQuestions.runId, key.runId),
          eq(researchRunQuestions.id, questionId),
          eq(researchRunQuestions.outcome, "pending"),
        ),
      );
  }

  async function assertRunnable(key: ResearchRunExecutionKey) {
    return db.transaction(async (tx) => {
      return Boolean(await lockLiveRunScope(tx, key, ["running"]));
    });
  }

  async function finish(
    key: ResearchRunExecutionKey,
    input: {
      status: "completed" | "failed";
      report?: NonNullable<ResearchRunDetail["report"]>;
      error?: string | null;
    },
  ) {
    if ((input.status === "completed") !== Boolean(input.report)) {
      throw new WorkspaceError(
        "conflict",
        "A completed research run requires an immutable report.",
      );
    }

    return db.transaction(async (tx) => {
      // Failure is an internal cleanup outcome, not a publication. It must be
      // persistable after authority or referenced records have been revoked.
      // Successful reports still require the live authorization/revision fence.
      const run =
        input.status === "failed"
          ? await (async () => {
              const [active] = await tx
                .select()
                .from(researchRuns)
                .where(
                  and(
                    eq(researchRuns.workspaceId, key.workspaceId),
                    eq(researchRuns.id, key.runId),
                    or(eq(researchRuns.status, "queued"), eq(researchRuns.status, "running")),
                  ),
                )
                .for("update")
                .limit(1);

              return active ?? null;
            })()
          : await lockLiveRunScope(tx, key, ["running"]);

      if (!run) {
        return false;
      }

      if (input.report) {
        for (const finding of input.report.findings) {
          for (const citation of finding.citations) {
            const [source] = await tx
              .select({
                content: researchRunSources.content,
                url: researchRunSources.url,
                retrievedAt: researchRunSources.retrievedAt,
              })
              .from(researchRunSources)
              .where(
                and(
                  eq(researchRunSources.workspaceId, key.workspaceId),
                  eq(researchRunSources.runId, key.runId),
                  eq(researchRunSources.id, citation.sourceId),
                ),
              )
              .limit(1);

            if (
              !source ||
              source.url !== citation.url ||
              source.retrievedAt.toISOString() !== citation.retrievedAt ||
              source.content.slice(citation.startOffset, citation.endOffset) !== citation.excerpt
            ) {
              throw new WorkspaceError(
                "conflict",
                "Research report contains an invalid source excerpt.",
              );
            }
          }
        }
      }

      await tx
        .update(researchRuns)
        .set({
          status: input.status,
          stage: "finished",
          report: input.report ?? null,
          error: input.error ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(researchRuns.workspaceId, key.workspaceId), eq(researchRuns.id, key.runId)));
      await appendApplicationEvent(tx, {
        id: key.runId,
        workspaceId: key.workspaceId,
        type: input.status === "completed" ? "research.completed" : "research.failed",
        actorId: run.actorId,
        executor:
          researchRunPolicySchema.parse(run.policy).executionVersion === "research-agent-v2"
            ? "agent"
            : "workflow",
        operationId: key.runId,
        ...(run.noteId ? { noteId: run.noteId } : {}),
        ...(run.personId ? { personId: run.personId } : {}),
        runId: key.runId,
        ...(input.report ? { resultId: key.runId } : {}),
      });

      return true;
    });
  }

  async function reusableSources(
    principal: Principal,
    workspaceId: string,
    input: {
      personId?: string | null;
      noteId?: string | null;
      maxRuns?: number;
      limit?: number;
      maxSnapshotAgeDays: number;
      maxBytes: number;
    },
  ) {
    const oldestReusableSnapshot = new Date(Date.now() - input.maxSnapshotAgeDays * 86_400_000);

    const legacy = input.personId
      ? await createResearchEvidenceRepository(db).reusableSources(
          principal,
          workspaceId,
          input.personId,
        )
      : [];

    const recentLegacy = legacy.filter(
      (source) => Date.parse(source.retrievedAt) >= oldestReusableSnapshot.getTime(),
    );

    const maxRuns = Math.max(1, Math.min(input.maxRuns ?? 5, 5));

    const limit = Math.max(1, Math.min(input.limit ?? 30, 30));

    const runs = await db.transaction(async (tx) => {
      await authorize(tx, principal, workspaceId);

      return tx
        .select({ id: researchRuns.id })
        .from(researchRuns)
        .leftJoin(
          people,
          and(
            eq(people.workspaceId, researchRuns.workspaceId),
            eq(people.id, researchRuns.personId),
          ),
        )
        .leftJoin(
          contactDetails,
          and(
            eq(contactDetails.workspaceId, researchRuns.workspaceId),
            eq(contactDetails.personId, researchRuns.personId),
          ),
        )
        .where(
          and(
            eq(researchRuns.workspaceId, workspaceId),
            eq(researchRuns.actorId, principal.id),
            eq(researchRuns.status, "completed"),
            input.personId
              ? and(
                  eq(researchRuns.personId, input.personId),
                  eq(people.revision, researchRuns.personRevision),
                  isNull(people.deletedAt),
                  sql`${researchRuns.contactRevision} = coalesce(${contactDetails.revision}, 0)`,
                )
              : isNull(researchRuns.personId),
            input.noteId !== undefined
              ? input.noteId
                ? eq(researchRuns.noteId, input.noteId)
                : isNull(researchRuns.noteId)
              : undefined,
          ),
        )
        .orderBy(desc(researchRuns.updatedAt), desc(researchRuns.id))
        .limit(maxRuns);
    });

    const saved = runs.length
      ? await db
          .select({
            id: researchRunSources.id,
            requestedUrl: researchRunSources.requestedUrl,
            url: researchRunSources.url,
            title: researchRunSources.title,
            publishedAt: researchRunSources.publishedAt,
            originSourceId: researchRunSources.originSourceId,
            disposition: researchRunSources.disposition,
            text: researchRunSources.content,
            retrievedAt: researchRunSources.retrievedAt,
            digest: researchRunSources.digest,
          })
          .from(researchRunSources)
          .where(
            and(
              eq(researchRunSources.workspaceId, workspaceId),
              gte(researchRunSources.retrievedAt, oldestReusableSnapshot),
              inArray(
                researchRunSources.runId,
                runs.map((run) => run.id),
              ),
            ),
          )
          .orderBy(desc(researchRunSources.retrievedAt))
          .limit(limit)
      : [];

    const combined = [
      ...recentLegacy,
      ...saved.map((source) => ({
        ...source,
        publishedAt: source.publishedAt?.toISOString() ?? null,
        retrievedAt: source.retrievedAt.toISOString(),
      })),
    ];

    const output: (typeof combined)[number][] = [];

    const digests = new Set<string>();

    let bytes = 0;

    for (const source of combined) {
      const size = new TextEncoder().encode(source.text).byteLength;

      if (digests.has(source.digest) || bytes + size > input.maxBytes) {
        continue;
      }

      output.push(source);
      digests.add(source.digest);
      bytes += size;

      if (output.length >= limit) {
        break;
      }
    }

    return output;
  }

  return {
    request,
    get,
    lookup,
    list,
    cancel,
    pendingDispatch,
    pendingDiscoverySettlement,
    pendingInferenceSettlement,
    claim,
    setStage,
    saveSources,
    saveSource,
    finish,
    reusableSources,
    loadWork,
    claimDiscovery,
    markDiscoveryCompleted,
    saveQuestionFinding,
    claimQuestionInference,
    saveInferenceResult,
    settleQuestionInference,
    failQuestion,
    assertRunnable,
  };
}
