-- Database-owned race scoring, expand step (unit scoring-ownership, W1-W3).
--
-- What: adds a second, complete scoring path beside today's one.
--   * race_score_results: one row per race and rostered driver, holding the raw result (as
--     finished, no penalty) and the final result (every effective penalty and appeal applied)
--     side by side. Only score_round() inserts or updates it (BR1.3 guard trigger).
--   * scoring_issues: rounds that cannot be scored (no season, no format, missing ruleset data)
--     or whose trigger-driven rescore failed, recorded instead of raised (BR3.5, BR3.7).
--   * scoring_settings: one row; triggers_enabled is the owner's kill switch (BR3.7).
--   * score_round(bigint): scores one round and replaces its rows (service_role and triggers).
--   * score_round_preview(bigint, jsonb): the same computation, read-only, with the owner-decided
--     changes switchable for the comparison (BR6.2). '{}' returns exactly what score_round writes.
--   * rescore_season(uuid): admin-checked, scores every round of a season (BR3.4).
--   * race_score_results_public: the view pages will read after the switch. Non-admins see the
--     raw set of an unposted round, everyone else the final set (BR4.1, BR4.2).
--   * Three statement-level triggers (INSERT, UPDATE, DELETE) on each scoring input table, so a
--     change to a scoring column rescores the rounds it touches in the same statement (BR3.1).
--
-- Why: today two engines score a race. recalculate_race_scores() writes race_scores but ignores
-- time penalties and adds deductions instead of subtracting them, and src/lib/penalties/ re-applies
-- every penalty on each page view. This migration moves the whole calculation into the database.
-- It only adds objects: race_scores, recalculate_race_scores() and race_scores_public are left
-- exactly as they are, so no live page changes until the switch PR moves the pages over.
--
-- Placement after a time penalty (BR2.3) is deterministic: untouched rows keep their raw relative
-- order and each time-penalised row is placed before the first untouched row of its laps-down
-- group whose gap is larger. The TypeScript comparator is not a strict order, so it cannot be
-- copied by a query; score_round_preview with "reorder-tie-break": false reproduces it (V8's
-- binary insertion sort, exact for races under 64 entrants) so the comparison can attribute any
-- difference to that cause.
--
-- Undo: supabase/down/20261021120000_race_score_results_expand.down.sql drops only these objects.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table public.race_score_results (
  subsession_id bigint not null references public.curated_rounds (subsession_id) on delete cascade,
  race_number integer not null check (race_number >= 1),
  driver_id uuid not null references public.drivers (id) on delete cascade,
  -- Plain columns, no foreign key: the round's season and the driver's team at scoring time.
  -- A SET NULL key would update rows behind score_round's back (BR1.3).
  season_id uuid not null,
  class_id integer not null references public.driver_classes (id),
  team_id uuid,
  -- The finishing slot as loaded (adjusted_position, else finish_position); kept for DSQ rows too,
  -- so pages can list them in raw order after the ranked rows.
  finish_position integer not null,
  classified boolean not null,
  dsq boolean not null,

  raw_position integer,
  raw_class_position integer,
  raw_laps_down integer,
  raw_gap_ms integer,
  raw_race_time_ms integer,
  raw_finish_points integer not null,
  raw_class_points integer not null,
  raw_finesse_bonus integer not null,
  raw_pole_bonus integer not null,
  raw_aggression_bonus integer not null,
  raw_lap_led_bonus integer not null,
  raw_fewest_incidents_bonus integer not null,
  raw_fastest_lap_bonus integer not null,
  raw_sprint_sweep_bonus integer not null,
  raw_overall_total integer not null,
  raw_class_total integer not null,

  final_position integer,
  final_class_position integer,
  final_laps_down integer,
  final_gap_ms integer,
  final_race_time_ms integer,
  final_finish_points integer not null,
  final_class_points integer not null,
  final_finesse_bonus integer not null,
  final_pole_bonus integer not null,
  final_aggression_bonus integer not null,
  final_lap_led_bonus integer not null,
  final_fewest_incidents_bonus integer not null,
  final_fastest_lap_bonus integer not null,
  final_sprint_sweep_bonus integer not null,
  final_points_deduction integer not null check (final_points_deduction >= 0),
  final_overall_total integer not null,
  final_class_total integer not null,

  penalised boolean not null,
  scored_at timestamp with time zone not null,
  primary key (subsession_id, race_number, driver_id)
);

create index race_score_results_driver_idx on public.race_score_results (driver_id);
create index race_score_results_season_idx on public.race_score_results (season_id);
create index race_score_results_class_idx on public.race_score_results (class_id);

comment on table public.race_score_results is
  'Raw and final result of every race and rostered driver, written only by score_round(). Pages read race_score_results_public.';

-- RLS on with no policy for anon or authenticated: the public view is the only read path.
alter table public.race_score_results enable row level security;

create table public.scoring_issues (
  subsession_id bigint primary key references public.curated_rounds (subsession_id) on delete cascade,
  season_id uuid,
  message text not null,
  first_seen_at timestamp with time zone not null default now(),
  last_seen_at timestamp with time zone not null default now()
);

comment on table public.scoring_issues is
  'Rounds score_round() could not score, or whose trigger-driven rescore failed. Cleared when the round scores.';

alter table public.scoring_issues enable row level security;

create policy "admin read scoring_issues" on public.scoring_issues
  for select to authenticated using ((select public.is_admin()));

