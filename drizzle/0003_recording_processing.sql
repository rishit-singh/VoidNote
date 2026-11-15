CREATE TABLE "processing_outbox" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp (3) with time zone,
	CONSTRAINT "processing_outbox_workspace_id_run_id_pk" PRIMARY KEY("workspace_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "processing_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "processing_runs" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_job_id" text,
	"config" jsonb NOT NULL,
	"raw_object_key" text,
	"error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_runs_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "processing_runs_one_logical_run" UNIQUE("workspace_id","recording_id"),
	CONSTRAINT "processing_runs_provider_job" UNIQUE("provider_job_id"),
	CONSTRAINT "processing_runs_status" CHECK ("processing_runs"."status" in ('queued','submitting','submission_unknown','submitted','running','succeeded','failed','blocked'))
);
--> statement-breakpoint
ALTER TABLE "processing_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recording_events" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_events_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "recording_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recordings" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"mime_type" text NOT NULL,
	"duration_seconds" double precision NOT NULL,
	"object_key" text NOT NULL,
	"status" text DEFAULT 'upload_pending' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	CONSTRAINT "recordings_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "recordings_note_identity" UNIQUE("workspace_id","note_id","id"),
	CONSTRAINT "recordings_bounds" CHECK ("recordings"."bytes" > 0 and "recordings"."bytes" <= 52428800 and "recordings"."duration_seconds" > 0 and "recordings"."duration_seconds" <= 7200),
	CONSTRAINT "recordings_status" CHECK ("recordings"."status" in ('upload_pending','ready'))
);
--> statement-breakpoint
ALTER TABLE "recordings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transcript_utterances" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"start_seconds" double precision NOT NULL,
	"end_seconds" double precision NOT NULL,
	"speaker_label" text NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "transcript_utterances_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "transcript_utterances_run_sequence" UNIQUE("workspace_id","run_id","sequence"),
	CONSTRAINT "transcript_utterances_bounds" CHECK ("transcript_utterances"."sequence" >= 0 and "transcript_utterances"."start_seconds" >= 0 and "transcript_utterances"."end_seconds" >= "transcript_utterances"."start_seconds" and "transcript_utterances"."end_seconds" <= 7200)
);
--> statement-breakpoint
ALTER TABLE "transcript_utterances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "processing_outbox" ADD CONSTRAINT "processing_outbox_workspace_id_run_id_processing_runs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."processing_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_workspace_id_note_id_recording_id_recordings_workspace_id_note_id_id_fk" FOREIGN KEY ("workspace_id","note_id","recording_id") REFERENCES "public"."recordings"("workspace_id","note_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_workspace_id_actor_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_events" ADD CONSTRAINT "recording_events_workspace_id_recording_id_recordings_workspace_id_id_fk" FOREIGN KEY ("workspace_id","recording_id") REFERENCES "public"."recordings"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_events" ADD CONSTRAINT "recording_events_workspace_id_run_id_processing_runs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."processing_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_workspace_id_note_id_notes_workspace_id_id_fk" FOREIGN KEY ("workspace_id","note_id") REFERENCES "public"."notes"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_workspace_id_actor_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_utterances" ADD CONSTRAINT "transcript_utterances_workspace_id_run_id_processing_runs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."processing_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "processing_outbox_pending_idx" ON "processing_outbox" USING btree ("created_at") WHERE "processing_outbox"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "processing_runs_note_idx" ON "processing_runs" USING btree ("workspace_id","note_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recordings_note_idx" ON "recordings" USING btree ("workspace_id","note_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "transcript_utterances_page_idx" ON "transcript_utterances" USING btree ("workspace_id","run_id","sequence");
--> statement-breakpoint
-- Backend-only tables: keep Supabase default API-role grants out of the boundary.
REVOKE ALL ON TABLE public.recordings, public.processing_runs, public.transcript_utterances, public.recording_events, public.processing_outbox FROM PUBLIC;
--> statement-breakpoint
DO $access$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.recordings, public.processing_runs, public.transcript_utterances, public.recording_events, public.processing_outbox FROM %I', api_role);
    END IF;
  END LOOP;
END;
$access$;
