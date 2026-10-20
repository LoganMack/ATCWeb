-- Captured from the live database: this was applied directly to the Supabase project (as migration 20260827203359) and never had a file in the repo.
-- Added so the repo and the database's migration history agree, and so a from-scratch rebuild reproduces it. It sits at this number because it ran between the neighbouring migrations.

-- Function Search Path Mutable
ALTER FUNCTION public.set_updated_at() SET search_path = public;
ALTER FUNCTION public.set_driver_audit_fields() SET search_path = public;

-- Trigger-only functions: never legitimately called via RPC
REVOKE EXECUTE ON FUNCTION public.enforce_team_roster_limits() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_role_self_escalation() FROM anon, authenticated;

-- Internal-only / SQL-editor-only maintenance functions: app never calls these via RPC
REVOKE EXECUTE ON FUNCTION public.recalculate_race_scores(bigint) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.relink_drivers_from_results() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.relink_rounds_to_seasons() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.renumber_season_rounds(uuid) FROM anon, authenticated;

-- Admin-only RPCs the app calls as the signed-in admin's own session (role
-- `authenticated`) -- anon never needs these; closes a real gap on
-- recalculate_season_scores where anon could bypass its own admin check
REVOKE EXECUTE ON FUNCTION public.recalculate_season_scores(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_driver_car_number(uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.sync_driver_statuses() FROM anon;
REVOKE EXECUTE ON FUNCTION public.sync_results_with_roster() FROM anon;
REVOKE EXECUTE ON FUNCTION public.sync_rookie_status() FROM anon;
