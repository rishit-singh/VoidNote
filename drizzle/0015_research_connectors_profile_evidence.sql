CREATE TABLE "assistant_profile_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"executor" text NOT NULL,
	"kind" text NOT NULL,
	"turn_id" uuid,
	"person_id" uuid NOT NULL,
	"expected_person_revision" integer NOT NULL,
	"person_revision" integer NOT NULL,
	"expected_contact_revision" integer NOT NULL,
	"contact_revision" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"fields" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_profile_changes_executor" CHECK ("assistant_profile_changes"."executor" in ('user', 'agent', 'workflow')),
	CONSTRAINT "assistant_profile_changes_kind" CHECK ("assistant_profile_changes"."kind" in ('create', 'patch', 'contact-save')),
	CONSTRAINT "assistant_profile_changes_turn" CHECK (("assistant_profile_changes"."executor" = 'user' and "assistant_profile_changes"."turn_id" is null) or ("assistant_profile_changes"."executor" <> 'user' and "assistant_profile_changes"."turn_id" is not null)),
	CONSTRAINT "assistant_profile_changes_revisions" CHECK ("assistant_profile_changes"."expected_person_revision" >= 0 and "assistant_profile_changes"."person_revision" > 0 and "assistant_profile_changes"."expected_contact_revision" >= 0 and "assistant_profile_changes"."contact_revision" >= 0),
	CONSTRAINT "assistant_profile_changes_fingerprint" CHECK (length("assistant_profile_changes"."fingerprint") = 64),
	CONSTRAINT "assistant_profile_changes_evidence_bound" CHECK (octet_length("assistant_profile_changes"."fields"::text) <= 16384 and octet_length("assistant_profile_changes"."sources"::text) <= 65536)
);
--> statement-breakpoint
ALTER TABLE "assistant_profile_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "connector_connections" (
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"connected_account_id" text,
	"status" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_connections_workspace_id_actor_id_provider_pk" PRIMARY KEY("workspace_id","actor_id","provider"),
	CONSTRAINT "connector_connections_account" UNIQUE("connected_account_id"),
	CONSTRAINT "connector_connections_state" CHECK (("connector_connections"."status" = 'pending' and "connector_connections"."connected_account_id" is not null) or ("connector_connections"."status" = 'revoked' and "connector_connections"."connected_account_id" is null) or ("connector_connections"."status" = 'connected' and "connector_connections"."connected_account_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "connector_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "connector_operation_receipts" (
	"workspace_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"fingerprint" text NOT NULL,
	"brief_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"status" text NOT NULL,
	"provider_request_id" text,
	"remote_message_id" text,
	"message_url" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "connector_operation_receipts_workspace_id_operation_id_pk" PRIMARY KEY("workspace_id","operation_id"),
	CONSTRAINT "connector_receipt_origin_bound" CHECK (length("connector_operation_receipts"."origin") between 1 and 200),
	CONSTRAINT "connector_receipt_fingerprint" CHECK (length("connector_operation_receipts"."fingerprint") = 64),
	CONSTRAINT "connector_receipt_state" CHECK ("connector_operation_receipts"."status" in ('in_flight','sent','failed','unknown'))
);
--> statement-breakpoint
ALTER TABLE "connector_operation_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "service_budget_operations" (
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"maximum_units" bigint NOT NULL,
	"actual_units" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp (3) with time zone,
	CONSTRAINT "service_budget_operations_workspace_id_provider_operation_id_pk" PRIMARY KEY("workspace_id","provider","operation_id"),
	CONSTRAINT "service_budget_operations_provider" CHECK ("service_budget_operations"."provider" in ('firecrawl','composio')),
	CONSTRAINT "service_budget_operations_maximum_range" CHECK ("service_budget_operations"."maximum_units" between 1 and 9007199254740991),
	CONSTRAINT "service_budget_operations_settlement" CHECK (("service_budget_operations"."actual_units" is null and "service_budget_operations"."settled_at" is null)
        or ("service_budget_operations"."actual_units" between 0 and "service_budget_operations"."maximum_units" and "service_budget_operations"."settled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "service_budget_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "service_budgets" (
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"id" uuid NOT NULL,
	"limit_units" bigint NOT NULL,
	"reserved_units" bigint DEFAULT 0 NOT NULL,
	"settled_units" bigint DEFAULT 0 NOT NULL,
	"approved_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_budgets_workspace_id_provider_id_pk" PRIMARY KEY("workspace_id","provider","id"),
	CONSTRAINT "service_budgets_provider" CHECK ("service_budgets"."provider" in ('firecrawl','composio')),
	CONSTRAINT "service_budgets_limit_range" CHECK ("service_budgets"."limit_units" between 0 and 9007199254740991),
	CONSTRAINT "service_budgets_reserved_range" CHECK ("service_budgets"."reserved_units" between 0 and 9007199254740991),
	CONSTRAINT "service_budgets_settled_range" CHECK ("service_budgets"."settled_units" between 0 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "service_budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "research_items" ADD COLUMN "discovery" jsonb DEFAULT '{"state":"pending","operationId":"","creditsUsed":null}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_profile_changes" ADD CONSTRAINT "assistant_profile_changes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_profile_changes" ADD CONSTRAINT "assistant_profile_changes_workspace_id_person_id_people_workspace_id_id_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_profile_changes" ADD CONSTRAINT "assistant_profile_changes_workspace_id_actor_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_profile_changes" ADD CONSTRAINT "assistant_profile_changes_workspace_id_turn_id_assistant_turns_workspace_id_id_fk" FOREIGN KEY ("workspace_id","turn_id") REFERENCES "public"."assistant_turns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_workspace_id_actor_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_operation_receipts" ADD CONSTRAINT "connector_operation_receipts_workspace_id_actor_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_budget_operations" ADD CONSTRAINT "service_budget_operations_budget_fk" FOREIGN KEY ("workspace_id","provider","budget_id") REFERENCES "public"."service_budgets"("workspace_id","provider","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_budgets" ADD CONSTRAINT "service_budgets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_profile_changes_operation" ON "assistant_profile_changes" USING btree ("workspace_id","operation_id") WHERE "assistant_profile_changes"."executor" in ('agent', 'workflow');--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_profile_changes_revision" ON "assistant_profile_changes" USING btree ("workspace_id","person_id","contact_revision") WHERE "assistant_profile_changes"."fields" <> '{}'::jsonb;--> statement-breakpoint
CREATE INDEX "assistant_profile_changes_owner" ON "assistant_profile_changes" USING btree ("workspace_id","person_id","contact_revision" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "connector_receipts_brief" ON "connector_operation_receipts" USING btree ("workspace_id","brief_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "connector_one_in_flight_per_workspace" ON "connector_operation_receipts" USING btree ("workspace_id","provider") WHERE "connector_operation_receipts"."status" = 'in_flight';--> statement-breakpoint
CREATE INDEX "service_budget_operations_budget" ON "service_budget_operations" USING btree ("workspace_id","provider","budget_id");