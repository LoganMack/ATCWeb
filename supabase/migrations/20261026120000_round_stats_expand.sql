-- Per-round standings building blocks, refreshed by the database (unit precompute, BR1.1, BR2.1-BR2.5,
-- BR3.1, BR3.2, BR5.2; follows 20261025120000).
--
-- What: adds three tables the database keeps current, one deferred refresh per round per transaction,
-- an issues table, and an admin-checked season rebuild.
--   * round_driver_stats: one row per driver with a score row in a round. Points for each view and
--     every per-round counting stat the standings, the "as of round N" slider and the career pages
--     sum: wins, podiums, top 5s and top 10s (class and overall), poles, starts, laps, laps led, net
--     positions, incidents, bonus points, cars used, races under the team and races scored for it.
--   * round_team_stats: one row per team, round and team competition ('overall', and the Alpha and
--     Delta class competitions by class id): the team's top 2 per race, summed, and its starts.
--   * round_penalty_points: every driver's effective (appeal-aware) penalty points in a posted round,
--     score row or not, so a quali or practice penalty for an absent driver is not lost.
--   * round_stats_issues: rounds whose refresh failed, recorded instead of raised. No foreign key, so
--     recording an issue can never block a cascade delete.
--   * private.round_stats_pending: the rounds a transaction touched. Statement-level triggers on every
--     input queue round ids here; one deferrable, initially deferred constraint trigger drains it at
--     commit, so an import or a score_round delete-and-insert refreshes each round once.
--   * private.build_round_stats(bigint), private.refresh_round_stats(bigint[]) and
--     public.rebuild_season_stats(uuid).
--
-- Concealment (BR3.1): the build reads race_score_results directly and picks the raw or final set
-- from round_incident_status.posted. It never reads race_score_results_public or is_admin(), so a
-- refresh run in an admin session still stores what a signed-out visitor sees. Penalty points are
-- stored only for posted rounds, as the penalties RLS policy shows them to visitors.
--
-- Per-row rules mirror src/lib/results (standings.ts, extendedStats.ts, seasonCarTeam.ts,
-- teamStandings.ts): raw results are matched through drivers.iracing_cust_id of non-AI drivers only
-- (driversSelect leaves AI drivers out, so their laps, incidents and cars count 0); the overall pole is
-- race 1's starting position 1 with the highest cust_id among mapped drivers (the last one the
-- TypeScript map keeps); the team top 2 breaks a points tie by shown position, then driver_id.
-- Drop weeks, tiebreaks, ranking, exclusions and km/corners stay in TypeScript (BR1.2).
--
-- Why: every standings, home and career page rebuilds these numbers from about 10,000 score rows plus
-- raw results and penalties on each cache miss; the driver page takes 8-10 s. The tables only add
-- objects and start empty, so no page changes until the page-loading unit reads them after the
-- backfill (rebuild_season_stats for every season) and the parity comparison.
--
-- Kill switch: scoring_settings.triggers_enabled = false stops the queueing and the drain too.
-- rebuild_season_stats keeps working (BR2.2).
--
-- Undo: supabase/down/20261026120000_round_stats_expand.down.sql drops only these objects.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table public.round_driver_stats (
  subsession_id bigint not null references public.curated_rounds (subsession_id) on delete cascade,
  driver_id uuid not null references public.drivers (id) on delete cascade,
  -- Plain columns, as on race_score_results: the round's season and the driver's class and team that
  -- season, as scored.
  season_id uuid not null,
  class_id integer not null,
  team_id uuid,
  -- True when the round is posted, so the final (penalised) set is what visitors see.
  final_visible boolean not null,
  overall_points integer not null,
  class_points integer not null,
  starts integer not null,
  class_wins integer not null,
  class_podiums integer not null,
  class_top5s integer not null,
  class_top10s integer not null,
  overall_wins integer not null,
  overall_podiums integer not null,
  overall_top5s integer not null,
  overall_top10s integer not null,
  overall_pole boolean not null,
  class_pole boolean not null,
  laps integer not null,
  laps_led integer not null,
  net_positions integer not null,
  incidents integer not null,
  bonus_points integer not null,
  cars jsonb not null,
  races_under_team integer not null,
  races_scored_for_team integer not null,
  refreshed_at timestamp with time zone not null,
  primary key (subsession_id, driver_id)
);

