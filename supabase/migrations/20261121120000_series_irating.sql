-- Series iRating: every driver's rating from championship races only, kept by the database (points
-- calculator and series iRating, BR1.1-BR1.7, BR2.1-BR2.7; FR6, FR7, NFR1, NFR4, NFR5, NFR8).
--
-- What: expand-only. New objects only; nothing that exists changes shape.
--   * private.rating_steps: one row per driver, rating kind (overall, alpha, gamma, delta) and rated race,
--     with the rating before and after it and the round's start time when it was rated. Races are ordered
--     by (start time, subsession id, race number); no sequence number is stored, so moving a round needs
--     no renumbering.
--   * private.rating_summary: one row per driver and kind (current, last change, minimum and maximum
--     including the 1350 start, races, the last 20 ratings), so the list reads one row per driver.
--   * private.rating_queue and private.rating_state: pending recomputes (append-only) and the outcome of
--     the last one.
--   * private.rating_chance() and private.rating_race(): iRacing's classic formula (BR = 1600 / ln 2,
--     200 / N, the fudge term, simultaneous update, decimals kept); src/lib/rating/iRating.ts is the
--     TypeScript reference and supabase/checks/series-rating-fixtures.sql checks the two agree.
--   * private.rating_recompute(): under one advisory lock, deletes the steps from the earliest queued
--     time T on, re-rates every rated race from T in order, rewrites the touched summaries and removes
--     the queue entries it read.
--   * Statement-level triggers on race_score_results and round_incident_status, and row triggers on
--     curated_rounds (start time changed, round deleted), append one queue entry with the earliest
--     affected time. A deferred constraint trigger on the queue recomputes small ranges (at most 40
--     races) at commit, inside its own sub-transaction, so a failure is recorded and never fails the
--     results write. Anything larger, failed or paused is left for public.rating_process_pending(),
--     which the site's 15-minute scheduled Worker run calls with the service role.
--   * public.rating_rebuild(): a full recompute for full admins that raises on error.
--   * public.series_ratings_shown: the public list, the summaries joined to drivers_shown, so a hidden
--     driver reads "Hidden Driver" with no link, no driver id and an opaque key (NFR4, FR7.3).
--
-- Which positions: a rated race is a scored race of a positive (championship) subsession. Overall moves
-- against the whole field by overall position; Alpha, Gamma and Delta only against that class by class
-- position. Rows with no position (DSQ) go last in raw finishing order. A posted round uses the final
-- (penalised) positions and an unposted one the raw positions, the same concealment rule as the round
-- stats (20261026120000), so a rating never shows a penalty before the stewards post it; posting or
-- unposting a round re-queues it. Fields of fewer than two drivers are skipped.
--
-- Why: the owner keeps series ratings by hand in a spreadsheet. The site already holds every scored
-- race, so the database can keep the ratings current itself; pages only read the summary view, and no
-- rating maths ever runs in a page request (NFR1).
--
-- Kill switch: scoring_settings.triggers_enabled = false leaves queue entries in place; neither the
-- at-commit recompute nor the scheduled run processes them until it is switched back on. The rebuild
-- and this migration's backfill run regardless.
--
-- Backfill: the last statement rates every race from the first one, outside any error-swallowing block,
-- so a failure fails this migration and the deploy stops before the code that reads the view goes live.
--
-- Undo: supabase/down/20261121120000_series_irating.down.sql drops only these objects.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table private.rating_steps (
  kind text not null check (kind in ('overall', 'alpha', 'gamma', 'delta')),
  driver_id uuid not null references public.drivers (id) on delete cascade,
  -- No foreign key to curated_rounds: a deleted round's steps must still say when it ran, so the
  -- recompute that removes them knows where to start (BR2.1).
  subsession_id bigint not null,
  race_number integer not null,
  season_id uuid not null,
  race_started_at timestamptz not null,
  field_size integer not null check (field_size >= 2),
  position integer not null check (position >= 1),
  rating_before double precision not null,
  rating_after double precision not null,
  primary key (kind, driver_id, subsession_id, race_number)
);

create index rating_steps_race_order on private.rating_steps (race_started_at, subsession_id, race_number);
create index rating_steps_race on private.rating_steps (subsession_id, race_number);
create index rating_steps_driver_latest
  on private.rating_steps (kind, driver_id, race_started_at desc, subsession_id desc, race_number desc);

