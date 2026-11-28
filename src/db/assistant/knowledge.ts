import { and, desc, eq, gt, ilike, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  type AssistantArtifact,
  type AssistantArtifactListItem,
  assistantArtifactListItemSchema,
  type AssistantMemory,
  assistantMemorySchema,
  type AssistantSource,
  type CreateAssistantArtifact,
  createAssistantArtifactSchema,
  type RememberAssistantMemory,
  rememberAssistantMemorySchema,
} from "../../contracts/assistant";
import {
  idSchema,
  type NoteRecord,
  type Principal,
  WorkspaceError,
} from "../../contracts/workspace";
import {
  assistantArtifactPublications,
  assistantArtifacts,
  assistantMemories,
  assistantMemoryRevisions,
  assistantOperationReceipts,
} from "../assistant-schema";
import type { Database } from "../repository";
import { commandReceipts, domainEvents, notes, outbox, people } from "../schema";
import {
  artifactChecksum,
  type AssistantWriteContext,
  authorize,
  deterministicId,
  fingerprint,
  guardNewWrite,
  lockWriteContext,
  publicArtifact,
  publicMemory,
  requireArtifact,
  requireMemory,
  requireNote,
  requirePerson,
  sourceValidationBudget,
  type Transaction,
  validateSources,
} from "./shared";

type OperationKind = typeof assistantOperationReceipts.$inferSelect.kind;

async function claimOperation(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  operationId: string,
  kind: OperationKind,
  input: unknown,
  resultId: string,
  context?: AssistantWriteContext,
) {
  idSchema.parse(operationId);
  const hash = fingerprint({
    actorId: principal.id,
    workspaceId,
    kind,
    version: 1,
    input,
    turnId: context?.turnId ?? null,
  });

  const [claim] = await tx
    .insert(assistantOperationReceipts)
    .values({
      workspaceId,
      operationId,
      actorId: principal.id,
      fingerprint: hash,
      kind,
      resultId,
    })
    .onConflictDoNothing()
    .returning({ id: assistantOperationReceipts.operationId });

  if (claim) {
    return true;
  }

  const [previous] = await tx
    .select()
    .from(assistantOperationReceipts)
    .where(
      and(
        eq(assistantOperationReceipts.workspaceId, workspaceId),
        eq(assistantOperationReceipts.operationId, operationId),
      ),
    )
    .limit(1);

  if (
    !previous ||
    previous.actorId !== principal.id ||
    previous.fingerprint !== hash ||
    previous.kind !== kind ||
    previous.resultId !== resultId
  ) {
    throw new WorkspaceError("command_reused", "Operation ID was used for different inputs");
  }

  return false;
}

