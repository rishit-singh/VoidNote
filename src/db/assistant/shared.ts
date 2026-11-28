import { createHash } from "node:crypto";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  assistantArtifactSchema,
  assistantMemorySchema,
  assistantMessageSchema,
  type AssistantSource,
  assistantThreadSchema,
  assistantTurnSchema,
} from "../../contracts/assistant";
import { idSchema, type Principal, WorkspaceError } from "../../contracts/workspace";
import {
  assistantArtifacts,
  assistantMemories,
  assistantMessages,
  assistantThreads,
  assistantTurns,
} from "../assistant-schema";
import { contactDetails } from "../contact-schema";
import type { Database } from "../repository";
import { researchRunSources } from "../research-runs-schema";
import { researchItems } from "../research-schema";
import {
  analysisJobs,
  notes,
  noteSummaries,
  people,
  processingRuns,
  recordings,
  transcriptSegments,
  transcriptUtterances,
  workspaceMemberships,
  workspaces,
} from "../schema";

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type ThreadRow = typeof assistantThreads.$inferSelect;
export type TurnRow = typeof assistantTurns.$inferSelect;
export type AssistantWriteContext = { turnId: string };
export const active = (turn: TurnRow) => turn.status === "queued" || turn.status === "running";
const MAX_SOURCE_DEPENDENCIES = 256;

const MAX_SOURCE_DEPTH = 8;

export type MemorySupersession = {
  revisions: ReadonlySet<number>;
  revision: number;
  status: "active" | "invalidated";
  replacement: AssistantSource[];
};

export type ProfileSupersession = {
  sourceRevisions: ReadonlySet<string>;
  personRevision: number;
  contactRevision: number;
};

type SourceValidationBudget = {
  remaining: number;
  memo?: Map<string, ValidatedSource>;
  visiting?: Set<string>;
  frames?: { depth: number; deepest: number }[];
  forbiddenMemoryId?: string;
  memorySupersessions?: ReadonlyMap<string, MemorySupersession>;
  supersessionsApplied?: number;
  profileSupersessions?: ReadonlyMap<string, ProfileSupersession>;
  profileSupersessionsApplied?: number;
};

type ValidatedSource = {
  sources: AssistantSource[];
  height: number;
  supersessions: number;
  profileSupersessions: number;
  preserveLabel: boolean;
};

export const sourceValidationBudget = (memoize = false): SourceValidationBudget => ({
  remaining: MAX_SOURCE_DEPENDENCIES,
  ...(memoize ? { memo: new Map(), visiting: new Set(), frames: [] } : {}),
});

