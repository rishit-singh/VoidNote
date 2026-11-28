CREATE TABLE "connector_link_receipts" (
	"workspace_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"connected_account_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "connector_link_receipts_workspace_id_operation_id_pk" PRIMARY KEY("workspace_id","operation_id"),
	CONSTRAINT "connector_link_origin_bound" CHECK (length("connector_link_receipts"."origin") between 1 and 200),
	CONSTRAINT "connector_link_fingerprint" CHECK (length("connector_link_receipts"."fingerprint") = 64),
	CONSTRAINT "connector_link_state" CHECK (("connector_link_receipts"."status" = 'in_flight' and "connector_link_receipts"."completed_at" is null)
        or ("connector_link_receipts"."status" in ('linked','failed','unknown') and "connector_link_receipts"."completed_at" is not null)),
	CONSTRAINT "connector_link_account" CHECK (("connector_link_receipts"."status" = 'linked' and "connector_link_receipts"."connected_account_id" is not null)
        or ("connector_link_receipts"."status" <> 'linked' and "connector_link_receipts"."connected_account_id" is null))
);
--> statement-breakpoint
ALTER TABLE "connector_link_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "research_items" ALTER COLUMN "discovery" SET DEFAULT '{"state":"pending","operationId":"","creditsUsed":null,"settled":false}'::jsonb;--> statement-breakpoint
ALTER TABLE "connector_operation_receipts" ADD COLUMN "connected_account_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_link_receipts" ADD CONSTRAINT "connector_link_receipts_workspace_id_actor_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_one_link_in_flight_per_actor" ON "connector_link_receipts" USING btree ("workspace_id","actor_id") WHERE "connector_link_receipts"."status" = 'in_flight';--> statement-breakpoint
CREATE INDEX "connector_link_receipts_owner" ON "connector_link_receipts" USING btree ("workspace_id","actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "service_budgets" ADD CONSTRAINT "service_budgets_accounted_within_limit" CHECK ("service_budgets"."reserved_units" + "service_budgets"."settled_units" <= "service_budgets"."limit_units");