import { and, desc, eq, sql } from "drizzle-orm";

import { assistantArtifacts } from "../assistant-schema";
import {
  connectorConnections,
  connectorLinkReceipts,
  connectorOperationReceipts,
} from "../connectors-schema";
import type { Database } from "../repository";
import { authorize, validateSources } from "../assistant/shared";
import { WorkspaceError, idSchema, type Principal } from "../../contracts/workspace";

const originBound = (origin: string) => {
  if (origin.length < 1 || origin.length > 200) {
    throw new WorkspaceError("forbidden", "Connector request origin is unavailable.");
  }
  return origin;
};

export function createConnectorRepository(db: Database) {
  return {
    async status(principal: Principal, workspaceId: string) {
      idSchema.parse(workspaceId);
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        const [connection] = await tx
          .select()
          .from(connectorConnections)
          .where(
            and(
              eq(connectorConnections.workspaceId, workspaceId),
              eq(connectorConnections.actorId, principal.id),
              eq(connectorConnections.provider, "slack"),
            ),
          )
          .limit(1);
        return {
          connection: connection?.status ?? "not_connected",
          connectedAccountId: connection?.connectedAccountId ?? null,
        } as const;
      });
    },

    async revokeConnection(principal: Principal, workspaceId: string, connectedAccountId: string) {
      await db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        await tx
          .update(connectorConnections)
          .set({ connectedAccountId: null, status: "revoked", updatedAt: new Date() })
          .where(
            and(
              eq(connectorConnections.workspaceId, workspaceId),
              eq(connectorConnections.actorId, principal.id),
              eq(connectorConnections.provider, "slack"),
              eq(connectorConnections.connectedAccountId, connectedAccountId),
            ),
          );
      });
    },

    async beginLink(input: {
      principal: Principal;
      workspaceId: string;
      operationId: string;
      origin: string;
      authConfigId: string;
    }) {
      const { principal, workspaceId, operationId, authConfigId } = input;
      idSchema.parse(workspaceId);
      idSchema.parse(operationId);
      const origin = originBound(input.origin);
      const fingerprint = await digestFingerprint([
        principal.id,
        workspaceId,
        operationId,
        origin,
        authConfigId,
      ]);
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`connector-link:${workspaceId}:${operationId}`}, 0))`,
        );
        const [existing] = await tx
          .select()
          .from(connectorLinkReceipts)
          .where(
            and(
              eq(connectorLinkReceipts.workspaceId, workspaceId),
              eq(connectorLinkReceipts.operationId, operationId),
            ),
          )
          .for("update")
          .limit(1);
        if (existing) {
          if (
            existing.actorId !== principal.id ||
            existing.origin !== origin ||
            existing.fingerprint !== fingerprint
          ) {
            throw new WorkspaceError(
              "command_reused",
              "This connection request ID was already used.",
            );
          }
          return { receipt: existing, replay: true };
        }
        const [receipt] = await tx
          .insert(connectorLinkReceipts)
          .values({
            workspaceId,
            operationId,
            actorId: principal.id,
            origin,
            fingerprint,
            status: "in_flight",
          })
          .returning();
        if (!receipt)
          throw new WorkspaceError("conflict", "Connection receipt could not be saved.");
        return { receipt, replay: false };
      });
    },

    async finishLink(
      workspaceId: string,
      operationId: string,
      result: { status: "linked" | "failed" | "unknown"; connectedAccountId?: string },
    ) {
      await db
        .update(connectorLinkReceipts)
        .set({
          status: result.status,
          connectedAccountId: result.status === "linked" ? result.connectedAccountId! : null,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(connectorLinkReceipts.workspaceId, workspaceId),
            eq(connectorLinkReceipts.operationId, operationId),
            eq(connectorLinkReceipts.status, "in_flight"),
          ),
        );
    },

    async listLinkReceipts(principal: Principal, workspaceId: string) {
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        return tx
          .select({
            operationId: connectorLinkReceipts.operationId,
            status: connectorLinkReceipts.status,
            createdAt: connectorLinkReceipts.createdAt,
            connectedAccountId: connectorLinkReceipts.connectedAccountId,
          })
          .from(connectorLinkReceipts)
          .where(
            and(
              eq(connectorLinkReceipts.workspaceId, workspaceId),
              eq(connectorLinkReceipts.actorId, principal.id),
            ),
          )
          .orderBy(desc(connectorLinkReceipts.createdAt))
          .limit(5);
      });
    },

    async saveConnection(
      principal: Principal,
      workspaceId: string,
      connectedAccountId: string,
      status: "pending" | "connected",
    ) {
      idSchema.parse(workspaceId);
      await db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        await tx
          .insert(connectorConnections)
          .values({
            workspaceId,
            actorId: principal.id,
            provider: "slack",
            connectedAccountId,
            status,
          })
          .onConflictDoUpdate({
            target: [
              connectorConnections.workspaceId,
              connectorConnections.actorId,
              connectorConnections.provider,
            ],
            set: { connectedAccountId, status, updatedAt: new Date() },
          });
      });
    },

    async beginShare(input: {
      principal: Principal;
      workspaceId: string;
      operationId: string;
      briefId: string;
      channelId: string;
      origin: string;
    }) {
      const { principal, workspaceId, operationId, briefId, channelId } = input;
      idSchema.parse(workspaceId);
      idSchema.parse(operationId);
      idSchema.parse(briefId);
      const origin = originBound(input.origin);

      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`connector:${workspaceId}:${operationId}`}, 0))`,
        );
        const [artifact] = await tx
          .select({
            id: assistantArtifacts.id,
            actorId: assistantArtifacts.actorId,
            kind: assistantArtifacts.kind,
            content: assistantArtifacts.content,
            sources: assistantArtifacts.sources,
          })
          .from(assistantArtifacts)
          .where(
            and(
              eq(assistantArtifacts.workspaceId, workspaceId),
              eq(assistantArtifacts.id, briefId),
              eq(assistantArtifacts.actorId, principal.id),
            ),
          )
          .limit(1);
        if (!artifact || artifact.kind !== "file" || artifact.content.length > 20_000) {
          throw new WorkspaceError("not_found", "Saved brief is unavailable.");
        }
        const [existing] = await tx
          .select()
          .from(connectorOperationReceipts)
          .where(
            and(
              eq(connectorOperationReceipts.workspaceId, workspaceId),
              eq(connectorOperationReceipts.operationId, operationId),
            ),
          )
          .for("update")
          .limit(1);
        if (existing) {
          const existingFingerprint = await fingerprintFor({
            principalId: principal.id,
            origin,
            briefId,
            channelId,
            content: artifact.content,
            connectedAccountId: existing.connectedAccountId,
          });
          if (
            existing.actorId !== principal.id ||
            existing.origin !== origin ||
            existing.fingerprint !== existingFingerprint
          ) {
            throw new WorkspaceError("command_reused", "This share request ID was already used.");
          }
          return {
            receipt: existing,
            connectedAccountId: existing.connectedAccountId,
            content: artifact.content,
            replay: true,
          };
        }

        await validateSources(tx, principal, workspaceId, artifact.sources);
        const [connection] = await tx
          .select()
          .from(connectorConnections)
          .where(
            and(
              eq(connectorConnections.workspaceId, workspaceId),
              eq(connectorConnections.actorId, principal.id),
              eq(connectorConnections.provider, "slack"),
              eq(connectorConnections.status, "connected"),
            ),
          )
          .for("update")
          .limit(1);
        if (!connection?.connectedAccountId) {
          throw new WorkspaceError("service_unavailable", "Connect Slack before sharing.");
        }
        const fingerprintHex = await fingerprintFor({
          principalId: principal.id,
          origin,
          briefId,
          channelId,
          content: artifact.content,
          connectedAccountId: connection.connectedAccountId,
        });

        const [receipt] = await tx
          .insert(connectorOperationReceipts)
          .values({
            workspaceId,
            operationId,
            provider: "slack",
            actorId: principal.id,
            origin,
            fingerprint: fingerprintHex,
            connectedAccountId: connection.connectedAccountId,
            briefId,
            channelId,
            status: "in_flight",
          })
          .returning();
        if (!receipt) throw new WorkspaceError("conflict", "Could not record share operation.");
        return {
          receipt,
          connectedAccountId: connection.connectedAccountId,
          content: artifact.content,
          replay: false,
        };
      });
    },

    async finishShare(
      workspaceId: string,
      operationId: string,
      result: {
        status: "sent" | "failed" | "unknown";
        providerRequestId: string | null;
        remoteMessageId: string | null;
        messageUrl: string | null;
      },
    ) {
      await db
        .update(connectorOperationReceipts)
        .set({ ...result, completedAt: new Date() })
        .where(
          and(
            eq(connectorOperationReceipts.workspaceId, workspaceId),
            eq(connectorOperationReceipts.operationId, operationId),
            eq(connectorOperationReceipts.status, "in_flight"),
          ),
        );
    },

    async listReceipts(principal: Principal, workspaceId: string) {
      return db.transaction(async (tx) => {
        await authorize(tx, principal, workspaceId);
        return tx
          .select({
            operationId: connectorOperationReceipts.operationId,
            briefId: connectorOperationReceipts.briefId,
            channelId: connectorOperationReceipts.channelId,
            status: connectorOperationReceipts.status,
            providerRequestId: connectorOperationReceipts.providerRequestId,
            remoteMessageId: connectorOperationReceipts.remoteMessageId,
            messageUrl: connectorOperationReceipts.messageUrl,
            createdAt: connectorOperationReceipts.createdAt,
          })
          .from(connectorOperationReceipts)
          .where(
            and(
              eq(connectorOperationReceipts.workspaceId, workspaceId),
              eq(connectorOperationReceipts.actorId, principal.id),
            ),
          )
          .orderBy(desc(connectorOperationReceipts.createdAt))
          .limit(10);
      });
    },
  };
}

async function fingerprintFor(input: {
  principalId: string;
  origin: string;
  briefId: string;
  channelId: string;
  content: string;
  connectedAccountId: string;
}) {
  return digestFingerprint([
    input.principalId,
    input.origin,
    input.briefId,
    input.channelId,
    input.content,
    input.connectedAccountId,
  ]);
}

async function digestFingerprint(value: unknown[]) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
