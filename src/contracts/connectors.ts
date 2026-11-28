import { z } from "zod";

export const connectorReceiptSchema = z.object({
  operationId: z.uuid(),
  briefId: z.uuid(),
  channelId: z.string().max(120),
  status: z.enum(["sent", "failed", "unknown"]),
  providerRequestId: z.string().max(200).nullable(),
  remoteMessageId: z.string().max(200).nullable(),
  messageUrl: z.url().nullable(),
  usageStatus: z.literal("unreported"),
  createdAt: z.iso.datetime(),
});
export const connectorLinkReceiptSchema = z.object({
  operationId: z.uuid(),
  status: z.enum(["in_flight", "linked", "failed", "unknown"]),
  usageStatus: z.literal("unreported"),
  createdAt: z.iso.datetime(),
});

export const connectorStatusSchema = z
  .object({
    enabled: z.boolean(),
    configured: z.boolean(),
    provider: z.literal("slack"),
    connection: z.enum(["not_connected", "pending", "connected", "revoked", "unavailable"]),
    budgetConfigured: z.boolean(),
    receipts: z.array(connectorReceiptSchema).max(10),
    linkReceipts: z.array(connectorLinkReceiptSchema).max(5),
  })
  .strict();
export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;

export const slackConnectLinkSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("redirect"),
    redirectUrl: z.url(),
    expiresAt: z.iso.datetime(),
    usageStatus: z.literal("unreported"),
  }),
  z.object({
    kind: z.literal("receipt"),
    operationId: z.uuid(),
    status: z.enum(["linked", "failed", "unknown"]),
    usageStatus: z.literal("unreported"),
  }),
]);

export const shareBriefInputSchema = z
  .object({
    workspaceId: z.uuid(),
    briefId: z.uuid(),
    channelId: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Z0-9#_-]+$/i),
    operationId: z.uuid(),
  })
  .strict();

export const shareBriefResultSchema = z
  .object({
    operationId: z.uuid(),
    status: z.enum(["sent", "failed", "unknown"]),
    providerRequestId: z.string().max(200).nullable(),
    remoteMessageId: z.string().max(200).nullable(),
    messageUrl: z.url().nullable(),
    usageStatus: z.literal("unreported"),
  })
  .strict();
