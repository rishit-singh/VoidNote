-- These tables are served only through the authenticated repository. All tables
-- have RLS enabled with no public policies (default deny). The backend connection
-- must use the table-owning role, or a separately provisioned trusted BYPASSRLS
-- role with table privileges. Never expose its credentials to browser clients.
-- Supabase may grant API roles access through default privileges; remove those
-- grants explicitly. Conditional role lookup also supports plain Postgres CI.
REVOKE ALL ON TABLE
  public.user_profiles,
  public.workspaces,
  public.workspace_memberships,
  public.notes,
  public.people,
  public.command_receipts,
  public.domain_events,
  public.outbox
FROM PUBLIC;
--> statement-breakpoint
DO $access$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE public.user_profiles, public.workspaces, public.workspace_memberships, public.notes, public.people, public.command_receipts, public.domain_events, public.outbox FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END;
$access$;
