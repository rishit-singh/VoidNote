ALTER TABLE "summary_inference_budgets" ADD COLUMN "settled_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "summary_inference_reservations" ADD COLUMN "input_token_bound" integer;--> statement-breakpoint
ALTER TABLE "summary_inference_reservations" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "summary_inference_reservations" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "summary_inference_reservations" ADD COLUMN "actual_micro_usd" bigint;--> statement-breakpoint
ALTER TABLE "summary_inference_reservations" ADD COLUMN "settled_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "summary_inference_budgets" ADD CONSTRAINT "summary_inference_budgets_settled_nonnegative" CHECK ("summary_inference_budgets"."settled_micro_usd" >= 0);--> statement-breakpoint
ALTER TABLE "summary_inference_reservations" ADD CONSTRAINT "summary_inference_reservations_input_bound" CHECK ("summary_inference_reservations"."input_token_bound" is null or ("summary_inference_reservations"."input_token_bound" > 0 and "summary_inference_reservations"."input_token_bound" <= 1048576));--> statement-breakpoint
ALTER TABLE "summary_inference_reservations" ADD CONSTRAINT "summary_inference_reservations_settlement" CHECK ((
        "summary_inference_reservations"."settled_at" is null and "summary_inference_reservations"."input_tokens" is null
        and "summary_inference_reservations"."output_tokens" is null and "summary_inference_reservations"."actual_micro_usd" is null
      ) or (
        "summary_inference_reservations"."settled_at" is not null and "summary_inference_reservations"."input_tokens" is not null
        and "summary_inference_reservations"."output_tokens" is not null and "summary_inference_reservations"."actual_micro_usd" is not null
        and "summary_inference_reservations"."input_tokens" >= 0 and "summary_inference_reservations"."output_tokens" >= 0 and "summary_inference_reservations"."actual_micro_usd" >= 0
      ));