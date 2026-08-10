-- Alpha Touring Challenge — "Naked Aggression" bonus: awarded to whichever
-- driver(s) gained the most net positions (starting_position - finish
-- position) in a single race. Shareable — every driver tied for the best
-- gain that race earns the full bonus, not a split of it.
--
-- Logan's ruleset JSON for this:
--   "naked_aggression": { "per": "race", "sprint": 2, "endurance": 4 }
-- Placed under `bonuses` (alongside sublime_finesse/class_pole) for the
-- same reason those live there — this migration reads it from
-- v_rules->'bonuses'->'naked_aggression', so when you add it to a ruleset's
-- JSON on Admin > Rulesets, nest it inside the existing "bonuses" object,
-- not at the top level. The "per": "race" field isn't read by this
-- function — the bonus is inherently per-race already (computed
-- separately for each race_number in the round, same as Sublime Finesse),
-- so that key is just documentation.
--
-- Two judgment calls worth flagging, since "adjust logic as needed" left
-- these open:
--  1. Only awarded when the best net gain in a race is POSITIVE. If every
--     classified driver lost positions or stayed put, nobody gets it that
--     race, rather than awarding it to whoever lost the fewest.
--  2. A driver must have a real `starting_position` on file and be
--     CLASSIFIED (§2.25) and not DSQ'd to be eligible — same eligibility
--     rule already used for finesse_bonus/pole_bonus/class_points, so a
--     driver who didn't run enough laps to be classified can't win it by
--     starting last and immediately retiring.

-- driver_round_totals/driver_standings both depend on race_scores.total_points
-- (bytes confirmed via pg_get_viewdef before writing this) — neither is
-- referenced anywhere in this app's own code (src/lib/results.ts computes
-- every standings view independently straight from race_scores rows), so
-- they may be vestigial from an earlier/different app iteration. Not
-- assuming that, though: dropped and recreated verbatim around the column
-- change rather than just CASCADE-dropping them, so nothing that might
-- still depend on them loses anything.
drop view public.driver_standings;
drop view public.driver_round_totals;

alter table public.race_scores drop column total_points;
alter table public.race_scores add column aggression_bonus integer not null default 0;
alter table public.race_scores add column total_points integer
  generated always as (finish_points + class_points + finesse_bonus + pole_bonus + aggression_bonus + points_deduction) stored;

CREATE VIEW public.driver_round_totals AS
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

CREATE VIEW public.driver_standings AS
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
      rr.starting_position,
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
  -- "Naked Aggression": most net positions gained (starting_position -
  -- finish position, using the same possibly-penalty-adjusted `position`
  -- everything else here uses) in a single race. Classified, non-DSQ'd,
  -- real starting_position required — same eligibility as the other
  -- per-race bonuses above. Only awarded when the best gain in a race is
  -- actually positive; shared in full (not split) by everyone tied for it.
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
        when not c.is_classified then 0
        when exists (
          select 1 from aggression a
          where a.race_number = c.race_number and a.cust_id = c.cust_id
        -- coalesced to 0 (not just cast) — unlike finesse/pole, a ruleset
        -- saved before this migration won't have bonuses.naked_aggression
        -- at all yet, and aggression_bonus is NOT NULL: without this,
        -- recalculating any round with a winner against such a ruleset
        -- would fail the whole insert on a not-null violation instead of
        -- just paying 0 until the ruleset JSON is updated.
        ) then coalesce((v_rules->'bonuses'->'naked_aggression'->>v_round.format)::int, 0)
        else 0
      end as aggression_bonus,
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
    finish_points, class_points, finesse_bonus, pole_bonus, aggression_bonus, points_deduction,
    scored_position, classified, dsq, ruleset_id, source
  )
  select
    p_subsession_id, s.race_number, s.driver_id, v_round.season_id, s.class_id, s.team_id,
    s.finish_points, s.class_points, s.finesse_bonus, s.pole_bonus, s.aggression_bonus, s.points_deduction,
    s.position, s.is_classified, s.is_dsq, v_ruleset_id, 'computed'
  from scored s;

  get diagnostics v_written = row_count;
  return v_written;
end;
$function$
