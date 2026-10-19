-- 0112_hide_unposted_penalties.sql
-- Penalties stay secret until stewards post the round (site audit SEC-01,
-- NFR2.1). Until now that was enforced only in page code: the select
-- policies on penalties, penalty_offense_links, penalty_involved_drivers,
-- round_penalties and race_scores were all `using (true)`, so anyone with the
-- public anon key could read an unposted round's penalties straight from
-- PostgREST. Undo script: supabase/down/0112_hide_unposted_penalties.down.sql
--
--  1. The four penalty tables: non-admins see a row only once its round is
--     posted (round_incident_status.posted). No status row = not posted.
--     Admins (is_admin()) still see everything, but only when the request
--     carries their own JWT; the app sends it on the admin paths that need
--     unposted rounds (Incident Report page, PP recompute).
--
--  2. race_scores: hiding unposted rows outright would blank the newest
--     round's results and standings until posting, and drivers report
--     incidents from that results page. So the base table gets the same
--     posted-or-admin policy, and the site reads the new view
--     race_scores_public instead. The view returns every row, but for an
--     unposted round it takes the penalty points deduction back out of
--     total_points and reports points_deduction as 0 -- exactly what the
--     results page already did in code (stripDeduction). Every other column
--     is untouched (none of them come from penalties).
--
--     The view runs as its owner (security_invoker = false) so it can read
--     the base rows; it exposes nothing the old public policy didn't, minus
--     the deduction. It is read-only for anon/authenticated (Supabase's
--     default grants would otherwise let them write through it as owner).

-- 1. Posted-or-admin select policies -------------------------------------------

drop policy if exists "public read" on public.penalties;
drop policy if exists "posted or admin read penalties" on public.penalties;
create policy "posted or admin read penalties" on public.penalties
  for select using (
    (select public.is_admin())
    or exists (
      select 1 from public.round_incident_status s
      where s.subsession_id = penalties.subsession_id and s.posted
    )
  );

drop policy if exists "public read" on public.penalty_offense_links;
drop policy if exists "posted or admin read penalty_offense_links" on public.penalty_offense_links;
create policy "posted or admin read penalty_offense_links" on public.penalty_offense_links
  for select using (
    (select public.is_admin())
    or exists (
      select 1 from public.penalties p
      join public.round_incident_status s on s.subsession_id = p.subsession_id
      where p.id = penalty_offense_links.penalty_id and s.posted
    )
  );

drop policy if exists "public read" on public.penalty_involved_drivers;
drop policy if exists "posted or admin read penalty_involved_drivers" on public.penalty_involved_drivers;
create policy "posted or admin read penalty_involved_drivers" on public.penalty_involved_drivers
  for select using (
    (select public.is_admin())
    or exists (
      select 1 from public.penalties p
      join public.round_incident_status s on s.subsession_id = p.subsession_id
      where p.id = penalty_involved_drivers.penalty_id and s.posted
    )
  );

drop policy if exists "public read round_penalties" on public.round_penalties;
drop policy if exists "posted or admin read round_penalties" on public.round_penalties;
create policy "posted or admin read round_penalties" on public.round_penalties
  for select using (
    (select public.is_admin())
    or exists (
      select 1 from public.round_incident_status s
      where s.subsession_id = round_penalties.subsession_id and s.posted
    )
  );

drop policy if exists "public read" on public.race_scores;
drop policy if exists "posted or admin read race_scores" on public.race_scores;
create policy "posted or admin read race_scores" on public.race_scores
  for select using (
    (select public.is_admin())
    or exists (
      select 1 from public.round_incident_status s
      where s.subsession_id = race_scores.subsession_id and s.posted
    )
  );

-- 2. Public race_scores view with unposted deductions stripped -----------------

create or replace view public.race_scores_public
with (security_invoker = false)
as
select
  rs.subsession_id,
  rs.race_number,
  rs.driver_id,
  rs.season_id,
  rs.class_id,
  rs.team_id,
  rs.finish_points,
  rs.class_points,
  rs.finesse_bonus,
  rs.pole_bonus,
  case when v.penalties_visible then rs.points_deduction else 0 end as points_deduction,
  rs.scored_position,
  rs.classified,
  rs.dsq,
  rs.source,
  rs.aggression_bonus,
  rs.lap_led_bonus,
  rs.fewest_incidents_bonus,
  rs.fastest_lap_bonus,
  rs.sprint_sweep_bonus,
  case when v.penalties_visible then rs.total_points else rs.total_points - rs.points_deduction end as total_points
from public.race_scores rs
cross join lateral (
  select
    (select public.is_admin())
    or exists (
      select 1 from public.round_incident_status s
      where s.subsession_id = rs.subsession_id and s.posted
    ) as penalties_visible
) v;

comment on view public.race_scores_public is
  'race_scores for public pages: every row, but an unposted round''s penalty deduction is removed (0112).';

revoke all on public.race_scores_public from public, anon, authenticated;
grant select on public.race_scores_public to anon, authenticated, service_role;