comment on table private.rating_steps is
  'Series iRating history: one row per driver, kind and rated race (BR1.2-BR1.6). Written only by private.rating_recompute().';

create table private.rating_summary (
  kind text not null check (kind in ('overall', 'alpha', 'gamma', 'delta')),
  driver_id uuid not null references public.drivers (id) on delete cascade,
  "current" double precision not null,
  last_change double precision not null,
  minimum double precision not null,
  maximum double precision not null,
  races integer not null check (races >= 1),
  -- The last 20 ratings, oldest first (NFR2).
  trend double precision[] not null,
  primary key (kind, driver_id)
);

comment on table private.rating_summary is
  'Series iRating list values per driver and kind (BR1.7), rewritten by each recompute; read through public.series_ratings_shown.';

create table private.rating_queue (
  id bigint generated always as identity primary key,
  pending_from timestamptz not null,
  queued_at timestamptz not null default now()
);

comment on table private.rating_queue is
  'Pending Series iRating recomputes (BR2.1): writers only append; a recompute deletes exactly the entries it read.';

create table private.rating_state (
  id boolean primary key default true constraint rating_state_single_row check (id),
  last_run_at timestamptz,
  last_run_from timestamptz,
  last_run_races integer,
  last_run_ms integer,
  last_error text,
  last_error_at timestamptz
);

insert into private.rating_state (id) values (true);

comment on table private.rating_state is
  'The last Series iRating recompute: when, from when, how many races, how long (NFR8) and the last error (BR2.4).';

-- ---------------------------------------------------------------------------------------------
-- The formula (BR1.5)
-- ---------------------------------------------------------------------------------------------

-- The chance that a driver rated p_a finishes ahead of one rated p_b; 0.5 for the degenerate 0/0 case.
create function private.rating_chance(p_a double precision, p_b double precision) returns double precision
  language sql immutable parallel safe
  set search_path = ''
  as $$
  select coalesce(
    ((1 - e.a) * e.b) / nullif((1 - e.b) * e.a + (1 - e.a) * e.b, 0),
    0.5)
  from (select exp(-p_a / (1600 / ln(2))) as a, exp(-p_b / (1600 / ln(2))) as b) e;
$$;

-- Ratings after one field: p_ratings are the ratings before the race and p_positions the positions in the
-- field (1..N), index for index. Returns the new ratings in the same order. Everyone moves at once.
create function private.rating_race(p_ratings double precision[], p_positions integer[])
  returns double precision[]
  language sql immutable parallel safe
  set search_path = ''
  as $$
  with f as (
    select r.i, r.rating, p.pos, exp(-r.rating / (1600 / ln(2))) as e
    from unnest(p_ratings) with ordinality as r (rating, i)
    join unnest(p_positions) with ordinality as p (pos, j) on p.j = r.i
  ),
  n as (
    select count(*)::double precision as n from f
  ),
  x as (
    -- Expected drivers beaten: the chance of beating every driver in the field, self included (0.5), less 0.5.
    select a.i, a.rating, a.pos,
      sum(coalesce(((1 - a.e) * b.e) / nullif((1 - b.e) * a.e + (1 - a.e) * b.e, 0), 0.5)) - 0.5 as expected
    from f a
    cross join f b
    group by a.i, a.rating, a.pos
  )
  select array_agg(
    case when n.n < 2 then x.rating
         else x.rating + (n.n - x.pos - x.expected - (n.n / 2 - x.pos) / 100) * 200 / n.n end
    order by x.i)
  from x cross join n;
$$;

-- ---------------------------------------------------------------------------------------------
-- The recompute (BR2.3)
-- ---------------------------------------------------------------------------------------------

-- The one lock that orders recomputes. Queue entries are never locked.
create function private.rating_lock_key() returns bigint
  language sql immutable
  set search_path = ''
  as $$
  select 7380914115021::bigint;
$$;

-- How many rated races start at or after p_from, counting no further than p_limit.
create function private.rating_race_count(p_from timestamptz, p_limit integer) returns integer
  language sql stable
  set search_path = ''
  as $$
  select count(*)::integer from (
    select distinct s.subsession_id, s.race_number
    from public.race_score_results s
    join public.curated_rounds cr on cr.subsession_id = s.subsession_id
    where s.subsession_id > 0 and cr.start_time >= p_from
    limit p_limit
  ) x;
$$;

