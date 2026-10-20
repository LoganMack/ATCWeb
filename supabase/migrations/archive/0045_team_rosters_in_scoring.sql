-- Alpha Touring Challenge — score against the season's team roster, not a
-- driver's current team
--
-- Root cause of "drivers show on the wrong team in old seasons, and new
-- rosters don't take effect no matter how many times a season gets
-- recalculated": recalculate_race_scores()'s entrant CTE has always pulled
-- team_id straight from `drivers.team_id` — a driver's single CURRENT team,
-- with no season scoping at all. class_id has had exactly this problem
-- solved already, since 0037_class_and_scoring_fixes.sql added
-- driver_season_classes and changed that CTE to
-- `coalesce(dsc.class_id, d.class_id)`, preferring a season-specific
-- override and falling back to the driver's current class when there isn't
-- one. team_id was never given the same treatment even though
-- 0008_team_rosters.sql added the exact season-scoped table for it
-- (team_rosters) five migrations earlier — that table has been populated by
-- the admin "Roster by Season" UI ever since, but nothing in scoring ever
-- read it, so every team assignment in race_scores has really just been
-- "whichever team this driver is on right now."
--
-- Concretely, this is why:
--   1. Recalculating an old season could show a driver on a team they only
--      joined much later — because by the time the recalc ran, the driver's
--      *current* drivers.team_id had already moved on, and every one of
--      their historical rounds got stamped with that same current team.
--   2. Adding drivers to a new team's season roster (team_rosters) and
--      recalculating did nothing to the standings/results — recalculation
--      never looked at team_rosters in the first place, only at
--      drivers.team_id.
--
-- Fix mirrors driver_season_classes exactly: left join team_rosters scoped
-- to this round's own season_id, and prefer that over the driver's current
-- team when a season-specific entry exists. A driver-season with no
-- team_rosters row (the common case for most of this league's history,
-- since the table is still sparsely populated) falls back to
-- drivers.team_id unchanged, so this is a pure additive fix — nothing
-- regresses for data that was never given a season-scoped roster entry.
--
-- Everything else in this function (distance/dsqd/deduction/classified/
-- class_rank/pole/net_gain/aggression/scored, the season-lock check, the
-- advisory lock, the format/ruleset guards) is unchanged from
-- 0033_naked_aggression_bonus.sql.
--
-- After this migration ships, every season with any team_rosters entries
-- needs a re-run of recalculate_season_scores() (or the per-round
-- recalculate) to actually rewrite the already-computed race_scores rows —
-- changing the function alone does not retroactively fix rows already in
-- the table.

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

  select s.scoring_ruleset_id, r.rules into v_ruleset_id, v_rules
  from public.seasons s
  join public.scoring_rulesets r on r.id = s.scoring_ruleset_id
  where s.id = v_round.season_id;

  if v_rules is null then
    raise exception 'Season % has no scoring ruleset', v_round.season_id;
  end if;

  -- Genuinely-required fields — unlike the optional bonuses below, a
  -- ruleset with no points table for this round's own format is a real
  -- misconfiguration, so fail loudly and clearly rather than letting it
  -- fall through to a confusing NOT NULL constraint violation deep inside
  -- the insert below.
  if v_rules->'base_points'->v_round.format is null then
    raise exception 'Ruleset % has no base_points for format %', v_ruleset_id, v_round.format;
  end if;
  if v_rules->'classified_minimum'->>v_round.format is null then
    raise exception 'Ruleset % has no classified_minimum for format %', v_ruleset_id, v_round.format;
  end if;

  with
  entrant as (
    select
      rr.race_number,
      rr.cust_id,
      d.id        as driver_id,
      coalesce(dsc.class_id, d.class_id) as class_id,
      -- Season-scoped roster (team_rosters) wins when this driver has an
      -- entry for THIS round's season; otherwise fall back to their
      -- current team, exactly the same precedence driver_season_classes
      -- gets above for class_id.
      coalesce(tr.team_id, d.team_id) as team_id,
      d.name      as driver_name,
      dc.name     as class_name,
      coalesce(rr.adjusted_position, rr.finish_position) as position,
      rr.starting_position,
      rr.laps_complete,
      rr.incidents
    from public.curated_race_results rr
    join public.drivers d        on d.iracing_cust_id = rr.cust_id
    left join public.driver_season_classes dsc
      on dsc.driver_id = d.id and dsc.season_id = v_round.season_id
    left join public.team_rosters tr
      on tr.driver_id = d.id and tr.season_id = v_round.season_id
    join public.driver_classes dc on dc.id = coalesce(dsc.class_id, d.class_id)
    where rr.subsession_id = p_subsession_id
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
        row_number() over (partition by d.class_id order by cq.qual_position) as rn
      from public.curated_qualifying cq
      join public.drivers d on d.iracing_cust_id = cq.cust_id
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
              when v_round.format = 'sprint' and c.race_number > 1
                   and (v_rules->'base_points' ? 'sprint_race2')
                then v_rules->'base_points'->'sprint_race2'->>(c.position - 1)
              else v_rules->'base_points'->v_round.format->>(c.position - 1)
            end
          )::int, 0)
        else coalesce((v_rules->'classified_minimum'->>v_round.format)::int, 0)
      end as finish_points,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when not (coalesce(v_rules->'class_podium'->'applies_to', '[]'::jsonb) ? c.class_name) then 0
        when cr.class_position is null or cr.class_position > 3 then 0
        else coalesce((
          case
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
        when not (v_rules->'bonuses' ? 'sublime_finesse') then 0
        when coalesce(c.incidents, 0)
             <= coalesce((v_rules->'bonuses'->'sublime_finesse'->>'max_incidents')::int, 0)
          then coalesce((v_rules->'bonuses'->'sublime_finesse'->>v_round.format)::int, 0)
        else 0
      end as finesse_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when c.race_number = 1 and c.cust_id in (select cust_id from pole)
          then coalesce((v_rules->'bonuses'->'class_pole'->>v_round.format)::int, 0)
        else 0
      end as pole_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when exists (
          select 1 from aggression a
          where a.race_number = c.race_number and a.cust_id = c.cust_id
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
