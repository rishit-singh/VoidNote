CREATE TABLE "conversation_summary_jobs" (
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"from_sequence" integer NOT NULL,
	"through_sequence" integer NOT NULL,
	"message_count" integer NOT NULL,
	"messages" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"input_bytes" integer NOT NULL,
	"text" text,
	"error" text,
	"dispatch_checked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "conversation_summary_jobs_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "conversation_summary_jobs_cutoff" UNIQUE("workspace_id","thread_id","through_sequence"),
	CONSTRAINT "conversation_summary_jobs_status" CHECK ("conversation_summary_jobs"."status" in ('queued','running','succeeded','failed','stale')),
	CONSTRAINT "conversation_summary_jobs_coverage" CHECK ("conversation_summary_jobs"."from_sequence" > 0 and "conversation_summary_jobs"."through_sequence" >= "conversation_summary_jobs"."from_sequence"
        and "conversation_summary_jobs"."message_count" between 1 and 50
        and "conversation_summary_jobs"."message_count" <= "conversation_summary_jobs"."through_sequence" - "conversation_summary_jobs"."from_sequence" + 1
        and jsonb_array_length("conversation_summary_jobs"."messages") = "conversation_summary_jobs"."message_count"
        and jsonb_array_length("conversation_summary_jobs"."sources") = "conversation_summary_jobs"."message_count"),
	CONSTRAINT "conversation_summary_jobs_input_bound" CHECK ("conversation_summary_jobs"."input_bytes" between 1 and 128000),
	CONSTRAINT "conversation_summary_jobs_text_bound" CHECK ("conversation_summary_jobs"."text" is null or length("conversation_summary_jobs"."text") <= 8000),
	CONSTRAINT "conversation_summary_jobs_error_bound" CHECK ("conversation_summary_jobs"."error" is null or length("conversation_summary_jobs"."error") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "conversation_summary_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversation_summary_scans" (
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"checked_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_summary_scans_workspace_id_thread_id_pk" PRIMARY KEY("workspace_id","thread_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_summary_scans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_summary_jobs" ADD CONSTRAINT "conversation_summary_jobs_thread_owner_fk" FOREIGN KEY ("workspace_id","thread_id","actor_id") REFERENCES "public"."assistant_threads"("workspace_id","id","actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summary_scans" ADD CONSTRAINT "conversation_summary_scans_workspace_id_thread_id_assistant_threads_workspace_id_id_fk" FOREIGN KEY ("workspace_id","thread_id") REFERENCES "public"."assistant_threads"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_summary_jobs_latest" ON "conversation_summary_jobs" USING btree ("workspace_id","thread_id","through_sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversation_summary_jobs_dispatch" ON "conversation_summary_jobs" USING btree (coalesce("dispatch_checked_at", "created_at"),"workspace_id","id") WHERE "conversation_summary_jobs"."status" in ('queued','running');--> statement-breakpoint
CREATE INDEX "conversation_summary_scans_checked" ON "conversation_summary_scans" USING btree ("checked_at","workspace_id","thread_id");
--> statement-breakpoint
-- Derived snapshots are backend-owned, like the assistant records they summarize.
DO $$
DECLARE
  target text;
  client_role text;
BEGIN
  FOREACH target IN ARRAY ARRAY['conversation_summary_jobs','conversation_summary_scans'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target);
    FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', target, client_role);
      END IF;
    END LOOP;
  END LOOP;
END $$;
