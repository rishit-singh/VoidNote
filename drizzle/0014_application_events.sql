CREATE TABLE "activity_notifications" (
	"workspace_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"sequence" bigserial NOT NULL,
	"title" text NOT NULL,
	"href" text NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp (3) with time zone,
	CONSTRAINT "activity_notifications_workspace_id_recipient_id_event_id_pk" PRIMARY KEY("workspace_id","recipient_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "activity_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "application_events" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_events_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "application_events_payload_bound" CHECK (octet_length("application_events"."payload"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "application_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "event_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"subscriber" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_until" timestamp (3) with time zone,
	"enqueued_at" timestamp (3) with time zone,
	"error" text,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "event_deliveries_subscriber" UNIQUE("workspace_id","event_id","subscriber"),
	CONSTRAINT "event_deliveries_state" CHECK ("event_deliveries"."status" in ('pending', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "event_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_notifications" ADD CONSTRAINT "activity_notifications_workspace_id_event_id_application_events_workspace_id_id_fk" FOREIGN KEY ("workspace_id","event_id") REFERENCES "public"."application_events"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_notifications" ADD CONSTRAINT "activity_notifications_workspace_id_recipient_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","recipient_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_workspace_id_event_id_application_events_workspace_id_id_fk" FOREIGN KEY ("workspace_id","event_id") REFERENCES "public"."application_events"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_notifications_feed" ON "activity_notifications" USING btree ("workspace_id","recipient_id","sequence");--> statement-breakpoint
CREATE INDEX "activity_notifications_unread" ON "activity_notifications" USING btree ("workspace_id","recipient_id") WHERE "activity_notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "event_deliveries_pending" ON "event_deliveries" USING btree ("available_at","id") WHERE "event_deliveries"."status" in ('pending', 'running');