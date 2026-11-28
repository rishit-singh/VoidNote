import { sql } from "drizzle-orm";
import { foreignKey, index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";

import { analysisJobs } from "./schema";

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

// Keep completed rows: an exact cancellation replay must not enqueue cleanup
// again after successful runtime acknowledgement.
export const summaryCancellationCleanup = pgTable(
  "summary_cancellation_cleanup",
  {
    workspaceId: uuid("workspace_id").notNull(),
    jobId: uuid("job_id").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    checkedAt: time("checked_at"),
    completedAt: time("completed_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.jobId] }),
    foreignKey({
      name: "summary_cancellation_cleanup_job_fk",
      columns: [t.workspaceId, t.jobId],
      foreignColumns: [analysisJobs.workspaceId, analysisJobs.id],
    }),
    index("summary_cancellation_cleanup_pending")
      .on(sql`${t.checkedAt} asc nulls first`, t.createdAt, t.workspaceId, t.jobId)
      .where(sql`${t.completedAt} is null`),
  ],
).enableRLS();