create table public.scoring_settings (
  id boolean primary key default true constraint scoring_settings_single_row check (id),
  triggers_enabled boolean not null default true,
  updated_at timestamp with time zone not null default now()
);

comment on table public.scoring_settings is
  'One row. triggers_enabled = false stops the scoring triggers (kill switch until the contract step).';

alter table public.scoring_settings enable row level security;

insert into public.scoring_settings default values;

-- ---------------------------------------------------------------------------------------------
-- Write guard (BR1.3)
-- ---------------------------------------------------------------------------------------------

create function private.race_score_results_guard() returns trigger
  language plpgsql
  set search_path = ''
  as $$
begin
  -- Deletes are not routed here: score_round's own delete and the ON DELETE CASCADE keys must pass.
  if coalesce(current_setting('atc.scoring_writer', true), '') <> 'on' then
    raise exception 'race_score_results is written only by score_round()'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger race_score_results_guard
  before insert or update on public.race_score_results
  for each row execute function private.race_score_results_guard();

-- ---------------------------------------------------------------------------------------------
-- Helpers (private schema; not exposed through the API, EXECUTE revoked below)
-- ---------------------------------------------------------------------------------------------

-- The owner-decided changes score_round applies (BR6.2). Each is true in score_round; a preview
-- sets one false to get today's behaviour for that cause.
create function private.scoring_switch_names() returns text[]
  language sql immutable
  set search_path = ''
  as $$
  select array[
    'deduction-sign', 'bonus-after-reorder', 'cross-class-ripple', 'per-class-pricing',
    'overall-formula', 'short-points-table', 'non-race-penalty', 'dsq-flat-penalty',
    'class-position-ranking', 'reorder-tie-break'
  ];
$$;

create function private.scoring_triggers_enabled() returns boolean
  language sql stable
  set search_path = ''
  as $$
  select coalesce((select s.triggers_enabled from public.scoring_settings s where s.id), true);
$$;

-- Why a round cannot be scored, or null when it can (BR3.5). Same checks, in the same order, as
-- recalculate_race_scores().
create function private.scoring_unscorable_reason(p_subsession_id bigint) returns text
  language plpgsql stable
  set search_path = ''
  as $$
declare
  v_round public.curated_rounds;
  v_ruleset_id uuid;
  v_rules jsonb;
begin
  select * into v_round from public.curated_rounds where subsession_id = p_subsession_id;
  if not found then
    return format('No such round: %s', p_subsession_id);
  end if;
  if v_round.season_id is null then
    return format('Round %s is not linked to a season', p_subsession_id);
  end if;
  if v_round.format is null then
    return format('Round %s has no format; scoring cannot pick a points table', p_subsession_id);
  end if;
  select s.scoring_ruleset_id, r.rules into v_ruleset_id, v_rules
  from public.seasons s
  left join public.scoring_rulesets r on r.id = s.scoring_ruleset_id
  where s.id = v_round.season_id;
  if v_rules is null then
    return format('Season %s has no scoring ruleset', v_round.season_id);
  end if;
  if v_rules -> 'base_points' -> v_round.format is null then
    return format('Ruleset %s has no base_points for format %s', v_ruleset_id, v_round.format);
  end if;
  if v_rules -> 'classified_minimum' ->> v_round.format is null then
    return format('Ruleset %s has no classified_minimum for format %s', v_ruleset_id, v_round.format);
  end if;
  return null;
end;
$$;

-- Finish points for one overall position. p_legacy_short = true is today's database rule (a
-- position inside 40 but past the end of a short table scores 0); false is the site's rule
-- (classified_minimum past the end of the table, Q4 A).
create function private.scoring_finish_points(
  p_rules jsonb, p_format text, p_race_number integer, p_override boolean, p_position integer,
  p_legacy_short boolean
) returns integer
  language sql immutable
  set search_path = ''
  as $$
  with t as (
    select
      case
        when p_override and (p_rules -> 'race_overrides' -> 'base_points' ? p_race_number::text)
          then p_rules -> 'race_overrides' -> 'base_points' -> p_race_number::text
        when p_format = 'sprint' and p_race_number = 3 and (p_rules -> 'base_points' ? 'sprint_race3')
          then p_rules -> 'base_points' -> 'sprint_race3'
        when p_format = 'sprint' and p_race_number > 1 and (p_rules -> 'base_points' ? 'sprint_race2')
          then p_rules -> 'base_points' -> 'sprint_race2'
        else p_rules -> 'base_points' -> p_format
      end as tbl,
      case
        when p_override and (p_rules -> 'race_overrides' -> 'classified_minimum' ? p_race_number::text)
          then p_rules -> 'race_overrides' -> 'classified_minimum' ->> p_race_number::text
        else p_rules -> 'classified_minimum' ->> p_format
      end as cmin
  )
  select case
    when p_position is null then 0
    when p_legacy_short then
      case when p_position <= 40 then coalesce((t.tbl ->> (p_position - 1))::integer, 0)
           else coalesce(t.cmin::integer, 0) end
    when jsonb_typeof(t.tbl) = 'array' and p_position between 1 and jsonb_array_length(t.tbl)
      then coalesce((t.tbl ->> (p_position - 1))::integer, 0)
    else coalesce(t.cmin::integer, 0)
  end
  from t;
$$;

