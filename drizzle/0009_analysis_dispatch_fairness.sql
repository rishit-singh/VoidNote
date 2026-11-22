DROP INDEX "analysis_jobs_dispatch_idx";--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD COLUMN "dispatch_checked_at" timestamp (3) with time zone;--> statement-breakpoint
CREATE INDEX "analysis_jobs_dispatch_idx" ON "analysis_jobs" USING btree (coalesce("dispatch_checked_at", "created_at"),"workspace_id","id") WHERE "analysis_jobs"."status" in ('queued', 'running');