-- Rates one race: every kind's field, ranked as BR1.3, each driver from their latest earlier step or 1350.
create function private.rating_rate_race(
  p_subsession_id bigint, p_race_number integer, p_season_id uuid, p_started_at timestamptz, p_posted boolean
) returns void
  language sql volatile
  set search_path = ''
  as $$
  with entrants as (
    select s.driver_id, lower(dc.name) as class_kind, s.finish_position, s.dsq,
      case when p_posted then s.final_position else s.raw_position end as pos_overall,
      case when p_posted then s.final_class_position else s.raw_class_position end as pos_class
    from public.race_score_results s
    join public.driver_classes dc on dc.id = s.class_id
    where s.subsession_id = p_subsession_id and s.race_number = p_race_number
  ),
  field as (
    -- A row with no position (DSQ) goes after every positioned row, in raw finishing order.
    select 'overall'::text as kind, e.driver_id,
      row_number() over (
        order by (e.dsq or e.pos_overall is null), e.pos_overall, e.finish_position, e.driver_id)::integer as pos
    from entrants e
    union all
    select e.class_kind, e.driver_id,
      row_number() over (
        partition by e.class_kind
        order by (e.dsq or e.pos_class is null), e.pos_class, e.finish_position, e.driver_id)::integer
    from entrants e
    where e.class_kind in ('alpha', 'gamma', 'delta')
  ),
  sized as (
    select f.kind, f.driver_id, f.pos, count(*) over (partition by f.kind)::integer as n
    from field f
  ),
  priced as (
    select s.kind, s.driver_id, s.pos, s.n, coalesce(prev.rating_after, 1350) as before
    from sized s
    left join lateral (
      select st.rating_after
      from private.rating_steps st
      where st.kind = s.kind and st.driver_id = s.driver_id
      order by st.race_started_at desc, st.subsession_id desc, st.race_number desc
      limit 1
    ) prev on true
    where s.n >= 2
  ),
  fields as (
    select p.kind, max(p.n) as n,
      array_agg(p.driver_id order by p.pos) as drivers,
      array_agg(p.before order by p.pos) as befores,
      array_agg(p.pos order by p.pos) as positions
    from priced p
    group by p.kind
  )
  insert into private.rating_steps (
    kind, driver_id, subsession_id, race_number, season_id, race_started_at, field_size, position,
    rating_before, rating_after)
  select fl.kind, u.driver_id, p_subsession_id, p_race_number, p_season_id, p_started_at, fl.n, u.pos,
    u.before, u.after
  from fields fl
  cross join lateral unnest(fl.drivers, fl.befores, fl.positions, private.rating_race(fl.befores, fl.positions))
    as u (driver_id, before, pos, after);
$$;

-- Rewrites the summary rows of the given 'kind|driver_id' pairs from their full history (BR1.7).
create function private.rating_write_summaries(p_pairs text[]) returns void
  language plpgsql volatile
  set search_path = ''
  as $$
begin
  delete from private.rating_summary rs where (rs.kind || '|' || rs.driver_id::text) = any (p_pairs);
  insert into private.rating_summary (kind, driver_id, "current", last_change, minimum, maximum, races, trend)
  select k.kind, k.driver_id, latest.rating_after, latest.rating_after - latest.rating_before,
    least(1350, agg.lo), greatest(1350, agg.hi), agg.races, recent.trend
  from (
    select split_part(t.pair, '|', 1) as kind, split_part(t.pair, '|', 2)::uuid as driver_id
    from unnest(p_pairs) as t (pair)
  ) k
  join lateral (
    select st.rating_before, st.rating_after
    from private.rating_steps st
    where st.kind = k.kind and st.driver_id = k.driver_id
    order by st.race_started_at desc, st.subsession_id desc, st.race_number desc
    limit 1
  ) latest on true
  join lateral (
    select min(st.rating_after) as lo, max(st.rating_after) as hi, count(*)::integer as races
    from private.rating_steps st
    where st.kind = k.kind and st.driver_id = k.driver_id
  ) agg on true
  join lateral (
    select array_agg(l.rating_after order by l.race_started_at, l.subsession_id, l.race_number) as trend
    from (
      select st.rating_after, st.race_started_at, st.subsession_id, st.race_number
      from private.rating_steps st
      where st.kind = k.kind and st.driver_id = k.driver_id
      order by st.race_started_at desc, st.subsession_id desc, st.race_number desc
      limit 20
    ) l
  ) recent on true;
end;
$$;

