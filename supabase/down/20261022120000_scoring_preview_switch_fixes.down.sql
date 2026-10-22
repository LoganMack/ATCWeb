-- Down script for 20261022120000_scoring_preview_switch_fixes.sql.
--
-- Restores private.scoring_switch_names() and private.scoring_compute() exactly as
-- 20261021120000_race_score_results_expand.sql created them: ten switches, cross-class-ripple
-- tested on time-penalised classes and shadowed by per-class-pricing, the overall formula without
-- the aggression bonus, and no unclassified-position switch. score_round's output is the same
-- either way, so no rescore is needed. A preview called with "unclassified-position" is refused
-- again as an unknown switch, so run the comparison script from the matching commit.

create or replace function private.scoring_switch_names() returns text[]
  language sql immutable
  set search_path = ''
  as $$
  select array[
    'deduction-sign', 'bonus-after-reorder', 'cross-class-ripple', 'per-class-pricing',
    'overall-formula', 'short-points-table', 'non-race-penalty', 'dsq-flat-penalty',
    'class-position-ranking', 'reorder-tie-break'
  ];
$$;

-- The calculation shared by score_round and score_round_preview (W1 steps 5-9). Returns the rows
-- for a scorable round; the callers check private.scoring_unscorable_reason first.
--
-- Switches (BR6.2); a missing key means true. false restores today's behaviour for that cause:
--   deduction-sign          false: a non-DSQ row's deduction has no effect (today the database
--                           adds it and the page subtracts it again).
--   bonus-after-reorder     false: aggression, fewest incidents, fastest lap and sprint sweep in
--                           the final set are priced from the raw positions.
--   cross-class-ripple      false: final finish points move only when a driver of the same class
--                           has a time penalty in that race.
--   per-class-pricing       false: a row whose class position moved is priced from its class
--                           position (today's Per Class view); otherwise it keeps raw points.
--   overall-formula         false: overall total = finish + finesse + pole - deduction.
--   short-points-table      false: inside position 40 but past a short table scores 0.
--   non-race-penalty        false: qualifying and practice penalties are ignored.
--   dsq-flat-penalty        false: a DSQ'd driver's points penalty is dropped.
--   class-position-ranking  false: class position counts classified rows only, DSQ included.
--   reorder-tie-break       false: the TypeScript comparator's order (scoring_ts_order), with
--                           class positions from a class-only reorder, as the site does.
create or replace function private.scoring_compute(p_subsession_id bigint, p_switches jsonb)
  returns setof public.race_score_results
  language plpgsql
  set search_path = ''
  as $$
declare
  v_round public.curated_rounds;
  v_rules jsonb;
  v_gamma_enabled boolean;
  v_delta_enabled boolean;
  v_fallback_class_id integer;
  v_override_active boolean;
  v_now timestamp with time zone := clock_timestamp();
  sw_deduction_sign boolean := coalesce((p_switches ->> 'deduction-sign')::boolean, true);
  sw_bonus_after_reorder boolean := coalesce((p_switches ->> 'bonus-after-reorder')::boolean, true);
  sw_cross_class_ripple boolean := coalesce((p_switches ->> 'cross-class-ripple')::boolean, true);
  sw_per_class_pricing boolean := coalesce((p_switches ->> 'per-class-pricing')::boolean, true);
  sw_overall_formula boolean := coalesce((p_switches ->> 'overall-formula')::boolean, true);
  sw_short_points_table boolean := coalesce((p_switches ->> 'short-points-table')::boolean, true);
  sw_non_race_penalty boolean := coalesce((p_switches ->> 'non-race-penalty')::boolean, true);
  sw_dsq_flat_penalty boolean := coalesce((p_switches ->> 'dsq-flat-penalty')::boolean, true);
  sw_class_position_ranking boolean := coalesce((p_switches ->> 'class-position-ranking')::boolean, true);
  sw_reorder_tie_break boolean := coalesce((p_switches ->> 'reorder-tie-break')::boolean, true);
  b_finesse boolean;
  b_class_pole boolean;
  b_aggression boolean;
  b_lap_led boolean;
  b_fewest boolean;
  b_fewest_top_x integer;
  b_fewest_per text;
  b_fastest boolean;
  b_fastest_top_x integer;
  b_fastest_per text;
  b_sweep boolean;
begin
  select * into v_round from public.curated_rounds where subsession_id = p_subsession_id;
  if not found then
    return;
  end if;

  select r.rules, s.gamma_enabled, s.delta_enabled
  into v_rules, v_gamma_enabled, v_delta_enabled
  from public.seasons s
  join public.scoring_rulesets r on r.id = s.scoring_ruleset_id
  where s.id = v_round.season_id;
  if v_rules is null or v_round.format is null then
    return;
  end if;

  v_override_active := exists (
    select 1
    from jsonb_array_elements_text(coalesce(v_rules -> 'race_overrides' -> 'subsession_ids', '[]'::jsonb)) sid
    where sid = p_subsession_id::text
  );

  b_finesse := coalesce((v_rules -> 'bonuses' -> 'sublime_finesse' ->> 'enabled')::boolean, false);
  b_class_pole := coalesce((v_rules -> 'bonuses' -> 'class_pole' ->> 'enabled')::boolean, false);
  b_aggression := coalesce((v_rules -> 'bonuses' -> 'naked_aggression' ->> 'enabled')::boolean, false);
  b_lap_led := coalesce((v_rules -> 'bonuses' -> 'lap_led' ->> 'enabled')::boolean, false);
  b_fewest := coalesce((v_rules -> 'bonuses' -> 'fewest_incidents' ->> 'enabled')::boolean, false);
  b_fewest_top_x := coalesce((v_rules -> 'bonuses' -> 'fewest_incidents' ->> 'top_x')::integer, 0);
  b_fewest_per := coalesce(v_rules -> 'bonuses' -> 'fewest_incidents' ->> 'per', 'race');
  b_fastest := coalesce((v_rules -> 'bonuses' -> 'fastest_lap' ->> 'enabled')::boolean, false);
  b_fastest_top_x := coalesce((v_rules -> 'bonuses' -> 'fastest_lap' ->> 'top_x')::integer, 0);
  b_fastest_per := coalesce(v_rules -> 'bonuses' -> 'fastest_lap' ->> 'per', 'race');
  b_sweep := coalesce((v_rules -> 'bonuses' -> 'sprint_sweep' ->> 'enabled')::boolean, false);

  select dc.id into v_fallback_class_id
  from public.driver_classes dc
  where dc.name = 'Alpha'
     or (dc.name = 'Gamma' and v_gamma_enabled)
     or (dc.name = 'Delta' and v_delta_enabled)
  order by dc.sort_order
  limit 1;

  return query
  with
  dsqd as (
    select distinct rr.cust_id
    from public.curated_race_results rr
    where rr.subsession_id = p_subsession_id
      and rr.reason_out in ('Disqualified', 'DQ/Scoring Invalidated')
  ),
  -- Every entrant of every race, rostered or not: unrostered entrants still occupy positions.
  field as (
    select
      rr.race_number,
      rr.cust_id,
      rr.finish_position,
      coalesce(rr.adjusted_position, rr.finish_position) as pos,
      rr.laps_complete as laps,
      rr.interval_ten_thousandths::numeric as intv,
      rr.average_lap_ten_thousandths::numeric as avg_lap,
      (rr.cust_id in (select dq.cust_id from dsqd dq)) as is_dsq
    from public.curated_race_results rr
    where rr.subsession_id = p_subsession_id
  ),
  -- max_laps sets the 50% classification line, as today; the leader (finish_position 1, before any
  -- adjustment) is the reference for laps down and race time, as in reorder.ts.
  race as (
    select
      f.race_number,
      max(f.laps) as max_laps,
      (array_agg(f.laps) filter (where f.finish_position = 1))[1] as l_laps,
      (array_agg(f.avg_lap) filter (where f.finish_position = 1))[1] as l_avg
    from field f
    group by f.race_number
  ),
  entrant as (
    select
      rr.race_number,
      rr.cust_id,
      d.id as driver_id,
      ec.class_id,
      dc.name as class_name,
      tr.team_id,
      rr.starting_position,
      rr.laps_led,
      rr.best_lap_ten_thousandths as best_lap,
      rr.incidents
    from public.curated_race_results rr
    join public.drivers d on d.iracing_cust_id = rr.cust_id
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
  -- Effective penalties per scoring race and driver (BR2.1, BR2.2); time in ten-thousandths.
  pen as (
    select
      case when p.session_type = 'race' then p.race_number else 1 end as race_number,
      p.driver_id,
      sum(coalesce(case when p.is_appealed then p.appeal_time_penalty_seconds else p.time_penalty_seconds end, 0)) * 10000 as time_t,
      sum(case when p.is_appealed then p.appeal_points_penalty else p.points_penalty end) as points
    from public.penalties p
    where p.subsession_id = p_subsession_id
      and p.driver_id is not null
      and (sw_non_race_penalty or p.session_type = 'race')
    group by 1, 2
  ),
  k0 as (
    select
      f.race_number, f.cust_id, f.pos, f.laps, f.intv, f.avg_lap, f.is_dsq,
      e.driver_id, e.class_id,
      coalesce(pn.time_t, 0) as pen_t,
      r.l_laps, r.l_avg,
      case when f.laps is not null and r.l_laps is not null and r.l_laps > f.laps
           then r.l_laps - f.laps else 0 end as ldb
    from field f
    join race r on r.race_number = f.race_number
    left join entrant e on e.race_number = f.race_number and e.cust_id = f.cust_id
    left join pen pn on pn.race_number = f.race_number and pn.driver_id = e.driver_id
  ),
  k1 as (
    select k0.*,
      (k0.pen_t <> 0) as touched,
      (k0.ldb = 0 and k0.intv is not null and k0.intv >= 0) as on_lead
    from k0
  ),
  -- The reorder key per row, with reorder.ts's three branches (BR2.3 a, b, c).
  k2 as (
    select k1.*,
      (case
        when k1.on_lead and not k1.touched then 0
        when k1.on_lead and k1.l_avg > 0 and k1.intv + k1.pen_t > k1.l_avg
          then floor((k1.intv + k1.pen_t) / k1.l_avg)
        when k1.on_lead then 0
        when k1.avg_lap is not null and k1.laps is not null and k1.l_avg > 0 and k1.l_laps is not null
          then greatest(k1.ldb::numeric, floor((k1.laps * k1.avg_lap - k1.l_laps * k1.l_avg + k1.pen_t) / k1.l_avg))
        else k1.ldb
      end)::integer as ld,
      case
        when k1.on_lead and not k1.touched then k1.intv
        when k1.on_lead and k1.l_avg > 0 and k1.intv + k1.pen_t > k1.l_avg
          then (k1.intv + k1.pen_t) - floor((k1.intv + k1.pen_t) / k1.l_avg) * k1.l_avg
        when k1.on_lead then k1.intv + k1.pen_t
        when k1.avg_lap is not null and k1.laps is not null and k1.l_avg > 0 and k1.l_laps is not null
          then k1.laps * k1.avg_lap - k1.l_laps * k1.l_avg + k1.pen_t
        else null
      end as gap
    from k1
  ),
  touched_race as (
    select distinct k2.race_number from k2 where not k2.is_dsq and k2.touched
  ),
  ranked as (
    select k2.* from k2
    where not k2.is_dsq and k2.race_number in (select t.race_number from touched_race t)
  ),
  lead_zero as (
    select rk.race_number, min(rk.gap) as zero
    from ranked rk where rk.ld = 0 and rk.gap is not null
    group by rk.race_number
  ),
  -- Deterministic placement (BR2.3): untouched rows numbered within their laps-down group in raw
  -- order; a touched row takes the slot of the first untouched row it beats.
  untouched as (
    select rk.race_number, rk.cust_id, rk.ld, rk.gap, rk.pos,
      row_number() over (partition by rk.race_number, rk.ld order by rk.pos, rk.cust_id) as u_rank
    from ranked rk where not rk.touched
  ),
  placed as (
    select rk.race_number, rk.cust_id, rk.ld, rk.gap, rk.pos, rk.driver_id, rk.touched,
      case
        when rk.touched then coalesce((
          select min(u.u_rank) from untouched u
          where u.race_number = rk.race_number and u.ld = rk.ld
            and case when rk.gap is null or u.gap is null then u.pos > rk.pos else u.gap > rk.gap end
        ), 2147483647)
        else (select u.u_rank from untouched u where u.race_number = rk.race_number and u.cust_id = rk.cust_id)
      end as slot
    from ranked rk
  ),
  placed_det as (
    select pl.race_number, pl.cust_id,
      row_number() over (
        partition by pl.race_number
        order by pl.ld, pl.slot, (not pl.touched), pl.gap nulls last, pl.pos, pl.driver_id nulls last, pl.cust_id
      )::integer as fpos
    from placed pl
  ),
  ts_input as (
    select rk.race_number,
      array_agg(rk.cust_id order by rk.pos, rk.cust_id) as custs,
      array_agg(rk.ld order by rk.pos, rk.cust_id) as lds,
      array_agg(rk.gap order by rk.pos, rk.cust_id) as gaps,
      array_agg(rk.touched order by rk.pos, rk.cust_id) as touches,
      array_agg(rk.pos order by rk.pos, rk.cust_id) as poss
    from ranked rk
    where not sw_reorder_tie_break
    group by rk.race_number
  ),
  placed_ts as (
    select ti.race_number, ti.custs[o.idx] as cust_id, o.ord::integer as fpos
    from ts_input ti
    cross join lateral unnest(private.scoring_ts_order(ti.lds, ti.gaps, ti.touches, ti.poss))
      with ordinality as o(idx, ord)
  ),
  ts_class_input as (
    select rk.race_number, rk.class_id,
      array_agg(rk.cust_id order by rk.pos, rk.cust_id) as custs,
      array_agg(rk.ld order by rk.pos, rk.cust_id) as lds,
      array_agg(rk.gap order by rk.pos, rk.cust_id) as gaps,
      array_agg(rk.touched order by rk.pos, rk.cust_id) as touches,
      array_agg(rk.pos order by rk.pos, rk.cust_id) as poss
    from ranked rk
    where not sw_reorder_tie_break and rk.driver_id is not null
    group by rk.race_number, rk.class_id
  ),
  class_ts as (
    select ti.race_number, ti.custs[o.idx] as cust_id, o.ord::integer as cpos
    from ts_class_input ti
    cross join lateral unnest(private.scoring_ts_order(ti.lds, ti.gaps, ti.touches, ti.poss))
      with ordinality as o(idx, ord)
  ),
  -- Both sets' positions, laps down, gap and race time for every rostered row.
  pos_rows as (
    select
      e.race_number, e.cust_id, e.driver_id, e.class_id, e.class_name, e.team_id,
      e.starting_position, e.laps_led, e.best_lap, e.incidents,
      k.pos as finish_position, k.is_dsq,
      (r.max_laps > 0 and coalesce(k.laps, 0) >= r.max_laps * 0.5) as classified,
      k.pen_t,
      coalesce(pn.points, 0) as pen_points,
      case when k.is_dsq then null else k.pos end as raw_pos,
      k.ldb as raw_ld,
      case when k.on_lead then k.intv end as raw_gap,
      case
        when k.on_lead and k.l_avg is not null and k.l_laps is not null then k.l_laps * k.l_avg + k.intv
        when k.laps is not null and k.avg_lap is not null then k.laps * k.avg_lap
      end as raw_rt,
      (rk.cust_id is not null) as reordered,
      case
        when k.is_dsq then null
        when rk.cust_id is null then k.pos
        when sw_reorder_tie_break then pd.fpos
        else pt.fpos
      end as fin_pos,
      case when rk.cust_id is null then k.ldb else rk.ld end as fin_ld,
      case
        when rk.cust_id is null then (case when k.on_lead then k.intv end)
        when rk.ld = 0 then rk.gap - lz.zero
      end as fin_gap,
      ct.cpos as ts_cpos,
      exists (
        select 1 from ranked r2
        where r2.race_number = e.race_number and r2.class_id = e.class_id and r2.touched
      ) as class_touched
    from entrant e
    join k1 k on k.race_number = e.race_number and k.cust_id = e.cust_id
    join race r on r.race_number = e.race_number
    left join pen pn on pn.race_number = e.race_number and pn.driver_id = e.driver_id
    left join ranked rk on rk.race_number = e.race_number and rk.cust_id = e.cust_id
    left join placed_det pd on pd.race_number = e.race_number and pd.cust_id = e.cust_id
    left join placed_ts pt on pt.race_number = e.race_number and pt.cust_id = e.cust_id
    left join lead_zero lz on lz.race_number = e.race_number
    left join class_ts ct on ct.race_number = e.race_number and ct.cust_id = e.cust_id
  ),
  -- Class positions (BR2.4): ranked, non-DSQ rows in the class, unclassified included.
  -- class-position-ranking = false: classified rows only, DSQ included, as the database does today.
  class_rows as (
    select pr.*,
      case
        when sw_class_position_ranking then
          case when pr.is_dsq then null
               else row_number() over (partition by pr.race_number, pr.class_id, pr.is_dsq order by pr.raw_pos, pr.cust_id) end
        else
          case when pr.classified
               then row_number() over (partition by pr.race_number, pr.class_id, pr.classified order by pr.finish_position, pr.cust_id) end
      end::integer as raw_cpos,
      case
        when sw_class_position_ranking then
          case
            when pr.is_dsq then null
            when not sw_reorder_tie_break and pr.reordered then pr.ts_cpos
            else row_number() over (partition by pr.race_number, pr.class_id, pr.is_dsq order by pr.fin_pos, pr.cust_id)
          end
        else
          case when pr.classified
               then row_number() over (partition by pr.race_number, pr.class_id, pr.classified
                                       order by coalesce(pr.fin_pos, pr.finish_position), pr.cust_id) end
      end::integer as fin_cpos
    from pos_rows pr
  ),
  -- One row per set; bonus_p is the position the position-dependent bonuses use.
  sets as (
    select 'raw'::text as set_name, cr.race_number, cr.cust_id, cr.driver_id, cr.class_name,
      cr.starting_position, cr.laps_led, cr.best_lap, cr.incidents, cr.is_dsq, cr.classified,
      cr.raw_pos as p, cr.raw_cpos as cp, cr.raw_pos as bonus_p, cr.raw_pos, cr.raw_cpos, cr.class_touched
    from class_rows cr
    union all
    select 'final'::text, cr.race_number, cr.cust_id, cr.driver_id, cr.class_name,
      cr.starting_position, cr.laps_led, cr.best_lap, cr.incidents, cr.is_dsq, cr.classified,
      cr.fin_pos, cr.fin_cpos,
      case when sw_bonus_after_reorder then cr.fin_pos else cr.raw_pos end,
      cr.raw_pos, cr.raw_cpos, cr.class_touched
    from class_rows cr
  ),
  eligible as (
    select s.* from sets s where s.classified and not s.is_dsq
  ),
  qual_entrant as (
    select
      cq.cust_id,
      cq.qual_position,
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
  pole as (
    select q.cust_id
    from (
      select qe.cust_id, row_number() over (partition by qe.class_id order by qe.qual_position) as rn
      from qual_entrant qe
    ) q
    where q.rn = 1
  ),
  net_gain as (
    select el.set_name, el.race_number, el.cust_id, (el.starting_position - el.bonus_p) as gain
    from eligible el
    where el.starting_position is not null and el.bonus_p is not null
  ),
  aggression as (
    select ng.set_name, ng.race_number, ng.cust_id
    from net_gain ng
    join (
      select g.set_name, g.race_number, max(g.gain) as best
      from net_gain g group by g.set_name, g.race_number
    ) b on b.set_name = ng.set_name and b.race_number = ng.race_number and b.best = ng.gain
    where b.best > 0
  ),
  fewest_race as (
    select el.set_name, el.race_number, el.cust_id
    from eligible el
    where b_fewest_top_x > 0 and el.bonus_p <= b_fewest_top_x
      and el.incidents = (
        select min(e2.incidents) from eligible e2
        where e2.set_name = el.set_name and e2.race_number = el.race_number
          and e2.bonus_p <= b_fewest_top_x
      )
  ),
  fastest_race as (
    select el.set_name, el.race_number, el.cust_id
    from eligible el
    where b_fastest_top_x > 0 and el.bonus_p <= b_fastest_top_x and el.best_lap is not null
      and el.best_lap = (
        select min(e2.best_lap) from eligible e2
        where e2.set_name = el.set_name and e2.race_number = el.race_number
          and e2.bonus_p <= b_fastest_top_x and e2.best_lap is not null
      )
  ),
  round_stats as (
    select el.set_name, el.cust_id,
      min(el.bonus_p) as best_pos, sum(el.incidents) as round_incidents, min(el.best_lap) as round_best_lap
    from eligible el
    group by el.set_name, el.cust_id
  ),
  fewest_round as (
    select rs.set_name, rs.cust_id
    from round_stats rs
    where b_fewest_top_x > 0 and rs.best_pos <= b_fewest_top_x
      and rs.round_incidents = (
        select min(r2.round_incidents) from round_stats r2
        where r2.set_name = rs.set_name and b_fewest_top_x > 0 and r2.best_pos <= b_fewest_top_x
      )
  ),
  fastest_round as (
    select rs.set_name, rs.cust_id
    from round_stats rs
    where b_fastest_top_x > 0 and rs.best_pos <= b_fastest_top_x and rs.round_best_lap is not null
      and rs.round_best_lap = (
        select min(r2.round_best_lap) from round_stats r2
        where r2.set_name = rs.set_name and r2.best_pos <= b_fastest_top_x and r2.round_best_lap is not null
      )
  ),
  sweep as (
    select el.set_name, el.cust_id
    from eligible el
    where el.bonus_p = 1
    group by el.set_name, el.cust_id
    having v_round.format = 'sprint'
      and (select count(distinct en.race_number) from entrant en) > 1
      and count(*) = (select count(distinct en.race_number) from entrant en)
  ),
  priced as (
    select s.set_name, s.race_number, s.cust_id, s.driver_id, s.is_dsq, s.p, s.cp,
      case
        when s.is_dsq or not s.classified then 0
        when s.set_name = 'raw' then
          private.scoring_finish_points(v_rules, v_round.format, s.race_number, v_override_active, s.p, not sw_short_points_table)
        when not sw_per_class_pricing then
          case when s.cp is distinct from s.raw_cpos
               then private.scoring_finish_points(v_rules, v_round.format, s.race_number, v_override_active, s.cp, not sw_short_points_table)
               else private.scoring_finish_points(v_rules, v_round.format, s.race_number, v_override_active, s.raw_pos, not sw_short_points_table)
          end
        when not sw_cross_class_ripple and not s.class_touched then
          private.scoring_finish_points(v_rules, v_round.format, s.race_number, v_override_active, s.raw_pos, not sw_short_points_table)
        else
          private.scoring_finish_points(v_rules, v_round.format, s.race_number, v_override_active, s.p, not sw_short_points_table)
      end as finish_points,
      case
        when s.is_dsq or not s.classified then 0
        else private.scoring_class_points(v_rules, v_round.format, s.race_number, s.class_name, s.cp)
      end as class_points,
      case
        when s.is_dsq or not s.classified or not b_finesse then 0
        when coalesce(s.incidents, 0) <= coalesce((v_rules -> 'bonuses' -> 'sublime_finesse' ->> 'max_incidents')::integer, 0)
          then coalesce((v_rules -> 'bonuses' -> 'sublime_finesse' ->> v_round.format)::integer, 0)
        else 0
      end as finesse_bonus,
      case
        when s.is_dsq or not b_class_pole then 0
        when s.race_number = 1 and s.cust_id in (select po.cust_id from pole po)
          then coalesce((v_rules -> 'bonuses' -> 'class_pole' ->> v_round.format)::integer, 0)
        else 0
      end as pole_bonus,
      case
        when s.is_dsq or not s.classified or not b_aggression then 0
        when exists (select 1 from aggression a where a.set_name = s.set_name and a.race_number = s.race_number and a.cust_id = s.cust_id)
          then coalesce((v_rules -> 'bonuses' -> 'naked_aggression' ->> v_round.format)::integer, 0)
        else 0
      end as aggression_bonus,
      case
        when s.is_dsq or not s.classified or not b_lap_led then 0
        when coalesce(s.laps_led, 0) > 0
          then coalesce((v_rules -> 'bonuses' -> 'lap_led' ->> v_round.format)::integer, 0)
        else 0
      end as lap_led_bonus,
      case
        when s.is_dsq or not s.classified or not b_fewest then 0
        when b_fewest_per = 'round' then
          case when s.race_number = 1
                    and exists (select 1 from fewest_round f where f.set_name = s.set_name and f.cust_id = s.cust_id)
               then coalesce((v_rules -> 'bonuses' -> 'fewest_incidents' ->> v_round.format)::integer, 0)
               else 0 end
        when exists (select 1 from fewest_race f where f.set_name = s.set_name and f.race_number = s.race_number and f.cust_id = s.cust_id)
          then coalesce((v_rules -> 'bonuses' -> 'fewest_incidents' ->> v_round.format)::integer, 0)
        else 0
      end as fewest_incidents_bonus,
      case
        when s.is_dsq or not s.classified or not b_fastest then 0
        when b_fastest_per = 'round' then
          case when s.race_number = 1
                    and exists (select 1 from fastest_round f where f.set_name = s.set_name and f.cust_id = s.cust_id)
               then coalesce((v_rules -> 'bonuses' -> 'fastest_lap' ->> v_round.format)::integer, 0)
               else 0 end
        when exists (select 1 from fastest_race f where f.set_name = s.set_name and f.race_number = s.race_number and f.cust_id = s.cust_id)
          then coalesce((v_rules -> 'bonuses' -> 'fastest_lap' ->> v_round.format)::integer, 0)
        else 0
      end as fastest_lap_bonus,
      case
        when s.is_dsq or not b_sweep then 0
        when s.race_number = 1 and exists (select 1 from sweep w where w.set_name = s.set_name and w.cust_id = s.cust_id)
          then coalesce((v_rules -> 'bonuses' -> 'sprint_sweep' ->> 'points')::integer, 0)
        else 0
      end as sprint_sweep_bonus
    from sets s
  ),
  joined as (
    select
      cr.*,
      rw.finish_points as r_finish, rw.class_points as r_class, rw.finesse_bonus as r_finesse,
      rw.pole_bonus as r_pole, rw.aggression_bonus as r_aggr, rw.lap_led_bonus as r_lap_led,
      rw.fewest_incidents_bonus as r_fewest, rw.fastest_lap_bonus as r_fastest, rw.sprint_sweep_bonus as r_sweep,
      fn.finish_points as f_finish, fn.class_points as f_class, fn.finesse_bonus as f_finesse,
      fn.pole_bonus as f_pole, fn.aggression_bonus as f_aggr, fn.lap_led_bonus as f_lap_led,
      fn.fewest_incidents_bonus as f_fewest, fn.fastest_lap_bonus as f_fastest, fn.sprint_sweep_bonus as f_sweep,
      -- BR2.5: subtracted, kept on a DSQ (Q4 A); the switches restore today's behaviour.
      (case
        when cr.is_dsq then case when sw_dsq_flat_penalty then cr.pen_points else 0 end
        else case when sw_deduction_sign then cr.pen_points else 0 end
      end)::integer as f_deduction,
      case when cr.raw_rt is not null then cr.raw_rt + cr.pen_t end as fin_rt
    from class_rows cr
    join priced rw on rw.set_name = 'raw' and rw.race_number = cr.race_number and rw.cust_id = cr.cust_id
    join priced fn on fn.set_name = 'final' and fn.race_number = cr.race_number and fn.cust_id = cr.cust_id
  ),
  totals as (
    select j.*,
      (j.r_finish + j.r_class + j.r_finesse + j.r_pole + j.r_aggr + j.r_lap_led + j.r_fewest + j.r_fastest + j.r_sweep) as r_class_total,
      (j.f_finish + j.f_class + j.f_finesse + j.f_pole + j.f_aggr + j.f_lap_led + j.f_fewest + j.f_fastest + j.f_sweep
        - j.f_deduction) as f_class_total
    from joined j
  )
  select
    p_subsession_id,
    t.race_number,
    t.driver_id,
    v_round.season_id,
    t.class_id,
    t.team_id,
    t.finish_position,
    t.classified,
    t.is_dsq,
    t.raw_pos,
    t.raw_cpos,
    t.raw_ld,
    round(t.raw_gap / 10)::integer,
    round(t.raw_rt / 10)::integer,
    t.r_finish, t.r_class, t.r_finesse, t.r_pole, t.r_aggr, t.r_lap_led, t.r_fewest, t.r_fastest, t.r_sweep,
    (case when sw_overall_formula then t.r_class_total - t.r_class
          else t.r_finish + t.r_finesse + t.r_pole end)::integer,
    t.r_class_total::integer,
    t.fin_pos,
    t.fin_cpos,
    t.fin_ld,
    round(t.fin_gap / 10)::integer,
    round(t.fin_rt / 10)::integer,
    t.f_finish, t.f_class, t.f_finesse, t.f_pole, t.f_aggr, t.f_lap_led, t.f_fewest, t.f_fastest, t.f_sweep,
    t.f_deduction,
    (case when sw_overall_formula then t.f_class_total - t.f_class
          else t.f_finish + t.f_finesse + t.f_pole - t.f_deduction end)::integer,
    t.f_class_total::integer,
    -- Penalised: an effective penalty changed this row's position, laps, time or points (gaps
    -- alone do not count: a penalised leader re-zeroes everyone's gap).
    (t.f_deduction <> 0
      or row(t.fin_pos, t.fin_cpos, t.fin_ld, round(t.fin_rt / 10),
             t.f_finish, t.f_class, t.f_finesse, t.f_pole, t.f_aggr, t.f_lap_led, t.f_fewest, t.f_fastest, t.f_sweep)
         is distinct from
         row(t.raw_pos, t.raw_cpos, t.raw_ld, round(t.raw_rt / 10),
             t.r_finish, t.r_class, t.r_finesse, t.r_pole, t.r_aggr, t.r_lap_led, t.r_fewest, t.r_fastest, t.r_sweep)),
    v_now
  from totals t;
end;
$$;

revoke all on function private.scoring_switch_names() from public, anon, authenticated, service_role;
revoke all on function private.scoring_compute(bigint, jsonb) from public, anon, authenticated, service_role;