export function artifactChecksum(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function fingerprint(value: unknown): string {
  function canonical(input: unknown): string {
    if (Array.isArray(input)) {
      return `[${input.map(canonical).join(",")}]`;
    }

    if (input !== null && typeof input === "object") {
      return `{${Object.entries(input)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    }

    return JSON.stringify(input) ?? "null";
  }

  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function deterministicId(workspaceId: string, operationId: string, purpose: string) {
  const hex = fingerprint({ workspaceId, operationId, purpose }).slice(0, 32);

  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export const turnScope = (workspaceId: string, turnId: string) =>
  and(eq(assistantTurns.workspaceId, workspaceId), eq(assistantTurns.id, turnId));

export function publicThread(row: ThreadRow) {
  return assistantThreadSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function publicTurn(row: TurnRow) {
  return assistantTurnSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function publicMessage(row: typeof assistantMessages.$inferSelect) {
  return assistantMessageSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}

export function publicMemory(row: typeof assistantMemories.$inferSelect) {
  return assistantMemorySchema.parse({
    ...row,
    status:
      row.status === "active" && row.expiresAt && row.expiresAt <= new Date()
        ? "expired"
        : row.status,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function publicArtifact(row: typeof assistantArtifacts.$inferSelect) {
  return assistantArtifactSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}

export async function authorize(tx: Transaction, principal: Principal, workspaceId: string) {
  idSchema.parse(principal.id);
  idSchema.parse(workspaceId);
  const [member] = await tx
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

  if (!member) {
    throw new WorkspaceError("forbidden", "Workspace access denied");
  }
}

export async function requireNote(tx: Transaction, workspaceId: string, noteId: string) {
  idSchema.parse(noteId);
  const [note] = await tx
    .select()
    .from(notes)
    .where(and(eq(notes.workspaceId, workspaceId), eq(notes.id, noteId), isNull(notes.deletedAt)))
    .for("share")
    .limit(1);

  if (!note) {
    throw new WorkspaceError("not_found", "Note not found");
  }

  return note;
}

export async function requirePerson(tx: Transaction, workspaceId: string, personId: string) {
  idSchema.parse(personId);
  const [person] = await tx
    .select({ id: people.id, revision: people.revision })
    .from(people)
    .where(
      and(eq(people.workspaceId, workspaceId), eq(people.id, personId), isNull(people.deletedAt)),
    )
    .for("share")
    .limit(1);

  if (!person) {
    throw new WorkspaceError("not_found", "Person not found");
  }

  return person;
}

export async function requireThread(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  threadId: string,
  lock = false,
) {
  idSchema.parse(threadId);
  const scope = and(
    eq(assistantThreads.workspaceId, workspaceId),
    eq(assistantThreads.id, threadId),
    eq(assistantThreads.actorId, principal.id),
  );

  // The immutable note association is read first to maintain lifecycle lock order:
  // membership/workspace -> note -> thread -> turn.
  const [candidate] = await tx.select().from(assistantThreads).where(scope).limit(1);

  if (!candidate) {
    throw new WorkspaceError("not_found", "Conversation not found");
  }

  if (candidate.noteId) {
    await requireNote(tx, workspaceId, candidate.noteId);
  }

  if (!lock) {
    return candidate;
  }

  const [thread] = await tx.select().from(assistantThreads).where(scope).for("update").limit(1);

  if (!thread) {
    throw new WorkspaceError("not_found", "Conversation not found");
  }

  return thread;
}

export async function requireTurn(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  turnId: string,
  lock = false,
) {
  idSchema.parse(turnId);
  const [candidate] = await tx
    .select()
    .from(assistantTurns)
    .where(and(turnScope(workspaceId, turnId), eq(assistantTurns.actorId, principal.id)))
    .limit(1);

  if (!candidate) {
    throw new WorkspaceError("not_found", "Turn not found");
  }

  const thread = await requireThread(tx, principal, workspaceId, candidate.threadId, lock);

  const [turn] = await tx
    .select()
    .from(assistantTurns)
    .where(turnScope(workspaceId, turnId))
    .limit(1);

  if (!turn) {
    throw new WorkspaceError("not_found", "Turn not found");
  }

  return { thread, turn };
}

export async function lockWriteContext(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  context?: AssistantWriteContext,
) {
  if (!context) {
    return null;
  }

  const { turn } = await requireTurn(tx, principal, workspaceId, context.turnId, true);

  return turn;
}

export function guardNewWrite(turn: TurnRow | null) {
  if (turn && turn.status !== "running") {
    throw new WorkspaceError("conflict", "The assistant turn is no longer running");
  }
}

export async function requireMemory(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  memoryId: string,
  lock: "share" | "update" = "share",
) {
  idSchema.parse(memoryId);
  const [memory] = await tx
    .select()
    .from(assistantMemories)
    .where(
      and(
        eq(assistantMemories.workspaceId, workspaceId),
        eq(assistantMemories.id, memoryId),
        eq(assistantMemories.actorId, principal.id),
      ),
    )
    .for(lock)
    .limit(1);

  if (!memory) {
    throw new WorkspaceError("not_found", "Memory not found");
  }

  if (memory.subjectId) {
    await requirePerson(tx, workspaceId, memory.subjectId);
  }

  return memory;
}

export async function requireArtifact(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  artifactId: string,
) {
  idSchema.parse(artifactId);
  const [artifact] = await tx
    .select()
    .from(assistantArtifacts)
    .where(
      and(
        eq(assistantArtifacts.workspaceId, workspaceId),
        eq(assistantArtifacts.id, artifactId),
        eq(assistantArtifacts.actorId, principal.id),
      ),
    )
    .limit(1);

  if (!artifact) {
    throw new WorkspaceError("not_found", "Artifact not found");
  }

  if (artifact.noteId) {
    await requireNote(tx, workspaceId, artifact.noteId);
  }

  return artifact;
}

export async function validateSources(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  sources: AssistantSource[],
  budget = sourceValidationBudget(),
  depth = 0,
  allowMemorySupersession = true,
): Promise<AssistantSource[]> {
  if (!budget.memo) {
    return validateSourceBatch(
      tx,
      principal,
      workspaceId,
      sources,
      budget,
      depth,
      allowMemorySupersession,
    );
  }

  const results = new Map<AssistantSource, AssistantSource[]>();

  const ordered = [...sources].sort((a, b) =>
    `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
  );

  for (const source of ordered) {
    // Presentation labels are not dependencies. Revisions, anchors and the
    // supersession mode are: a successful current read must never mask a stale
    // revision or let current memory provenance use predecessor exemptions.
    const key = fingerprint({
      source: { ...source, label: undefined },
      allowMemorySupersession:
        source.kind === "memory" || source.kind === "message" ? allowMemorySupersession : undefined,
      forbiddenMemoryId: budget.forbiddenMemoryId,
    });

    const cached = budget.memo.get(key);

    const deepest = depth + (cached?.height ?? 0);

    if (deepest > MAX_SOURCE_DEPTH) {
      throw new WorkspaceError("conflict", "Source dependency depth exceeds the validation bound");
    }

    for (const frame of budget.frames!) {
      frame.deepest = Math.max(frame.deepest, deepest);
    }

    if (cached) {
      // Ancestor messages still need to see that cached descendants were
      // superseded, otherwise they would retain unusable historical pointers.
      budget.supersessionsApplied =
        (budget.supersessionsApplied ?? 0) + Number(cached.supersessions > 0);
      budget.profileSupersessionsApplied =
        (budget.profileSupersessionsApplied ?? 0) + Number(cached.profileSupersessions > 0);
      results.set(
        source,
        cached.preserveLabel
          ? cached.sources.map((item) => ({ ...item, label: source.label }))
          : cached.sources,
      );
      continue;
    }

    if (budget.visiting!.has(key)) {
      throw new WorkspaceError("conflict", "Source dependencies contain a cycle");
    }

    const frame = { depth, deepest: depth };

    const before = budget.supersessionsApplied ?? 0;

    const profilesBefore = budget.profileSupersessionsApplied ?? 0;

    budget.visiting!.add(key);
    budget.frames!.push(frame);

    try {
      const validated = await validateSourceBatch(
        tx,
        principal,
        workspaceId,
        [source],
        budget,
        depth,
        allowMemorySupersession,
      );

      const supersessions = (budget.supersessionsApplied ?? 0) - before;

      const profileSupersessions = (budget.profileSupersessionsApplied ?? 0) - profilesBefore;

      budget.memo.set(key, {
        sources: validated,
        height: frame.deepest - frame.depth,
        supersessions,
        profileSupersessions,
        preserveLabel:
          source.kind === "person" || (supersessions === 0 && profileSupersessions === 0),
      });
      results.set(source, validated);
    } finally {
      budget.frames!.pop();
      budget.visiting!.delete(key);
    }
  }

  // A small DAG can have exponentially many paths to superseded evidence.
  // Merge bounded, distinct provenance before returning it to a parent or
  // caching that parent's expansion. Keep the first presentation label without
  // collapsing different revisions, contact revisions or transcript anchors.
  const merged: AssistantSource[] = [];

  const seen = new Set<string>();

  for (const source of sources) {
    for (const dependency of results.get(source)!) {
      const key = fingerprint({ ...dependency, label: undefined });

      if (seen.has(key)) {
        continue;
      }

      if (merged.length >= MAX_SOURCE_DEPENDENCIES) {
        throw new WorkspaceError("conflict", "Too many expanded source dependencies");
      }

      seen.add(key);
      merged.push(dependency);
    }
  }

  return merged;
}

async function validateSourceBatch(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  sources: AssistantSource[],
  budget = sourceValidationBudget(),
  depth = 0,
  allowMemorySupersession = true,
): Promise<AssistantSource[]> {
  if (depth > MAX_SOURCE_DEPTH) {
    throw new WorkspaceError("conflict", "Source dependency depth exceeds the validation bound");
  }

  const revisions = new Map<AssistantSource, number>();

  const contactRevisions = new Map<AssistantSource, number>();

  const replacements = new Map<AssistantSource, AssistantSource[]>();

  // Sort lifecycle locks so opposite source order cannot deadlock two publishers.
  const ordered = [...sources].sort((a, b) =>
    `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
  );

  for (const source of ordered) {
    budget.remaining -= 1;

    if (budget.remaining < 0) {
      throw new WorkspaceError("conflict", "Too many source dependencies to validate");
    }

    let revision: number | undefined;

    if (source.contactRevision !== undefined && source.kind !== "person") {
      throw new WorkspaceError("conflict", "Contact revisions require a person source");
    }

    if (
      source.kind !== "url" &&
      (source.researchRunId !== undefined || source.researchBatchId !== undefined)
    ) {
      throw new WorkspaceError("conflict", "Research scopes require a saved URL source.");
    }

    if (
      source.kind !== "transcript" &&
      (source.recordingId !== undefined ||
        source.runId !== undefined ||
        source.startSeconds !== undefined ||
        source.endSeconds !== undefined ||
        (source.noteId !== undefined &&
          ((source.kind !== "note" && source.kind !== "summary") ||
            (source.kind === "note" && source.noteId !== source.id))))
    ) {
      throw new WorkspaceError("conflict", "Audio anchors require a verified transcript source");
    }

    const supersession =
      allowMemorySupersession && source.kind === "memory" && source.revision !== undefined
        ? budget.memorySupersessions?.get(source.id)
        : undefined;

    if (supersession && supersession.revisions.has(source.revision!)) {
      const memory = publicMemory(await requireMemory(tx, principal, workspaceId, source.id));

      if (memory.revision !== supersession.revision || memory.status !== supersession.status) {
        throw new WorkspaceError("conflict", "Memory changed after the acknowledged mutation");
      }

      replacements.set(
        source,
        await validateSources(
          tx,
          principal,
          workspaceId,
          supersession.replacement,
          budget,
          depth + 1,
          false,
        ),
      );
      budget.supersessionsApplied = (budget.supersessionsApplied ?? 0) + 1;
      continue;
    }

    switch (source.kind) {
      case "url": {
        const url = z.url().parse(source.url ?? source.id);

        if (!["https:", "http:"].includes(new URL(url).protocol)) {
          throw new WorkspaceError("conflict", "Only HTTP sources are supported");
        }

        if (source.researchRunId && source.researchBatchId) {
          throw new WorkspaceError("conflict", "Research evidence must identify one saved scope.");
        }

        if (source.researchRunId) {
          idSchema.parse(source.id);
          const [snapshot] = await tx
            .select({ id: researchRunSources.id })
            .from(researchRunSources)
            .where(
              and(
                eq(researchRunSources.workspaceId, workspaceId),
                eq(researchRunSources.runId, source.researchRunId),
                eq(researchRunSources.id, source.id),
                eq(researchRunSources.url, url),
              ),
            )
            .limit(1);

          if (!snapshot) {
            throw new WorkspaceError("conflict", "Saved research evidence is unavailable.");
          }
        }

        if (source.researchBatchId) {
          const [snapshot] = await tx
            .select({ id: researchItems.batchId })
            .from(researchItems)
            .where(
              and(
                eq(researchItems.workspaceId, workspaceId),
                eq(researchItems.batchId, source.researchBatchId),
                sql`exists (
                  select 1 from jsonb_array_elements(${researchItems.sources}) as source
                  where source->>'id' = ${source.id} and source->>'url' = ${url}
                )`,
              ),
            )
            .limit(1);

          if (!snapshot) {
            throw new WorkspaceError("conflict", "Saved contact-research evidence is unavailable.");
          }
        }

        break;
      }

      case "note":
        revision = (await requireNote(tx, workspaceId, source.id)).revision;
        break;
      case "summary": {
        idSchema.parse(source.id);

        if (!source.noteId || source.noteId === source.id) {
          throw new WorkspaceError("conflict", "Summary sources require their note scope.");
        }

        const note = await requireNote(tx, workspaceId, source.noteId);

        const [summary] = await tx
          .select({
            version: noteSummaries.version,
            status: analysisJobs.status,
            context: analysisJobs.context,
          })
          .from(noteSummaries)
          .innerJoin(
            analysisJobs,
            and(
              eq(analysisJobs.workspaceId, noteSummaries.workspaceId),
              eq(analysisJobs.id, noteSummaries.jobId),
            ),
          )
          .where(
            and(
              eq(noteSummaries.workspaceId, workspaceId),
              eq(noteSummaries.jobId, source.id),
              eq(noteSummaries.noteId, source.noteId),
            ),
          )
          .for("share", { of: [noteSummaries, analysisJobs] })
          .limit(1);

        if (!summary || summary.status !== "succeeded" || !summary.context) {
          throw new WorkspaceError("not_found", "Saved Summary source is unavailable.");
        }

        const context = z
          .object({
            source: z.object({
              noteId: idSchema,
              recordingId: idSchema,
              runId: idSchema,
              generation: z.number().int().positive(),
            }),
            noteRevision: z.number().int().positive(),
            profiles: z.array(
              z.object({ personId: idSchema, revision: z.number().int().positive() }),
            ),
          })
          .passthrough()
          .parse(summary.context);

        if (context.source.noteId !== source.noteId || context.noteRevision !== note.revision) {
          throw new WorkspaceError("conflict", "Saved Summary dependencies have changed.");
        }

        const [run] = await tx
          .select({ generation: processingRuns.transcriptGeneration })
          .from(processingRuns)
          .innerJoin(
            recordings,
            and(
              eq(recordings.workspaceId, workspaceId),
              eq(recordings.id, processingRuns.recordingId),
            ),
          )
          .where(
            and(
              eq(processingRuns.workspaceId, workspaceId),
              eq(processingRuns.id, context.source.runId),
              eq(processingRuns.noteId, source.noteId),
              eq(processingRuns.recordingId, context.source.recordingId),
              eq(processingRuns.status, "succeeded"),
              eq(recordings.status, "ready"),
              isNull(recordings.deletedAt),
            ),
          )
          .for("share", { of: [processingRuns, recordings] })
          .limit(1);

        if (!run || run.generation !== context.source.generation) {
          throw new WorkspaceError("conflict", "Saved Summary transcript has changed.");
        }

        if (context.profiles.length) {
          const profileRows = await tx
            .select({ id: people.id, revision: people.revision, deletedAt: people.deletedAt })
            .from(people)
            .where(
              and(
                eq(people.workspaceId, workspaceId),
                inArray(
                  people.id,
                  context.profiles.map((profile) => profile.personId),
                ),
              ),
            )
            .for("share")
            .limit(context.profiles.length);

          if (
            profileRows.length !== context.profiles.length ||
            profileRows.some(
              (row) =>
                row.deletedAt !== null ||
                context.profiles.find((profile) => profile.personId === row.id)?.revision !==
                  row.revision,
            )
          ) {
            throw new WorkspaceError("conflict", "Saved Summary profile sources have changed.");
          }
        }

        revision = summary.version;
        break;
      }

      case "transcript": {
        idSchema.parse(source.id);

        if (!source.noteId || !source.recordingId || !source.runId) {
          throw new WorkspaceError("conflict", "Transcript sources require their full scope");
        }

        await requireNote(tx, workspaceId, source.noteId);
        const [run] = await tx
          .select({
            generation: processingRuns.transcriptGeneration,
            materializedAt: processingRuns.correctionsMaterializedAt,
          })
          .from(processingRuns)
          .innerJoin(
            recordings,
            and(
              eq(recordings.workspaceId, workspaceId),
              eq(recordings.id, processingRuns.recordingId),
            ),
          )
          .where(
            and(
              eq(processingRuns.workspaceId, workspaceId),
              eq(processingRuns.id, source.runId),
              eq(processingRuns.noteId, source.noteId),
              eq(processingRuns.recordingId, source.recordingId),
              eq(processingRuns.status, "succeeded"),
              eq(recordings.status, "ready"),
              isNull(recordings.deletedAt),
            ),
          )
          .for("share", { of: [processingRuns, recordings] })
          .limit(1);

        if (!run || run.generation < 1) {
          throw new WorkspaceError("not_found", "Transcript source not found");
        }

        const [segment] = await tx
          .select({
            start: transcriptSegments.startSeconds,
            end: transcriptSegments.endSeconds,
          })
          .from(transcriptSegments)
          .where(
            and(
              eq(transcriptSegments.workspaceId, workspaceId),
              eq(transcriptSegments.runId, source.runId),
              eq(transcriptSegments.id, source.id),
              eq(transcriptSegments.active, true),
            ),
          )
          .for("share")
          .limit(1);

        let span = segment;

        if (!span && run.materializedAt === null) {
          [span] = await tx
            .select({
              start: transcriptUtterances.startSeconds,
              end: transcriptUtterances.endSeconds,
            })
            .from(transcriptUtterances)
            .where(
              and(
                eq(transcriptUtterances.workspaceId, workspaceId),
                eq(transcriptUtterances.runId, source.runId),
                eq(transcriptUtterances.id, source.id),
              ),
            )
            .limit(1);
        }

        if (!span) {
          throw new WorkspaceError("not_found", "Transcript passage not found");
        }

        if (
          (source.startSeconds === undefined) !== (source.endSeconds === undefined) ||
          (source.startSeconds !== undefined &&
            source.endSeconds !== undefined &&
            (source.startSeconds < span.start ||
              source.endSeconds > span.end ||
              source.endSeconds <= source.startSeconds))
        ) {
          throw new WorkspaceError("conflict", "Audio anchor is outside its source passage");
        }

        // Transcript revision identifies the run's corrected generation, which
        // changes on text, attribution and boundary edits.
        revision = run.generation;
        break;
      }

      case "person": {
        const profileSupersession = budget.profileSupersessions?.get(source.id);

        const sourceRevisionKey =
          source.revision !== undefined && source.contactRevision !== undefined
            ? `${source.revision}:${source.contactRevision}`
            : null;

        if (
          profileSupersession &&
          sourceRevisionKey &&
          profileSupersession.sourceRevisions.has(sourceRevisionKey)
        ) {
          const person = await requirePerson(tx, workspaceId, source.id);

          const [details] = await tx
            .select({ revision: contactDetails.revision })
            .from(contactDetails)
            .where(
              and(
                eq(contactDetails.workspaceId, workspaceId),
                eq(contactDetails.personId, source.id),
              ),
            )
            .for("share")
            .limit(1);

          const contactRevision = details?.revision ?? 0;

          if (
            person.revision !== profileSupersession.personRevision ||
            contactRevision !== profileSupersession.contactRevision
          ) {
            throw new WorkspaceError("conflict", "Profile changed after the acknowledged update.");
          }

          replacements.set(source, [
            {
              kind: "person",
              id: source.id,
              label: source.label,
              revision: profileSupersession.personRevision,
              contactRevision: profileSupersession.contactRevision,
            },
          ]);
          budget.profileSupersessionsApplied = (budget.profileSupersessionsApplied ?? 0) + 1;
          continue;
        }

        revision = (await requirePerson(tx, workspaceId, source.id)).revision;
        // Contact writes lock the person for update, including first creation.
        // Its shared lifecycle lock therefore protects the absent revision 0 too.
        const [details] = await tx
          .select({ revision: contactDetails.revision })
          .from(contactDetails)
          .where(
            and(
              eq(contactDetails.workspaceId, workspaceId),
              eq(contactDetails.personId, source.id),
            ),
          )
          .for("share")
          .limit(1);

        const contactRevision = details?.revision ?? 0;

        if (source.contactRevision !== undefined && source.contactRevision !== contactRevision) {
          throw new WorkspaceError(
            "conflict",
            "Source contact details have changed",
            contactRevision,
          );
        }

        contactRevisions.set(source, contactRevision);
        break;
      }

      case "message": {
        idSchema.parse(source.id);
        const [message] = await tx
          .select({
            threadId: assistantMessages.threadId,
            sources: assistantMessages.sources,
            tools: assistantMessages.tools,
          })
          .from(assistantMessages)
          .where(
            and(
              eq(assistantMessages.workspaceId, workspaceId),
              eq(assistantMessages.id, source.id),
            ),
          )
          .limit(1);

        if (!message) {
          throw new WorkspaceError("not_found", "Source message not found");
        }

        await requireThread(tx, principal, workspaceId, message.threadId);
        const before =
          (budget.supersessionsApplied ?? 0) + (budget.profileSupersessionsApplied ?? 0);

        const dependencies = await validateSources(
          tx,
          principal,
          workspaceId,
          [...message.sources, ...message.tools.flatMap((tool) => tool.sources)],
          budget,
          depth + 1,
          allowMemorySupersession,
        );

        const after =
          (budget.supersessionsApplied ?? 0) + (budget.profileSupersessionsApplied ?? 0);

        if (after !== before) {
          // This historical message contains explicitly superseded evidence.
          // Preserve ALL other dependencies and current memory provenance rather
          // than carrying an unusable message pointer or dropping its lineage.
          replacements.set(source, dependencies);
        }

        break;
      }

      case "memory": {
        if (source.id === budget.forbiddenMemoryId) {
          throw new WorkspaceError("conflict", "Memory cannot depend on its own revision");
        }

        const memory = await requireMemory(tx, principal, workspaceId, source.id);

        if (publicMemory(memory).status !== "active") {
          throw new WorkspaceError("conflict", "Source memory is not active");
        }

        revision = memory.revision;
        await validateSources(tx, principal, workspaceId, memory.sources, budget, depth + 1, false);
        break;
      }

      case "artifact": {
        const artifact = await requireArtifact(tx, principal, workspaceId, source.id);

        revision = artifact.revision;
        await validateSources(
          tx,
          principal,
          workspaceId,
          artifact.sources,
          budget,
          depth + 1,
          false,
        );
        break;
      }
    }

    if (source.revision !== undefined && source.revision !== revision) {
      throw new WorkspaceError("conflict", "Source revision has changed", revision);
    }

    if (revision !== undefined) {
      revisions.set(source, revision);
    }
  }

  // Pin every mutable local dependency, including sources whose caller omitted a
  // revision. Subsequent recall can then detect change instead of silently
  // reinterpreting the claim against today's record.
  return sources.flatMap((source) => {
    const replacement = replacements.get(source);

    if (replacement) {
      return replacement;
    }

    const revision = revisions.get(source);

    const contactRevision = contactRevisions.get(source);

    return [
      {
        ...source,
        ...(revision === undefined ? {} : { revision }),
        ...(contactRevision === undefined ? {} : { contactRevision }),
      },
    ];
  });
}
