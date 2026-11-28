import { z } from "zod";

import { idSchema } from "./workspace";

export const applicationEventTypeSchema = z.enum([
  "note.changed",
  "profile.changed",
  "transcript.ready",
  "transcript.corrected",
  "summary.published",
  "summary.failed",
  "research.completed",
  "research.failed",
]);

export const applicationEventInputSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  type: applicationEventTypeSchema,
  actorId: idSchema,
  executor: z.enum(["user", "agent", "workflow"]),
  operationId: z.string().min(1).max(240),
  noteId: idSchema.optional(),
  personId: idSchema.optional(),
  runId: idSchema.optional(),
  generation: z.number().int().nonnegative().optional(),
  resultId: idSchema.optional(),
});

export type ApplicationEventInput = z.infer<typeof applicationEventInputSchema>;
export type ApplicationEventType = z.infer<typeof applicationEventTypeSchema>;

export const activityItemSchema = z.object({
  id: idSchema,
  sequence: z.string().regex(/^[0-9]+$/),
  type: applicationEventTypeSchema,
  title: z.string(),
  href: z.string().startsWith("/"),
  executor: z.enum(["user", "agent", "workflow"]),
  createdAt: z.iso.datetime({ offset: true }),
  readAt: z.iso.datetime({ offset: true }).nullable(),
  noteId: idSchema.nullable(),
  personId: idSchema.nullable(),
  runId: idSchema.nullable().optional(),
});

export const activityScopeSchema = z.object({ workspaceId: idSchema }).strict();
export const activityPageInputSchema = activityScopeSchema.extend({
  before: z
    .string()
    .regex(/^[0-9]{1,20}$/)
    .optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export const activityPageSchema = z.object({
  items: z.array(activityItemSchema),
  nextCursor: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
});
export const activityChangesInputSchema = activityScopeSchema.extend({
  after: z
    .string()
    .regex(/^[0-9]{1,20}$/)
    .default("0"),
});
export const activityChangesSchema = z.object({
  items: z.array(activityItemSchema),
  cursor: z.string(),
  hasMore: z.boolean(),
});
export type ActivityItem = z.infer<typeof activityItemSchema>;

export const ACTIVITY_PROTOCOL = "voidnote.activity.v1";
export const ACTIVITY_LEASE_MS = 30_000;
export const ACTIVITY_TICKET_MS = 20_000;
export const activitySubscriptionSchema = z.object({
  workspaceId: idSchema,
  userId: idSchema,
  ticket: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive(),
});
export function activityHubName(workspaceId: string, userId: string) {
  return `activity:${workspaceId}:${userId}`;
}
