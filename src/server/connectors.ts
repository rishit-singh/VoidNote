import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { ComposioHttpError, createConnectorClient } from "@/connectors/composio";
import { readConnectorPolicy, isConnectorAvailable } from "@/config/connectors";
import { WorkspaceError, type Principal } from "@/contracts/workspace";
import { withDatabase } from "@/db/client";
import { createConnectorRepository } from "@/db/connectors/repository";
import { createServiceBudgetRepository } from "@/db/service-budgets";
import type { ServiceBudgetReservation } from "@/db/service-budgets/repository";

function policy() {
  const { env } = getCloudflareContext();
  return readConnectorPolicy(env);
}

async function composioUserId(workspaceId: string, principalId: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`voidnote-composio-user-v1:${workspaceId}:${principalId}`),
  );
  return `vn_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 48)}`;
}

export async function getSlackConnectorStatus(principal: Principal, workspaceId: string) {
  const config = policy();
  const [storedStatus, storedReceipts, storedLinkReceipts] = await withDatabase((db) =>
    Promise.all([
      createConnectorRepository(db).status(principal, workspaceId),
      createConnectorRepository(db).listReceipts(principal, workspaceId),
      createConnectorRepository(db).listLinkReceipts(principal, workspaceId),
    ]),
  );
  if (!isConnectorAvailable(config)) {
    return {
      enabled: false,
      configured: false,
      provider: "slack" as const,
      connection: "unavailable" as const,
      budgetConfigured: false,
      receipts: storedReceipts.map((receipt) => ({
        ...receipt,
        status: receipt.status === "in_flight" ? ("unknown" as const) : receipt.status,
        usageStatus: "unreported" as const,
        createdAt: receipt.createdAt.toISOString(),
      })),
      linkReceipts: storedLinkReceipts.map((receipt) => ({
        operationId: receipt.operationId,
        status: receipt.status,
        usageStatus: "unreported" as const,
        createdAt: receipt.createdAt.toISOString(),
      })),
    };
  }

  const userId = await composioUserId(workspaceId, principal.id);
  try {
    const client = createConnectorClient(config);
    const accounts = await client.listSlackAccounts({ userId });
    const matching = accounts.find((candidate) => candidate.id === storedStatus.connectedAccountId);
    if (matching?.status === "ACTIVE") {
      await withDatabase((db) =>
        createConnectorRepository(db).saveConnection(
          principal,
          workspaceId,
          matching.id,
          "connected",
        ),
      );
    } else if (
      storedStatus.connectedAccountId &&
      (!matching || ["EXPIRED", "REVOKED", "DISABLED", "FAILED"].includes(matching.status))
    ) {
      await withDatabase((db) =>
        createConnectorRepository(db).revokeConnection(
          principal,
          workspaceId,
          storedStatus.connectedAccountId!,
        ),
      );
    }
  } catch {
    // Keep the persisted state; transient provider reads must not erase recovery.
  }

  const [status, receipts, linkReceipts] = await withDatabase((db) =>
    Promise.all([
      createConnectorRepository(db).status(principal, workspaceId),
      createConnectorRepository(db).listReceipts(principal, workspaceId),
      createConnectorRepository(db).listLinkReceipts(principal, workspaceId),
    ]),
  );
  return {
    enabled: config.enabled,
    configured: true,
    provider: "slack" as const,
    connection: status.connection,
    budgetConfigured: Boolean(config.serviceBudgetId && config.operationUnitBound),
    receipts: receipts.map((receipt) => ({
      ...receipt,
      status: receipt.status === "in_flight" ? ("unknown" as const) : receipt.status,
      usageStatus: "unreported" as const,
      createdAt: receipt.createdAt.toISOString(),
    })),
    linkReceipts: linkReceipts.map((receipt) => ({
      operationId: receipt.operationId,
      status: receipt.status,
      usageStatus: "unreported" as const,
      createdAt: receipt.createdAt.toISOString(),
    })),
  };
}

export async function createSlackConnection(
  principal: Principal,
  workspaceId: string,
  operationId: string,
  origin: string,
) {
  const config = policy();
  if (!isConnectorAvailable(config)) {
    throw new WorkspaceError("service_unavailable", "Slack connection is not configured.");
  }
  const client = createConnectorClient(config);
  const { env } = getCloudflareContext();
  const appUrl = new URL(env.APP_URL);
  if (appUrl.protocol !== "https:") {
    throw new WorkspaceError(
      "service_unavailable",
      "Slack connection requires a configured HTTPS APP_URL.",
    );
  }
  const callbackUrl = new URL("/settings?slack_connected=1", appUrl).toString();
  const link = await withDatabase((db) =>
    createConnectorRepository(db).beginLink({
      principal,
      workspaceId,
      operationId,
      origin,
      authConfigId: config.slackAuthConfigId!,
    }),
  );
  if (link.replay) {
    return {
      kind: "receipt" as const,
      operationId,
      status: link.receipt.status === "in_flight" ? "unknown" : link.receipt.status,
      usageStatus: "unreported" as const,
    };
  }
  let reservation: ServiceBudgetReservation;
  try {
    reservation = await withDatabase((db) =>
      createServiceBudgetRepository(db).reserve({
        workspaceId,
        provider: "composio",
        budgetId: config.serviceBudgetId!,
        operationId,
        maximumUnits: config.operationUnitBound!,
      }),
    );
  } catch {
    await withDatabase((db) =>
      createConnectorRepository(db).finishLink(workspaceId, operationId, { status: "failed" }),
    );
    throw new WorkspaceError(
      "service_unavailable",
      "The configured workspace service allowance is unavailable.",
    );
  }
  if (reservation.status !== "created") {
    await withDatabase((db) =>
      createConnectorRepository(db).finishLink(workspaceId, operationId, { status: "unknown" }),
    );
    return {
      kind: "receipt" as const,
      operationId,
      status: "unknown" as const,
      usageStatus: "unreported" as const,
    };
  }
  try {
    const result = await client.createSlackLink({
      userId: await composioUserId(workspaceId, principal.id),
      authConfigId: config.slackAuthConfigId!,
      callbackUrl,
    });
    await withDatabase((db) =>
      createConnectorRepository(db).saveConnection(
        principal,
        workspaceId,
        result.connectedAccountId,
        "pending",
      ),
    );
    await withDatabase((db) =>
      createConnectorRepository(db).finishLink(workspaceId, operationId, {
        status: "linked",
        connectedAccountId: result.connectedAccountId,
      }),
    );
    return {
      kind: "redirect" as const,
      redirectUrl: result.redirectUrl,
      expiresAt: result.expiresAt,
      usageStatus: "unreported" as const,
    };
  } catch (error) {
    const definite =
      error instanceof ComposioHttpError && error.status < 500 && error.status !== 408;
    await withDatabase((db) =>
      createConnectorRepository(db).finishLink(workspaceId, operationId, {
        status: definite ? "failed" : "unknown",
      }),
    );
    if (definite) {
      throw error;
    }
    return {
      kind: "receipt" as const,
      operationId,
      status: "unknown" as const,
      usageStatus: "unreported" as const,
    };
  }
}