async function createAuthoredNote(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  operationId: string,
  noteId: string,
  title: string,
) {
  const now = new Date();

  const commandId = deterministicId(workspaceId, operationId, "authored-note-command");

  const eventId = deterministicId(workspaceId, operationId, "authored-note-event");

  const result: NoteRecord = {
    workspaceId,
    id: noteId,
    title,
    transcript: "",
    revision: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    deletedAt: null,
  };

  await tx.insert(notes).values({
    workspaceId,
    id: noteId,
    title,
    transcript: "",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(commandReceipts).values({
    workspaceId,
    commandId,
    actorId: principal.id,
    fingerprint: fingerprint({ kind: "assistant-authored-note", operationId, result }),
    result,
  });
  await tx.insert(domainEvents).values({
    workspaceId,
    id: eventId,
    entityType: "note",
    entityId: noteId,
    noteId,
    revision: 1,
    operation: "create",
    actorId: principal.id,
    commandId,
    payload: result,
  });
  await tx.insert(outbox).values({ workspaceId, eventId, kind: "note.changed" });
}

async function recordMemoryRevision(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  operationId: string,
  before: AssistantMemory | null,
  after: AssistantMemory,
  reason: string,
) {
  await tx.insert(assistantMemoryRevisions).values({
    workspaceId,
    memoryId: after.id,
    revision: after.revision,
    operationId,
    actorId: principal.id,
    before,
    after,
    reason,
  });
}

export function createKnowledgeOperations(db: Database) {
  return {
    async remember(
      principal: Principal,
      workspaceId: string,
      value: RememberAssistantMemory,
      context?: AssistantWriteContext,
    ): Promise<AssistantMemory> {
      const input = rememberAssistantMemorySchema.parse(value);

      const memoryId = deterministicId(workspaceId, input.operationId, "memory");

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        const turn = await lockWriteContext(tx, principal, workspaceId, context);

        const claimed = await claimOperation(
          tx,
          principal,
          workspaceId,
          input.operationId,
          "remember",
          input,
          memoryId,
          context,
        );

        if (!claimed) {
          return publicMemory(await requireMemory(tx, principal, workspaceId, memoryId));
        }

        guardNewWrite(turn);

        if (input.subjectId) {
          await requirePerson(tx, workspaceId, input.subjectId);
        }

        if (input.provenance === "source-supported" && input.sources.length === 0) {
          throw new WorkspaceError("conflict", "Source-supported memory requires evidence");
        }

        const sources = await validateSources(tx, principal, workspaceId, input.sources);

        const [memory] = await tx
          .insert(assistantMemories)
          .values({
            workspaceId,
            id: memoryId,
            actorId: principal.id,
            subjectId: input.subjectId,
            kind: input.kind,
            content: input.content,
            provenance: input.provenance,
            sources,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            status: input.provenance === "agent-inferred" ? "needs-review" : "active",
          })
          .returning();

        await recordMemoryRevision(
          tx,
          principal,
          workspaceId,
          input.operationId,
          null,
          publicMemory(memory!),
          "Memory created",
        );

        return publicMemory(memory!);
      });
    },

    async recall(
      principal: Principal,
      workspaceId: string,
      query: string,
      subjectId?: string,
    ): Promise<AssistantMemory[]> {
      z.string().max(300).parse(query);

      if (subjectId) {
        idSchema.parse(subjectId);
      }

      // Search is a bounded literal contains match, not an unescaped SQL pattern.
      const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);

        if (subjectId) {
          await requirePerson(tx, workspaceId, subjectId);
        }

        const rows = await tx
          .select({ memory: assistantMemories })
          .from(assistantMemories)
          .leftJoin(
            people,
            and(eq(people.workspaceId, workspaceId), eq(people.id, assistantMemories.subjectId)),
          )
          .where(
            and(
              eq(assistantMemories.workspaceId, workspaceId),
              eq(assistantMemories.actorId, principal.id),
              eq(assistantMemories.status, "active"),
              or(isNull(assistantMemories.expiresAt), gt(assistantMemories.expiresAt, new Date())),
              or(isNull(assistantMemories.subjectId), isNull(people.deletedAt)),
              subjectId ? eq(assistantMemories.subjectId, subjectId) : undefined,
              ilike(assistantMemories.content, pattern),
            ),
          )
          .orderBy(desc(assistantMemories.createdAt), desc(assistantMemories.id))
          .limit(50);

        const memories: AssistantMemory[] = [];

        const budget = sourceValidationBudget();

        for (const { memory } of rows) {
          try {
            // Saved provenance is immutable; stale/deleted sources do not silently
            // become active retrieval context.
            await validateSources(tx, principal, workspaceId, memory.sources, budget);
            memories.push(publicMemory(memory));
          } catch (error) {
            if (
              !(error instanceof WorkspaceError) ||
              !["not_found", "conflict"].includes(error.code)
            ) {
              throw error;
            }
          }
        }

        return memories;
      });
    },

    async invalidateMemory(
      principal: Principal,
      workspaceId: string,
      id: string,
      expectedRevision: number,
      reason: string,
      operationId: string,
      context?: AssistantWriteContext,
    ): Promise<AssistantMemory> {
      idSchema.parse(id);
      z.number().int().min(1).max(2_147_483_646).parse(expectedRevision);
      z.string().trim().min(1).max(1000).parse(reason);
      const input = { id, expectedRevision, reason, operationId };

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        const turn = await lockWriteContext(tx, principal, workspaceId, context);

        const claimed = await claimOperation(
          tx,
          principal,
          workspaceId,
          operationId,
          "invalidate-memory",
          input,
          id,
          context,
        );

        const memory = await requireMemory(tx, principal, workspaceId, id, "update");

        if (!claimed) {
          return publicMemory(memory);
        }

        guardNewWrite(turn);

        if (memory.revision !== expectedRevision) {
          throw new WorkspaceError("conflict", "Memory has changed", memory.revision);
        }

        const [invalidated] = await tx
          .update(assistantMemories)
          .set({
            status: "invalidated",
            revision: memory.revision + 1,
            invalidationReason: reason,
            updatedAt: new Date(),
          })
          .where(and(eq(assistantMemories.workspaceId, workspaceId), eq(assistantMemories.id, id)))
          .returning();

        await recordMemoryRevision(
          tx,
          principal,
          workspaceId,
          operationId,
          publicMemory(memory),
          publicMemory(invalidated!),
          reason,
        );

        return publicMemory(invalidated!);
      });
    },

    async reviseMemory(
      principal: Principal,
      workspaceId: string,
      id: string,
      expectedRevision: number,
      content: string,
      sources: AssistantSource[],
      reason: string,
      operationId: string,
      context?: AssistantWriteContext,
    ): Promise<AssistantMemory> {
      const input = z
        .object({
          id: idSchema,
          expectedRevision: z.number().int().min(1).max(2_147_483_646),
          content: assistantMemorySchema.shape.content,
          sources: assistantMemorySchema.shape.sources,
          reason: z.string().trim().min(1).max(1000),
          operationId: idSchema,
        })
        .parse({ id, expectedRevision, content, sources, reason, operationId });

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        // Revisions may reference other memories. Serialize this owner's revision
        // operations before taking target/source locks, avoiding A->B / B->A
        // lock upgrades while retaining source-validation publication fences.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:assistant-memory-revision:${principal.id}`}, 0))`,
        );
        const turn = await lockWriteContext(tx, principal, workspaceId, context);

        const claimed = await claimOperation(
          tx,
          principal,
          workspaceId,
          operationId,
          "revise-memory",
          input,
          id,
          context,
        );

        const memory = await requireMemory(tx, principal, workspaceId, id, "update");

        if (!claimed) {
          return publicMemory(memory);
        }

        guardNewWrite(turn);

        if (memory.revision !== expectedRevision) {
          throw new WorkspaceError("conflict", "Memory has changed", memory.revision);
        }

        if (memory.provenance === "source-supported" && input.sources.length === 0) {
          throw new WorkspaceError("conflict", "Source-supported memory requires evidence");
        }

        const budget = sourceValidationBudget();

        budget.forbiddenMemoryId = id;
        const pinnedSources = await validateSources(
          tx,
          principal,
          workspaceId,
          input.sources,
          budget,
        );

        const [revised] = await tx
          .update(assistantMemories)
          .set({
            content: input.content,
            sources: pinnedSources,
            revision: memory.revision + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(assistantMemories.workspaceId, workspaceId), eq(assistantMemories.id, id)))
          .returning();

        await recordMemoryRevision(
          tx,
          principal,
          workspaceId,
          operationId,
          publicMemory(memory),
          publicMemory(revised!),
          input.reason,
        );

        return publicMemory(revised!);
      });
    },

    async createArtifact(
      principal: Principal,
      workspaceId: string,
      value: CreateAssistantArtifact,
      context?: AssistantWriteContext,
    ): Promise<AssistantArtifact> {
      const input = createAssistantArtifactSchema.parse(value);

      const artifactId = deterministicId(workspaceId, input.operationId, "artifact");

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        const turn = await lockWriteContext(tx, principal, workspaceId, context);

        const claimed = await claimOperation(
          tx,
          principal,
          workspaceId,
          input.operationId,
          "create-artifact",
          input,
          artifactId,
          context,
        );

        if (!claimed) {
          return publicArtifact(await requireArtifact(tx, principal, workspaceId, artifactId));
        }

        guardNewWrite(turn);

        const sources = await validateSources(tx, principal, workspaceId, input.sources);

        let noteId = input.noteId;

        if (input.kind === "note") {
          if (noteId !== null) {
            throw new WorkspaceError("conflict", "New authored notes require an empty note ID");
          }

          noteId = deterministicId(workspaceId, input.operationId, "authored-note");
          await createAuthoredNote(
            tx,
            principal,
            workspaceId,
            input.operationId,
            noteId,
            input.name,
          );
        } else if (noteId) {
          await requireNote(tx, workspaceId, noteId);
        }

        if (
          input.kind === "annotation" &&
          (!noteId ||
            !input.sources.some(
              (source) =>
                (source.kind === "note" && source.id === noteId) ||
                (source.kind === "transcript" && source.noteId === noteId),
            ))
        ) {
          throw new WorkspaceError(
            "conflict",
            "Annotations require a real source on their destination note",
          );
        }

        const [artifact] = await tx
          .insert(assistantArtifacts)
          .values({
            workspaceId,
            id: artifactId,
            actorId: principal.id,
            turnId: context?.turnId ?? null,
            kind: input.kind,
            noteId,
            name: input.name,
            mediaType: input.mediaType,
            content: input.content,
            sources,
          })
          .returning();

        await tx.insert(assistantArtifactPublications).values({
          workspaceId,
          artifactId,
          objectKey: `workspaces/${workspaceId}/assistant/artifacts/${artifactId}/1`,
          checksum: artifactChecksum(input.content),
        });

        return publicArtifact(artifact!);
      });
    },

    async listArtifacts(
      principal: Principal,
      workspaceId: string,
      noteId?: string,
    ): Promise<AssistantArtifactListItem[]> {
      if (noteId) {
        idSchema.parse(noteId);
      }

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);

        if (noteId) {
          await requireNote(tx, workspaceId, noteId);
        }

        const rows = await tx
          .select({
            id: assistantArtifacts.id,
            kind: assistantArtifacts.kind,
            noteId: assistantArtifacts.noteId,
            name: assistantArtifacts.name,
            mediaType: assistantArtifacts.mediaType,
            sources: assistantArtifacts.sources,
            revision: assistantArtifacts.revision,
            createdAt: assistantArtifacts.createdAt,
          })
          .from(assistantArtifacts)
          .leftJoin(
            notes,
            and(eq(notes.workspaceId, workspaceId), eq(notes.id, assistantArtifacts.noteId)),
          )
          .where(
            and(
              eq(assistantArtifacts.workspaceId, workspaceId),
              eq(assistantArtifacts.actorId, principal.id),
              noteId ? eq(assistantArtifacts.noteId, noteId) : undefined,
              or(isNull(assistantArtifacts.noteId), isNull(notes.deletedAt)),
            ),
          )
          .orderBy(desc(assistantArtifacts.createdAt), desc(assistantArtifacts.id))
          .limit(100);

        return rows.map((artifact) =>
          assistantArtifactListItemSchema.parse({
            ...artifact,
            createdAt: artifact.createdAt.toISOString(),
          }),
        );
      });
    },

    async getArtifact(principal: Principal, workspaceId: string, id: string) {
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);

        return publicArtifact(await requireArtifact(tx, principal, workspaceId, id));
      });
    },
  };
}