-- Class podium points for one class position; 0 for a class the ruleset does not award.
create function private.scoring_class_points(
  p_rules jsonb, p_format text, p_race_number integer, p_class_name text, p_class_position integer
) returns integer
  language sql immutable
  set search_path = ''
  as $$
  select case
    when p_class_position is null or p_class_position < 1 then 0
    when not (coalesce(p_rules -> 'class_podium' -> 'applies_to', '[]'::jsonb) ? p_class_name) then 0
    else coalesce((
      case
        when p_format = 'sprint' and p_race_number = 3 and (p_rules -> 'class_podium' ? 'sprint_race3')
          then p_rules -> 'class_podium' -> 'sprint_race3' ->> (p_class_position - 1)
        when p_format = 'sprint' and p_race_number > 1 and (p_rules -> 'class_podium' ? 'sprint_race2')
          then p_rules -> 'class_podium' -> 'sprint_race2' ->> (p_class_position - 1)
        else p_rules -> 'class_podium' -> p_format ->> (p_class_position - 1)
      end
    )::integer, 0)
  end;
$$;

-- src/lib/penalties/reorder.ts's comparator, for the reorder-tie-break preview only.
create function private.scoring_ts_compare(
  a_laps_down integer, a_gap numeric, a_touched boolean, a_position integer,
  b_laps_down integer, b_gap numeric, b_touched boolean, b_position integer
) returns numeric
  language sql immutable
  set search_path = ''
  as $$
  select case
    when a_laps_down <> b_laps_down then (a_laps_down - b_laps_down)::numeric
    when not a_touched and not b_touched then (a_position - b_position)::numeric
    when a_gap is not null and b_gap is not null and a_gap <> b_gap then a_gap - b_gap
    else (a_position - b_position)::numeric
  end;
$$;

-- The order V8's Array.prototype.sort leaves the reorder keys in (TimSort: one natural run, then
-- binary insertion sort, which is the whole algorithm below 64 elements). Inputs are parallel
-- arrays in raw order; returns their 1-based indexes in sorted order. Used only by the
-- reorder-tie-break preview, so the comparison can reproduce what the site shows today.
create function private.scoring_ts_order(
  p_laps_down integer[], p_gap numeric[], p_touched boolean[], p_position integer[]
) returns integer[]
  language plpgsql immutable
  set search_path = ''
  as $$
declare
  n integer := coalesce(array_length(p_laps_down, 1), 0);
  w integer[];
  run_length integer;
  is_descending boolean;
  prev integer;
  i integer;
  s integer;
  lo integer;
  hi integer;
  mid integer;
  pivot integer;
  tmp integer;
begin
  if n >= 64 then
    raise exception 'scoring_ts_order reproduces V8 only below 64 rows (got %)', n;
  end if;
  w := array(select generate_series(1, n));
  if n < 2 then
    return w;
  end if;

  -- CountAndMakeRun
  run_length := 2;
  is_descending := private.scoring_ts_compare(
    p_laps_down[w[2]], p_gap[w[2]], p_touched[w[2]], p_position[w[2]],
    p_laps_down[w[1]], p_gap[w[1]], p_touched[w[1]], p_position[w[1]]) < 0;
  prev := w[2];
  for i in 3 .. n loop
    if is_descending then
      exit when private.scoring_ts_compare(
        p_laps_down[w[i]], p_gap[w[i]], p_touched[w[i]], p_position[w[i]],
        p_laps_down[prev], p_gap[prev], p_touched[prev], p_position[prev]) >= 0;
    else
      exit when private.scoring_ts_compare(
        p_laps_down[w[i]], p_gap[w[i]], p_touched[w[i]], p_position[w[i]],
        p_laps_down[prev], p_gap[prev], p_touched[prev], p_position[prev]) < 0;
    end if;
    prev := w[i];
    run_length := run_length + 1;
  end loop;
  if is_descending then
    for i in 1 .. run_length / 2 loop
      tmp := w[i];
      w[i] := w[run_length + 1 - i];
      w[run_length + 1 - i] := tmp;
    end loop;
  end if;

  -- BinaryInsertionSort over the rest
  for s in run_length + 1 .. n loop
    pivot := w[s];
    lo := 1;
    hi := s;
    while lo < hi loop
      mid := lo + ((hi - lo) / 2);
      if private.scoring_ts_compare(
           p_laps_down[pivot], p_gap[pivot], p_touched[pivot], p_position[pivot],
           p_laps_down[w[mid]], p_gap[w[mid]], p_touched[w[mid]], p_position[w[mid]]) < 0 then
        hi := mid;
      else
        lo := mid + 1;
      end if;
    end loop;
    for i in reverse s .. lo + 1 loop
      w[i] := w[i - 1];
    end loop;
    w[lo] := pivot;
  end loop;
  return w;
end;
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
create function private.scoring_compute(p_subsession_id bigint, p_switches jsonb)
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

-- Records (or refreshes) a round's open issue.
create function private.scoring_record_issue(p_subsession_id bigint, p_season_id uuid, p_message text)
  returns void
  language sql
  set search_path = ''
  as $$
  insert into public.scoring_issues as si (subsession_id, season_id, message)
  select p_subsession_id, p_season_id, p_message
  where exists (select 1 from public.curated_rounds cr where cr.subsession_id = p_subsession_id)
  on conflict (subsession_id) do update
    set season_id = excluded.season_id, message = excluded.message, last_seen_at = now();
$$;

-- ---------------------------------------------------------------------------------------------
-- score_round, score_round_preview, rescore_season
-- ---------------------------------------------------------------------------------------------