export async function shareSavedBrief(input: {
  principal: Principal;
  workspaceId: string;
  briefId: string;
  channelId: string;
  operationId: string;
  origin: string;
}) {
  const config = policy();
  if (!isConnectorAvailable(config)) {
    throw new WorkspaceError(
      "service_unavailable",
      "Slack sharing requires connector and service-budget configuration.",
    );
  }
  const prepared = await withDatabase((db) =>
    createConnectorRepository(db).beginShare({
      ...input,
      origin: input.origin,
    }),
  );
  if (prepared.replay) {
    return {
      operationId: input.operationId,
      status: prepared.receipt.status === "in_flight" ? "unknown" : prepared.receipt.status,
      providerRequestId: prepared.receipt.providerRequestId,
      remoteMessageId: prepared.receipt.remoteMessageId,
      messageUrl: prepared.receipt.messageUrl,
      usageStatus: "unreported" as const,
    } as const;
  }

  let reservation: ServiceBudgetReservation;
  try {
    reservation = await withDatabase((db) =>
      createServiceBudgetRepository(db).reserve({
        workspaceId: input.workspaceId,
        provider: "composio",
        budgetId: config.serviceBudgetId!,
        operationId: input.operationId,
        maximumUnits: config.operationUnitBound!,
      }),
    );
  } catch {
    await withDatabase((db) =>
      createConnectorRepository(db).finishShare(input.workspaceId, input.operationId, {
        status: "failed",
        providerRequestId: null,
        remoteMessageId: null,
        messageUrl: null,
      }),
    );
    throw new WorkspaceError(
      "service_unavailable",
      "The configured workspace service allowance is unavailable.",
    );
  }
  if (reservation.status !== "created") {
    await withDatabase((db) =>
      createConnectorRepository(db).finishShare(input.workspaceId, input.operationId, {
        status: "unknown",
        providerRequestId: null,
        remoteMessageId: null,
        messageUrl: null,
      }),
    );
    return {
      operationId: input.operationId,
      status: "unknown" as const,
      providerRequestId: null,
      remoteMessageId: null,
      messageUrl: null,
      usageStatus: "unreported" as const,
    };
  }

  try {
    const client = createConnectorClient(config);
    const result = await client.executeSlackMessage({
      userId: await composioUserId(input.workspaceId, input.principal.id),
      connectedAccountId: prepared.receipt.connectedAccountId,
      channelId: input.channelId,
      text: prepared.content,
    });
    const message = result.data.message as Record<string, unknown> | undefined;
    const output = {
      status: result.successful ? ("sent" as const) : ("failed" as const),
      providerRequestId: result.requestId,
      remoteMessageId: typeof message?.ts === "string" ? message.ts : null,
      messageUrl: typeof result.data.url === "string" ? result.data.url : null,
      usageStatus: "unreported" as const,
    };
    await withDatabase((db) =>
      createConnectorRepository(db).finishShare(input.workspaceId, input.operationId, output),
    );
    return { operationId: input.operationId, ...output };
  } catch (error) {
    if (error instanceof ComposioHttpError && error.status < 500 && error.status !== 408) {
      await withDatabase((db) =>
        createConnectorRepository(db).finishShare(input.workspaceId, input.operationId, {
          status: "failed",
          providerRequestId: null,
          remoteMessageId: null,
          messageUrl: null,
        }),
      );
      return {
        operationId: input.operationId,
        status: "failed" as const,
        providerRequestId: null,
        remoteMessageId: null,
        messageUrl: null,
        usageStatus: "unreported" as const,
      };
    }

    await withDatabase((db) =>
      createConnectorRepository(db).finishShare(input.workspaceId, input.operationId, {
        status: "unknown",
        providerRequestId: null,
        remoteMessageId: null,
        messageUrl: null,
      }),
    );
    return {
      operationId: input.operationId,
      status: "unknown" as const,
      providerRequestId: null,
      remoteMessageId: null,
      messageUrl: null,
      usageStatus: "unreported" as const,
    };
  }
}
