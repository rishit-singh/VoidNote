CREATE TABLE "analysis_jobs" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"source" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"context" jsonb,
	"error" text,
	"dispatched_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_jobs_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "analysis_jobs_command" UNIQUE("workspace_id","command_id"),
	CONSTRAINT "analysis_jobs_status" CHECK ("analysis_jobs"."status" in ('queued','running','succeeded','failed','cancelled','superseded','blocked'))
);
--> statement-breakpoint
ALTER TABLE "analysis_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "note_summaries" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"source" jsonb NOT NULL,
	"analysis" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_summaries_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "note_summaries_job" UNIQUE("workspace_id","job_id"),
	CONSTRAINT "note_summaries_version" UNIQUE("workspace_id","note_id","version"),
	CONSTRAINT "note_summaries_version_positive" CHECK ("note_summaries"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "note_summaries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD COLUMN "transcript_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_workspace_id_note_id_notes_workspace_id_id_fk" FOREIGN KEY ("workspace_id","note_id") REFERENCES "public"."notes"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_workspace_id_run_id_processing_runs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."processing_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_workspace_id_actor_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_summaries" ADD CONSTRAINT "note_summaries_workspace_id_note_id_notes_workspace_id_id_fk" FOREIGN KEY ("workspace_id","note_id") REFERENCES "public"."notes"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_summaries" ADD CONSTRAINT "note_summaries_workspace_id_job_id_analysis_jobs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."analysis_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_jobs_dispatch_idx" ON "analysis_jobs" USING btree ("created_at","workspace_id","id") WHERE "analysis_jobs"."dispatched_at" is null and "analysis_jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "analysis_jobs_note_idx" ON "analysis_jobs" USING btree ("workspace_id","note_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_transcript_generation" CHECK ("processing_runs"."transcript_generation" >= 0);
--> statement-breakpoint
-- Existing completed transcripts start at a baseline generation. Historical
-- segment/correction revisions remain unchanged and preserve their exact lineage.
UPDATE "processing_runs" SET "transcript_generation" = 1 WHERE "status" = 'succeeded';
--> statement-breakpoint
-- Supabase may grant newly created tables to API roles through default privileges.
-- These records are accessed only through authorized server repositories.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON analysis_jobs, note_summaries FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON analysis_jobs, note_summaries FROM authenticated;
  END IF;
END $$;
