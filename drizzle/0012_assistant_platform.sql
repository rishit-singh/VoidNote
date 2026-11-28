CREATE TABLE "assistant_artifact_publications" (
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"checksum" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp (3) with time zone,
	"cancelled_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_artifact_publications_workspace_id_artifact_id_pk" PRIMARY KEY("workspace_id","artifact_id"),
	CONSTRAINT "assistant_artifact_publications_key" UNIQUE("object_key"),
	CONSTRAINT "assistant_artifact_publications_attempts" CHECK ("assistant_artifact_publications"."attempts" >= 0),
	CONSTRAINT "assistant_artifact_publications_checksum" CHECK ("assistant_artifact_publications"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "assistant_artifact_publications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assistant_artifacts" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"turn_id" uuid,
	"kind" text NOT NULL,
	"note_id" uuid,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"content" text NOT NULL,
	"sources" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "assistant_artifacts_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "assistant_artifacts_kind" CHECK ("assistant_artifacts"."kind" in ('note','file','annotation')),
	CONSTRAINT "assistant_artifacts_media_type" CHECK ("assistant_artifacts"."media_type" in ('text/plain','text/markdown')),
	CONSTRAINT "assistant_artifacts_revision" CHECK ("assistant_artifacts"."revision" > 0),
	CONSTRAINT "assistant_artifacts_content_bound" CHECK (length("assistant_artifacts"."content") <= 100000),
	CONSTRAINT "assistant_artifacts_note" CHECK ("assistant_artifacts"."kind" = 'file' or "assistant_artifacts"."note_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "assistant_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assistant_memories" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"subject_id" uuid,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"provenance" text NOT NULL,
	"sources" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp (3) with time zone,
	"invalidation_reason" text,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_memories_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "assistant_memories_revision" CHECK ("assistant_memories"."revision" > 0),
	CONSTRAINT "assistant_memories_status" CHECK ("assistant_memories"."status" in ('active','invalidated','expired','needs-review')),
	CONSTRAINT "assistant_memories_kind" CHECK ("assistant_memories"."kind" in ('preference','claim','working-summary')),
	CONSTRAINT "assistant_memories_provenance" CHECK ("assistant_memories"."provenance" in ('user-stated','source-supported','agent-inferred')),
	CONSTRAINT "assistant_memories_content_bound" CHECK (length("assistant_memories"."content") between 1 and 8000)
);
--> statement-breakpoint
ALTER TABLE "assistant_memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assistant_memory_revisions" (
	"workspace_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"operation_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_memory_revisions_workspace_id_memory_id_revision_pk" PRIMARY KEY("workspace_id","memory_id","revision"),
	CONSTRAINT "assistant_memory_revisions_operation" UNIQUE("workspace_id","operation_id"),
	CONSTRAINT "assistant_memory_revisions_positive" CHECK ("assistant_memory_revisions"."revision" > 0),
	CONSTRAINT "assistant_memory_revisions_reason" CHECK (length("assistant_memory_revisions"."reason") between 1 and 1000),
	CONSTRAINT "assistant_memory_revisions_snapshot_bound" CHECK (octet_length("assistant_memory_revisions"."after"::text) <= 524288 and ("assistant_memory_revisions"."before" is null or octet_length("assistant_memory_revisions"."before"::text) <= 524288))
);
--> statement-breakpoint
ALTER TABLE "assistant_memory_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assistant_messages" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sequence" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_messages_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "assistant_messages_turn_role" UNIQUE("workspace_id","turn_id","role"),
	CONSTRAINT "assistant_messages_thread_sequence" UNIQUE("workspace_id","thread_id","sequence"),
	CONSTRAINT "assistant_messages_role" CHECK ("assistant_messages"."role" in ('user','assistant')),
	CONSTRAINT "assistant_messages_sequence" CHECK ("assistant_messages"."sequence" > 0),
	CONSTRAINT "assistant_messages_text_bound" CHECK (length("assistant_messages"."text") <= 100000)
);
--> statement-breakpoint
ALTER TABLE "assistant_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assistant_operation_receipts" (
	"workspace_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"result_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_operation_receipts_workspace_id_operation_id_pk" PRIMARY KEY("workspace_id","operation_id"),
	CONSTRAINT "assistant_operation_receipts_hash" CHECK (length("assistant_operation_receipts"."fingerprint") = 64),
	CONSTRAINT "assistant_operation_receipts_kind" CHECK ("assistant_operation_receipts"."kind" in ('remember','revise-memory','invalidate-memory','create-artifact'))
);
--> statement-breakpoint
ALTER TABLE "assistant_operation_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assistant_threads" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"note_id" uuid,
	"title" text DEFAULT 'New conversation' NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_threads_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "assistant_threads_owner_identity" UNIQUE("workspace_id","id","actor_id")
);
--> statement-breakpoint
ALTER TABLE "assistant_threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assistant_turns" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"thread_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"text" text NOT NULL,
	"policy" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"output_fingerprint" text,
	"error" text,
	"dispatch_checked_at" timestamp (3) with time zone,
	"cancellation_dispatched_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_turns_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "assistant_turns_thread_identity" UNIQUE("workspace_id","thread_id","id"),
	CONSTRAINT "assistant_turns_status" CHECK ("assistant_turns"."status" in ('queued','running','succeeded','failed','cancelled','interrupted')),
	CONSTRAINT "assistant_turns_text_bound" CHECK (length("assistant_turns"."text") between 1 and 16000),
	CONSTRAINT "assistant_turns_policy_bound" CHECK (octet_length("assistant_turns"."policy"::text) <= 65536)
);
--> statement-breakpoint
ALTER TABLE "assistant_turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_details" (
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"organization" text DEFAULT '' NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_details_workspace_id_person_id_pk" PRIMARY KEY("workspace_id","person_id"),
	CONSTRAINT "contact_details_revision_check" CHECK ("contact_details"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "contact_details" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_receipts" (
	"workspace_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "contact_receipts_workspace_id_operation_id_pk" PRIMARY KEY("workspace_id","operation_id")
);
--> statement-breakpoint
ALTER TABLE "contact_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inference_budgets" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"rate_version_id" uuid NOT NULL,
	"limit_micro_usd" bigint NOT NULL,
	"reserved_micro_usd" bigint DEFAULT 0 NOT NULL,
	"settled_micro_usd" bigint DEFAULT 0 NOT NULL,
	"approved_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_budgets_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "inference_budgets_rate_identity" UNIQUE("workspace_id","id","rate_version_id"),
	CONSTRAINT "inference_budgets_limit_range" CHECK ("inference_budgets"."limit_micro_usd" between 0 and 9007199254740991),
	CONSTRAINT "inference_budgets_reserved_range" CHECK ("inference_budgets"."reserved_micro_usd" between 0 and 9007199254740991),
	CONSTRAINT "inference_budgets_settled_range" CHECK ("inference_budgets"."settled_micro_usd" between 0 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "inference_budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inference_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"currency" text NOT NULL,
	"input_micro_usd_per_million_tokens" bigint NOT NULL,
	"output_micro_usd_per_million_tokens" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_rates_model_identity" UNIQUE("id","model"),
	CONSTRAINT "inference_rates_provider" CHECK (length("inference_rates"."provider") between 1 and 128),
	CONSTRAINT "inference_rates_model" CHECK (length("inference_rates"."model") between 1 and 256),
	CONSTRAINT "inference_rates_currency" CHECK ("inference_rates"."currency" = 'USD'),
	CONSTRAINT "inference_rates_input_range" CHECK ("inference_rates"."input_micro_usd_per_million_tokens" between 0 and 9007199254740991),
	CONSTRAINT "inference_rates_output_range" CHECK ("inference_rates"."output_micro_usd_per_million_tokens" between 0 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "inference_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inference_receipts" (
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"rate_version_id" uuid NOT NULL,
	"model" text NOT NULL,
	"input_token_bound" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"reserved_micro_usd" bigint NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"actual_micro_usd" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp (3) with time zone,
	CONSTRAINT "inference_receipts_workspace_id_request_id_pk" PRIMARY KEY("workspace_id","request_id"),
	CONSTRAINT "inference_receipts_model" CHECK (length("inference_receipts"."model") between 1 and 256),
	CONSTRAINT "inference_receipts_input_bound" CHECK ("inference_receipts"."input_token_bound" >= 0),
	CONSTRAINT "inference_receipts_output_bound" CHECK ("inference_receipts"."max_output_tokens" >= 0),
	CONSTRAINT "inference_receipts_reserved_range" CHECK ("inference_receipts"."reserved_micro_usd" between 0 and 9007199254740991),
	CONSTRAINT "inference_receipts_settlement" CHECK ((
        "inference_receipts"."settled_at" is null and "inference_receipts"."input_tokens" is null
        and "inference_receipts"."output_tokens" is null and "inference_receipts"."actual_micro_usd" is null
      ) or (
        "inference_receipts"."settled_at" is not null and "inference_receipts"."input_tokens" is not null
        and "inference_receipts"."output_tokens" is not null and "inference_receipts"."actual_micro_usd" is not null
        and "inference_receipts"."input_tokens" >= 0 and "inference_receipts"."output_tokens" >= 0
        and "inference_receipts"."actual_micro_usd" between 0 and 9007199254740991
      ))
);
--> statement-breakpoint
ALTER TABLE "inference_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research_batches" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"cancelled_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_batches_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "research_batches_request_bound" CHECK (octet_length("research_batches"."request"::text) <= 100000)
);
--> statement-breakpoint
ALTER TABLE "research_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research_commands" (
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_commands_workspace_id_request_id_pk" PRIMARY KEY("workspace_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "research_commands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "research_items" (
	"workspace_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"profile_revision" integer NOT NULL,
	"contact_revision" integer DEFAULT 0 NOT NULL,
	"contact" jsonb NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"deadline" timestamp (3) with time zone NOT NULL,
	"dispatch_checked_at" timestamp (3) with time zone,
	"cleanup_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_items_workspace_id_batch_id_person_id_pk" PRIMARY KEY("workspace_id","batch_id","person_id"),
	CONSTRAINT "research_items_status" CHECK ("research_items"."status" in ('queued','running','needs-input','partial','completed','failed','cancelled')),
	CONSTRAINT "research_items_versions" CHECK ("research_items"."generation" > 0 and "research_items"."profile_revision" > 0 and "research_items"."contact_revision" >= 0),
	CONSTRAINT "research_items_sources_bound" CHECK (octet_length("research_items"."sources"::text) <= 3200000),
	CONSTRAINT "research_items_facts_bound" CHECK (octet_length("research_items"."facts"::text) <= 1000000)
);
--> statement-breakpoint
ALTER TABLE "research_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "summary_cancellation_cleanup" (
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "summary_cancellation_cleanup_workspace_id_job_id_pk" PRIMARY KEY("workspace_id","job_id")
);
--> statement-breakpoint
ALTER TABLE "summary_cancellation_cleanup" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assistant_artifact_publications" ADD CONSTRAINT "assistant_artifact_publications_workspace_id_artifact_id_assistant_artifacts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","artifact_id") REFERENCES "public"."assistant_artifacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_artifacts" ADD CONSTRAINT "assistant_artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_artifacts" ADD CONSTRAINT "assistant_artifacts_actor_id_user_profiles_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_artifacts" ADD CONSTRAINT "assistant_artifacts_workspace_id_actor_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_artifacts" ADD CONSTRAINT "assistant_artifacts_workspace_id_turn_id_assistant_turns_workspace_id_id_fk" FOREIGN KEY ("workspace_id","turn_id") REFERENCES "public"."assistant_turns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_artifacts" ADD CONSTRAINT "assistant_artifacts_workspace_id_note_id_notes_workspace_id_id_fk" FOREIGN KEY ("workspace_id","note_id") REFERENCES "public"."notes"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_memories" ADD CONSTRAINT "assistant_memories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_memories" ADD CONSTRAINT "assistant_memories_actor_id_user_profiles_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_memories" ADD CONSTRAINT "assistant_memories_workspace_id_actor_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_memories" ADD CONSTRAINT "assistant_memories_workspace_id_subject_id_people_workspace_id_id_fk" FOREIGN KEY ("workspace_id","subject_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_memory_revisions" ADD CONSTRAINT "assistant_memory_revisions_workspace_id_memory_id_assistant_memories_workspace_id_id_fk" FOREIGN KEY ("workspace_id","memory_id") REFERENCES "public"."assistant_memories"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_memory_revisions" ADD CONSTRAINT "assistant_memory_revisions_workspace_id_operation_id_assistant_operation_receipts_workspace_id_operation_id_fk" FOREIGN KEY ("workspace_id","operation_id") REFERENCES "public"."assistant_operation_receipts"("workspace_id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_memory_revisions" ADD CONSTRAINT "assistant_memory_revisions_workspace_id_actor_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_workspace_id_thread_id_turn_id_assistant_turns_workspace_id_thread_id_id_fk" FOREIGN KEY ("workspace_id","thread_id","turn_id") REFERENCES "public"."assistant_turns"("workspace_id","thread_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_operation_receipts" ADD CONSTRAINT "assistant_operation_receipts_workspace_id_actor_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_threads" ADD CONSTRAINT "assistant_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_threads" ADD CONSTRAINT "assistant_threads_actor_id_user_profiles_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_threads" ADD CONSTRAINT "assistant_threads_workspace_id_actor_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_threads" ADD CONSTRAINT "assistant_threads_workspace_id_note_id_notes_workspace_id_id_fk" FOREIGN KEY ("workspace_id","note_id") REFERENCES "public"."notes"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_actor_id_user_profiles_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_thread_owner_fk" FOREIGN KEY ("workspace_id","thread_id","actor_id") REFERENCES "public"."assistant_threads"("workspace_id","id","actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_details" ADD CONSTRAINT "contact_details_workspace_id_person_id_people_workspace_id_id_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_receipts" ADD CONSTRAINT "contact_receipts_workspace_id_person_id_people_workspace_id_id_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_budgets" ADD CONSTRAINT "inference_budgets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_budgets" ADD CONSTRAINT "inference_budgets_rate_version_id_inference_rates_id_fk" FOREIGN KEY ("rate_version_id") REFERENCES "public"."inference_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_receipts" ADD CONSTRAINT "inference_receipts_budget_fk" FOREIGN KEY ("workspace_id","budget_id","rate_version_id") REFERENCES "public"."inference_budgets"("workspace_id","id","rate_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_receipts" ADD CONSTRAINT "inference_receipts_rate_model_fk" FOREIGN KEY ("rate_version_id","model") REFERENCES "public"."inference_rates"("id","model") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_batches" ADD CONSTRAINT "research_batches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_batches" ADD CONSTRAINT "research_batches_workspace_id_actor_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_commands" ADD CONSTRAINT "research_commands_workspace_id_batch_id_research_batches_workspace_id_id_fk" FOREIGN KEY ("workspace_id","batch_id") REFERENCES "public"."research_batches"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_items" ADD CONSTRAINT "research_items_workspace_id_batch_id_research_batches_workspace_id_id_fk" FOREIGN KEY ("workspace_id","batch_id") REFERENCES "public"."research_batches"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_items" ADD CONSTRAINT "research_items_workspace_id_person_id_people_workspace_id_id_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_cancellation_cleanup" ADD CONSTRAINT "summary_cancellation_cleanup_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."analysis_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_artifact_publications_pending" ON "assistant_artifact_publications" USING btree ("available_at","workspace_id","artifact_id") WHERE "assistant_artifact_publications"."published_at" is null and "assistant_artifact_publications"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "assistant_artifacts_owner" ON "assistant_artifacts" USING btree ("workspace_id","actor_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "assistant_memories_recall" ON "assistant_memories" USING btree ("workspace_id","actor_id","subject_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "assistant_threads_owner_updated" ON "assistant_threads" USING btree ("workspace_id","actor_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_turns_one_active" ON "assistant_turns" USING btree ("workspace_id","thread_id") WHERE "assistant_turns"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "assistant_turns_dispatch" ON "assistant_turns" USING btree (coalesce("dispatch_checked_at", "created_at"),"workspace_id","id") WHERE "assistant_turns"."status" in ('queued','running') or ("assistant_turns"."status" = 'cancelled' and "assistant_turns"."cancellation_dispatched_at" is null);--> statement-breakpoint
CREATE INDEX "inference_receipts_budget" ON "inference_receipts" USING btree ("workspace_id","budget_id");--> statement-breakpoint
CREATE INDEX "research_batches_workspace_created" ON "research_batches" USING btree ("workspace_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "research_items_dispatch" ON "research_items" USING btree (coalesce("dispatch_checked_at", "updated_at"),"workspace_id","batch_id","person_id") WHERE "research_items"."status" in ('queued','running') or ("research_items"."status" = 'cancelled' and "research_items"."cleanup_at" is null);--> statement-breakpoint
CREATE INDEX "summary_cancellation_cleanup_pending" ON "summary_cancellation_cleanup" USING btree ("checked_at" asc nulls first,"created_at","workspace_id","job_id") WHERE "summary_cancellation_cleanup"."completed_at" is null;
--> statement-breakpoint
INSERT INTO summary_cancellation_cleanup (workspace_id, job_id)
SELECT workspace_id, id FROM analysis_jobs WHERE status = 'cancelled'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Backend-owned tables must not inherit Supabase API-role write privileges.
DO $$
DECLARE
  target text;
  client_role text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'assistant_threads','assistant_turns','assistant_messages','assistant_memories',
    'assistant_memory_revisions','assistant_artifacts','assistant_operation_receipts',
    'assistant_artifact_publications','contact_details','contact_receipts',
    'inference_rates','inference_budgets','inference_receipts',
    'research_batches','research_items','research_commands','summary_cancellation_cleanup'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target);
    FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', target, client_role);
      END IF;
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inference_reject_destructive_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Inference accounting history is permanent' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inference_rates_immutable
BEFORE UPDATE OR DELETE ON public.inference_rates
FOR EACH ROW EXECUTE FUNCTION public.inference_reject_destructive_change();
--> statement-breakpoint
CREATE TRIGGER inference_rates_no_truncate
BEFORE TRUNCATE ON public.inference_rates
FOR EACH STATEMENT EXECUTE FUNCTION public.inference_reject_destructive_change();
--> statement-breakpoint
CREATE TRIGGER inference_receipts_no_delete
BEFORE DELETE ON public.inference_receipts
FOR EACH ROW EXECUTE FUNCTION public.inference_reject_destructive_change();
--> statement-breakpoint
CREATE TRIGGER inference_receipts_no_truncate
BEFORE TRUNCATE ON public.inference_receipts
FOR EACH STATEMENT EXECUTE FUNCTION public.inference_reject_destructive_change();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inference_guard_receipt_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Settled inference receipts are immutable' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['input_tokens','output_tokens','actual_micro_usd','settled_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['input_tokens','output_tokens','actual_micro_usd','settled_at'])
    OR NEW.settled_at IS NULL OR NEW.input_tokens IS NULL
    OR NEW.output_tokens IS NULL OR NEW.actual_micro_usd IS NULL THEN
    RAISE EXCEPTION 'Only complete inference settlement may update a held receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inference_receipts_settle_once
BEFORE UPDATE ON public.inference_receipts
FOR EACH ROW EXECUTE FUNCTION public.inference_guard_receipt_update();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inference_guard_budget_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['reserved_micro_usd','settled_micro_usd','revoked_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['reserved_micro_usd','settled_micro_usd','revoked_at'])
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    OR NEW.settled_micro_usd < OLD.settled_micro_usd THEN
    RAISE EXCEPTION 'Inference approval is immutable; only accounting and revocation may change'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inference_budgets_approved_identity
BEFORE UPDATE ON public.inference_budgets
FOR EACH ROW EXECUTE FUNCTION public.inference_guard_budget_update();
--> statement-breakpoint
CREATE TRIGGER inference_budgets_no_delete
BEFORE DELETE ON public.inference_budgets
FOR EACH ROW EXECUTE FUNCTION public.inference_reject_destructive_change();
--> statement-breakpoint
CREATE TRIGGER inference_budgets_no_truncate
BEFORE TRUNCATE ON public.inference_budgets
FOR EACH STATEMENT EXECUTE FUNCTION public.inference_reject_destructive_change();
