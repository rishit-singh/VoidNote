-- Audit before enforcing identity uniqueness. Stop for explicit operator
-- resolution; never choose a winner or rewrite existing person/recording data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "people"
    WHERE "deleted_at" IS NULL AND "account_id" IS NOT NULL
    GROUP BY "workspace_id", "account_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate active self-profile links exist. Audit people grouped by workspace_id/account_id before applying 0018_self_profile.';
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "people_active_account_unique" ON "people" USING btree ("workspace_id","account_id") WHERE "people"."deleted_at" is null and "people"."account_id" is not null;
