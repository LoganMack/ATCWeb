-- 0102_security_advisor_fixes.sql
-- Clears the Supabase security-advisor warnings that can be fixed without changing behaviour.
-- What's left on purpose (not fixable without a design change): the signed-in-callable admin RPCs
-- (admin_*, approve/reject_signup_request, recalculate_season_scores, set_driver_car_number,
-- sync_*, submit_kudos, save_incident_report_review, incident_report_review_counts) and the
-- anonymous submit_incident_report / submit_incident_appeal. Each is meant to be called through
-- the REST API and checks its caller inside.

-- 1. Pin the search_path on the one trigger function that had none.
alter function public.stamp_incident_report_reviews_closed() set search_path = public;

-- 2. Admin-only RPCs: anonymous callers never need them (the app calls them with the signed-in admin's own token).
revoke execute on function public.save_incident_report_review(uuid, jsonb, text) from public, anon;
grant execute on function public.save_incident_report_review(uuid, jsonb, text) to authenticated;
revoke execute on function public.incident_report_review_counts(bigint) from public, anon;
grant execute on function public.incident_report_review_counts(bigint) to authenticated;

-- 3. RLS helper functions. Policies call these as the querying role, so anon/authenticated must be able to
--    execute them, but they don't belong in the API-exposed `public` schema as SECURITY DEFINER. The privileged
--    body moves to a private schema (not exposed through the REST API) and a SECURITY INVOKER wrapper keeps the
--    old name, so the ~150 policies that reference public.is_admin() etc. keep working untouched (CREATE OR
--    REPLACE keeps each function's identity).
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function private.has_reviewed_incident_report(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from incident_report_reviews
    where report_id = p_report_id and reviewer_id = auth.uid()
  );
$$;

create or replace function private.is_involved_in_incident_report(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from incident_report_drivers ird
    join profiles p on p.driver_id = ird.driver_id
    where ird.report_id = p_report_id and p.id = auth.uid()
  );
$$;

revoke all on function private.is_admin() from public;
revoke all on function private.has_reviewed_incident_report(uuid) from public;
revoke all on function private.is_involved_in_incident_report(uuid) from public;
grant execute on function private.is_admin() to anon, authenticated, service_role;
grant execute on function private.has_reviewed_incident_report(uuid) to anon, authenticated, service_role;
grant execute on function private.is_involved_in_incident_report(uuid) to anon, authenticated, service_role;

create or replace function public.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$ select private.is_admin(); $$;

create or replace function public.has_reviewed_incident_report(p_report_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$ select private.has_reviewed_incident_report(p_report_id); $$;

create or replace function public.is_involved_in_incident_report(p_report_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$ select private.is_involved_in_incident_report(p_report_id); $$;