create function public.score_round(p_subsession_id bigint) returns integer
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_season_id uuid;
  v_locked_name text;
  v_reason text;
  v_rows public.race_score_results[];
  v_has_rows boolean;
  v_written integer;
begin
  select cr.season_id into v_season_id from public.curated_rounds cr where cr.subsession_id = p_subsession_id;
  if not found then
    return 0; -- deleted in the same statement; the cascade already removed its rows
  end if;

  -- The same per-season key recalculate_race_scores() takes, so the two serialise.
  if v_season_id is not null then
    perform pg_advisory_xact_lock(hashtext(v_season_id::text));
  end if;

  -- A locked season is the round's season or, for a round just moved, the season its stored rows
  -- belong to (BR3.3).
  select s.name into v_locked_name
  from public.seasons s
  where s.standings_locked_at is not null
    and (s.id = v_season_id
         or s.id in (select r.season_id from public.race_score_results r where r.subsession_id = p_subsession_id))
  order by (s.id = v_season_id) desc
  limit 1;

  v_has_rows := exists (select 1 from public.race_score_results r where r.subsession_id = p_subsession_id);
  v_reason := private.scoring_unscorable_reason(p_subsession_id);

  if v_reason is not null then
    if v_locked_name is not null and v_has_rows then
      raise exception 'This change would alter results in %, whose standings are locked. Unlock the season first.', v_locked_name
        using errcode = 'SC001';
    end if;
    delete from public.race_score_results r where r.subsession_id = p_subsession_id;
    perform private.scoring_record_issue(p_subsession_id, v_season_id, v_reason);
    return 0;
  end if;

  v_rows := array(select c from private.scoring_compute(p_subsession_id, '{}'::jsonb) c);

  if v_locked_name is not null then
    if exists (
         select to_jsonb(x) - 'scored_at' from unnest(v_rows) x
         except
         select to_jsonb(r) - 'scored_at' from public.race_score_results r where r.subsession_id = p_subsession_id
       )
       or exists (
         select to_jsonb(r) - 'scored_at' from public.race_score_results r where r.subsession_id = p_subsession_id
         except
         select to_jsonb(x) - 'scored_at' from unnest(v_rows) x
       ) then
      raise exception 'This change would alter results in %, whose standings are locked. Unlock the season first.', v_locked_name
        using errcode = 'SC001';
    end if;
    delete from public.scoring_issues si where si.subsession_id = p_subsession_id;
    return 0; -- unchanged: nothing to write
  end if;

  perform set_config('atc.scoring_writer', 'on', true);
  delete from public.race_score_results r where r.subsession_id = p_subsession_id;
  insert into public.race_score_results select * from unnest(v_rows);
  get diagnostics v_written = row_count;
  perform set_config('atc.scoring_writer', 'off', true);

  delete from public.scoring_issues si where si.subsession_id = p_subsession_id;
  return v_written;
end;
$$;

comment on function public.score_round(bigint) is
  'Scores one round into race_score_results (raw and final sets). Called by the scoring triggers and rescore_season(); service_role only.';

create function public.score_round_preview(p_subsession_id bigint, p_switches jsonb default '{}'::jsonb)
  returns setof public.race_score_results
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_bad text;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can preview scores'
      using errcode = 'insufficient_privilege';
  end if;
  if p_switches is null or jsonb_typeof(p_switches) <> 'object' then
    raise exception 'Scoring switches must be a JSON object';
  end if;
  select string_agg(e.key, ', ' order by e.key) into v_bad
  from jsonb_each(p_switches) e
  where e.key <> all (private.scoring_switch_names()) or jsonb_typeof(e.value) <> 'boolean';
  if v_bad is not null then
    raise exception 'Unknown or non-boolean scoring switch: %', v_bad;
  end if;

  if private.scoring_unscorable_reason(p_subsession_id) is not null then
    return;
  end if;
  return query select * from private.scoring_compute(p_subsession_id, p_switches);
end;
$$;

comment on function public.score_round_preview(bigint, jsonb) is
  'Read-only: the rows score_round() would write, with owner-decided changes switchable (BR6.2). Admins and service_role.';

create function public.rescore_season(p_season_id uuid)
  returns table (subsession_id bigint, rows_written integer, error_message text)
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_subsession_id bigint;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can recalculate scores'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.seasons s where s.id = p_season_id) then
    raise exception 'No such season: %', p_season_id;
  end if;

  for v_subsession_id in
    select cr.subsession_id from public.curated_rounds cr
    where cr.season_id = p_season_id
    order by cr.subsession_id
  loop
    subsession_id := v_subsession_id;
    begin
      rows_written := public.score_round(v_subsession_id);
      error_message := null;
    exception when others then
      rows_written := null;
      error_message := sqlerrm;
      if sqlstate <> 'SC001' then
        perform private.scoring_record_issue(v_subsession_id, p_season_id, 'Scoring failed: ' || sqlerrm);
      end if;
    end;
    return next;
  end loop;
end;
$$;

comment on function public.rescore_season(uuid) is
  'Admin-checked: scores every round of a season with score_round(), returning one row per round.';

-- ---------------------------------------------------------------------------------------------
-- Triggers on the scoring inputs (W2, BR3.1-BR3.7)
-- ---------------------------------------------------------------------------------------------

