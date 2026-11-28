-- Drizzle runs ALL pending migrations in one transaction. NOT VALID followed by
-- VALIDATE here does not release the creation locks between statements.
-- This bounded atomic migration is suitable for the audited small local dataset.
-- Production requires its own orphan/size/lock audit; use separately committed
-- operational stages if that audit warrants it, not merely separate SQL files.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "user_profiles" VALIDATE CONSTRAINT "user_profiles_id_users_id_fk";
