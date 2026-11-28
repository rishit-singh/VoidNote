-- Additive accounting protection following 0015.
-- Do not edit an already-applied migration. Service-budget rows are provisioned
-- administratively; runtime may only mutate accounting counters and revoke once.

CREATE OR REPLACE FUNCTION public.service_budget_reject_destructive_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Service budget accounting history is permanent'
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.service_budget_guard_approval_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['reserved_units','settled_units','revoked_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['reserved_units','settled_units','revoked_at'])
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    OR NEW.settled_units < OLD.settled_units THEN
    RAISE EXCEPTION
      'Service budget approval is immutable; only accounting and one-way revocation may change'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER service_budgets_approval_immutable
BEFORE UPDATE ON public.service_budgets
FOR EACH ROW EXECUTE FUNCTION public.service_budget_guard_approval_update();
--> statement-breakpoint

CREATE TRIGGER service_budgets_no_delete
BEFORE DELETE ON public.service_budgets
FOR EACH ROW EXECUTE FUNCTION public.service_budget_reject_destructive_change();
--> statement-breakpoint

CREATE TRIGGER service_budgets_no_truncate
BEFORE TRUNCATE ON public.service_budgets
FOR EACH STATEMENT EXECUTE FUNCTION public.service_budget_reject_destructive_change();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.service_budget_guard_operation_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.settled_at IS NOT NULL
    OR (to_jsonb(NEW) - ARRAY['actual_units','settled_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['actual_units','settled_at'])
    OR NEW.actual_units IS NULL
    OR NEW.settled_at IS NULL THEN
    RAISE EXCEPTION
      'Only one complete settlement may update a held service operation'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER service_budget_operations_settle_once
BEFORE UPDATE ON public.service_budget_operations
FOR EACH ROW EXECUTE FUNCTION public.service_budget_guard_operation_update();
--> statement-breakpoint

CREATE TRIGGER service_budget_operations_no_delete
BEFORE DELETE ON public.service_budget_operations
FOR EACH ROW EXECUTE FUNCTION public.service_budget_reject_destructive_change();
--> statement-breakpoint

CREATE TRIGGER service_budget_operations_no_truncate
BEFORE TRUNCATE ON public.service_budget_operations
FOR EACH STATEMENT EXECUTE FUNCTION public.service_budget_reject_destructive_change();
--> statement-breakpoint

-- 0015's default gives historical items a pending checkpoint with an empty
-- operation ID. These rows are pinned to the old direct provider (or have no
-- sourceProvider field, which parses as direct). Give those dormant checkpoints
-- stable identities without touching sources, facts, status, or policy.
UPDATE public.research_items AS item
SET discovery = jsonb_set(
  item.discovery,
  '{operationId}',
  to_jsonb(gen_random_uuid()::text),
  true
)
FROM public.research_batches AS batch
WHERE batch.workspace_id = item.workspace_id
  AND batch.id = item.batch_id
  AND item.discovery->>'state' = 'pending'
  AND coalesce(batch.policy->>'sourceProvider', 'direct') = 'direct'
  AND coalesce(item.discovery->>'operationId', '') = '';