-- Scores the given rounds in lock order (season key, then subsession_id). A locked-season refusal
-- aborts the statement; any other fault is recorded and the caller's save goes ahead (BR3.7).
create function private.scoring_rescore(p_subsession_ids bigint[]) returns void
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_round record;
begin
  for v_round in
    select cr.subsession_id, cr.season_id
    from public.curated_rounds cr
    where cr.subsession_id = any (p_subsession_ids)
    order by hashtext(coalesce(cr.season_id::text, '')), cr.subsession_id
  loop
    begin
      perform public.score_round(v_round.subsession_id);
    exception
      when sqlstate 'SC001' then
        raise;
      when others then
        perform private.scoring_record_issue(v_round.subsession_id, v_round.season_id, 'Scoring failed: ' || sqlerrm);
    end;
  end loop;
end;
$$;

-- Rounds of the given seasons that have a race or qualifying result for one of the given drivers.
create function private.scoring_rounds_for_driver_seasons(p_driver_ids uuid[], p_season_ids uuid[])
  returns bigint[]
  language sql stable
  set search_path = ''
  as $$
  select coalesce(array_agg(distinct cr.subsession_id), '{}')
  from unnest(p_driver_ids, p_season_ids) as ds(driver_id, season_id)
  join public.drivers d on d.id = ds.driver_id and d.iracing_cust_id is not null
  join public.curated_rounds cr on cr.season_id = ds.season_id
  where exists (select 1 from public.curated_race_results rr
                where rr.subsession_id = cr.subsession_id and rr.cust_id = d.iracing_cust_id)
     or exists (select 1 from public.curated_qualifying cq
                where cq.subsession_id = cr.subsession_id and cq.cust_id = d.iracing_cust_id);
$$;

-- Each trigger function below keeps only rows whose listed scoring columns changed: for UPDATE,
-- the symmetric difference of the old and new projections, so a no-op or non-scoring edit maps to
-- no round (BR3.2).

create function private.scoring_on_penalties() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v bigint[];
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    v := array(select distinct n.subsession_id from new_rows n);
  elsif tg_op = 'DELETE' then
    v := array(select distinct o.subsession_id from old_rows o);
  else
    v := array(
      select distinct d.subsession_id from (
        (select n.subsession_id, n.race_number, n.session_type, n.driver_id, n.time_penalty_seconds, n.points_penalty,
                n.is_appealed, n.appeal_time_penalty_seconds, n.appeal_points_penalty, n.is_warning from new_rows n
         except
         select o.subsession_id, o.race_number, o.session_type, o.driver_id, o.time_penalty_seconds, o.points_penalty,
                o.is_appealed, o.appeal_time_penalty_seconds, o.appeal_points_penalty, o.is_warning from old_rows o)
        union all
        (select o.subsession_id, o.race_number, o.session_type, o.driver_id, o.time_penalty_seconds, o.points_penalty,
                o.is_appealed, o.appeal_time_penalty_seconds, o.appeal_points_penalty, o.is_warning from old_rows o
         except
         select n.subsession_id, n.race_number, n.session_type, n.driver_id, n.time_penalty_seconds, n.points_penalty,
                n.is_appealed, n.appeal_time_penalty_seconds, n.appeal_points_penalty, n.is_warning from new_rows n)
      ) d);
  end if;
  perform private.scoring_rescore(v);
  return null;
end;
$$;

create function private.scoring_on_curated_rounds() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v bigint[];
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  -- A deleted round needs nothing: ON DELETE CASCADE removes its rows.
  if tg_op = 'INSERT' then
    v := array(select n.subsession_id from new_rows n);
  elsif tg_op = 'UPDATE' then
    v := array(
      select distinct d.subsession_id from (
        (select n.subsession_id, n.season_id, n.format from new_rows n
         except
         select o.subsession_id, o.season_id, o.format from old_rows o)
        union all
        (select o.subsession_id, o.season_id, o.format from old_rows o
         except
         select n.subsession_id, n.season_id, n.format from new_rows n)
      ) d);
  else
    return null;
  end if;
  perform private.scoring_rescore(v);
  return null;
end;
$$;

create function private.scoring_on_curated_race_results() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v bigint[];
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    v := array(select distinct n.subsession_id from new_rows n);
  elsif tg_op = 'DELETE' then
    v := array(select distinct o.subsession_id from old_rows o);
  else
    v := array(
      select distinct d.subsession_id from (
        (select n.subsession_id, n.race_number, n.cust_id, n.finish_position, n.adjusted_position, n.laps_complete,
                n.laps_led, n.incidents, n.reason_out, n.starting_position, n.interval_ten_thousandths,
                n.average_lap_ten_thousandths, n.best_lap_ten_thousandths from new_rows n
         except
         select o.subsession_id, o.race_number, o.cust_id, o.finish_position, o.adjusted_position, o.laps_complete,
                o.laps_led, o.incidents, o.reason_out, o.starting_position, o.interval_ten_thousandths,
                o.average_lap_ten_thousandths, o.best_lap_ten_thousandths from old_rows o)
        union all
        (select o.subsession_id, o.race_number, o.cust_id, o.finish_position, o.adjusted_position, o.laps_complete,
                o.laps_led, o.incidents, o.reason_out, o.starting_position, o.interval_ten_thousandths,
                o.average_lap_ten_thousandths, o.best_lap_ten_thousandths from old_rows o
         except
         select n.subsession_id, n.race_number, n.cust_id, n.finish_position, n.adjusted_position, n.laps_complete,
                n.laps_led, n.incidents, n.reason_out, n.starting_position, n.interval_ten_thousandths,
                n.average_lap_ten_thousandths, n.best_lap_ten_thousandths from new_rows n)
      ) d);
  end if;
  perform private.scoring_rescore(v);
  return null;
