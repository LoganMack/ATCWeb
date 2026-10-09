-- Captured from the live database: this was applied directly to the Supabase project (as migration 20260827203526) and never had a file in the repo.
-- Added so the repo and the database's migration history agree, and so a from-scratch rebuild reproduces it. It sits at this number because it ran between the neighbouring migrations.

-- Follow-up: the previous migration revoked EXECUTE from anon/authenticated
-- explicitly, but these 8 functions still had their original CREATE-FUNCTION-
-- time default grant to the PUBLIC pseudo-role intact, which anon and
-- authenticated both inherit from -- so the prior revoke had no real effect
-- for them. Revoking from PUBLIC directly closes the gap for real this time.
REVOKE EXECUTE ON FUNCTION public.enforce_team_roster_limits() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_role_self_escalation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.recalculate_season_scores(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_driver_car_number(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_driver_statuses() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_results_with_roster() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_rookie_status() FROM PUBLIC;

-- Re-grant to authenticated explicitly for the ones the admin panel calls as
-- the signed-in admin's own session -- revoking from PUBLIC also removes
-- authenticated's inherited access.
GRANT EXECUTE ON FUNCTION public.recalculate_season_scores(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_driver_car_number(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_driver_statuses() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_results_with_roster() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_rookie_status() TO authenticated;
