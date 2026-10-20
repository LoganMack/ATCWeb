-- Alpha Touring Challenge — per-race points overrides for special events
--
-- Some seasons run a one-off special event round with a completely
-- different points table PER RACE NUMBER, unrelated to the normal
-- sprint/endurance base_points split — e.g. a 3-race event where race 1
-- pays an "Alpha/Special" table, race 2 a "Feature" table, and race 3 a
-- "Sprint" table (ATC10's planned S11-style special event, which is what
-- prompted this). The existing `base_points.sprint_race2` mechanism
-- (0038_class_podium_race2.sql) only covers "one alternate table for every
-- race after race 1," which can't express three genuinely different
-- tables, and a season only ever has ONE scoring_ruleset_id — there's no
-- per-round ruleset to swap to just for one special round.
--
-- Solution: a new optional `race_overrides` block in the ruleset JSON,
-- SCOPED TO SPECIFIC ROUNDS by subsession_id:
--
--   "race_overrides": {
--     "subsession_ids": ["68449968"],
--     "base_points": { "1": [100, 94, ...], "2": [65, 61, ...], "3": [35, 33, ...] },
--     "classified_minimum": { "1": 10, "2": 5, "3": 5 }
--   }
--
-- When the round being scored is NOT in race_overrides.subsession_ids
-- (the common case — this key can even be entirely absent), behavior is
-- byte-for-byte identical to before this migration: format-keyed
-- base_points/classified_minimum, sprint_race2 override included. When it
-- IS in that list, base_points/classified_minimum for THAT round are
-- looked up by race_number (as a string key: "1", "2", "3", ...) under
-- race_overrides instead — completely bypassing format/sprint_race2 for
-- that round only. Every other round in every other season sharing that
-- same ruleset (rulesets are commonly reused across many seasons — see
-- "ATC 18.3", used by ATC1-11/17/18) is unaffected, since subsession_ids
-- is an explicit allowlist, not a season or format switch.
--
-- subsession_ids are stored as JSON STRINGS (not numbers) and compared via
-- jsonb_array_elements_text + p_subsession_id::text, not the jsonb `?`
-- operator — `?` only matches JSON STRING array elements, not numbers, so
-- storing them as bare numbers would silently never match.
--
-- This lets an admin attach a special event's points table to a season's
-- EXISTING ruleset (no new ruleset row, no temporarily reassigning the
-- season's scoring_ruleset_id) by adding one JSON block, then activate it
-- by adding that round's real subsession_id to the list once iRacing
-- results are in and the round goes 'official' — until then it's inert.
--
-- Only base_points/classified_minimum are covered (what was actually
-- asked for and what ATC10's special event needs); class_podium and the
-- bonuses stay format-keyed as before even for an overridden round. A
-- `race_overrides.qualifying_points` field is reserved in the ruleset JSON
-- template (Admin > Rulesets) for a future iRacing-qualifying-based bonus
-- some special events hand out, but is NOT read anywhere yet — qualifying
-- data (`curated_qualifying`) has no race_number column at all (applies to
-- race 1's grid only, same scope class_pole already uses), and wiring it
-- up for real needs a new race_scores column plus a change to
-- total_points' GENERATED ALWAYS expression, which needs its own
-- migration once a concrete event actually needs it.

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
  -- True when this round's subsession_id is explicitly listed in
  -- v_rules->'race_overrides'->'subsession_ids' — computed once here
  -- rather than re-evaluating the same exists() in every scored row below.
  v_override_active boolean;
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

  -- Still required even for an overridden round: race_overrides only ever
  -- covers a specific race_number allowlist, never the whole round, so the
  -- format-keyed table must still exist as the fallback for anything
  -- outside that allowlist (or if race_overrides is edited away later).
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

  with
  entrant as (
    select
      rr.race_number,
      rr.cust_id,
      d.id        as driver_id,
      coalesce(dsc.class_id, d.class_id) as class_id,
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
