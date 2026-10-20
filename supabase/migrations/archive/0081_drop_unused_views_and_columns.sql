-- Alpha Touring Challenge — drop unused views, columns, and their dependents
--
-- From a codebase/DB audit: 5 of the 6 views under public (driver_round_totals,
-- driver_standings, qualifying_results, race_results, team_standings) turned
-- out to be dead — created at various points but never queried by any page or
-- API route (only driver_last_race is actually used, by src/lib/supabase.ts).
-- driver_standings depends on driver_round_totals, so it's dropped first.
--
-- race_scores.ruleset_id was written by recalculate_race_scores() on every
-- score computation but never read back anywhere (no view, function, or app
-- code selects it) — just its own index and FK to scoring_rulesets sitting
-- idle. Dropping it means updating recalculate_race_scores() to stop writing
-- it; the underlying v_ruleset_id variable stays, since it's still used in
-- two error messages ("Ruleset % has no base_points/classified_minimum for
-- format %"). race_scores.scored_at (an auto-timestamp, DEFAULT now()) was
-- never referenced by anything either.
--
-- curated_rounds.series_name has held a value since 0004_curated_races.sql
-- but nothing has ever read it — no view, function, or app code.
--
-- Verified against a real subsession (87179212, 25 existing race_scores rows)
-- that re-running recalculate_race_scores() after this change reproduces the
-- exact same finish_points/class_points/total_points/scored_position for
-- every row — the edit only removes a write, not any actual scoring logic.

-- Drop unused views (driver_standings depends on driver_round_totals)
drop view if exists public.driver_standings;
drop view if exists public.driver_round_totals;
drop view if exists public.qualifying_results;
drop view if exists public.race_results;
drop view if exists public.team_standings;

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
  lap_led_race as (
    select c.race_number, c.cust_id
    from classified c
    where c.is_classified
      and c.cust_id not in (select cust_id from dsqd)
      and coalesce(c.laps_led, 0) > 0
  ),
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
    scored_position, classified, dsq, source
  )
  select
    p_subsession_id, s.race_number, s.driver_id, v_round.season_id, s.class_id, s.team_id,
    s.finish_points, s.class_points, s.finesse_bonus, s.pole_bonus, s.aggression_bonus,
    s.lap_led_bonus, s.fewest_incidents_bonus, s.fastest_lap_bonus, s.sprint_sweep_bonus,
    s.points_deduction,
    s.position, s.is_classified, s.is_dsq, 'computed'
  from scored s;

  get diagnostics v_written = row_count;
  return v_written;
end;
$function$

-- Drop dead columns: written but never read by any view, function, or app code
alter table public.race_scores drop column ruleset_id;
alter table public.race_scores drop column scored_at;
alter table public.curated_rounds drop column series_name;