end;
$$;

create function private.scoring_on_curated_qualifying() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v bigint[];
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    v := array(select distinct n.subsession_id from new_rows n);
  elsif tg_op = 'DELETE' then
    v := array(select distinct o.subsession_id from old_rows o);
  else
    v := array(
      select distinct d.subsession_id from (
        (select n.subsession_id, n.cust_id, n.qual_position, n.best_lap_ten_thousandths from new_rows n
         except
         select o.subsession_id, o.cust_id, o.qual_position, o.best_lap_ten_thousandths from old_rows o)
        union all
        (select o.subsession_id, o.cust_id, o.qual_position, o.best_lap_ten_thousandths from old_rows o
         except
         select n.subsession_id, n.cust_id, n.qual_position, n.best_lap_ten_thousandths from new_rows n)
      ) d);
  end if;
  perform private.scoring_rescore(v);
  return null;
end;
$$;

create function private.scoring_on_drivers() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_custs bigint[];
  v bigint[];
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    v_custs := array(select n.iracing_cust_id from new_rows n where n.iracing_cust_id is not null);
  elsif tg_op = 'DELETE' then
    v_custs := array(select o.iracing_cust_id from old_rows o where o.iracing_cust_id is not null);
  else
    v_custs := array(
      select d.iracing_cust_id from (
        (select n.iracing_cust_id, n.class_id from new_rows n
         except
         select o.iracing_cust_id, o.class_id from old_rows o)
        union all
        (select o.iracing_cust_id, o.class_id from old_rows o
         except
         select n.iracing_cust_id, n.class_id from new_rows n)
      ) d
      where d.iracing_cust_id is not null);
  end if;
  if coalesce(array_length(v_custs, 1), 0) = 0 then
    return null;
  end if;
  v := array(
    select rr.subsession_id from public.curated_race_results rr where rr.cust_id = any (v_custs)
    union
    select cq.subsession_id from public.curated_qualifying cq where cq.cust_id = any (v_custs));
  perform private.scoring_rescore(v);
  return null;
end;
$$;

create function private.scoring_on_driver_season_classes() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_drivers uuid[];
  v_seasons uuid[];
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    select array_agg(n.driver_id), array_agg(n.season_id) into v_drivers, v_seasons from new_rows n;
  elsif tg_op = 'DELETE' then
    select array_agg(o.driver_id), array_agg(o.season_id) into v_drivers, v_seasons from old_rows o;
  else
    select array_agg(d.driver_id), array_agg(d.season_id) into v_drivers, v_seasons from (
      (select n.driver_id, n.season_id, n.class_id from new_rows n
       except
       select o.driver_id, o.season_id, o.class_id from old_rows o)
      union all
      (select o.driver_id, o.season_id, o.class_id from old_rows o
       except
       select n.driver_id, n.season_id, n.class_id from new_rows n)
    ) d;
  end if;
  if v_drivers is not null then
    perform private.scoring_rescore(private.scoring_rounds_for_driver_seasons(v_drivers, v_seasons));
  end if;
  return null;
end;
$$;

create function private.scoring_on_team_rosters() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_drivers uuid[];
  v_seasons uuid[];
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    select array_agg(n.driver_id), array_agg(n.season_id) into v_drivers, v_seasons from new_rows n;
  elsif tg_op = 'DELETE' then
    select array_agg(o.driver_id), array_agg(o.season_id) into v_drivers, v_seasons from old_rows o;
  else
    select array_agg(d.driver_id), array_agg(d.season_id) into v_drivers, v_seasons from (
      (select n.driver_id, n.team_id, n.season_id from new_rows n
       except
       select o.driver_id, o.team_id, o.season_id from old_rows o)
      union all
      (select o.driver_id, o.team_id, o.season_id from old_rows o
       except
       select n.driver_id, n.team_id, n.season_id from new_rows n)
    ) d;
  end if;
  if v_drivers is not null then
    perform private.scoring_rescore(private.scoring_rounds_for_driver_seasons(v_drivers, v_seasons));
  end if;
  return null;
end;
$$;

create function private.scoring_on_seasons() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_seasons uuid[];
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  -- A new season has no rounds yet, and a deleted one has already set its rounds' season_id to
  -- null (which fires the curated_rounds trigger), so only updates matter here.
  if tg_op <> 'UPDATE' then
    return null;
  end if;
  v_seasons := array(
    select d.id from (
      (select n.id, n.scoring_ruleset_id, n.gamma_enabled, n.delta_enabled from new_rows n
       except
       select o.id, o.scoring_ruleset_id, o.gamma_enabled, o.delta_enabled from old_rows o)
      union all
      (select o.id, o.scoring_ruleset_id, o.gamma_enabled, o.delta_enabled from old_rows o
       except
       select n.id, n.scoring_ruleset_id, n.gamma_enabled, n.delta_enabled from new_rows n)
    ) d);
  perform private.scoring_rescore(array(
    select cr.subsession_id from public.curated_rounds cr where cr.season_id = any (v_seasons)));
  return null;
end;
$$;

