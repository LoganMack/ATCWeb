-- Undoes 20261115120000_appeal_close_and_comments.sql: drops the comment and close functions, the lock
-- trigger and the involvement helper, the comments table and the new columns, and restores the previous
-- private.scoring_on_penalties (copied verbatim from 20261021120000_race_score_results_expand.sql) and the
-- previous penalties_shown (copied verbatim from 20261111120000_incident_clips_and_ordering.sql).
--
-- Steward comments, each closed appeal's decision record and every appealed warning flag are lost; closed
-- appeals stay reviewed. A penalty whose appeal removed or added a warning shows its original flag again.
-- Revert the site code first, so nothing reads appeal_is_warning or calls the dropped functions.

drop function public.incident_appeal_comments_for_round(bigint);
drop function public.save_incident_appeal_comment(uuid, text);
drop function public.close_incident_appeal(uuid, numeric, integer, integer, boolean, text);

drop trigger incident_appeals_lock on public.incident_appeals;
drop function private.incident_appeals_lock();

drop table public.incident_appeal_comments;

drop function private.is_involved_in_appeal(uuid);

create or replace function private.scoring_on_penalties() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v bigint[];
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    v := array(select distinct n.subsession_id from new_rows n);
  elsif tg_op = 'DELETE' then
    v := array(select distinct o.subsession_id from old_rows o);
  else
    v := array(
      select distinct d.subsession_id from (
        (select n.subsession_id, n.race_number, n.session_type, n.driver_id, n.time_penalty_seconds, n.points_penalty,
                n.is_appealed, n.appeal_time_penalty_seconds, n.appeal_points_penalty, n.is_warning from new_rows n
         except
         select o.subsession_id, o.race_number, o.session_type, o.driver_id, o.time_penalty_seconds, o.points_penalty,
                o.is_appealed, o.appeal_time_penalty_seconds, o.appeal_points_penalty, o.is_warning from old_rows o)
        union all
        (select o.subsession_id, o.race_number, o.session_type, o.driver_id, o.time_penalty_seconds, o.points_penalty,
                o.is_appealed, o.appeal_time_penalty_seconds, o.appeal_points_penalty, o.is_warning from old_rows o
         except
         select n.subsession_id, n.race_number, n.session_type, n.driver_id, n.time_penalty_seconds, n.points_penalty,
                n.is_appealed, n.appeal_time_penalty_seconds, n.appeal_points_penalty, n.is_warning from new_rows n)
      ) d);
  end if;
  perform private.scoring_rescore(v);
  return null;
end;
$$;

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
  p.session_type,
  p.turn,
  p.video_url
from public.penalties p
where (select public.is_admin())
   or exists (
     select 1 from public.round_incident_status s where s.subsession_id = p.subsession_id and s.posted
   );

comment on view public.penalties_shown is
  'penalties for pages (U4): posted rounds (all for admins); hidden drivers'' full names masked in the text.';

revoke all on table public.penalties_shown from public, anon, authenticated, service_role;
grant select on table public.penalties_shown to anon, authenticated, service_role;

alter table public.penalties drop column appeal_is_warning;

drop index public.incident_appeals_closed_by_idx;

alter table public.incident_appeals
  drop constraint incident_appeals_close_values_check,
  drop constraint incident_appeals_close_fields_check,
  drop column decided_is_warning,
  drop column decided_penalty_points,
  drop column decided_points_penalty,
  drop column decided_time_penalty_seconds,
  drop column close_comment,
  drop column closed_by,
  drop column closed_at;
