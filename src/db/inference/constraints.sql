-- Append after the generated inference tables and constraints in a NEW migration.
-- Use a non-owner application role without DDL/trigger-management privileges:
-- a table owner or superuser can disable triggers.

CREATE OR REPLACE FUNCTION public.inference_reject_destructive_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Inference accounting history is permanent'
    USING ERRCODE = '23514';
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
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Settled inference receipts are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF (to_jsonb(NEW) - ARRAY['input_tokens', 'output_tokens', 'actual_micro_usd', 'settled_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['input_tokens', 'output_tokens', 'actual_micro_usd', 'settled_at'])
    OR NEW.settled_at IS NULL
    OR NEW.input_tokens IS NULL
    OR NEW.output_tokens IS NULL
    OR NEW.actual_micro_usd IS NULL THEN
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
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['reserved_micro_usd', 'settled_micro_usd', 'revoked_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['reserved_micro_usd', 'settled_micro_usd', 'revoked_at'])
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