create index round_driver_stats_season_idx on public.round_driver_stats (season_id);
create index round_driver_stats_driver_idx on public.round_driver_stats (driver_id);

comment on table public.round_driver_stats is
  'One driver''s numbers for one round, as a signed-out visitor sees them. Written only by the round stats refresh.';

create table public.round_team_stats (
  subsession_id bigint not null references public.curated_rounds (subsession_id) on delete cascade,
  -- No foreign key, as race_score_results.team_id: a deleted team keeps its scored rows.
  team_id uuid not null,
  competition text not null constraint round_team_stats_competition_check check (competition ~ '^(overall|[0-9]+)$'),
  season_id uuid not null,
  points integer not null,
  starts integer not null,
  refreshed_at timestamp with time zone not null,
  primary key (subsession_id, team_id, competition)
);

create index round_team_stats_season_idx on public.round_team_stats (season_id);

comment on table public.round_team_stats is
  'One team''s points (top 2 per race, summed) and starts in one round for one competition: overall, or a class id. Written only by the round stats refresh.';

create table public.round_penalty_points (
  subsession_id bigint not null references public.curated_rounds (subsession_id) on delete cascade,
  driver_id uuid not null references public.drivers (id) on delete cascade,
  season_id uuid not null,
  penalty_points integer not null,
  refreshed_at timestamp with time zone not null,
  primary key (subsession_id, driver_id)
);

create index round_penalty_points_season_idx on public.round_penalty_points (season_id);
create index round_penalty_points_driver_idx on public.round_penalty_points (driver_id);

comment on table public.round_penalty_points is
  'Every driver''s effective penalty points in a posted round, with or without a score row. Written only by the round stats refresh.';

create table public.round_stats_issues (
  subsession_id bigint primary key,
  season_id uuid,
  error_message text not null,
  recorded_at timestamp with time zone not null default now()
);

comment on table public.round_stats_issues is
  'Rounds whose stats refresh failed; their previous rows stay. Cleared when the round refreshes. Admins only.';

create table private.round_stats_pending (
  xact_id xid8 not null default pg_current_xact_id(),
  subsession_id bigint not null,
  primary key (xact_id, subsession_id)
);

comment on table private.round_stats_pending is
  'Rounds the current transaction touched; drained at commit by the round_stats_drain constraint trigger.';

alter table public.round_driver_stats enable row level security;
alter table public.round_team_stats enable row level security;
alter table public.round_penalty_points enable row level security;
alter table public.round_stats_issues enable row level security;
alter table private.round_stats_pending enable row level security;

-- Only visitor-visible numbers are stored, so everyone may read them (BR3.2).
create policy "public read round_driver_stats" on public.round_driver_stats
  for select to anon, authenticated using (true);
create policy "public read round_team_stats" on public.round_team_stats
  for select to anon, authenticated using (true);
create policy "public read round_penalty_points" on public.round_penalty_points
  for select to anon, authenticated using (true);
create policy "admin read round_stats_issues" on public.round_stats_issues
  for select to authenticated using ((select public.is_admin()));

-- ---------------------------------------------------------------------------------------------
-- Write guard
-- ---------------------------------------------------------------------------------------------

create function private.round_stats_guard() returns trigger
  language plpgsql
  set search_path = ''
  as $$
begin
  -- Deletes are not routed here: the refresh's own delete and the ON DELETE CASCADE keys must pass.
  if coalesce(current_setting('atc.stats_writer', true), '') <> 'on' then
    raise exception '% is written only by the round stats refresh', tg_table_name
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger round_driver_stats_guard
  before insert or update on public.round_driver_stats
  for each row execute function private.round_stats_guard();
create trigger round_team_stats_guard
  before insert or update on public.round_team_stats
  for each row execute function private.round_stats_guard();
create trigger round_penalty_points_guard
  before insert or update on public.round_penalty_points
  for each row execute function private.round_stats_guard();

-- ---------------------------------------------------------------------------------------------
-- Build, refresh, rebuild
-- ---------------------------------------------------------------------------------------------

-- Replaces one round's rows in the three tables. The caller holds the season lock and sets
-- atc.stats_writer. A round with no score rows ends with no rows (BR2.5: it is missing from the pool,
-- as an unscored round is today). Returns the number of driver rows written.
create function private.build_round_stats(p_subsession_id bigint) returns integer
  language plpgsql
  set search_path = ''
  as $$
