-- Undo for 20261119120000_race_incident_adjustments.sql.
--
-- Removes the re-import trigger, set_race_incidents, the adjustments table and its composite type, and puts
-- curated_race_results_shown (and round_best_laps_shown, which reads it) back exactly as
-- 20261029120000_driver_privacy_views.sql and 20261118120000_records_text_polls.sql define them.
--
-- The incident counts stay as they were last saved; only the record of the imported originals is lost.
-- Export public.race_incident_adjustments first if the originals matter.

-- 1. The trigger and its function
drop trigger if exists reapply_incident_adjustment on public.curated_race_results;
drop function if exists private.reapply_incident_adjustment();

-- 2. The write function and its type
drop function if exists public.set_race_incidents(bigint, integer, jsonb);
drop type if exists private.incident_change;

-- 3. The views (a column can't be removed with create or replace)
drop view if exists public.round_best_laps_shown;
drop view if exists public.curated_race_results_shown;

-- 4. curated_race_results_shown as 20261029120000_driver_privacy_views.sql defines it
create view public.curated_race_results_shown with (security_invoker = false, security_barrier = true) as
select
  r.subsession_id,
  r.race_number,
  case when h.name_hidden then private.hidden_cust_id(rd.id) else r.cust_id end as cust_id,
  case when h.name_hidden then 'Hidden Driver' else r.display_name end as display_name,
  r.car_name,
  r.car_class_name,
  r.finish_position,
  r.starting_position,
  r.laps_complete,
  r.laps_led,
  r.interval_ten_thousandths,
  r.average_lap_ten_thousandths,
  r.best_lap_ten_thousandths,
  r.incidents,
  r.reason_out,
  r.penalty_points,
  r.adjusted_position,
  r.created_at,
  r.updated_at,
  case when rd.id is null then null else rd.id end as roster_driver_id
from public.curated_race_results r
left join public.drivers rd on rd.iracing_cust_id = r.cust_id
left join private.hidden_drivers h on h.driver_id = rd.id;

comment on view public.curated_race_results_shown is
  'curated_race_results for pages (U4): a hidden roster driver shows as "Hidden Driver" with a stand-in cust_id.';

revoke all on table public.curated_race_results_shown from public, anon, authenticated, service_role;
grant select on table public.curated_race_results_shown to anon, authenticated, service_role;

-- 5. round_best_laps_shown as 20261118120000_records_text_polls.sql defines it
create view public.round_best_laps_shown with (security_invoker = false, security_barrier = true) as
select distinct on (r.subsession_id, s.class_id)
  r.subsession_id,
  s.class_id,
  r.best_lap_ten_thousandths,
  r.race_number,
  r.finish_position,
  r.cust_id,
  r.roster_driver_id,
  r.display_name,
  r.car_name,
  cr.track_name,
  cr.layout,
  cr.start_time
from public.curated_race_results_shown r
join public.curated_rounds cr on cr.subsession_id = r.subsession_id
left join public.race_score_results s
  on s.subsession_id = r.subsession_id
  and s.race_number = r.race_number
  and s.driver_id = r.roster_driver_id
where r.best_lap_ten_thousandths > 0
  and not exists (
    select 1 from public.round_overrides o
    where o.subsession_id = r.subsession_id and (o.is_exhibition or o.is_test)
  )
order by r.subsession_id, s.class_id, r.best_lap_ten_thousandths, r.race_number, r.finish_position;

comment on view public.round_best_laps_shown is
  'Fastest lap per round and class (class null = no scored class) from the masked race results; exhibition '
  'and test rounds and empty laps left out. Pages build track records from it.';

revoke all on table public.round_best_laps_shown from public, anon, authenticated;
grant select on table public.round_best_laps_shown to anon, authenticated;

-- 6. The adjustments table
drop table if exists public.race_incident_adjustments;
