CREATE TABLE "research_agent_operations" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"usage" jsonb,
	"usage_settled_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_agent_operations_workspace_id_run_id_operation_id_pk" PRIMARY KEY("workspace_id","run_id","operation_id"),
	CONSTRAINT "research_agent_operations_kind" CHECK ("research_agent_operations"."kind" in ('model','tool')),
	CONSTRAINT "research_agent_operations_state" CHECK ("research_agent_operations"."state" in ('pending','submitted','completed','uncertain')),
	CONSTRAINT "research_agent_operations_payload_bound" CHECK (octet_length("research_agent_operations"."payload"::text) <= 50000),
	CONSTRAINT "research_agent_operations_result_bound" CHECK ("research_agent_operations"."result" is null or octet_length("research_agent_operations"."result"::text) <= 100000),
	CONSTRAINT "research_agent_operations_usage_bound" CHECK ("research_agent_operations"."usage" is null or octet_length("research_agent_operations"."usage"::text) <= 10000)
);
--> statement-breakpoint
ALTER TABLE "research_agent_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "research_agent_operations" ADD CONSTRAINT "research_agent_operations_workspace_id_run_id_research_runs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."research_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_agent_operations_run" ON "research_agent_operations" USING btree ("workspace_id","run_id","created_at");