declare
  v_posted boolean;
  v_season_id uuid;
  v_now timestamp with time zone := now();
  v_written integer;
begin
  delete from public.round_driver_stats t where t.subsession_id = p_subsession_id;
  delete from public.round_team_stats t where t.subsession_id = p_subsession_id;
  delete from public.round_penalty_points t where t.subsession_id = p_subsession_id;

  select r.season_id into v_season_id
  from public.race_score_results r where r.subsession_id = p_subsession_id limit 1;
  if not found then
    return 0;
  end if;

  -- The visitor's set: final once posted, raw otherwise. Never is_admin() (BR3.1).
  v_posted := exists (
    select 1 from public.round_incident_status s where s.subsession_id = p_subsession_id and s.posted);

  insert into public.round_driver_stats (
    subsession_id, driver_id, season_id, class_id, team_id, final_visible,
    overall_points, class_points, starts,
    class_wins, class_podiums, class_top5s, class_top10s,
    overall_wins, overall_podiums, overall_top5s, overall_top10s,
    overall_pole, class_pole, laps, laps_led, net_positions, incidents, bonus_points,
    cars, races_under_team, races_scored_for_team, refreshed_at)
  with shown as (
    select
      r.race_number, r.driver_id, r.season_id, r.class_id, r.team_id, r.dsq,
      case when v_posted then r.final_position else r.raw_position end as position,
      case when v_posted then r.final_class_position else r.raw_class_position end as class_position,
      case when v_posted then r.final_finesse_bonus else r.raw_finesse_bonus end as finesse_bonus,
      case when v_posted then r.final_pole_bonus else r.raw_pole_bonus end as pole_bonus,
      case when v_posted then r.final_overall_total else r.raw_overall_total end as overall_total,
      case when v_posted then r.final_class_total else r.raw_class_total end as class_total,
      d.iracing_cust_id as cust_id
    from public.race_score_results r
    -- driversSelect leaves AI drivers out, so their rows find no raw result (laps, incidents, cars 0).
    left join public.drivers d on d.id = r.driver_id and not d.is_ai
    where r.subsession_id = p_subsession_id
  ),
  with_raw as (
    select s.*,
      rr.laps_complete, rr.laps_led, rr.incidents, rr.car_name,
      rr.starting_position, coalesce(rr.adjusted_position, rr.finish_position) as raw_final_position,
      -- The team's top 2 of the race (topTeamScorers), with a fixed order on a points tie.
      case when s.team_id is not null then
        row_number() over (partition by s.race_number, s.team_id
                           order by s.overall_total desc, s.position asc nulls last, s.driver_id)
      end as team_rank
    from shown s
    left join public.curated_race_results rr
      on rr.subsession_id = p_subsession_id and rr.race_number = s.race_number and rr.cust_id = s.cust_id
  ),
  -- Race 1's grid position 1, mapped to a non-AI driver; the highest cust_id wins a tie, as the
  -- TypeScript map (ordered by cust_id) keeps the last one.
  pole as (
    select d.id as driver_id
    from public.curated_race_results rr
    join public.drivers d on d.iracing_cust_id = rr.cust_id and not d.is_ai
    where rr.subsession_id = p_subsession_id and rr.race_number = 1 and rr.starting_position = 1
    order by rr.cust_id desc
    limit 1
  ),
  cars as (
    select c.driver_id, jsonb_object_agg(c.car_name, c.races) as cars
    from (
      select w.driver_id, w.car_name, count(*) as races
      from with_raw w
      where w.car_name is not null and w.car_name <> ''
      group by w.driver_id, w.car_name
    ) c
    group by c.driver_id
  )
  select
    p_subsession_id, w.driver_id, w.season_id, w.class_id, w.team_id, v_posted,
    sum(w.overall_total), sum(w.class_total), count(*),
    count(*) filter (where not w.dsq and w.class_position = 1),
    count(*) filter (where not w.dsq and w.class_position <= 3),
    count(*) filter (where not w.dsq and w.class_position <= 5),
    count(*) filter (where not w.dsq and w.class_position <= 10),
    count(*) filter (where not w.dsq and w.position = 1),
    count(*) filter (where not w.dsq and w.position <= 3),
    count(*) filter (where not w.dsq and w.position <= 5),
    count(*) filter (where not w.dsq and w.position <= 10),
    coalesce(bool_or(w.driver_id = (select p.driver_id from pole p)), false),
    bool_or(w.pole_bonus > 0),
    coalesce(sum(w.laps_complete), 0),
    coalesce(sum(w.laps_led), 0),
    coalesce(sum(w.starting_position - w.raw_final_position) filter (where w.starting_position is not null), 0),
    coalesce(sum(w.incidents), 0),
    sum(w.finesse_bonus + w.pole_bonus),
    coalesce((select c.cars from cars c where c.driver_id = w.driver_id), '{}'::jsonb),
    count(*) filter (where w.team_id is not null),
    count(*) filter (where w.team_rank <= 2),
    v_now
  from with_raw w
  -- One class and one team per driver and season, as scored; two would break the primary key and
  -- fail the round loudly instead of storing a guess.
  group by w.driver_id, w.season_id, w.class_id, w.team_id;
  get diagnostics v_written = row_count;

  insert into public.round_team_stats (subsession_id, team_id, competition, season_id, points, starts, refreshed_at)
  with entries as (
    select
      'overall'::text as competition, r.race_number, r.team_id, r.driver_id, r.season_id,
      case when v_posted then r.final_overall_total else r.raw_overall_total end as points
    from public.race_score_results r
    where r.subsession_id = p_subsession_id and r.team_id is not null
    union all
    -- The Alpha and Delta team competitions, scored like their driver championships (BR2.6).
    select
      r.class_id::text, r.race_number, r.team_id, r.driver_id, r.season_id,
      case
        when dc.name in ('Gamma', 'Delta') then
          case when v_posted then r.final_class_total else r.raw_class_total end
        else case when v_posted then r.final_overall_total else r.raw_overall_total end
      end
    from public.race_score_results r
    join public.driver_classes dc on dc.id = r.class_id
    where r.subsession_id = p_subsession_id and r.team_id is not null and dc.name in ('Alpha', 'Delta')
  ),
  ranked as (
    select e.*,
      row_number() over (partition by e.competition, e.race_number, e.team_id
                         order by e.points desc, e.driver_id) as rn
    from entries e
  )
  select p_subsession_id, k.team_id, k.competition, k.season_id,
    coalesce(sum(k.points) filter (where k.rn <= 2), 0), count(*), v_now
  from ranked k
  group by k.team_id, k.competition, k.season_id;

  -- Visitors see penalties only once a round is posted (the penalties RLS policy).
  if v_posted then
    insert into public.round_penalty_points (subsession_id, driver_id, season_id, penalty_points, refreshed_at)
    select p_subsession_id, p.driver_id, v_season_id,
      sum(case when p.is_appealed then p.appeal_penalty_points else p.penalty_points end), v_now
    from public.penalties p
    where p.subsession_id = p_subsession_id and p.driver_id is not null
    group by p.driver_id;
  end if;

  return v_written;