-- The recompute itself. Starts at the earliest queued time, or p_from when that is earlier; with nothing
-- queued and no p_from it does nothing. Returns the number of races rated.
create function private.rating_recompute(p_from timestamptz default null) returns integer
  language plpgsql volatile security definer
  set search_path = ''
  as $$
declare
  v_ids bigint[];
  v_from timestamptz;
  v_old text[];
  v_new text[];
  v_race record;
  v_races integer := 0;
  v_started timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(private.rating_lock_key());

  select coalesce(array_agg(q.id), '{}'), min(q.pending_from) into v_ids, v_from from private.rating_queue q;
  v_from := least(v_from, p_from);
  if v_from is null then
    return 0;
  end if;

  -- Drivers who had a step from T on keep a summary only if earlier steps remain.
  select coalesce(array_agg(distinct st.kind || '|' || st.driver_id::text), '{}') into v_old
  from private.rating_steps st
  where st.race_started_at >= v_from;

  delete from private.rating_steps st where st.race_started_at >= v_from;

  for v_race in
    select r.subsession_id, r.race_number, r.season_id, cr.start_time,
      coalesce(ris.posted, false) as posted
    from (
      select distinct s.subsession_id, s.race_number, s.season_id
      from public.race_score_results s
      where s.subsession_id > 0
    ) r
    join public.curated_rounds cr on cr.subsession_id = r.subsession_id
    left join public.round_incident_status ris on ris.subsession_id = r.subsession_id
    where cr.start_time >= v_from
    order by cr.start_time, r.subsession_id, r.race_number
  loop
    perform private.rating_rate_race(
      v_race.subsession_id, v_race.race_number, v_race.season_id, v_race.start_time, v_race.posted);
    v_races := v_races + 1;
  end loop;

  select coalesce(array_agg(distinct st.kind || '|' || st.driver_id::text), '{}') into v_new
  from private.rating_steps st
  where st.race_started_at >= v_from;

  perform private.rating_write_summaries(array(select distinct p from unnest(v_old || v_new) as u (p)));

  delete from private.rating_queue q where q.id = any (v_ids);

  update private.rating_state set
    last_run_at = now(),
    last_run_from = v_from,
    last_run_races = v_races,
    last_run_ms = (extract(epoch from clock_timestamp() - v_started) * 1000)::integer;

  return v_races;
end;
$$;

comment on function private.rating_recompute(timestamptz) is
  'Series iRating recompute (BR2.3): from the earliest queued time (or p_from), under the rating lock. Raises on error; callers that must not fail catch it.';

create function private.rating_record_error(p_message text) returns void
  language sql volatile
  set search_path = ''
  as $$
  update private.rating_state set last_error = left(p_message, 500), last_error_at = now();
$$;

-- ---------------------------------------------------------------------------------------------
-- Queueing (BR2.1)
-- ---------------------------------------------------------------------------------------------

create function private.rating_enqueue(p_from timestamptz) returns void
  language sql volatile
  set search_path = ''
  as $$
  insert into private.rating_queue (pending_from) select p_from where p_from is not null;
$$;

-- New rows count from their round's start time; old rows from the time their steps were rated (so a
-- deleted round is still known) or, failing that, their round's current start time.
create function private.rating_on_race_score_results() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_from timestamptz;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    select min(cr.start_time) into v_from
    from public.curated_rounds cr
    where cr.subsession_id in (select n.subsession_id from new_rows n where n.subsession_id > 0);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_from := least(
      v_from,
      (select min(st.race_started_at)
       from private.rating_steps st
       where (st.subsession_id, st.race_number) in (select o.subsession_id, o.race_number from old_rows o)),
      (select min(cr.start_time)
       from public.curated_rounds cr
       where cr.subsession_id in (select o.subsession_id from old_rows o where o.subsession_id > 0)));
  end if;
  perform private.rating_enqueue(v_from);
  return null;
end;
$$;

-- A rated round moved: both its old and new start times (BR2.1).
create function private.rating_on_round_moved() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  if new.subsession_id > 0
     and (exists (select 1 from public.race_score_results s where s.subsession_id = new.subsession_id)
          or exists (select 1 from private.rating_steps st where st.subsession_id = new.subsession_id)) then
    perform private.rating_enqueue(least(old.start_time, new.start_time));
  end if;
  return null;
end;
$$;

