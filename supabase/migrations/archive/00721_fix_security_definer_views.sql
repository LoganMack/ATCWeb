-- Captured from the live database: this was applied directly to the Supabase project (as migration 20260827202301) and never had a file in the repo.
-- Added so the repo and the database's migration history agree, and so a from-scratch rebuild reproduces it. It sits at this number because it ran between the neighbouring migrations.

ALTER VIEW public.qualifying_results SET (security_invoker = true);
ALTER VIEW public.driver_last_race SET (security_invoker = true);
ALTER VIEW public.team_standings SET (security_invoker = true);
ALTER VIEW public.race_results SET (security_invoker = true);
ALTER VIEW public.driver_round_totals SET (security_invoker = true);
ALTER VIEW public.driver_standings SET (security_invoker = true);