end;
$$;

-- Records a failed refresh. Its own exception block: a failure here is logged, never raised, so it
-- cannot undo the caller's save or block a cascade delete (BR2.4).
create function private.record_round_stats_issue(p_subsession_id bigint, p_season_id uuid, p_message text)
  returns void
  language plpgsql
  set search_path = ''
  as $$
begin
  begin
    insert into public.round_stats_issues as i (subsession_id, season_id, error_message, recorded_at)
    values (p_subsession_id, p_season_id, p_message, now())
    on conflict (subsession_id) do update
      set season_id = excluded.season_id, error_message = excluded.error_message, recorded_at = now();
  exception when others then
    raise warning 'Could not record the round stats issue for %: % (%)', p_subsession_id, sqlerrm, p_message;
  end;
end;
$$;

-- Refreshes the given rounds in lock order (season key, then subsession_id), each all or nothing:
-- a failure keeps the round's previous rows and records an issue (BR2.3, BR2.4). Rounds no longer in
-- curated_rounds are skipped; the cascade already removed their rows.
create function private.refresh_round_stats(p_subsession_ids bigint[])
  returns table (subsession_id bigint, rows_written integer, error_message text)
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_round record;
begin
  delete from public.round_stats_issues i
  where i.subsession_id = any (p_subsession_ids)
    and not exists (select 1 from public.curated_rounds cr where cr.subsession_id = i.subsession_id);

  for v_round in
    select cr.subsession_id, cr.season_id
    from public.curated_rounds cr
    where cr.subsession_id = any (p_subsession_ids)
    order by hashtext(coalesce(cr.season_id::text, '')), cr.subsession_id
  loop
    subsession_id := v_round.subsession_id;
    begin
      -- The per-season key score_round takes, so a refresh never interleaves with a rescore.
      if v_round.season_id is not null then
        perform pg_advisory_xact_lock(hashtext(v_round.season_id::text));
      end if;
      perform set_config('atc.stats_writer', 'on', true);
      rows_written := private.build_round_stats(v_round.subsession_id);
      perform set_config('atc.stats_writer', 'off', true);
      delete from public.round_stats_issues i where i.subsession_id = v_round.subsession_id;
      error_message := null;
    exception when others then
      perform set_config('atc.stats_writer', 'off', true);
      rows_written := null;
      error_message := sqlerrm;
      perform private.record_round_stats_issue(v_round.subsession_id, v_round.season_id, 'Refresh failed: ' || sqlerrm);
    end;
    return next;
  end loop;
