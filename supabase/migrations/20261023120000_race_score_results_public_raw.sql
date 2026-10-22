-- Raw columns on race_score_results_public (unit scoring-ownership, BR4.1, BR4.2; follows 20261022120000).
--
-- What: replaces the view with the same columns, in the same order, plus three at the end:
-- raw_class_position, raw_overall_total and raw_class_total. (raw_position is already there.)
-- Every existing column, the security_invoker = false option, the comment and the grants stay as
-- 20261021120000 created them.
--
-- Why: after the switch the results page shows a "Penalty Adjustment" line (the shown total less
-- the total before this round's penalties) and the incident page a points delta per penalty. Both
-- need the raw totals, which the view did not expose. The raw set is what every reader sees until a
-- round is posted, so exposing it hides nothing: before posting it equals the shown set for
-- non-admins, and after posting the penalties are public.
--
-- Order: this must reach production before the scoring-switch code deploys, because that code
-- selects these columns. Applying it changes no live page (nothing reads them yet).
--
-- Undo: supabase/down/20261023120000_race_score_results_public_raw.down.sql drops and recreates the
-- view without the three columns. Run it only while no deployed code selects them.

create or replace view public.race_score_results_public with (security_invoker = false) as
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
  r.scored_at,
  r.raw_class_position,
  r.raw_overall_total,
  r.raw_class_total
from public.race_score_results r
cross join lateral (
  select (
    (select public.is_admin())
    or exists (select 1 from public.round_incident_status s where s.subsession_id = r.subsession_id and s.posted)
  ) as final_visible
) v;

comment on view public.race_score_results_public is
  'race_score_results for pages: the final set for admins and posted rounds, otherwise the raw set (no deduction, not penalised). The raw_ columns are always the raw set.';

-- create or replace keeps the grants; restated so the file stands on its own.
revoke all on table public.race_score_results_public from public, anon, authenticated, service_role;
grant select on table public.race_score_results_public to anon, authenticated, service_role;
