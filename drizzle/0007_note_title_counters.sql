CREATE TABLE "note_title_counters" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"last_number" integer NOT NULL,
	CONSTRAINT "note_title_counters_number_check" CHECK ("note_title_counters"."last_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "note_title_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "note_title_counters" ADD CONSTRAINT "note_title_counters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
REVOKE ALL ON TABLE public.note_title_counters FROM PUBLIC;
--> statement-breakpoint
DO $access$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.note_title_counters FROM %I', api_role);
    END IF;
  END LOOP;
END;
$access$;