end;
$$;

create function public.rebuild_season_stats(p_season_id uuid)
  returns table (subsession_id bigint, rows_written integer, error_message text)
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can rebuild season stats'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.seasons s where s.id = p_season_id) then
    raise exception 'No such season: %', p_season_id;
  end if;
  -- Not gated by the kill switch, so the owner can rebuild while the triggers are off (BR2.2).
  return query
  select f.subsession_id, f.rows_written, f.error_message
  from private.refresh_round_stats(array(
    select cr.subsession_id from public.curated_rounds cr where cr.season_id = p_season_id)) f;
end;
$$;

comment on function public.rebuild_season_stats(uuid) is
  'Admin-checked: refreshes the round stats of every round of a season, one row per round. Works with the kill switch off.';

-- ---------------------------------------------------------------------------------------------
-- Queue and drain
-- ---------------------------------------------------------------------------------------------

create function private.queue_round_stats(p_subsession_ids bigint[]) returns void
  language sql
  set search_path = ''
  as $$
  insert into private.round_stats_pending (subsession_id)
  select distinct u.id from unnest(p_subsession_ids) as u(id) where u.id is not null
  on conflict do nothing;
$$;

-- Runs at commit. The first event drains every round this transaction queued; later events of the
-- same commit find nothing left.
create function private.round_stats_drain() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v bigint[];
begin
  with d as (
    delete from private.round_stats_pending p
    where p.xact_id = pg_current_xact_id()
    returning p.subsession_id
  )
  select coalesce(array_agg(distinct d.subsession_id), '{}') into v from d;
  if cardinality(v) = 0 or not private.scoring_triggers_enabled() then
    return null;
  end if;
  perform 1 from private.refresh_round_stats(v);
  return null;
end;
$$;

create constraint trigger round_stats_drain
  after insert on private.round_stats_pending
  deferrable initially deferred
  for each row execute function private.round_stats_drain();

-- Each queue function keeps, for UPDATE, only rows whose listed stat columns changed (the symmetric
-- difference of the old and new projections), as the scoring triggers do.

create function private.round_stats_on_race_score_results() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform private.queue_round_stats(array(select n.subsession_id from new_rows n));
  elsif tg_op = 'DELETE' then
    perform private.queue_round_stats(array(select o.subsession_id from old_rows o));
  else
    perform private.queue_round_stats(array(
      select n.subsession_id from new_rows n union select o.subsession_id from old_rows o));
  end if;
  return null;
end;
$$;

create function private.round_stats_on_penalties() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform private.queue_round_stats(array(select n.subsession_id from new_rows n));
  elsif tg_op = 'DELETE' then
    perform private.queue_round_stats(array(select o.subsession_id from old_rows o));
  else
    perform private.queue_round_stats(array(
      select d.subsession_id from (
        (select n.subsession_id, n.driver_id, n.penalty_points, n.is_appealed, n.appeal_penalty_points from new_rows n
         except
         select o.subsession_id, o.driver_id, o.penalty_points, o.is_appealed, o.appeal_penalty_points from old_rows o)
        union all
        (select o.subsession_id, o.driver_id, o.penalty_points, o.is_appealed, o.appeal_penalty_points from old_rows o
         except
         select n.subsession_id, n.driver_id, n.penalty_points, n.is_appealed, n.appeal_penalty_points from new_rows n)
      ) d));
  end if;
  return null;
