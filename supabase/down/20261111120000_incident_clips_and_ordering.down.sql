-- Undoes 20261111120000_incident_clips_and_ordering.sql: drops the posting and clip functions and the admin
-- order, restores the previous incident_submissions body (dismissed reports listed, numbered by submission
-- time) and the previous penalties_shown, then drops the shared order and the three new columns.
-- Clips and incident turns stored since the migration are lost. Post dates kept on unposted rounds stay;
-- every reader checks posted, so they open no appeal window.

drop function public.set_incident_video(bigint, text, integer, text, text);
drop function public.set_incident_report_video(uuid, text);
drop function public.set_round_incident_posted(bigint, boolean, boolean);
drop function public.incident_report_order(bigint);

create or replace function public.incident_submissions(p_subsession_id bigint)
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

drop function private.incident_report_order(bigint);

drop view public.penalties_shown;

create view public.penalties_shown with (security_invoker = false, security_barrier = true) as
select
  p.id,
  p.subsession_id,
  p.race_number,
  p.driver_id,
  p.incident_number,
  p.lap,
  private.mask_names(
    p.description,
    (select coalesce(array_agg(h.full_name), '{}') from private.hidden_drivers h where h.name_hidden)
  ) as description,
  p.time_penalty_seconds,
  p.points_penalty,
  p.penalty_points,
  p.created_at,
  p.updated_at,
  p.is_warning,
  p.is_appealed,
  private.mask_names(
    p.appeal_result,
    (select coalesce(array_agg(h.full_name), '{}') from private.hidden_drivers h where h.name_hidden)
  ) as appeal_result,
  p.appeal_time_penalty_seconds,
  p.appeal_points_penalty,
  p.appeal_penalty_points,
  p.session_type
from public.penalties p
where (select public.is_admin())
   or exists (
     select 1 from public.round_incident_status s where s.subsession_id = p.subsession_id and s.posted
   );

comment on view public.penalties_shown is
  'penalties for pages (U4): posted rounds (all for admins); hidden drivers'' full names masked in the text.';

revoke all on table public.penalties_shown from public, anon, authenticated, service_role;
grant select on table public.penalties_shown to anon, authenticated, service_role;

alter table public.penalties
  drop constraint penalties_video_url_check,
  drop constraint penalties_turn_check,
  drop column video_url,
  drop column turn;

alter table public.incident_reports
  drop constraint incident_reports_video_url_check,
  drop column video_url;
