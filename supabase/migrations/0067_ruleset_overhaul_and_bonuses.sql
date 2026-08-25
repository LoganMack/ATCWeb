-- Ruleset admin overhaul + new bonus points + class-pole season-scoping fix.
-- Covers Logan's Aug 25 request:
--   1. Every bonus (existing + new) gets an explicit enabled/disabled flag.
--   2. A third sprint-race points table (sprint_race3), same shape as the
--      existing sprint_race2.
--   3/4. scoring_rulesets drops notes/rulebook entirely, can_drop_final_round
--      defaults to true for new rows (existing rows left exactly as-is —
--      confirmed with Logan).
--   5. Four new bonuses: lap_led, fewest_incidents, fastest_lap,
--      sprint_sweep — all disabled by default (they don't exist in any
--      ruleset's JSON yet, and the scoring function now requires an explicit
--      enabled:true, so they simply don't fire until an admin turns them on
--      from the new UI).
--   6. Incident-limit config lives entirely in `rules` JSON
--      (round_incident_limit.sprint/endurance + race_overrides.incident_limit
--      for special events) — informational only, never read by this
--      function. Left to the app layer (results.ts/[subsessionId].astro).
--   7. Fixes the class-pole bug: the `pole` CTE was partitioning qualifying
--      results by `d.class_id` (the driver's CURRENT class straight off the
--      drivers table) instead of the season-correct class every other part
--      of this function already resolves (driver_season_classes override,
--      falling back to the highest class actually available that season —
--      see 0058_class_season_fallback_fix.sql). Confirmed live: e.g.
--      subsession 37324062 (ATC1, a season with only Alpha) awarded
--      pole_bonus to BOTH Wiley Cox and Murphy Nichols in the same race,
--      because they're Delta and Gamma today and got split into different
--      class partitions that didn't even exist in ATC1 — only one Alpha
--      pole should ever have been awarded. New `qual_entrant` CTE mirrors
--      `entrant`'s exact class-resolution logic, applied to
--      curated_qualifying instead (a driver can appear in qualifying without
--      a race_results row, so this can't just reuse `entrant`).
--
-- IMPORTANT: this migration only changes what a FUTURE recalculation
-- produces. A companion step (run right after this migration, from the
-- Admin UI or a one-off script) re-runs recalculate_race_scores() for every
-- official round so the class-pole fix and new bonus columns actually
-- populate existing race_scores rows — see the chat for that step.

begin;

-- ---------------------------------------------------------------------------
-- 1. scoring_rulesets: drop notes/rulebook, default can_drop_final_round
-- ---------------------------------------------------------------------------
alter table public.scoring_rulesets drop column if exists notes;
alter table public.scoring_rulesets drop column if exists rulebook;
alter table public.scoring_rulesets alter column can_drop_final_round set default true;

-- ---------------------------------------------------------------------------
-- 2. race_scores: add the four new bonus columns and regenerate total_points
--    to include them. total_points is a GENERATED column, and Postgres has
--    no ALTER COLUMN ... for a generation expression — it has to be dropped
--    and re-added. driver_round_totals (sum(rs.total_points)) and
--    driver_standings (built on driver_round_totals) both transitively
--    depend on it, so they're dropped and recreated verbatim around the
--    column swap. team_standings does NOT depend on total_points (it
--    computes its own bespoke team-points formula straight from
--    finish_points/finesse_bonus/pole_bonus/points_deduction/class_points,
--    deliberately excluding aggression_bonus already) — left completely
--    untouched, so team scoring's existing exclusion of "individual
--    achievement" bonuses is preserved for these four new ones too rather
--    than guessed at.
-- ---------------------------------------------------------------------------

drop view if exists public.driver_standings;
drop view if exists public.driver_round_totals;

alter table public.race_scores drop column if exists total_points;

alter table public.race_scores
  add column if not exists lap_led_bonus integer not null default 0,
  add column if not exists fewest_incidents_bonus integer not null default 0,
  add column if not exists fastest_lap_bonus integer not null default 0,
  add column if not exists sprint_sweep_bonus integer not null default 0;

alter table public.race_scores
  add column total_points integer generated always as (
    finish_points + class_points + finesse_bonus + pole_bonus + aggression_bonus +
    lap_led_bonus + fewest_incidents_bonus + fastest_lap_bonus + sprint_sweep_bonus +
    points_deduction
  ) stored;

comment on column public.race_scores.lap_led_bonus is 'New bonus (Aug 2026): awarded when this driver led at least one lap in this race. Race-scoped only (rules.bonuses.lap_led has no per field). Zero unless rules.bonuses.lap_led.enabled is true.';
comment on column public.race_scores.fewest_incidents_bonus is 'New bonus (Aug 2026): awarded to whoever has the fewest incidents among drivers finishing in the top rules.bonuses.fewest_incidents.top_x — scoped per race or per round per rules.bonuses.fewest_incidents.per. Round-scoped awards land on race_number 1 only, same convention as pole_bonus. Zero unless enabled.';
comment on column public.race_scores.fastest_lap_bonus is 'New bonus (Aug 2026): awarded to whoever set the fastest single lap among drivers finishing in the top rules.bonuses.fastest_lap.top_x — scoped per race or per round per rules.bonuses.fastest_lap.per. Round-scoped awards land on race_number 1 only. Zero unless enabled.';
comment on column public.race_scores.sprint_sweep_bonus is 'New bonus (Aug 2026): awarded once (on race_number 1) when a driver wins every race of a sprint round with 2+ races. Zero unless rules.bonuses.sprint_sweep.enabled is true.';

-- Recreated verbatim from before this migration (pg_get_viewdef, captured
-- 2026-08-25) — no logic changes, they just now sum/reference the enriched
-- total_points automatically.
create view public.driver_round_totals as
 SELECT rs.season_id,
    rs.driver_id,
    rs.subsession_id,
    cr.round_number,
    max(rs.class_id) AS class_id,
    max(rs.team_id::text)::uuid AS team_id,
    sum(rs.total_points) AS round_points,
    min(rs.scored_position) AS best_position,
    bool_or(rs.dsq) AS dsq,
    bool_or(rs.dsq) OR sum(rs.points_deduction) < 0 AS drop_locked
   FROM race_scores rs
     JOIN curated_rounds cr ON cr.subsession_id = rs.subsession_id
  WHERE cr.status = 'official'::text
  GROUP BY rs.season_id, rs.driver_id, rs.subsession_id, cr.round_number;

create view public.driver_standings as
 WITH participant AS (
         SELECT DISTINCT driver_round_totals.season_id,
            driver_round_totals.driver_id
           FROM driver_round_totals
        ), season_round AS (
         SELECT curated_rounds.season_id,
            curated_rounds.subsession_id,
            curated_rounds.round_number
           FROM curated_rounds
          WHERE curated_rounds.status = 'official'::text AND curated_rounds.season_id IS NOT NULL
        ), grid AS (
         SELECT p.season_id,
            p.driver_id,
            r.subsession_id,
            r.round_number
           FROM participant p
             JOIN season_round r USING (season_id)
        ), filled AS (
         SELECT g.season_id,
            g.driver_id,
            g.subsession_id,
            g.round_number,
            COALESCE(t.round_points, 0::bigint) AS round_points,
            COALESCE(t.drop_locked, false) AS drop_locked,
            t.driver_id IS NOT NULL AS started
           FROM grid g
             LEFT JOIN driver_round_totals t ON t.season_id = g.season_id AND t.driver_id = g.driver_id AND t.subsession_id = g.subsession_id
        ), allowance AS (
         SELECT s.id AS season_id,
            (((r.rules -> 'drops'::text) ->> 'base'::text)::integer) + s.extra_drop_weeks AS drop_count
           FROM seasons s
             LEFT JOIN scoring_rulesets r ON r.id = s.scoring_ruleset_id
        ), ranked AS (
         SELECT f.season_id,
            f.driver_id,
            f.subsession_id,
            f.round_number,
            f.round_points,
            f.drop_locked,
            f.started,
                CASE
                    WHEN f.drop_locked THEN NULL::bigint
                    ELSE row_number() OVER (PARTITION BY f.season_id, f.driver_id, f.drop_locked ORDER BY f.round_points, f.round_number)
                END AS drop_order
           FROM filled f
        ), counted AS (
         SELECT r.season_id,
            r.driver_id,
            r.subsession_id,
            r.round_number,
            r.round_points,
            r.drop_locked,
            r.started,
            r.drop_order,
            NOT r.drop_locked AND r.drop_order <= COALESCE(a.drop_count, 0) AS dropped
           FROM ranked r
             LEFT JOIN allowance a USING (season_id)
        ), class_result AS (
         SELECT t.season_id,
            t.driver_id,
            t.class_id,
            t.subsession_id,
            row_number() OVER (PARTITION BY t.season_id, t.subsession_id, t.class_id ORDER BY t.best_position) AS class_finish
           FROM driver_round_totals t
        ), current_class AS (
         SELECT DISTINCT ON (t.season_id, t.driver_id) t.season_id,
            t.driver_id,
            t.class_id,
            t.team_id
           FROM driver_round_totals t
             JOIN curated_rounds cr_1 ON cr_1.subsession_id = t.subsession_id
          ORDER BY t.season_id, t.driver_id, cr_1.start_time DESC
        )
 SELECT c.season_id,
    c.driver_id,
    d.name AS driver_name,
    d.car_number,
    cc.class_id,
    dc.name AS class_name,
    cc.team_id,
    sum(c.round_points) FILTER (WHERE NOT c.dropped) AS points,
    sum(c.round_points) AS points_before_drops,
    count(*) FILTER (WHERE c.started) AS starts,
    count(*) FILTER (WHERE c.dropped) AS dropped_rounds,
    count(*) FILTER (WHERE cr.class_finish = 1) AS wins,
    count(*) FILTER (WHERE cr.class_finish <= 3) AS podiums,
    count(*) FILTER (WHERE cr.class_finish <= 5) AS top_fives,
    min(cr.class_finish) AS best_finish,
    round(avg(cr.class_finish), 2) AS average_finish,
    rank() OVER (PARTITION BY c.season_id, cc.class_id ORDER BY (sum(c.round_points) FILTER (WHERE NOT c.dropped)) DESC, (count(*) FILTER (WHERE cr.class_finish = 1)) DESC, (count(*) FILTER (WHERE cr.class_finish <= 3)) DESC, (count(*) FILTER (WHERE cr.class_finish <= 5)) DESC, d.name) AS "position"
   FROM counted c
     JOIN drivers d ON d.id = c.driver_id
     JOIN current_class cc ON cc.season_id = c.season_id AND cc.driver_id = c.driver_id
     JOIN driver_classes dc ON dc.id = cc.class_id
     LEFT JOIN class_result cr ON cr.season_id = c.season_id AND cr.driver_id = c.driver_id AND cr.subsession_id = c.subsession_id
  GROUP BY c.season_id, c.driver_id, d.name, d.car_number, cc.class_id, dc.name, cc.team_id;

-- ---------------------------------------------------------------------------
-- 3. Backfill enabled:true onto every EXISTING bonus already configured on
--    a live ruleset, so requiring an explicit enabled flag (below) doesn't
--    silently zero out sublime_finesse/class_pole/naked_aggression for
--    every season currently scoring with them. Confirmed against live data
--    first: not every ruleset has all three (e.g. "ATC 17-18" has
--    class_pole+sublime_finesse but no naked_aggression; ATC12/13/15/16
--    have sublime_finesse+naked_aggression but no class_pole), so each
--    UPDATE is individually WHERE-guarded to only touch a ruleset that
--    already has that specific bonus object.
--
--    NOTE ON create_missing: jsonb_set's 4th arg means "only replace an
--    existing value, never add a new key at all" when false — it is NOT
--    "create intermediate objects but not the leaf," which was this
--    migration's original (wrong) assumption on first run against
--    production; that version was a complete no-op and had to be corrected
--    by hand. create_missing=true is safe here specifically because the
--    WHERE guard on each UPDATE already proves the parent bonus object
--    exists, so it can only ever add the 'enabled' leaf to it — it can't
--    fabricate a whole new bonus object with no point values, since the
--    WHERE clause excludes rows where that would happen.
update public.scoring_rulesets
set rules = jsonb_set(rules, '{bonuses,sublime_finesse,enabled}', 'true'::jsonb, true)
where rules->'bonuses'->'sublime_finesse' is not null;

update public.scoring_rulesets
set rules = jsonb_set(rules, '{bonuses,class_pole,enabled}', 'true'::jsonb, true)
where rules->'bonuses'->'class_pole' is not null;

update public.scoring_rulesets
set rules = jsonb_set(rules, '{bonuses,naked_aggression,enabled}', 'true'::jsonb, true)
where rules->'bonuses'->'naked_aggression' is not null;

-- ---------------------------------------------------------------------------
-- 4. recalculate_race_scores(): class-pole fix, enabled-gated bonuses,
--    4 new bonuses, sprint_race3.
-- ---------------------------------------------------------------------------
create or replace function public.recalculate_race_scores(p_subsession_id bigint)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_round      record;
  v_rules      jsonb;
  v_ruleset_id uuid;
  v_written    int;
  v_override_active boolean;
  v_gamma_enabled boolean;
  v_delta_enabled boolean;
  v_fallback_class_id integer;
  v_sublime_finesse_enabled boolean;
  v_class_pole_enabled boolean;
  v_naked_aggression_enabled boolean;
  v_lap_led_enabled boolean;
  v_fewest_incidents_enabled boolean;
  v_fewest_incidents_top_x integer;
  v_fewest_incidents_per text;
  v_fastest_lap_enabled boolean;
  v_fastest_lap_top_x integer;
  v_fastest_lap_per text;
  v_sprint_sweep_enabled boolean;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can recalculate scores'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_round from public.curated_rounds where subsession_id = p_subsession_id;
  if not found then
    raise exception 'No such round: %', p_subsession_id;
  end if;

  if v_round.season_id is not null then
    perform pg_advisory_xact_lock(hashtext(v_round.season_id::text));
  end if;

  if exists (select 1 from public.seasons
             where id = v_round.season_id and standings_locked_at is not null) then
    raise exception 'Season standings are locked; unlock the season to rescore'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  delete from public.race_scores where subsession_id = p_subsession_id;

  if v_round.status <> 'official' then
    return 0;
  end if;

  if v_round.season_id is null then
    raise exception 'Round % is not linked to a season', p_subsession_id;
  end if;
  if v_round.format is null then
    raise exception 'Round % has no format; scoring cannot pick a points table',
      p_subsession_id;
  end if;

  select s.scoring_ruleset_id, r.rules, s.gamma_enabled, s.delta_enabled
  into v_ruleset_id, v_rules, v_gamma_enabled, v_delta_enabled
  from public.seasons s
  join public.scoring_rulesets r on r.id = s.scoring_ruleset_id
  where s.id = v_round.season_id;

  if v_rules is null then
    raise exception 'Season % has no scoring ruleset', v_round.season_id;
  end if;

  if v_rules->'base_points'->v_round.format is null then
    raise exception 'Ruleset % has no base_points for format %', v_ruleset_id, v_round.format;
  end if;
  if v_rules->'classified_minimum'->>v_round.format is null then
    raise exception 'Ruleset % has no classified_minimum for format %', v_ruleset_id, v_round.format;
  end if;

  select exists (
    select 1
    from jsonb_array_elements_text(coalesce(v_rules->'race_overrides'->'subsession_ids', '[]'::jsonb)) sid
    where sid = p_subsession_id::text
  ) into v_override_active;

  v_sublime_finesse_enabled := coalesce((v_rules->'bonuses'->'sublime_finesse'->>'enabled')::boolean, false);
  v_class_pole_enabled := coalesce((v_rules->'bonuses'->'class_pole'->>'enabled')::boolean, false);
  v_naked_aggression_enabled := coalesce((v_rules->'bonuses'->'naked_aggression'->>'enabled')::boolean, false);
  v_lap_led_enabled := coalesce((v_rules->'bonuses'->'lap_led'->>'enabled')::boolean, false);
  v_fewest_incidents_enabled := coalesce((v_rules->'bonuses'->'fewest_incidents'->>'enabled')::boolean, false);
  v_fewest_incidents_top_x := coalesce((v_rules->'bonuses'->'fewest_incidents'->>'top_x')::integer, 0);
  v_fewest_incidents_per := coalesce(v_rules->'bonuses'->'fewest_incidents'->>'per', 'race');
  v_fastest_lap_enabled := coalesce((v_rules->'bonuses'->'fastest_lap'->>'enabled')::boolean, false);
  v_fastest_lap_top_x := coalesce((v_rules->'bonuses'->'fastest_lap'->>'top_x')::integer, 0);
  v_fastest_lap_per := coalesce(v_rules->'bonuses'->'fastest_lap'->>'per', 'race');
  v_sprint_sweep_enabled := coalesce((v_rules->'bonuses'->'sprint_sweep'->>'enabled')::boolean, false);

  -- Highest-tier class actually available this season. Alpha always
  -- qualifies (no *_enabled column — it's never been opt-in); Gamma/Delta
  -- only if this season has them switched on.
  select dc.id into v_fallback_class_id
  from public.driver_classes dc
  where dc.name = 'Alpha'
     or (dc.name = 'Gamma' and v_gamma_enabled)
     or (dc.name = 'Delta' and v_delta_enabled)
  order by dc.sort_order
  limit 1;

  with
  entrant as (
    select
      rr.race_number,
      rr.cust_id,
      d.id        as driver_id,
      ec.class_id as class_id,
      tr.team_id as team_id,
      d.name      as driver_name,
      dc.name     as class_name,
      coalesce(rr.adjusted_position, rr.finish_position) as position,
      rr.starting_position,
      rr.laps_complete,
      rr.laps_led,
      rr.best_lap_ten_thousandths,
      rr.incidents
    from public.curated_race_results rr
    join public.drivers d        on d.iracing_cust_id = rr.cust_id
    left join public.driver_season_classes dsc
      on dsc.driver_id = d.id and dsc.season_id = v_round.season_id
    left join public.team_rosters tr
      on tr.driver_id = d.id and tr.season_id = v_round.season_id
    join public.driver_classes dcur on dcur.id = d.class_id
    cross join lateral (
      -- An explicit per-season override always wins. Otherwise, the
      -- driver's current class — UNLESS that class isn't available in
      -- this season at all, in which case fall back to the highest class
      -- that is (see v_fallback_class_id above), not silently to a class
      -- that didn't exist yet.
      select coalesce(
        dsc.class_id,
        case
          when dcur.name = 'Gamma' and not v_gamma_enabled then v_fallback_class_id
          when dcur.name = 'Delta' and not v_delta_enabled then v_fallback_class_id
          else d.class_id
        end
      ) as class_id
    ) ec
    join public.driver_classes dc on dc.id = ec.class_id
    where rr.subsession_id = p_subsession_id
  ),
  -- Same class-resolution shape as `entrant` above, applied to
  -- curated_qualifying instead — a driver can appear in qualifying without
  -- ever having a curated_race_results row (e.g. DNS), so this can't just
  -- reuse `entrant`. This is the fix for the class-pole bug: `pole` below
  -- now partitions by THIS season-correct class, not the driver's raw
  -- current drivers.class_id.
  qual_entrant as (
    select
      cq.cust_id,
      coalesce(
        dsc.class_id,
        case
          when dcur.name = 'Gamma' and not v_gamma_enabled then v_fallback_class_id
          when dcur.name = 'Delta' and not v_delta_enabled then v_fallback_class_id
          else d.class_id
        end
      ) as class_id
    from public.curated_qualifying cq
    join public.drivers d on d.iracing_cust_id = cq.cust_id
    left join public.driver_season_classes dsc
      on dsc.driver_id = d.id and dsc.season_id = v_round.season_id
    join public.driver_classes dcur on dcur.id = d.class_id
    where cq.subsession_id = p_subsession_id
  ),
  distance as (
    select race_number, max(laps_complete) as leader_laps
    from public.curated_race_results
    where subsession_id = p_subsession_id
    group by race_number
  ),
  dsqd as (
    select distinct cust_id
    from public.curated_race_results
    where subsession_id = p_subsession_id
      and reason_out in ('Disqualified', 'DQ/Scoring Invalidated')
  ),
  deduction as (
    select
      p.race_number,
      d.iracing_cust_id as cust_id,
      sum(case when p.is_appealed then p.appeal_points_penalty else p.points_penalty end) as points_deduction
    from public.penalties p
    join public.drivers d on d.id = p.driver_id
    where p.subsession_id = p_subsession_id
    group by p.race_number, d.iracing_cust_id
  ),
  classified as (
    select
      e.*,
      (d.leader_laps > 0
        and coalesce(e.laps_complete, 0) >= d.leader_laps * 0.5) as is_classified
    from entrant e
    join distance d using (race_number)
  ),
  class_rank as (
    select
      c.race_number, c.cust_id,
      (row_number() over (
        partition by c.race_number, c.class_id
        order by c.position
      ))::int as class_position
    from classified c
    where c.is_classified
  ),
  pole as (
    select q.cust_id
    from (
      select
        cq.cust_id,
        row_number() over (partition by qe.class_id order by cq.qual_position) as rn
      from public.curated_qualifying cq
      join qual_entrant qe on qe.cust_id = cq.cust_id
      where cq.subsession_id = p_subsession_id
    ) q
    where q.rn = 1
  ),
  net_gain as (
    select
      c.race_number,
      c.cust_id,
      (c.starting_position - c.position) as gain
    from classified c
    where c.is_classified
      and c.starting_position is not null
      and c.cust_id not in (select cust_id from dsqd)
  ),
  best_gain_per_race as (
    select race_number, max(gain) as best_gain
    from net_gain
    group by race_number
  ),
  aggression as (
    select ng.race_number, ng.cust_id
    from net_gain ng
    join best_gain_per_race b
      on b.race_number = ng.race_number and b.best_gain = ng.gain
    where b.best_gain > 0
  ),
  -- Lap led (new, Aug 2026): race-scoped only — every classified,
  -- non-DSQ'd driver who led >=1 lap in that specific race.
  lap_led_race as (
    select c.race_number, c.cust_id
    from classified c
    where c.is_classified
      and c.cust_id not in (select cust_id from dsqd)
      and coalesce(c.laps_led, 0) > 0
  ),
  -- Fewest incidents / fastest lap (new, Aug 2026) — race scope: eligible
  -- pool is classified, non-DSQ'd drivers finishing within the top_x
  -- overall positions of THAT race; winner(s) are whoever ties for the
  -- extreme value within that race. Same three-CTE shape (eligible / extreme
  -- value / winners) already used for naked_aggression above.
  incident_eligible_race as (
    select c.race_number, c.cust_id, c.incidents
    from classified c
    where c.is_classified
      and c.cust_id not in (select cust_id from dsqd)
      and v_fewest_incidents_top_x > 0
      and c.position <= v_fewest_incidents_top_x
  ),
  incident_min_race as (
    select race_number, min(incidents) as min_incidents
    from incident_eligible_race
    group by race_number
  ),
  fewest_incidents_race as (
    select e.race_number, e.cust_id
    from incident_eligible_race e
    join incident_min_race m on m.race_number = e.race_number and m.min_incidents = e.incidents
  ),
  lap_eligible_race as (
    select c.race_number, c.cust_id, c.best_lap_ten_thousandths
    from classified c
    where c.is_classified
      and c.cust_id not in (select cust_id from dsqd)
      and c.best_lap_ten_thousandths is not null
      and v_fastest_lap_top_x > 0
      and c.position <= v_fastest_lap_top_x
  ),
  lap_min_race as (
    select race_number, min(best_lap_ten_thousandths) as min_lap
    from lap_eligible_race
    group by race_number
  ),
  fastest_lap_race as (
    select e.race_number, e.cust_id
    from lap_eligible_race e
    join lap_min_race m on m.race_number = e.race_number and m.min_lap = e.best_lap_ten_thousandths
  ),
  -- Round scope for the same two bonuses: aggregate each driver's classified,
  -- non-DSQ'd races across the whole round first (best position reached +
  -- total incidents + fastest single lap anywhere in the round — same
  -- "best_position" shape driver_round_totals already uses), then apply the
  -- identical top_x/extreme-value logic once per round. Winner(s) land on
  -- race_number = 1 only, same convention pole_bonus already uses for its
  -- own round-scoped award.
  round_stats as (
    select
      c.cust_id,
      min(c.position) as round_best_position,
      sum(c.incidents) as round_incidents,
      min(c.best_lap_ten_thousandths) as round_best_lap
    from classified c
    where c.is_classified
      and c.cust_id not in (select cust_id from dsqd)
    group by c.cust_id
  ),
  incident_eligible_round as (
    select cust_id, round_incidents
    from round_stats
    where v_fewest_incidents_top_x > 0
      and round_best_position <= v_fewest_incidents_top_x
  ),
  fewest_incidents_round as (
    select e.cust_id
    from incident_eligible_round e
    where e.round_incidents = (select min(round_incidents) from incident_eligible_round)
  ),
  lap_eligible_round as (
    select cust_id, round_best_lap
    from round_stats
    where v_fastest_lap_top_x > 0
      and round_best_position <= v_fastest_lap_top_x
      and round_best_lap is not null
  ),
  fastest_lap_round as (
    select e.cust_id
    from lap_eligible_round e
    where e.round_best_lap = (select min(round_best_lap) from lap_eligible_round)
  ),
  -- Sprint sweep (new, Aug 2026): a driver who wins (overall P1, classified,
  -- not DSQ'd) every race of a sprint round with 2+ races. One-time award,
  -- race_number = 1, same convention as the other round-scoped bonuses.
  round_race_count as (
    select count(distinct race_number) as race_count from classified
  ),
  sprint_wins as (
    select c.cust_id, count(*) as win_count
    from classified c
    where c.is_classified and c.position = 1
      and c.cust_id not in (select cust_id from dsqd)
    group by c.cust_id
  ),
  sprint_sweep_winners as (
    select sw.cust_id
    from sprint_wins sw, round_race_count rc
    where v_round.format = 'sprint' and rc.race_count > 1 and sw.win_count = rc.race_count
  ),
  scored as (
    select
      c.race_number,
      c.driver_id,
      c.class_id,
      c.team_id,
      c.position,
      c.is_classified,
      (c.cust_id in (select cust_id from dsqd)) as is_dsq,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when c.position <= 40 then
          coalesce((
            case
              -- Special-event per-race override wins outright when this
              -- round is in scope AND this race_number has its own table —
              -- checked before sprint_race2/3 so an overridden round never
              -- falls through to the ordinary sprint-format logic at all.
              when v_override_active
                   and (v_rules->'race_overrides'->'base_points' ? c.race_number::text)
                then v_rules->'race_overrides'->'base_points'->c.race_number::text->>(c.position - 1)
              when v_round.format = 'sprint' and c.race_number = 3
                   and (v_rules->'base_points' ? 'sprint_race3')
                then v_rules->'base_points'->'sprint_race3'->>(c.position - 1)
              when v_round.format = 'sprint' and c.race_number > 1
                   and (v_rules->'base_points' ? 'sprint_race2')
                then v_rules->'base_points'->'sprint_race2'->>(c.position - 1)
              else v_rules->'base_points'->v_round.format->>(c.position - 1)
            end
          )::int, 0)
        else
          coalesce((
            case
              when v_override_active
                   and (v_rules->'race_overrides'->'classified_minimum' ? c.race_number::text)
                then v_rules->'race_overrides'->'classified_minimum'->>c.race_number::text
              else v_rules->'classified_minimum'->>v_round.format
            end
          )::int, 0)
      end as finish_points,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when not (coalesce(v_rules->'class_podium'->'applies_to', '[]'::jsonb) ? c.class_name) then 0
        when cr.class_position is null or cr.class_position > 3 then 0
        else coalesce((
          case
            when v_round.format = 'sprint' and c.race_number = 3
                 and (v_rules->'class_podium' ? 'sprint_race3')
              then v_rules->'class_podium'->'sprint_race3'->>(cr.class_position - 1)
            when v_round.format = 'sprint' and c.race_number > 1
                 and (v_rules->'class_podium' ? 'sprint_race2')
              then v_rules->'class_podium'->'sprint_race2'->>(cr.class_position - 1)
            else v_rules->'class_podium'->v_round.format->>(cr.class_position - 1)
          end
        )::int, 0)
      end as class_points,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when not v_sublime_finesse_enabled then 0
        when coalesce(c.incidents, 0)
             <= coalesce((v_rules->'bonuses'->'sublime_finesse'->>'max_incidents')::int, 0)
          then coalesce((v_rules->'bonuses'->'sublime_finesse'->>v_round.format)::int, 0)
        else 0
      end as finesse_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not v_class_pole_enabled then 0
        when c.race_number = 1 and c.cust_id in (select cust_id from pole)
          then coalesce((v_rules->'bonuses'->'class_pole'->>v_round.format)::int, 0)
        else 0
      end as pole_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when not v_naked_aggression_enabled then 0
        when exists (
          select 1 from aggression a
          where a.race_number = c.race_number and a.cust_id = c.cust_id
        ) then coalesce((v_rules->'bonuses'->'naked_aggression'->>v_round.format)::int, 0)
        else 0
      end as aggression_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when not v_lap_led_enabled then 0
        when exists (
          select 1 from lap_led_race l
          where l.race_number = c.race_number and l.cust_id = c.cust_id
        ) then coalesce((v_rules->'bonuses'->'lap_led'->>v_round.format)::int, 0)
        else 0
      end as lap_led_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when not v_fewest_incidents_enabled then 0
        when v_fewest_incidents_per = 'round' then
          case when c.race_number = 1 and c.cust_id in (select cust_id from fewest_incidents_round)
            then coalesce((v_rules->'bonuses'->'fewest_incidents'->>v_round.format)::int, 0)
            else 0 end
        when exists (
          select 1 from fewest_incidents_race f
          where f.race_number = c.race_number and f.cust_id = c.cust_id
        ) then coalesce((v_rules->'bonuses'->'fewest_incidents'->>v_round.format)::int, 0)
        else 0
      end as fewest_incidents_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when not v_fastest_lap_enabled then 0
        when v_fastest_lap_per = 'round' then
          case when c.race_number = 1 and c.cust_id in (select cust_id from fastest_lap_round)
            then coalesce((v_rules->'bonuses'->'fastest_lap'->>v_round.format)::int, 0)
            else 0 end
        when exists (
          select 1 from fastest_lap_race f
          where f.race_number = c.race_number and f.cust_id = c.cust_id
        ) then coalesce((v_rules->'bonuses'->'fastest_lap'->>v_round.format)::int, 0)
        else 0
      end as fastest_lap_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not v_sprint_sweep_enabled then 0
        when c.race_number = 1 and c.cust_id in (select cust_id from sprint_sweep_winners)
          then coalesce((v_rules->'bonuses'->'sprint_sweep'->>'points')::int, 0)
        else 0
      end as sprint_sweep_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        else coalesce(dd.points_deduction, 0)
      end as points_deduction
    from classified c
    left join class_rank cr using (race_number, cust_id)
    left join deduction dd using (race_number, cust_id)
  )
  insert into public.race_scores (
    subsession_id, race_number, driver_id, season_id, class_id, team_id,
    finish_points, class_points, finesse_bonus, pole_bonus, aggression_bonus,
    lap_led_bonus, fewest_incidents_bonus, fastest_lap_bonus, sprint_sweep_bonus,
    points_deduction,
    scored_position, classified, dsq, ruleset_id, source
  )
  select
    p_subsession_id, s.race_number, s.driver_id, v_round.season_id, s.class_id, s.team_id,
    s.finish_points, s.class_points, s.finesse_bonus, s.pole_bonus, s.aggression_bonus,
    s.lap_led_bonus, s.fewest_incidents_bonus, s.fastest_lap_bonus, s.sprint_sweep_bonus,
    s.points_deduction,
    s.position, s.is_classified, s.is_dsq, v_ruleset_id, 'computed'
  from scored s;

  get diagnostics v_written = row_count;
  return v_written;
end;
$function$;

commit;
