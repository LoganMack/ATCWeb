-- Three fixes to recalculate_race_scores, bundled together since they all
-- touch the same function:
--
-- 1. Defensive bonus/points lookups (Logan: recalculating ATC15 only wrote
--    1 round, ATC14 wrote none). Root cause: recalculate_race_scores reads
--    v_rules->'bonuses'->'class_pole'->>format unconditionally whenever a
--    pole-sitter is found, and casts the result straight to ::int. When a
--    ruleset simply doesn't define a class_pole bonus (a legitimate ruleset
--    choice — confirmed with Logan that class pole didn't exist before
--    ATC17), that lookup returns SQL NULL, and inserting NULL into
--    race_scores.pole_bonus (NOT NULL) blew up the entire round with a
--    cryptic "null value in column pole_bonus violates not-null
--    constraint" — every round that happened to have an actual pole-sitter
--    on file failed outright; only rounds where nobody matched the pole
--    lookup slipped through, which is why ATC15 wrote exactly 1 round (the
--    only one with no qualifying-derived pole match) and ATC14 wrote none.
--    naked_aggression already guarded against this with its own
--    coalesce(..., 0) — this migration applies that same "missing bonus
--    means nobody earns it" treatment to class_pole, sublime_finesse, and
--    class_points, instead of only naked_aggression. A genuinely-required
--    field (base_points/classified_minimum for the round's own format) is
--    still validated up front with a clear, admin-readable exception rather
--    than silently defaulting — those aren't optional bonuses, a ruleset
--    missing its actual points table is a real misconfiguration.
--
-- 2. Optional second-sprint-race points (Logan: "the second sprint race
--    always had a different points haul than the first sprint race").
--    base_points.sprint_race2, if present, is used for every sprint race
--    after the first (race_number > 1); otherwise every race in a sprint
--    round keeps using base_points.sprint exactly as before — so this is a
--    pure opt-in, no behavior change for any ruleset that doesn't set it.
--
-- 3. Per-season class override (Logan: "the Gamma class did not exist
--    until ATC16 ... create a class column in the race results to track
--    each driver's per-season class"). A driver's CLASS can change over
--    their career (e.g. someone who's Gamma today may have raced Alpha
--    back in ATC14, before Gamma existed at all) — scoring always used
--    drivers.class_id, the driver's CURRENT class, which silently
--    misattributes every historical round to whatever class a driver
--    happens to be in today. driver_season_classes (below) is an optional
--    per-driver-per-season override, populated by a future data import;
--    scoring prefers it when present and falls back to drivers.class_id
--    otherwise, so nothing changes until historical rows actually get
--    imported.
create table public.driver_season_classes (
  driver_id  uuid    not null references public.drivers(id) on delete cascade,
  season_id  uuid    not null references public.seasons(id) on delete cascade,
  class_id   integer not null references public.driver_classes(id),
  created_at timestamptz not null default now(),
  primary key (driver_id, season_id)
);

comment on table public.driver_season_classes is
  'Optional override of which class a driver raced as a in a given season — falls back to drivers.class_id (their current class) when no row exists for a driver+season. Needed because a driver''s class can change over their career (e.g. Gamma didn''t exist before ATC16), so scoring an old season by a driver''s CURRENT class can misattribute them. Populated by a manual data import, not any admin UI form.';

alter table public.driver_season_classes enable row level security;

drop policy if exists "public read" on public.driver_season_classes;
create policy "public read" on public.driver_season_classes for select using (true);

drop policy if exists "admin write driver_season_classes" on public.driver_season_classes;
create policy "admin write driver_season_classes" on public.driver_season_classes for insert with check (is_admin());

drop policy if exists "admin update driver_season_classes" on public.driver_season_classes;
create policy "admin update driver_season_classes" on public.driver_season_classes for update using (is_admin());

drop policy if exists "admin delete driver_season_classes" on public.driver_season_classes;
create policy "admin delete driver_season_classes" on public.driver_season_classes for delete using (is_admin());

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
      d.team_id,
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
              -- Optional second-sprint-race points table — every race
              -- after the first in a sprint round uses it when the
              -- ruleset defines one; falls straight back to the normal
              -- base_points.sprint table (same as every prior race)
              -- when it doesn't, so this is a no-op for any ruleset
              -- that never sets it.
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
        -- coalesce to '[]' rather than leaving this NULL when the
        -- ruleset has no class_podium at all — a bare `? c.class_name`
        -- against NULL is itself NULL (neither true nor false), which
        -- would silently fall through to the next WHEN instead of
        -- reliably excluding every class the way an empty list does.
        when not (coalesce(v_rules->'class_podium'->'applies_to', '[]'::jsonb) ? c.class_name) then 0
        when cr.class_position is null or cr.class_position > 3 then 0
        else coalesce((v_rules->'class_podium'->v_round.format->>(cr.class_position - 1))::int, 0)
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

-- Admin Seasons page: per-season checkboxes to activate Gamma/Delta (Logan:
-- "The Gamma class did not exist until ATC16 ... introduce a checkbox to
-- activate the delta and gamma classes for each season"). Explicit flags
-- rather than inferring "does this class have any data yet" from
-- race_scores, since that heuristic breaks the moment historical class
-- data starts getting backfilled via driver_season_classes above — a
-- season admins haven't imported yet would flicker between "no class" and
-- "has class" as data trickles in, instead of being a stable yes/no an
-- admin sets once.
alter table public.seasons
  add column gamma_enabled boolean not null default false,
  add column delta_enabled boolean not null default false;

comment on column public.seasons.gamma_enabled is
  'Whether the Gamma class competed this season — controls whether Gamma standings/champions/tabs show for this season on the public site. Gamma did not exist before ATC16.';
comment on column public.seasons.delta_enabled is
  'Whether the Delta class competed this season — controls whether Delta standings/champions/tabs show for this season on the public site. Delta did not exist before ATC5.';

-- Backfill existing championship seasons using the same cutoffs already
-- documented elsewhere in this codebase (src/lib/results.ts:
-- "Gamma before ATC16, Delta before ATC5"). Exhibition/off-season entries
-- (non-"ATCxx"-named seasons) are left at the false default — they're
-- already excluded from all standings computation via isChampionshipSeason,
-- so these flags are moot for them either way.
update public.seasons set gamma_enabled = true where name ~ '^ATC[0-9]+$' and number >= 16;
update public.seasons set delta_enabled = true where name ~ '^ATC[0-9]+$' and number >= 5;
