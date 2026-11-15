CREATE TABLE "transcript_correction_outbox" (
	"workspace_id" uuid NOT NULL,
	"correction_id" uuid NOT NULL,
	"kind" text DEFAULT 'transcript.dependencies_invalidated' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "transcript_correction_outbox_workspace_id_correction_id_pk" PRIMARY KEY("workspace_id","correction_id"),
	CONSTRAINT "transcript_correction_outbox_attempts" CHECK ("transcript_correction_outbox"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "transcript_correction_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transcript_corrections" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"affected_count" integer NOT NULL,
	"snapshot_bytes" integer NOT NULL,
	"undo_of" uuid,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_corrections_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "transcript_corrections_command" UNIQUE("workspace_id","command_id"),
	CONSTRAINT "transcript_corrections_run_identity" UNIQUE("workspace_id","run_id","id"),
	CONSTRAINT "transcript_corrections_kind" CHECK ("transcript_corrections"."kind" in ('assign','edit','split','undo')),
	CONSTRAINT "transcript_corrections_count" CHECK ("transcript_corrections"."affected_count" > 0 and "transcript_corrections"."affected_count" <= 500),
	CONSTRAINT "transcript_corrections_snapshot_bytes" CHECK ("transcript_corrections"."snapshot_bytes" > 0 and "transcript_corrections"."snapshot_bytes" <= 2097152)
);
--> statement-breakpoint
ALTER TABLE "transcript_corrections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transcript_sample_candidates" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"correction_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"start_seconds" double precision NOT NULL,
	"end_seconds" double precision NOT NULL,
	"state" text DEFAULT 'candidate' NOT NULL,
	"invalidated_at" timestamp (3) with time zone,
	CONSTRAINT "transcript_sample_candidates_workspace_id_correction_id_segment_id_pk" PRIMARY KEY("workspace_id","correction_id","segment_id"),
	CONSTRAINT "transcript_samples_state" CHECK ("transcript_sample_candidates"."state" in ('candidate','confirmed','invalidated')),
	CONSTRAINT "transcript_samples_bounds" CHECK ("transcript_sample_candidates"."start_seconds" >= 0 and "transcript_sample_candidates"."end_seconds" >= "transcript_sample_candidates"."start_seconds" and "transcript_sample_candidates"."end_seconds" <= 7200)
);
--> statement-breakpoint
ALTER TABLE "transcript_sample_candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"source_utterance_id" uuid NOT NULL,
	"parent_id" uuid,
	"sequence" integer NOT NULL,
	"order_key" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"attribution_revision" integer DEFAULT 0 NOT NULL,
	"start_seconds" double precision NOT NULL,
	"end_seconds" double precision NOT NULL,
	"text" text NOT NULL,
	"assignment_kind" text DEFAULT 'unassigned' NOT NULL,
	"person_id" uuid,
	"assignment_source" text DEFAULT 'unassigned' NOT NULL,
	"review_state" text DEFAULT 'unreviewed' NOT NULL,
	"provider_score" double precision,
	"sample_suitability" text DEFAULT 'not_evaluated' NOT NULL,
	CONSTRAINT "transcript_segments_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "transcript_segments_run_identity" UNIQUE("workspace_id","run_id","id"),
	CONSTRAINT "transcript_segments_bounds" CHECK ("transcript_segments"."start_seconds" >= 0 and "transcript_segments"."end_seconds" >= "transcript_segments"."start_seconds" and "transcript_segments"."end_seconds" <= 7200),
	CONSTRAINT "transcript_segments_revisions" CHECK ("transcript_segments"."revision" >= "transcript_segments"."attribution_revision" and "transcript_segments"."attribution_revision" >= 0),
	CONSTRAINT "transcript_segments_assignment" CHECK (("transcript_segments"."assignment_kind" = 'unassigned' and "transcript_segments"."assignment_source" = 'unassigned' and "transcript_segments"."person_id" is null) or ("transcript_segments"."assignment_kind" = 'unknown' and "transcript_segments"."assignment_source" = 'manual' and "transcript_segments"."person_id" is null) or ("transcript_segments"."assignment_kind" = 'person' and "transcript_segments"."assignment_source" = 'manual' and "transcript_segments"."person_id" is not null)),
	CONSTRAINT "transcript_segments_review" CHECK ("transcript_segments"."review_state" in ('unreviewed','confirmed','needs_review')),
	CONSTRAINT "transcript_segments_sample" CHECK ("transcript_segments"."sample_suitability" in ('not_evaluated','candidate','invalidated')),
	CONSTRAINT "transcript_segments_order" CHECK ("transcript_segments"."sequence" >= 0 and "transcript_segments"."order_key" ~ '^[01]*$' and length("transcript_segments"."order_key") <= 256)
);
--> statement-breakpoint
ALTER TABLE "transcript_segments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD COLUMN "corrections_materialized_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "transcript_utterances" ADD CONSTRAINT "transcript_utterances_run_identity" UNIQUE("workspace_id","run_id","id");--> statement-breakpoint
ALTER TABLE "transcript_correction_outbox" ADD CONSTRAINT "transcript_correction_outbox_workspace_id_correction_id_transcript_corrections_workspace_id_id_fk" FOREIGN KEY ("workspace_id","correction_id") REFERENCES "public"."transcript_corrections"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_corrections" ADD CONSTRAINT "transcript_corrections_workspace_id_run_id_processing_runs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."processing_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_corrections" ADD CONSTRAINT "transcript_corrections_workspace_id_actor_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_corrections" ADD CONSTRAINT "transcript_corrections_undo_fk" FOREIGN KEY ("workspace_id","run_id","undo_of") REFERENCES "public"."transcript_corrections"("workspace_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_sample_candidates" ADD CONSTRAINT "transcript_samples_correction_fk" FOREIGN KEY ("workspace_id","run_id","correction_id") REFERENCES "public"."transcript_corrections"("workspace_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_sample_candidates" ADD CONSTRAINT "transcript_samples_segment_fk" FOREIGN KEY ("workspace_id","run_id","segment_id") REFERENCES "public"."transcript_segments"("workspace_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_sample_candidates" ADD CONSTRAINT "transcript_sample_candidates_workspace_id_person_id_people_workspace_id_id_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_workspace_id_run_id_processing_runs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."processing_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_source_fk" FOREIGN KEY ("workspace_id","run_id","source_utterance_id") REFERENCES "public"."transcript_utterances"("workspace_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_parent_fk" FOREIGN KEY ("workspace_id","run_id","parent_id") REFERENCES "public"."transcript_segments"("workspace_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_workspace_id_person_id_people_workspace_id_id_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_correction_outbox_pending_idx" ON "transcript_correction_outbox" USING btree ("created_at") WHERE "transcript_correction_outbox"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "transcript_corrections_history_idx" ON "transcript_corrections" USING btree ("workspace_id","run_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transcript_samples_segment_idx" ON "transcript_sample_candidates" USING btree ("workspace_id","run_id","segment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_segments_lineage" ON "transcript_segments" USING btree ("workspace_id","run_id","sequence","order_key") WHERE "transcript_segments"."active";--> statement-breakpoint
CREATE INDEX "transcript_segments_page_idx" ON "transcript_segments" USING btree ("workspace_id","run_id","sequence","order_key","id") WHERE "transcript_segments"."active";--> statement-breakpoint
CREATE INDEX "transcript_segments_person_idx" ON "transcript_segments" USING btree ("workspace_id","person_id","id") WHERE "transcript_segments"."active";--> statement-breakpoint
-- Correction data follows the existing backend-only access boundary.
REVOKE ALL ON TABLE public.transcript_segments, public.transcript_corrections, public.transcript_sample_candidates, public.transcript_correction_outbox FROM PUBLIC;
--> statement-breakpoint
DO $access$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.transcript_segments, public.transcript_corrections, public.transcript_sample_candidates, public.transcript_correction_outbox FROM %I', api_role);
    END IF;
  END LOOP;
END;
$access$;
