CREATE TABLE "command_receipts" (
	"workspace_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_receipts_workspace_id_command_id_pk" PRIMARY KEY("workspace_id","command_id")
);
--> statement-breakpoint
ALTER TABLE "command_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "domain_events" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"note_id" uuid,
	"person_id" uuid,
	"branch_id" text DEFAULT 'default' NOT NULL,
	"revision" integer NOT NULL,
	"operation" text NOT NULL,
	"operation_version" integer DEFAULT 1 NOT NULL,
	"actor_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_events_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "domain_events_entity_sequence_unique" UNIQUE("workspace_id","entity_type","entity_id","branch_id","revision"),
	CONSTRAINT "domain_events_command_unique" UNIQUE("workspace_id","command_id"),
	CONSTRAINT "domain_events_entity_check" CHECK (("domain_events"."entity_type" = 'note' and "domain_events"."note_id" is not null and "domain_events"."note_id" = "domain_events"."entity_id" and "domain_events"."person_id" is null) or ("domain_events"."entity_type" = 'person' and "domain_events"."person_id" is not null and "domain_events"."person_id" = "domain_events"."entity_id" and "domain_events"."note_id" is null)),
	CONSTRAINT "domain_events_revision_check" CHECK ("domain_events"."revision" > 0),
	CONSTRAINT "domain_events_version_check" CHECK ("domain_events"."operation_version" > 0),
	CONSTRAINT "domain_events_branch_check" CHECK ("domain_events"."branch_id" = 'default')
);
--> statement-breakpoint
ALTER TABLE "domain_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notes" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"branch_id" text DEFAULT 'default' NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"title" text NOT NULL,
	"transcript" text NOT NULL,
	"legacy_utterances" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"import_source_key" text,
	"source_created_at" timestamp (3) with time zone,
	"source_updated_at" timestamp (3) with time zone,
	CONSTRAINT "notes_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "notes_import_source_unique" UNIQUE("workspace_id","import_source_key"),
	CONSTRAINT "notes_revision_check" CHECK ("notes"."revision" > 0),
	CONSTRAINT "notes_branch_check" CHECK ("notes"."branch_id" = 'default')
);
--> statement-breakpoint
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outbox" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"available_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "outbox_event_unique" UNIQUE("workspace_id","event_id"),
	CONSTRAINT "outbox_attempts_check" CHECK ("outbox"."attempts" >= 0)
);

--> statement-breakpoint
ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "people" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"branch_id" text DEFAULT 'default' NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"account_id" uuid,
	CONSTRAINT "people_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "people_revision_check" CHECK ("people"."revision" > 0),
	CONSTRAINT "people_branch_check" CHECK ("people"."branch_id" = 'default')
);
--> statement-breakpoint
ALTER TABLE "people" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_memberships" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	CONSTRAINT "workspace_memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_memberships_role_check" CHECK ("workspace_memberships"."role" in ('owner', 'member'))
);
--> statement-breakpoint
ALTER TABLE "workspace_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text DEFAULT 'Private workspace' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	CONSTRAINT "workspaces_owner_unique" UNIQUE("owner_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_actor_membership_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_note_fk" FOREIGN KEY ("workspace_id","note_id") REFERENCES "public"."notes"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_actor_membership_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_receipt_fk" FOREIGN KEY ("workspace_id","command_id") REFERENCES "public"."command_receipts"("workspace_id","command_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_event_fk" FOREIGN KEY ("workspace_id","event_id") REFERENCES "public"."domain_events"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_account_membership_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_user_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_active_updated_idx" ON "notes" USING btree ("workspace_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "notes"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_eligible_idx" ON "outbox" USING btree ("available_at","workspace_id","id") WHERE "outbox"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "people_active_id_idx" ON "people" USING btree ("workspace_id","id") WHERE "people"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "people_active_name_prefix_idx" ON "people" USING btree ("workspace_id",lower("display_name") text_pattern_ops,"id") WHERE "people"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "workspace_memberships_user_idx" ON "workspace_memberships" USING btree ("user_id","workspace_id");
