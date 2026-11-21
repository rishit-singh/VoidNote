import { z } from "zod";

export const RECENT_RECORDINGS_LIMIT = 3;

/** Saved workspace totals, independent of list pagination and local drafts. */
export const workspaceOverviewSchema = z.object({
  notes: z.number().int().nonnegative(),
  profiles: z.number().int().nonnegative(),
  recordings: z.number().int().nonnegative(),
  recordedSeconds: z.number().nonnegative(),
  recentRecordings: z
    .array(
      z.object({
        id: z.uuid(),
        noteId: z.uuid(),
        title: z.string(),
        durationSeconds: z.number().positive(),
        createdAt: z.iso.datetime({ offset: true }),
      }),
    )
    .max(RECENT_RECORDINGS_LIMIT),
});

export type WorkspaceOverview = z.infer<typeof workspaceOverviewSchema>;
