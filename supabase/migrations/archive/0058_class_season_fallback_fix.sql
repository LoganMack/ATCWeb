-- Fixes recalculate_race_scores' driver_season_classes fallback (Logan:
-- "when a driver has no historical class selected in a season where their
-- current class does not exist, they begin to appear in those seasons as
-- their current class by default... drivers should default to the highest
-- available class in a season in this situation").
--
-- driver_season_classes (0037_class_and_scoring_fixes.sql) is an OPTIONAL
-- per-driver-per-season override, only ever populated where a driver's
-- current class genuinely differs from what they raced that season — e.g.
-- a driver who's Delta today but raced Alpha back in ATC3, before Delta
-- existed at all (Delta only went live ATC5+, Gamma only ATC16+ — see
-- seasons.gamma_enabled/delta_enabled, same migration). The entrant CTE's
-- `coalesce(dsc.class_id, d.class_id)` fell straight through to the
-- driver's CURRENT class whenever no override row exists — which is wrong
-- whenever that current class didn't exist yet in the round's season, not
-- just when there happens to be an override. Confirmed live in race_scores:
-- Andrew Benagh (ATC1), Gareth McAlister (ATC3), and Adrian Fedorowski
-- (ATC4) are all currently Delta and, with no ATC1/3/4 override on file,
-- were scored as Delta in seasons where delta_enabled is false — seasons
-- that never had a Delta class to begin with, silently splitting a
-- nonexistent class into those seasons' standings.
--
-- Fix: when there's no override AND the driver's current class isn't
-- enabled for this round's season, fall back to the highest-tier class
-- that IS available that season (lowest driver_classes.sort_order among
-- Alpha — always available, no *_enabled column needed — Gamma if
-- gamma_enabled, Delta if delta_enabled) instead of the driver's current
-- class. An explicit driver_season_classes override, when present, still
-- always wins outright, same as before.
--
-- This only changes what a FUTURE (re)score of a round computes — it does
-- not retroactively touch already-written race_scores rows. See this
-- migration's companion data fix for the specific already-miscored rounds
-- above (re-run via recalculate_race_scores, not a raw UPDATE, so every
-- downstream column — finish_points, class_points, etc. — gets
-- recomputed consistently rather than just patching class_id in place).
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
  v_override_active boolean;
  -- Season class availability + the resulting "highest available class"
  -- fallback id, both resolved once here rather than per-entrant-row below.
  v_gamma_enabled boolean;
  v_delta_enabled boolean;
  v_fallback_class_id integer;
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
      -- No fallback: a driver with no team_rosters entry for THIS round's
      -- season is on no team that season. See 0046's own header comment.
      tr.team_id as team_id,
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
              -- Special-event per-race override wins outright when this
              -- round is in scope AND this race_number has its own table —
              -- checked before sprint_race2 so an overridden round never
              -- falls through to the ordinary sprint-format logic at all.
              when v_override_active
                   and (v_rules->'race_overrides'->'base_points' ? c.race_number::text)
                then v_rules->'race_overrides'->'base_points'->c.race_number::text->>(c.position - 1)
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
$function$;