end;
$$;

create function private.round_stats_on_round_incident_status() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform private.queue_round_stats(array(select n.subsession_id from new_rows n));
  elsif tg_op = 'DELETE' then
    perform private.queue_round_stats(array(select o.subsession_id from old_rows o));
  else
    perform private.queue_round_stats(array(
      select d.subsession_id from (
        (select n.subsession_id, n.posted from new_rows n
         except
         select o.subsession_id, o.posted from old_rows o)
        union all
        (select o.subsession_id, o.posted from old_rows o
         except
         select n.subsession_id, n.posted from new_rows n)
      ) d));
  end if;
  return null;
end;
$$;

create function private.round_stats_on_curated_race_results() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform private.queue_round_stats(array(select n.subsession_id from new_rows n));
  elsif tg_op = 'DELETE' then
    perform private.queue_round_stats(array(select o.subsession_id from old_rows o));
  else
    perform private.queue_round_stats(array(
      select d.subsession_id from (
        (select n.subsession_id, n.race_number, n.cust_id, n.finish_position, n.adjusted_position,
                n.starting_position, n.laps_complete, n.laps_led, n.incidents, n.car_name from new_rows n
         except
         select o.subsession_id, o.race_number, o.cust_id, o.finish_position, o.adjusted_position,
                o.starting_position, o.laps_complete, o.laps_led, o.incidents, o.car_name from old_rows o)
        union all
        (select o.subsession_id, o.race_number, o.cust_id, o.finish_position, o.adjusted_position,
                o.starting_position, o.laps_complete, o.laps_led, o.incidents, o.car_name from old_rows o
         except
         select n.subsession_id, n.race_number, n.cust_id, n.finish_position, n.adjusted_position,
                n.starting_position, n.laps_complete, n.laps_led, n.incidents, n.car_name from new_rows n)
      ) d));
  end if;
  return null;
end;
$$;

-- A driver's cust id or AI flag decides which raw results and which pole they map to; the name is
-- watched as the design lists it. Their own rounds and every round of the old or new cust id refresh.
create function private.round_stats_on_drivers() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_driver_ids uuid[];
  v_custs bigint[];
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    v_driver_ids := array(select n.id from new_rows n);
    v_custs := array(select n.iracing_cust_id from new_rows n where n.iracing_cust_id is not null);
  elsif tg_op = 'DELETE' then
    v_driver_ids := array(select o.id from old_rows o);
    v_custs := array(select o.iracing_cust_id from old_rows o where o.iracing_cust_id is not null);
  else
    select coalesce(array_agg(d.id), '{}'),
           coalesce(array_agg(d.iracing_cust_id) filter (where d.iracing_cust_id is not null), '{}')
    into v_driver_ids, v_custs
    from (
      (select n.id, n.iracing_cust_id, n.is_ai, n.name from new_rows n
       except
       select o.id, o.iracing_cust_id, o.is_ai, o.name from old_rows o)
      union all
      (select o.id, o.iracing_cust_id, o.is_ai, o.name from old_rows o
       except
       select n.id, n.iracing_cust_id, n.is_ai, n.name from new_rows n)
    ) d;
  end if;
  if coalesce(array_length(v_driver_ids, 1), 0) = 0 then
    return null;
  end if;
  perform private.queue_round_stats(array(
    select r.subsession_id from public.race_score_results r where r.driver_id = any (v_driver_ids)
    union
    select rr.subsession_id from public.curated_race_results rr where rr.cust_id = any (v_custs)));
  return null;
end;
$$;

create function private.round_stats_on_curated_rounds() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  -- Insert has no score rows yet; a delete cascades through race_score_results' own trigger.
  perform private.queue_round_stats(array(
    select d.subsession_id from (
      (select n.subsession_id, n.season_id, n.start_time from new_rows n
       except
       select o.subsession_id, o.season_id, o.start_time from old_rows o)
      union all
      (select o.subsession_id, o.season_id, o.start_time from old_rows o
       except
       select n.subsession_id, n.season_id, n.start_time from new_rows n)
    ) d));
  return null;
end;
$$;

create trigger round_stats_on_race_score_results_insert after insert on public.race_score_results
  referencing new table as new_rows for each statement execute function private.round_stats_on_race_score_results();