-- A rated round deleted: from the time its steps were rated. The cascade through race_score_results
-- queues it too; this covers a round whose rows were already gone.
create function private.rating_on_round_deleted() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  perform private.rating_enqueue(
    (select min(st.race_started_at) from private.rating_steps st where st.subsession_id = old.subsession_id));
  return null;
end;
$$;

-- Posting or unposting switches a round between raw and final positions.
create function private.rating_on_round_incident_status() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_ids bigint[];
begin
  if tg_op = 'INSERT' then
    v_ids := array(select n.subsession_id from new_rows n where n.posted);
  elsif tg_op = 'DELETE' then
    v_ids := array(select o.subsession_id from old_rows o where o.posted);
  else
    v_ids := array(
      select d.subsession_id from (
        (select n.subsession_id, n.posted from new_rows n except select o.subsession_id, o.posted from old_rows o)
        union all
        (select o.subsession_id, o.posted from old_rows o except select n.subsession_id, n.posted from new_rows n)
      ) d);
  end if;
  if coalesce(cardinality(v_ids), 0) = 0 then
    return null;
  end if;
  perform private.rating_enqueue(
    (select min(cr.start_time)
     from public.curated_rounds cr
     where cr.subsession_id = any (v_ids)
       and cr.subsession_id > 0
       and exists (select 1 from public.race_score_results s where s.subsession_id = cr.subsession_id)));
  return null;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Processing (BR2.2, BR2.4, BR2.6, BR2.7)
-- ---------------------------------------------------------------------------------------------

-- At commit. Never waits and never fails the write: a recompute that errors (or is cancelled by a
-- statement timeout) is undone on its own, recorded, and left queued for the scheduled run.
create function private.rating_drain() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_from timestamptz;
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if not pg_try_advisory_xact_lock(private.rating_lock_key()) then
    return null;
  end if;
  select min(q.pending_from) into v_from from private.rating_queue q;
  if v_from is null then
    return null;
  end if;
  if private.rating_race_count(v_from, 41) > 40 then
    return null;
  end if;
  begin
    perform private.rating_recompute();
  exception
    when query_canceled then
      perform private.rating_record_error('at commit: ' || sqlerrm);
    when others then
      perform private.rating_record_error('at commit: ' || sqlerrm);
  end;
  return null;
end;
$$;

create constraint trigger rating_drain
  after insert on private.rating_queue
  deferrable initially deferred
  for each row execute function private.rating_drain();

