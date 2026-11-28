CREATE TABLE "research_run_commands" (
	"workspace_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_run_commands_workspace_id_command_id_pk" PRIMARY KEY("workspace_id","command_id")
);
--> statement-breakpoint
ALTER TABLE "research_run_commands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research_run_discoveries" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"operation_id" uuid NOT NULL,
	"query" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"credits_used" integer,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "research_run_discoveries_workspace_id_run_id_ordinal_pk" PRIMARY KEY("workspace_id","run_id","ordinal"),
	CONSTRAINT "research_run_discoveries_ordinal" CHECK ("research_run_discoveries"."ordinal" in (0,1)),
	CONSTRAINT "research_run_discoveries_state" CHECK ("research_run_discoveries"."state" in ('pending','submitted','completed')),
	CONSTRAINT "research_run_discoveries_candidates_bound" CHECK (octet_length("research_run_discoveries"."candidates"::text) <= 40000)
);
--> statement-breakpoint
ALTER TABLE "research_run_discoveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research_run_finding_evidence" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"excerpt" text NOT NULL,
	CONSTRAINT "research_run_finding_evidence_workspace_id_run_id_finding_id_source_id_start_offset_pk" PRIMARY KEY("workspace_id","run_id","finding_id","source_id","start_offset"),
	CONSTRAINT "research_run_finding_evidence_relation" CHECK ("research_run_finding_evidence"."relation" in ('supports','contradicts','premise')),
	CONSTRAINT "research_run_finding_evidence_offsets" CHECK ("research_run_finding_evidence"."start_offset" >= 0 and "research_run_finding_evidence"."end_offset" > "research_run_finding_evidence"."start_offset")
);
--> statement-breakpoint
ALTER TABLE "research_run_finding_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research_run_findings" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"statement" text,
	"classification" text,
	"explanation" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "research_run_findings_workspace_id_run_id_id_pk" PRIMARY KEY("workspace_id","run_id","id"),
	CONSTRAINT "research_run_findings_outcome" CHECK ("research_run_findings"."outcome" in ('supported','conflicting','insufficient-evidence','failed')),
	CONSTRAINT "research_run_findings_classification" CHECK ("research_run_findings"."classification" is null or "research_run_findings"."classification" in ('direct-evidence','deduction'))
);
--> statement-breakpoint
ALTER TABLE "research_run_findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research_run_questions" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"question" text NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"operation_id" uuid NOT NULL,
	"inference_state" text DEFAULT 'pending' NOT NULL,
	"inference_result" jsonb,
	"inference_usage" jsonb,
	"error" text,
	CONSTRAINT "research_run_questions_workspace_id_run_id_id_pk" PRIMARY KEY("workspace_id","run_id","id"),
	CONSTRAINT "research_run_questions_outcome" CHECK ("research_run_questions"."outcome" in ('pending','supported','conflicting','insufficient-evidence','failed')),
	CONSTRAINT "research_run_questions_inference_state" CHECK ("research_run_questions"."inference_state" in ('pending','submitted','settled')),
	CONSTRAINT "research_run_questions_result_bound" CHECK ("research_run_questions"."inference_result" is null or octet_length("research_run_questions"."inference_result"::text) <= 30000)
);
--> statement-breakpoint
ALTER TABLE "research_run_questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research_run_sources" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"requested_url" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"published_at" timestamp (3) with time zone,
	"origin_source_id" text,
	"digest" text NOT NULL,
	"retrieved_at" timestamp (3) with time zone NOT NULL,
	"content" text NOT NULL,
	"disposition" text DEFAULT 'retrieved' NOT NULL,
	CONSTRAINT "research_run_sources_workspace_id_run_id_id_pk" PRIMARY KEY("workspace_id","run_id","id"),
	CONSTRAINT "research_run_sources_content_bound" CHECK (octet_length("research_run_sources"."content") <= 128000)
);
--> statement-breakpoint
ALTER TABLE "research_run_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research_runs" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"origin_turn_id" uuid,
	"note_id" uuid,
	"person_id" uuid,
	"person_revision" integer,
	"contact_revision" integer,
	"question" text NOT NULL,
	"payload" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"report" jsonb,
	"error" text,
	"discovery_state" text DEFAULT 'pending' NOT NULL,
	"discovery_credits_used" integer,
	"dispatch_checked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_runs_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "research_runs_person_revision" CHECK (("research_runs"."person_id" is null and "research_runs"."person_revision" is null and "research_runs"."contact_revision" is null) or ("research_runs"."person_id" is not null and "research_runs"."person_revision" > 0 and "research_runs"."contact_revision" >= 0)),
	CONSTRAINT "research_runs_status" CHECK ("research_runs"."status" in ('queued','running','completed','failed','cancelled')),
	CONSTRAINT "research_runs_stage" CHECK ("research_runs"."stage" in ('queued','planning','retrieving','analyzing','synthesizing','publishing','finished')),
	CONSTRAINT "research_runs_payload_bound" CHECK (octet_length("research_runs"."payload"::text) <= 50000),
	CONSTRAINT "research_runs_policy_bound" CHECK (octet_length("research_runs"."policy"::text) <= 20000),
	CONSTRAINT "research_runs_report_bound" CHECK ("research_runs"."report" is null or octet_length("research_runs"."report"::text) <= 200000),
	CONSTRAINT "research_runs_publication_consistency" CHECK (("research_runs"."status" = 'completed') = ("research_runs"."report" is not null)),
	CONSTRAINT "research_runs_discovery_state" CHECK ("research_runs"."discovery_state" in ('pending','submitted','completed'))
);
--> statement-breakpoint
ALTER TABLE "research_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "research_run_commands" ADD CONSTRAINT "research_run_commands_workspace_id_run_id_research_runs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."research_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_run_discoveries" ADD CONSTRAINT "research_run_discoveries_workspace_id_run_id_research_runs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."research_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_run_finding_evidence" ADD CONSTRAINT "research_run_finding_evidence_workspace_id_run_id_finding_id_research_run_findings_workspace_id_run_id_id_fk" FOREIGN KEY ("workspace_id","run_id","finding_id") REFERENCES "public"."research_run_findings"("workspace_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_run_finding_evidence" ADD CONSTRAINT "research_run_finding_evidence_workspace_id_run_id_source_id_research_run_sources_workspace_id_run_id_id_fk" FOREIGN KEY ("workspace_id","run_id","source_id") REFERENCES "public"."research_run_sources"("workspace_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_run_findings" ADD CONSTRAINT "research_run_findings_workspace_id_run_id_research_runs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."research_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_run_findings" ADD CONSTRAINT "research_run_findings_workspace_id_run_id_question_id_research_run_questions_workspace_id_run_id_id_fk" FOREIGN KEY ("workspace_id","run_id","question_id") REFERENCES "public"."research_run_questions"("workspace_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_run_questions" ADD CONSTRAINT "research_run_questions_workspace_id_run_id_research_runs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."research_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_run_sources" ADD CONSTRAINT "research_run_sources_workspace_id_run_id_research_runs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."research_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_workspace_id_actor_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_workspace_id_origin_turn_id_assistant_turns_workspace_id_id_fk" FOREIGN KEY ("workspace_id","origin_turn_id") REFERENCES "public"."assistant_turns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_workspace_id_person_id_people_workspace_id_id_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_workspace_id_note_id_notes_workspace_id_id_fk" FOREIGN KEY ("workspace_id","note_id") REFERENCES "public"."notes"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_run_discoveries_dispatch" ON "research_run_discoveries" USING btree ("workspace_id","run_id","state");--> statement-breakpoint
CREATE INDEX "research_run_finding_evidence_finding" ON "research_run_finding_evidence" USING btree ("workspace_id","run_id","finding_id");--> statement-breakpoint
CREATE INDEX "research_run_questions_order" ON "research_run_questions" USING btree ("workspace_id","run_id","ordinal");--> statement-breakpoint
CREATE INDEX "research_run_sources_url" ON "research_run_sources" USING btree ("workspace_id","url","retrieved_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "research_runs_workspace_created" ON "research_runs" USING btree ("workspace_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "research_runs_dispatch" ON "research_runs" USING btree (coalesce("dispatch_checked_at", "updated_at"),"workspace_id","id") WHERE "research_runs"."status" in ('queued','running');--> statement-breakpoint
CREATE INDEX "research_runs_origin_note" ON "research_runs" USING btree ("workspace_id","note_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "research_items_workspace_recent" ON "research_items" USING btree ("workspace_id","updated_at" DESC NULLS LAST,"batch_id" DESC NULLS LAST,"person_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "research_items_person_evidence" ON "research_items" USING btree ("workspace_id","person_id","updated_at" DESC NULLS LAST,"batch_id" DESC NULLS LAST) WHERE "research_items"."status" in ('completed','partial');