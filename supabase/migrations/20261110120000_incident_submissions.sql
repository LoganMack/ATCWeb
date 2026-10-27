-- Public Incident Submissions list (incident-submissions-page).
--
-- What: incident_submissions(p_subsession_id) lists an unposted round's incident reports for everyone,
-- anonymous visitors included, so the round's "Incident Submissions" page can show what has been reported
-- before the stewards post their decisions. Each row carries only the report id, its number in the round
-- (by submission time), its session, its lap and the involved cars' numbers. Once the round is posted the
-- function returns nothing: the posted Incident Report takes over.
--
-- Why in the database: incident_reports and incident_report_drivers stay readable only by admins and the
-- reporter, so nothing about a report's description, reporter, turn, status, dismissal or reviews can
-- reach the public API. Dismissed and logged reports are listed like open ones, because dropping them
-- would show the decision before posting. Car numbers are already public on the roster.
--
-- Expand only: a new function that nothing on main calls. Undo with
-- supabase/down/20261110120000_incident_submissions.down.sql.

create function public.incident_submissions(p_subsession_id bigint)
  returns table (id uuid, submission_number integer, session text, lap integer, involved_cars text[])
  language sql stable security definer
  set search_path = ''
  as $$
  select
    r.id,
    (row_number() over (order by r.created_at, r.id))::integer as submission_number,
    r.session,
    r.lap,
    array(
      select d.car_number::text
      from public.incident_report_drivers x
      join public.drivers d on d.id = x.driver_id
      where x.report_id = r.id and d.car_number is not null
      order by d.car_number
    ) as involved_cars
  from public.incident_reports r
  where r.subsession_id = p_subsession_id
    and not exists (
      select 1 from public.round_incident_status s where s.subsession_id = r.subsession_id and s.posted
    )
  order by r.created_at, r.id;
$$;

comment on function public.incident_submissions(bigint) is
  'An unposted round''s incident reports for the public Incident Submissions page: id, number, session, lap '
  'and involved car numbers only. Empty once the round is posted.';

revoke all on function public.incident_submissions(bigint) from public;
grant execute on function public.incident_submissions(bigint) to anon, authenticated, service_role;
