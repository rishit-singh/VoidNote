import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { idSchema, type Principal, WorkspaceError } from "../../contracts/workspace";
import { assistantArtifactPublications, assistantArtifacts } from "../assistant-schema";
import type { Database } from "../repository";
import {
  artifactChecksum,
  authorize,
  requireArtifact,
  requireTurn,
  type Transaction,
  validateSources,
} from "./shared";

export type AssistantArtifactPublication = {
  workspaceId: string;
  artifactId: string;
  objectKey: string;
  checksum: string;
  content: string;
  mediaType: "text/plain" | "text/markdown";
};

export type AssistantArtifactDeletion = Pick<
  AssistantArtifactPublication,
  "workspaceId" | "artifactId" | "objectKey"
>;

const scope = (workspaceId: string, artifactId: string) =>
  and(
    eq(assistantArtifactPublications.workspaceId, workspaceId),
    eq(assistantArtifactPublications.artifactId, artifactId),
  );

async function cancelPublication(tx: Transaction, workspaceId: string, artifactId: string) {
  await tx
    .update(assistantArtifactPublications)
    .set({ cancelledAt: new Date() })
    .where(
      and(
        scope(workspaceId, artifactId),
        isNull(assistantArtifactPublications.publishedAt),
        isNull(assistantArtifactPublications.cancelledAt),
      ),
    );
}

async function publication(tx: Transaction, workspaceId: string, artifactId: string) {
  const [candidate] = await tx
    .select({ actorId: assistantArtifacts.actorId, turnId: assistantArtifacts.turnId })
    .from(assistantArtifacts)
    .where(
      and(eq(assistantArtifacts.workspaceId, workspaceId), eq(assistantArtifacts.id, artifactId)),
    )
    .limit(1);

  if (!candidate) {
    return null;
  }

  const principal: Principal = { id: candidate.actorId, email: null };

  try {
    // Match cancellation lock order: membership -> lifecycle notes -> thread ->
    // publication. Never hold a dispatch scan's publication lock across these.
    await authorize(tx, principal, workspaceId);
    let turnCancelled = false;

    if (candidate.turnId) {
      const { turn } = await requireTurn(tx, principal, workspaceId, candidate.turnId, true);

      turnCancelled = turn.status === "cancelled";
    }

    const artifact = await requireArtifact(tx, principal, workspaceId, artifactId);

    await validateSources(tx, principal, workspaceId, artifact.sources);

    const [row] = await tx
      .select()
      .from(assistantArtifactPublications)
      .where(scope(workspaceId, artifactId))
      .for("update")
      .limit(1);

    if (!row || row.cancelledAt) {
      return null;
    }

    if (turnCancelled && !row.publishedAt) {
      await cancelPublication(tx, workspaceId, artifactId);

      return null;
    }

    if (row.checksum !== artifactChecksum(artifact.content)) {
      throw new WorkspaceError("conflict", "Artifact content does not match its publication");
    }

    return { row, artifact };
  } catch (error) {
    if (
      error instanceof WorkspaceError &&
      ["not_found", "forbidden", "conflict"].includes(error.code)
    ) {
      await cancelPublication(tx, workspaceId, artifactId);

      return null;
    }

    throw error;
  }
}

export function createPublicationOperations(db: Database) {
  return {
    async pendingArtifactDeletions(limit = 20): Promise<AssistantArtifactDeletion[]> {
      z.number().int().min(1).max(100).parse(limit);

      return db.transaction(async (tx) => {
        const rows = await tx
          .select({
            workspaceId: assistantArtifactPublications.workspaceId,
            artifactId: assistantArtifactPublications.artifactId,
            objectKey: assistantArtifactPublications.objectKey,
          })
          .from(assistantArtifactPublications)
          .where(
            and(
              isNotNull(assistantArtifactPublications.cancelledAt),
              isNull(assistantArtifactPublications.publishedAt),
            ),
          )
          .orderBy(
            asc(assistantArtifactPublications.availableAt),
            asc(assistantArtifactPublications.workspaceId),
            asc(assistantArtifactPublications.artifactId),
          )
          .limit(limit)
          .for("update", { skipLocked: true });

        for (const row of rows) {
          await tx
            .update(assistantArtifactPublications)
            .set({
              availableAt: new Date(),
              attempts: sql`${assistantArtifactPublications.attempts} + 1`,
            })
            .where(scope(row.workspaceId, row.artifactId));
        }

        // Cancellation is a permanent deletion intent. There is deliberately no
        // cleanup acknowledgement encoded in publishedAt: after uncertain R2 I/O
        // or a late in-flight upload, future sweeps retry the same immutable key.
        // Already published resources are outside this orphan-cleanup boundary.
        return rows;
      });
    },

    async pendingArtifactPublications(limit = 20): Promise<AssistantArtifactPublication[]> {
      z.number().int().min(1).max(100).parse(limit);
      const candidates = await db.transaction(async (tx) => {
        const rows = await tx
          .select({
            workspaceId: assistantArtifactPublications.workspaceId,
            artifactId: assistantArtifactPublications.artifactId,
          })
          .from(assistantArtifactPublications)
          .where(
            and(
              isNull(assistantArtifactPublications.publishedAt),
              isNull(assistantArtifactPublications.cancelledAt),
            ),
          )
          .orderBy(
            asc(assistantArtifactPublications.availableAt),
            asc(assistantArtifactPublications.workspaceId),
            asc(assistantArtifactPublications.artifactId),
          )
          .limit(limit)
          .for("update", { skipLocked: true });

        for (const row of rows) {
          await tx
            .update(assistantArtifactPublications)
            .set({
              availableAt: new Date(),
              attempts: sql`${assistantArtifactPublications.attempts} + 1`,
            })
            .where(scope(row.workspaceId, row.artifactId));
        }

        return rows;
      });

      const pending: AssistantArtifactPublication[] = [];

      for (const candidate of candidates) {
        const item = await db.transaction(async (tx) => {
          const current = await publication(tx, candidate.workspaceId, candidate.artifactId);

          if (!current || current.row.publishedAt) {
            return null;
          }

          return {
            workspaceId: candidate.workspaceId,
            artifactId: candidate.artifactId,
            objectKey: current.row.objectKey,
            checksum: current.row.checksum,
            content: current.artifact.content,
            mediaType: current.artifact.mediaType,
          };
        });

        if (item) {
          pending.push(item);
        }
      }

      return pending;
    },

    async acknowledgeArtifactPublication(
      workspaceId: string,
      artifactId: string,
      checksum: string,
    ): Promise<boolean> {
      idSchema.parse(workspaceId);
      idSchema.parse(artifactId);
      z.string()
        .regex(/^[0-9a-f]{64}$/)
        .parse(checksum);

      return db.transaction(async (tx) => {
        const current = await publication(tx, workspaceId, artifactId);

        if (!current) {
          return false;
        }

        if (current.row.checksum !== checksum) {
          throw new WorkspaceError("conflict", "Published artifact checksum does not match");
        }

        if (current.row.publishedAt) {
          return true;
        }

        await tx
          .update(assistantArtifactPublications)
          .set({ publishedAt: new Date() })
          .where(scope(workspaceId, artifactId));

        return true;
      });
    },
  };
}
