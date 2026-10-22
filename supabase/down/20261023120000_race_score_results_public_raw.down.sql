-- Down script for 20261023120000_race_score_results_public_raw.sql.
--
-- Restores race_score_results_public exactly as 20261021120000_race_score_results_expand.sql created
-- it, without raw_class_position, raw_overall_total and raw_class_total. A view cannot lose columns
-- through create or replace, so it is dropped and recreated, with its comment and grants. Run it
-- only while no deployed code selects those columns (the scoring-switch code does).

drop view public.race_score_results_public;

-- Runs as its owner on purpose, like race_scores_public: the base table grants nothing to anon or
-- authenticated, so this view is the only public path, and it chooses the set per reader.
create view public.race_score_results_public with (security_invoker = false) as
select
  r.subsession_id,
  r.race_number,
  r.driver_id,
  r.season_id,
  r.class_id,
  r.team_id,
  r.finish_position,
  r.classified,
  r.dsq,
  r.raw_position,
  case when v.final_visible then 'final' else 'raw' end as shown_set,
  case when v.final_visible then r.final_position else r.raw_position end as shown_position,
  case when v.final_visible then r.final_class_position else r.raw_class_position end as shown_class_position,
  case when v.final_visible then r.final_laps_down else r.raw_laps_down end as shown_laps_down,
  case when v.final_visible then r.final_gap_ms else r.raw_gap_ms end as shown_gap_ms,
  case when v.final_visible then r.final_race_time_ms else r.raw_race_time_ms end as shown_race_time_ms,
  case when v.final_visible then r.final_finish_points else r.raw_finish_points end as shown_finish_points,
  case when v.final_visible then r.final_class_points else r.raw_class_points end as shown_class_points,
  case when v.final_visible then r.final_finesse_bonus else r.raw_finesse_bonus end as shown_finesse_bonus,
  case when v.final_visible then r.final_pole_bonus else r.raw_pole_bonus end as shown_pole_bonus,
  case when v.final_visible then r.final_aggression_bonus else r.raw_aggression_bonus end as shown_aggression_bonus,
  case when v.final_visible then r.final_lap_led_bonus else r.raw_lap_led_bonus end as shown_lap_led_bonus,
  case when v.final_visible then r.final_fewest_incidents_bonus else r.raw_fewest_incidents_bonus end as shown_fewest_incidents_bonus,
  case when v.final_visible then r.final_fastest_lap_bonus else r.raw_fastest_lap_bonus end as shown_fastest_lap_bonus,
  case when v.final_visible then r.final_sprint_sweep_bonus else r.raw_sprint_sweep_bonus end as shown_sprint_sweep_bonus,
  case when v.final_visible then r.final_points_deduction else 0 end as shown_points_deduction,
  case when v.final_visible then r.final_overall_total else r.raw_overall_total end as shown_overall_total,
  case when v.final_visible then r.final_class_total else r.raw_class_total end as shown_class_total,
  case when v.final_visible then r.penalised else false end as shown_penalised,
  r.scored_at
from public.race_score_results r
cross join lateral (
  select (
    (select public.is_admin())
    or exists (select 1 from public.round_incident_status s where s.subsession_id = r.subsession_id and s.posted)
  ) as final_visible
) v;

comment on view public.race_score_results_public is
  'race_score_results for pages: the final set for admins and posted rounds, otherwise the raw set (no deduction, not penalised).';

revoke all on table public.race_score_results_public from public, anon, authenticated, service_role;
grant select on table public.race_score_results_public to anon, authenticated, service_role;