create function private.scoring_on_scoring_rulesets() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_rulesets uuid[];
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    v_rulesets := array(select n.id from new_rows n);
  elsif tg_op = 'DELETE' then
    v_rulesets := array(select o.id from old_rows o);
  else
    v_rulesets := array(
      select d.id from (
        (select n.id, n.rules from new_rows n
         except
         select o.id, o.rules from old_rows o)
        union all
        (select o.id, o.rules from old_rows o
         except
         select n.id, n.rules from new_rows n)
      ) d);
  end if;
  perform private.scoring_rescore(array(
    select cr.subsession_id
    from public.curated_rounds cr
    join public.seasons s on s.id = cr.season_id
    where s.scoring_ruleset_id = any (v_rulesets)));
  return null;
end;
$$;

create function private.scoring_on_driver_classes() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_classes integer[];
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    v_classes := array(select n.id from new_rows n);
  elsif tg_op = 'DELETE' then
    v_classes := array(select o.id from old_rows o);
  else
    v_classes := array(
      select d.id from (
        (select n.id, n.name, n.sort_order from new_rows n
         except
         select o.id, o.name, o.sort_order from old_rows o)
        union all
        (select o.id, o.name, o.sort_order from old_rows o
         except
         select n.id, n.name, n.sort_order from new_rows n)
      ) d);
  end if;
  -- Every round of a season that uses the class: as a scored class, a season class, or the
  -- current class of a driver with a result in it. Class names also pick the fallback class.
  perform private.scoring_rescore(array(
    select cr.subsession_id
    from public.curated_rounds cr
    where cr.season_id in (
      select r.season_id from public.race_score_results r where r.class_id = any (v_classes)
      union
      select dsc.season_id from public.driver_season_classes dsc where dsc.class_id = any (v_classes)
      union
      select cr2.season_id
      from public.curated_rounds cr2
      join public.curated_race_results rr on rr.subsession_id = cr2.subsession_id
      join public.drivers d on d.iracing_cust_id = rr.cust_id
      where d.class_id = any (v_classes)
    )));
  return null;
end;
$$;

create trigger scoring_on_penalties_insert after insert on public.penalties
  referencing new table as new_rows for each statement execute function private.scoring_on_penalties();
create trigger scoring_on_penalties_update after update on public.penalties
  referencing old table as old_rows new table as new_rows for each statement execute function private.scoring_on_penalties();
create trigger scoring_on_penalties_delete after delete on public.penalties
  referencing old table as old_rows for each statement execute function private.scoring_on_penalties();

create trigger scoring_on_curated_rounds_insert after insert on public.curated_rounds
  referencing new table as new_rows for each statement execute function private.scoring_on_curated_rounds();
create trigger scoring_on_curated_rounds_update after update on public.curated_rounds
  referencing old table as old_rows new table as new_rows for each statement execute function private.scoring_on_curated_rounds();
create trigger scoring_on_curated_rounds_delete after delete on public.curated_rounds
  referencing old table as old_rows for each statement execute function private.scoring_on_curated_rounds();

create trigger scoring_on_curated_race_results_insert after insert on public.curated_race_results
  referencing new table as new_rows for each statement execute function private.scoring_on_curated_race_results();
create trigger scoring_on_curated_race_results_update after update on public.curated_race_results
  referencing old table as old_rows new table as new_rows for each statement execute function private.scoring_on_curated_race_results();
create trigger scoring_on_curated_race_results_delete after delete on public.curated_race_results
  referencing old table as old_rows for each statement execute function private.scoring_on_curated_race_results();

create trigger scoring_on_curated_qualifying_insert after insert on public.curated_qualifying
  referencing new table as new_rows for each statement execute function private.scoring_on_curated_qualifying();
create trigger scoring_on_curated_qualifying_update after update on public.curated_qualifying
  referencing old table as old_rows new table as new_rows for each statement execute function private.scoring_on_curated_qualifying();
create trigger scoring_on_curated_qualifying_delete after delete on public.curated_qualifying
  referencing old table as old_rows for each statement execute function private.scoring_on_curated_qualifying();

create trigger scoring_on_drivers_insert after insert on public.drivers
  referencing new table as new_rows for each statement execute function private.scoring_on_drivers();
create trigger scoring_on_drivers_update after update on public.drivers
  referencing old table as old_rows new table as new_rows for each statement execute function private.scoring_on_drivers();
create trigger scoring_on_drivers_delete after delete on public.drivers
  referencing old table as old_rows for each statement execute function private.scoring_on_drivers();

create trigger scoring_on_driver_season_classes_insert after insert on public.driver_season_classes
  referencing new table as new_rows for each statement execute function private.scoring_on_driver_season_classes();
create trigger scoring_on_driver_season_classes_update after update on public.driver_season_classes
  referencing old table as old_rows new table as new_rows for each statement execute function private.scoring_on_driver_season_classes();
create trigger scoring_on_driver_season_classes_delete after delete on public.driver_season_classes
  referencing old table as old_rows for each statement execute function private.scoring_on_driver_season_classes();

create trigger scoring_on_team_rosters_insert after insert on public.team_rosters
  referencing new table as new_rows for each statement execute function private.scoring_on_team_rosters();
create trigger scoring_on_team_rosters_update after update on public.team_rosters
  referencing old table as old_rows new table as new_rows for each statement execute function private.scoring_on_team_rosters();
create trigger scoring_on_team_rosters_delete after delete on public.team_rosters
  referencing old table as old_rows for each statement execute function private.scoring_on_team_rosters();