-- The scheduled run (the Worker's 15-minute cron, with the service role): waits for the lock and clears
-- whatever is queued, with no range cap. The outcome is returned for the Worker's log.
create function public.rating_process_pending() returns jsonb
  language plpgsql volatile security definer
  set search_path = ''
  as $$
declare
  v_queued integer;
  v_races integer;
  v_started timestamptz := clock_timestamp();
begin
  select count(*)::integer into v_queued from private.rating_queue;
  if not private.scoring_triggers_enabled() then
    return jsonb_build_object('status', 'paused', 'queued', v_queued);
  end if;
  if v_queued = 0 then
    return jsonb_build_object('status', 'idle', 'queued', 0);
  end if;
  perform pg_advisory_xact_lock(private.rating_lock_key());
  begin
    v_races := private.rating_recompute();
  exception when others then
    perform private.rating_record_error('scheduled: ' || sqlerrm);
    return jsonb_build_object('status', 'error', 'queued', v_queued, 'error', left(sqlerrm, 500));
  end;
  return jsonb_build_object(
    'status', 'ok',
    'queued', v_queued,
    'races', v_races,
    'ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::integer);
end;
$$;

comment on function public.rating_process_pending() is
  'Series iRating scheduled run (BR2.6): service role only. Recomputes everything queued unless the kill switch is off.';

-- The owner's rebuild: every race from the first, raising on error (BR2.7). Returns the races rated.
create function public.rating_rebuild() returns integer
  language plpgsql volatile security definer
  set search_path = ''
  as $$
begin
  if not public.is_full_admin() then
    raise exception 'Only a full admin can rebuild the series ratings' using errcode = '42501';
  end if;
  return private.rating_recompute('-infinity'::timestamptz);
end;
$$;

comment on function public.rating_rebuild() is
  'Series iRating full rebuild for full admins (BR2.7); raises on error.';

-- ---------------------------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------------------------

create trigger rating_on_race_score_results_insert after insert on public.race_score_results
  referencing new table as new_rows for each statement execute function private.rating_on_race_score_results();
create trigger rating_on_race_score_results_update after update on public.race_score_results
  referencing old table as old_rows new table as new_rows for each statement execute function private.rating_on_race_score_results();
create trigger rating_on_race_score_results_delete after delete on public.race_score_results
  referencing old table as old_rows for each statement execute function private.rating_on_race_score_results();

create trigger rating_on_round_moved after update of start_time on public.curated_rounds
  for each row when (old.start_time is distinct from new.start_time)
  execute function private.rating_on_round_moved();
create trigger rating_on_round_deleted after delete on public.curated_rounds
  for each row execute function private.rating_on_round_deleted();

create trigger rating_on_round_incident_status_insert after insert on public.round_incident_status
  referencing new table as new_rows for each statement execute function private.rating_on_round_incident_status();
create trigger rating_on_round_incident_status_update after update on public.round_incident_status
  referencing old table as old_rows new table as new_rows for each statement execute function private.rating_on_round_incident_status();
create trigger rating_on_round_incident_status_delete after delete on public.round_incident_status
  referencing old table as old_rows for each statement execute function private.rating_on_round_incident_status();

-- ---------------------------------------------------------------------------------------------
-- The public list (FR7, NFR2, NFR4)
-- ---------------------------------------------------------------------------------------------

-- Runs as its owner and reads names only through drivers_shown, which masks per caller. A hidden driver
-- gets "Hidden Driver", no driver id, no link and a key derived from the stand-in customer id.
create view public.series_ratings_shown with (security_invoker = false, security_barrier = true) as
select
  rs.kind,
  case when d.is_hidden then 'h' || abs(private.hidden_cust_id(d.id))::text else d.id::text end as driver_key,
  d.name,
  not d.is_hidden as linkable,
  case when d.is_hidden then null else d.id end as driver_id,
  round(rs."current"::numeric)::integer as "current",
  round(rs.last_change::numeric)::integer as last_change,
  round(rs.minimum::numeric)::integer as minimum,
  round(rs.maximum::numeric)::integer as maximum,
  rs.races,
  array(
    select round(t.v::numeric)::integer from unnest(rs.trend) with ordinality as t (v, i) order by t.i
  ) as trend
from private.rating_summary rs
join public.drivers_shown d on d.id = rs.driver_id;

comment on view public.series_ratings_shown is
  'Series iRating list (FR7): one row per driver and kind, rounded, last 20 ratings; hidden drivers masked.';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on table private.rating_steps from public, anon, authenticated, service_role;
revoke all on table private.rating_summary from public, anon, authenticated, service_role;
revoke all on table private.rating_queue from public, anon, authenticated, service_role;
revoke all on table private.rating_state from public, anon, authenticated, service_role;

revoke all on table public.series_ratings_shown from public, anon, authenticated, service_role;
grant select on table public.series_ratings_shown to anon, authenticated, service_role;

revoke all on function public.rating_process_pending() from public, anon, authenticated;
grant execute on function public.rating_process_pending() to service_role;
revoke all on function public.rating_rebuild() from public, anon;
grant execute on function public.rating_rebuild() to authenticated, service_role;

revoke all on function private.rating_chance(double precision, double precision) from public, anon, authenticated, service_role;
revoke all on function private.rating_race(double precision[], integer[]) from public, anon, authenticated, service_role;
revoke all on function private.rating_lock_key() from public, anon, authenticated, service_role;
revoke all on function private.rating_race_count(timestamptz, integer) from public, anon, authenticated, service_role;
revoke all on function private.rating_rate_race(bigint, integer, uuid, timestamptz, boolean) from public, anon, authenticated, service_role;
revoke all on function private.rating_write_summaries(text[]) from public, anon, authenticated, service_role;
revoke all on function private.rating_recompute(timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.rating_record_error(text) from public, anon, authenticated, service_role;
revoke all on function private.rating_enqueue(timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.rating_on_race_score_results() from public, anon, authenticated, service_role;
revoke all on function private.rating_on_round_moved() from public, anon, authenticated, service_role;
revoke all on function private.rating_on_round_deleted() from public, anon, authenticated, service_role;
revoke all on function private.rating_on_round_incident_status() from public, anon, authenticated, service_role;
revoke all on function private.rating_drain() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Backfill (BR2.7, NFR8): every race from the first. Not wrapped, so a failure fails the migration.
-- ---------------------------------------------------------------------------------------------

select private.rating_recompute('-infinity'::timestamptz);
