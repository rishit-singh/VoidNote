CREATE TABLE "summary_inference_budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"limit_micro_usd" integer NOT NULL,
	"reservation_micro_usd" integer NOT NULL,
	"reserved_micro_usd" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "summary_inference_budgets_limit_positive" CHECK ("summary_inference_budgets"."limit_micro_usd" > 0),
	CONSTRAINT "summary_inference_budgets_reservation_positive" CHECK ("summary_inference_budgets"."reservation_micro_usd" > 0),
	CONSTRAINT "summary_inference_budgets_reserved_bounds" CHECK ("summary_inference_budgets"."reserved_micro_usd" >= 0 and "summary_inference_budgets"."reserved_micro_usd" <= "summary_inference_budgets"."limit_micro_usd")
);
--> statement-breakpoint
ALTER TABLE "summary_inference_budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "summary_inference_reservations" (
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"amount_micro_usd" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "summary_inference_reservations_workspace_id_job_id_pk" PRIMARY KEY("workspace_id","job_id"),
	CONSTRAINT "summary_inference_reservations_amount_positive" CHECK ("summary_inference_reservations"."amount_micro_usd" > 0)
);
--> statement-breakpoint
ALTER TABLE "summary_inference_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "summary_inference_reservations" ADD CONSTRAINT "summary_inference_reservations_budget_id_summary_inference_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."summary_inference_budgets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_inference_reservations" ADD CONSTRAINT "summary_inference_reservations_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."analysis_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Supabase default privileges must not expose backend-only spending authority.
REVOKE ALL ON summary_inference_budgets, summary_inference_reservations FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON summary_inference_budgets, summary_inference_reservations FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON summary_inference_budgets, summary_inference_reservations FROM authenticated;
  END IF;
END $$;