create trigger scoring_on_seasons_insert after insert on public.seasons
  referencing new table as new_rows for each statement execute function private.scoring_on_seasons();
create trigger scoring_on_seasons_update after update on public.seasons
  referencing old table as old_rows new table as new_rows for each statement execute function private.scoring_on_seasons();
create trigger scoring_on_seasons_delete after delete on public.seasons
  referencing old table as old_rows for each statement execute function private.scoring_on_seasons();

create trigger scoring_on_scoring_rulesets_insert after insert on public.scoring_rulesets
  referencing new table as new_rows for each statement execute function private.scoring_on_scoring_rulesets();
create trigger scoring_on_scoring_rulesets_update after update on public.scoring_rulesets
  referencing old table as old_rows new table as new_rows for each statement execute function private.scoring_on_scoring_rulesets();
create trigger scoring_on_scoring_rulesets_delete after delete on public.scoring_rulesets
  referencing old table as old_rows for each statement execute function private.scoring_on_scoring_rulesets();

create trigger scoring_on_driver_classes_insert after insert on public.driver_classes
  referencing new table as new_rows for each statement execute function private.scoring_on_driver_classes();
create trigger scoring_on_driver_classes_update after update on public.driver_classes
  referencing old table as old_rows new table as new_rows for each statement execute function private.scoring_on_driver_classes();
create trigger scoring_on_driver_classes_delete after delete on public.driver_classes
  referencing old table as old_rows for each statement execute function private.scoring_on_driver_classes();

-- ---------------------------------------------------------------------------------------------
-- Public view (W3, BR4.1, BR4.2)
-- ---------------------------------------------------------------------------------------------

-- Runs as its owner on purpose, like race_scores_public: the base table grants nothing to anon or
-- authenticated, so this view is the only public path, and it chooses the set per reader.
create view public.race_score_results_public with (security_invoker = false) as
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
  r.scored_at
from public.race_score_results r
cross join lateral (
  select (
    (select public.is_admin())
    or exists (select 1 from public.round_incident_status s where s.subsession_id = r.subsession_id and s.posted)
  ) as final_visible
) v;

comment on view public.race_score_results_public is
  'race_score_results for pages: the final set for admins and posted rounds, otherwise the raw set (no deduction, not penalised).';

-- ---------------------------------------------------------------------------------------------
-- Privileges. The baseline's default privileges grant anon and authenticated everything on new
-- objects in public, and PUBLIC may execute any new function, so every grant is explicit here.
-- ---------------------------------------------------------------------------------------------

revoke all on table public.race_score_results from public, anon, authenticated, service_role;
grant select on table public.race_score_results to service_role;

revoke all on table public.scoring_issues from public, anon, authenticated, service_role;
grant select on table public.scoring_issues to authenticated, service_role;

revoke all on table public.scoring_settings from public, anon, authenticated, service_role;
grant select on table public.scoring_settings to service_role;

revoke all on table public.race_score_results_public from public, anon, authenticated, service_role;
grant select on table public.race_score_results_public to anon, authenticated, service_role;

revoke all on function public.score_round(bigint) from public, anon, authenticated;
grant execute on function public.score_round(bigint) to service_role;

revoke all on function public.score_round_preview(bigint, jsonb) from public, anon;
grant execute on function public.score_round_preview(bigint, jsonb) to authenticated, service_role;

revoke all on function public.rescore_season(uuid) from public, anon;
grant execute on function public.rescore_season(uuid) to authenticated, service_role;

revoke all on function private.race_score_results_guard() from public, anon, authenticated, service_role;
revoke all on function private.scoring_switch_names() from public, anon, authenticated, service_role;
revoke all on function private.scoring_triggers_enabled() from public, anon, authenticated, service_role;
revoke all on function private.scoring_unscorable_reason(bigint) from public, anon, authenticated, service_role;
revoke all on function private.scoring_finish_points(jsonb, text, integer, boolean, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function private.scoring_class_points(jsonb, text, integer, text, integer) from public, anon, authenticated, service_role;
revoke all on function private.scoring_ts_compare(integer, numeric, boolean, integer, integer, numeric, boolean, integer) from public, anon, authenticated, service_role;
revoke all on function private.scoring_ts_order(integer[], numeric[], boolean[], integer[]) from public, anon, authenticated, service_role;
revoke all on function private.scoring_compute(bigint, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.scoring_record_issue(bigint, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.scoring_rescore(bigint[]) from public, anon, authenticated, service_role;
revoke all on function private.scoring_rounds_for_driver_seasons(uuid[], uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.scoring_on_penalties() from public, anon, authenticated, service_role;
revoke all on function private.scoring_on_curated_rounds() from public, anon, authenticated, service_role;
revoke all on function private.scoring_on_curated_race_results() from public, anon, authenticated, service_role;
revoke all on function private.scoring_on_curated_qualifying() from public, anon, authenticated, service_role;
revoke all on function private.scoring_on_drivers() from public, anon, authenticated, service_role;
revoke all on function private.scoring_on_driver_season_classes() from public, anon, authenticated, service_role;
revoke all on function private.scoring_on_team_rosters() from public, anon, authenticated, service_role;
revoke all on function private.scoring_on_seasons() from public, anon, authenticated, service_role;
revoke all on function private.scoring_on_scoring_rulesets() from public, anon, authenticated, service_role;
revoke all on function private.scoring_on_driver_classes() from public, anon, authenticated, service_role;
