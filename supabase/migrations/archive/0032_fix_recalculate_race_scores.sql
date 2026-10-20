-- Alpha Touring Challenge — fix recalculate_race_scores() against the
-- current penalties schema
--
-- recalculate_race_scores() (the DB function that turns raw curated_race_results
-- + a season's scoring ruleset into race_scores rows) still referenced the
-- OLD penalties table shape (p.cust_id / p.applied / p.dsq) — none of which
-- exist on the current `penalties` table (driver_id, no applied flag, no
-- dsq column; see src/lib/penalties.ts's own header comment for the current
-- two-currency model: points_penalty = flat championship-points deduction,
-- penalty_points = PP/probation tally, entirely separate, both entered
-- directly by a steward, appeal_* overrides once is_appealed is set).
-- Calling this function before this fix would have failed with "column
-- p.cust_id does not exist" at the dsqd CTE.
--
-- Two real fixes, not just a rename:
--
-- 1. DSQ no longer has a flag on `penalties` at all (the current admin
--    penalty UI has no DSQ concept — see penalties.ts's own documented
--    simplifications). DSQ is a raw pipeline signal instead, on
--    curated_race_results.reason_out — confirmed against live data
--    ('Disqualified': 46 rows, 'DQ/Scoring Invalidated': 2 rows, alongside
--    'Running'/'Disconnected'/'Retired'). Sourced from there now, keeping
--    the original §5.34 behavior (a DSQ anywhere in the round kills the
--    whole round for that driver) — just re-pointed at the correct table.
--
-- 2. The points deduction no longer runs the PP level (1-8) through the
--    ruleset's `pp_penalties` table to derive a points value. Inspecting
--    the live ruleset confirms `pp_penalties` is a STEWARD REFERENCE table
--    (seconds/quali-ban/lap+points+pit-start/race-ban by severity) meant to
--    guide a human's manual entry, not a value meant to be mechanically
--    re-derived — matching penalties.ts's own comment that points are
--    "always entered by hand," never auto-filled from a lookup. The
--    deduction CTE now sums penalties.points_penalty (or its appeal
--    override) directly, exactly matching penalties.ts's own
--    effectivePointsPenalty() helper, so the DB-side "official" recalc and
--    the TS-side live-preview adjustment logic agree.
--
-- Everything else (entrant/distance/classified/class_rank/pole/scored,
-- the season-lock check, the advisory lock, the format/ruleset guards) is
-- unchanged from before this migration.

CREATE OR REPLACE FUNCTION public.recalculate_race_scores(p_subsession_id bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_round      record;
  v_rules      jsonb;
  v_ruleset_id uuid;
  v_written    int;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can recalculate scores'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_round from public.curated_rounds where subsession_id = p_subsession_id;
  if not found then
    raise exception 'No such round: %', p_subsession_id;
  end if;

  -- Serialise concurrent stewards working the same season.
  if v_round.season_id is not null then
    perform pg_advisory_xact_lock(hashtext(v_round.season_id::text));
  end if;

  if exists (select 1 from public.seasons
             where id = v_round.season_id and standings_locked_at is not null) then
    raise exception 'Season standings are locked; unlock the season to rescore'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  delete from public.race_scores where subsession_id = p_subsession_id;

  -- Not official yet, or explicitly not a championship event: no rows at all.
  -- 'unofficial' means absent, NOT a zero-point round — the distinction matters
  -- for average finish, starts, and drop-week counting.
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

  select s.scoring_ruleset_id, r.rules into v_ruleset_id, v_rules
  from public.seasons s
  join public.scoring_rulesets r on r.id = s.scoring_ruleset_id
  where s.id = v_round.season_id;

  if v_rules is null then
    raise exception 'Season % has no scoring ruleset', v_round.season_id;
  end if;

  with
  -- Rostered drivers only. Guests race but do not score, so the join to
  -- drivers.iracing_cust_id is what filters them out.
  entrant as (
    select
      rr.race_number,
      rr.cust_id,
      d.id        as driver_id,
      d.class_id,
      d.team_id,
      d.name      as driver_name,
      dc.name     as class_name,
      coalesce(rr.adjusted_position, rr.finish_position) as position,
      rr.laps_complete,
      rr.incidents
    from public.curated_race_results rr
    join public.drivers d        on d.iracing_cust_id = rr.cust_id
    join public.driver_classes dc on dc.id = d.class_id
    where rr.subsession_id = p_subsession_id
  ),
  -- §2.25 race length is the leader's completed laps; under 50% is unclassified.
  distance as (
    select race_number, max(laps_complete) as leader_laps
    from public.curated_race_results
    where subsession_id = p_subsession_id
    group by race_number
  ),
  -- §5.34 a DSQ anywhere in the round kills the whole round for that driver.
  -- No dsq flag on `penalties` (current admin penalty system has no DSQ
  -- concept — see penalties.ts) — DSQ is the raw pipeline signal on
  -- curated_race_results.reason_out instead.
  dsqd as (
    select distinct cust_id
    from public.curated_race_results
    where subsession_id = p_subsession_id
      and reason_out in ('Disqualified', 'DQ/Scoring Invalidated')
  ),
  -- Championship-points deductions: penalties.points_penalty (or its appeal
  -- override, appeal_points_penalty) as entered directly by the steward —
  -- matches penalties.ts's effectivePointsPenalty(). Summed per driver per
  -- race in case more than one penalty landed on the same driver/race.
  -- Joined via driver_id -> drivers.iracing_cust_id since `penalties` has no
  -- cust_id column of its own.
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
  -- §2.8 class podium, gamma/delta only, ranked within the driver's ATC class.
  -- Classified drivers only — confirmed with the league, and consistent with
  -- Sublime Finesse's explicit requirement.
  class_rank as (
    select
      c.race_number, c.cust_id,
      -- ::int matters: row_number() is bigint, and Postgres has no
      -- `jsonb ->> bigint` operator — only `->> integer`. Without the cast the
      -- class_podium lookup below fails at runtime, not at create time.
      (row_number() over (
        partition by c.race_number, c.class_id
        order by c.position
      ))::int as class_position
    from classified c
    where c.is_classified
  ),
  -- §2.26.2 Class Pole: 1st in class in QUALIFYING, once per round. Attached to
  -- race 1 so a sprint round cannot pay it twice.
  pole as (
    select q.cust_id
    from (
      select
        cq.cust_id,
        row_number() over (partition by d.class_id order by cq.qual_position) as rn
      from public.curated_qualifying cq
      join public.drivers d on d.iracing_cust_id = cq.cust_id
      where cq.subsession_id = p_subsession_id
    ) q
    where q.rn = 1
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
          (v_rules->'base_points'->v_round.format->>(c.position - 1))::int
        else (v_rules->'classified_minimum'->>v_round.format)::int
      end as finish_points,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when not (v_rules->'class_podium'->'applies_to' ? c.class_name) then 0
        when cr.class_position is null or cr.class_position > 3 then 0
        else (v_rules->'class_podium'->v_round.format->>(cr.class_position - 1))::int
      end as class_points,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when coalesce(c.incidents, 0)
             <= (v_rules->'bonuses'->'sublime_finesse'->>'max_incidents')::int
          then (v_rules->'bonuses'->'sublime_finesse'->>v_round.format)::int
        else 0
      end as finesse_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when c.race_number = 1 and c.cust_id in (select cust_id from pole)
          then (v_rules->'bonuses'->'class_pole'->>v_round.format)::int
        else 0
      end as pole_bonus,
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
    finish_points, class_points, finesse_bonus, pole_bonus, points_deduction,
    scored_position, classified, dsq, ruleset_id, source
  )
  select
    p_subsession_id, s.race_number, s.driver_id, v_round.season_id, s.class_id, s.team_id,
    s.finish_points, s.class_points, s.finesse_bonus, s.pole_bonus, s.points_deduction,
    s.position, s.is_classified, s.is_dsq, v_ruleset_id, 'computed'
  from scored s;

  get diagnostics v_written = row_count;
  return v_written;
end;
$function$