create trigger round_stats_on_race_score_results_update after update on public.race_score_results
  referencing old table as old_rows new table as new_rows for each statement execute function private.round_stats_on_race_score_results();
create trigger round_stats_on_race_score_results_delete after delete on public.race_score_results
  referencing old table as old_rows for each statement execute function private.round_stats_on_race_score_results();

create trigger round_stats_on_penalties_insert after insert on public.penalties
  referencing new table as new_rows for each statement execute function private.round_stats_on_penalties();
create trigger round_stats_on_penalties_update after update on public.penalties
  referencing old table as old_rows new table as new_rows for each statement execute function private.round_stats_on_penalties();
create trigger round_stats_on_penalties_delete after delete on public.penalties
  referencing old table as old_rows for each statement execute function private.round_stats_on_penalties();

create trigger round_stats_on_round_incident_status_insert after insert on public.round_incident_status
  referencing new table as new_rows for each statement execute function private.round_stats_on_round_incident_status();
create trigger round_stats_on_round_incident_status_update after update on public.round_incident_status
  referencing old table as old_rows new table as new_rows for each statement execute function private.round_stats_on_round_incident_status();
create trigger round_stats_on_round_incident_status_delete after delete on public.round_incident_status
  referencing old table as old_rows for each statement execute function private.round_stats_on_round_incident_status();

create trigger round_stats_on_curated_race_results_insert after insert on public.curated_race_results
  referencing new table as new_rows for each statement execute function private.round_stats_on_curated_race_results();
create trigger round_stats_on_curated_race_results_update after update on public.curated_race_results
  referencing old table as old_rows new table as new_rows for each statement execute function private.round_stats_on_curated_race_results();
create trigger round_stats_on_curated_race_results_delete after delete on public.curated_race_results
  referencing old table as old_rows for each statement execute function private.round_stats_on_curated_race_results();

create trigger round_stats_on_drivers_insert after insert on public.drivers
  referencing new table as new_rows for each statement execute function private.round_stats_on_drivers();
create trigger round_stats_on_drivers_update after update on public.drivers
  referencing old table as old_rows new table as new_rows for each statement execute function private.round_stats_on_drivers();
create trigger round_stats_on_drivers_delete after delete on public.drivers
  referencing old table as old_rows for each statement execute function private.round_stats_on_drivers();

create trigger round_stats_on_curated_rounds_update after update on public.curated_rounds
  referencing old table as old_rows new table as new_rows for each statement execute function private.round_stats_on_curated_rounds();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on table public.round_driver_stats from public, anon, authenticated, service_role;
grant select on table public.round_driver_stats to anon, authenticated, service_role;

revoke all on table public.round_team_stats from public, anon, authenticated, service_role;
grant select on table public.round_team_stats to anon, authenticated, service_role;

revoke all on table public.round_penalty_points from public, anon, authenticated, service_role;
grant select on table public.round_penalty_points to anon, authenticated, service_role;

revoke all on table public.round_stats_issues from public, anon, authenticated, service_role;
grant select on table public.round_stats_issues to authenticated, service_role;

revoke all on table private.round_stats_pending from public, anon, authenticated, service_role;

revoke all on function public.rebuild_season_stats(uuid) from public, anon;
grant execute on function public.rebuild_season_stats(uuid) to authenticated, service_role;

revoke all on function private.round_stats_guard() from public, anon, authenticated, service_role;
revoke all on function private.build_round_stats(bigint) from public, anon, authenticated, service_role;
revoke all on function private.record_round_stats_issue(bigint, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.refresh_round_stats(bigint[]) from public, anon, authenticated, service_role;
revoke all on function private.queue_round_stats(bigint[]) from public, anon, authenticated, service_role;
revoke all on function private.round_stats_drain() from public, anon, authenticated, service_role;
revoke all on function private.round_stats_on_race_score_results() from public, anon, authenticated, service_role;
revoke all on function private.round_stats_on_penalties() from public, anon, authenticated, service_role;
revoke all on function private.round_stats_on_round_incident_status() from public, anon, authenticated, service_role;
revoke all on function private.round_stats_on_curated_race_results() from public, anon, authenticated, service_role;
revoke all on function private.round_stats_on_drivers() from public, anon, authenticated, service_role;
revoke all on function private.round_stats_on_curated_rounds() from public, anon, authenticated, service_role;
