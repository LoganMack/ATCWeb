-- Series iRating fixtures for 20261121120000_series_irating.sql (BR1.1-BR1.7, BR2.1-BR2.7; NFR4, NFR7, NFR8):
-- the formula against hand-worked numbers, the fields per kind, DSQ last, single-entrant fields skipped,
-- corrections, moved and deleted rounds, posting, the kill switch, a failing at-commit recompute, the
-- scheduled run and the rebuild, the masked public list and the grants (I01-I14; I14 reports the time).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild):
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/series-rating-fixtures.sql
--
-- Same conventions as scoring-fixtures.sql (supabase/checks/README.md): every assertion calls
-- rating_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each case
-- runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`.
--
-- The at-commit recompute is a deferred constraint trigger and this file never commits, so
-- rating_fixture.flush() fires it on demand with SET CONSTRAINTS ... IMMEDIATE.
--
-- Expected ratings come from src/lib/rating/iRating.ts (the TypeScript reference), printed to two decimals.
--
-- Base data: season 9401 (Gamma and Delta enabled), endurance rounds of one race each:
--   4001 (2026-04-01): a1, a2, a3            -> every driver starts at 1350: +66.33, +0.33, -65.67
--   4002 (2026-04-08): g1, a1, g2, a2, d1    -> overall field of 5, Alpha a1 a2, Gamma g1 g2, Delta d1 alone

begin;

set local client_min_messages = notice;

create schema rating_fixture;

create table rating_fixture.code (
  code text primary key,
  driver_id uuid not null unique,
  cust_id integer not null unique
);

create function rating_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'series rating fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Fires the at-commit recompute now, then defers it again.
create function rating_fixture.flush() returns void
  language plpgsql as $$
begin
  set constraints private.rating_drain immediate;
  set constraints private.rating_drain deferred;
end;
$$;

create function rating_fixture.id(p_code text) returns uuid
  language sql as $$
  select c.driver_id from rating_fixture.code c where c.code = p_code;
$$;

-- "<code>=<rating after, 2 dp>" for one kind's steps in one round, by code.
create function rating_fixture.after(p_kind text, p_subsession_id bigint) returns text
  language sql as $$
  select coalesce(string_agg(c.code || '=' || round(s.rating_after::numeric, 2), ' ' order by c.code), '')
  from private.rating_steps s join rating_fixture.code c on c.driver_id = s.driver_id
  where s.kind = p_kind and s.subsession_id = p_subsession_id;
$$;

-- "<code>=<position>/<field size>" for one kind's steps in one round, by code.
create function rating_fixture.pos(p_kind text, p_subsession_id bigint) returns text
  language sql as $$
  select coalesce(string_agg(c.code || '=' || s.position || '/' || s.field_size, ' ' order by c.code), '')
  from private.rating_steps s join rating_fixture.code c on c.driver_id = s.driver_id
  where s.kind = p_kind and s.subsession_id = p_subsession_id;
$$;

-- "<code>=<current, 2 dp>/<races>" for one kind's summary rows, by code.
create function rating_fixture.summary(p_kind text) returns text
  language sql as $$
  select coalesce(string_agg(c.code || '=' || round(s."current"::numeric, 2) || '/' || s.races, ' ' order by c.code), '')
  from private.rating_summary s join rating_fixture.code c on c.driver_id = s.driver_id
  where s.kind = p_kind;
$$;

-- The SQLSTATE p_sql fails with as p_who ('anon', 'service_role' or an account id), or 'ok'.
create function rating_fixture.state_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  if p_who in ('anon', 'service_role') then
    perform set_config('request.jwt.claims', json_build_object('role', p_who)::text, true);
    perform set_config('role', p_who, true);
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_who, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
  begin
    execute p_sql;
  exception when others then
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
    return sqlstate;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return 'ok';
end;
$$;

-- The first text value p_sql returns as p_who ('anon' or an account id).
create function rating_fixture.read_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v text;
begin
  if p_who = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_who, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
  execute p_sql into v;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return v;
end;
$$;

-- Base data ------------------------------------------------------------------------------------

insert into public.driver_statuses (id, name) values (1, 'Active') on conflict do nothing;
insert into public.driver_classes (id, name, sort_order) values (1, 'Alpha', 1), (2, 'Gamma', 2), (3, 'Delta', 3)
  on conflict do nothing;

insert into public.scoring_rulesets (id, name, rules) values
  ('aaaaaaaa-0000-0000-0000-000000000401', 'Rating fixture', '{
    "base_points": {"endurance": [100, 80, 60, 40, 30, 20], "sprint": [50, 40, 30]},
    "classified_minimum": {"endurance": 5, "sprint": 2}
  }');

insert into public.seasons (id, number, name, scoring_ruleset_id, gamma_enabled, delta_enabled) values
  ('bbbbbbbb-0000-0000-0000-000000000401', 9401, 'Rating Season 1', 'aaaaaaaa-0000-0000-0000-000000000401', true, true);

insert into rating_fixture.code (code, driver_id, cust_id) values
  ('a1', '77777777-0000-0000-0000-000000000401', 940401),
  ('a2', '77777777-0000-0000-0000-000000000402', 940402),
  ('a3', '77777777-0000-0000-0000-000000000403', 940403),
  ('g1', '77777777-0000-0000-0000-000000000404', 940404),
  ('g2', '77777777-0000-0000-0000-000000000405', 940405),
  ('d1', '77777777-0000-0000-0000-000000000406', 940406);

insert into public.drivers (id, name, status_id, class_id, iracing_cust_id, is_ai)
select c.driver_id, 'Rating ' || c.code, 1,
       case left(c.code, 1) when 'g' then 2 when 'd' then 3 else 1 end,
       c.cust_id, false
from rating_fixture.code c;

-- Two teams: a roster holds at most 4 drivers per season.
insert into public.teams (id, name) values
  ('cccccccc-0000-0000-0000-000000000401', 'Rating Team A'),
  ('cccccccc-0000-0000-0000-000000000402', 'Rating Team B');
insert into public.team_rosters (season_id, team_id, driver_id)
select 'bbbbbbbb-0000-0000-0000-000000000401',
       case when left(c.code, 1) = 'a' then 'cccccccc-0000-0000-0000-000000000401'::uuid
            else 'cccccccc-0000-0000-0000-000000000402'::uuid end,
       c.driver_id
from rating_fixture.code c;

insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, format) values
  (4001, '2026-04-01 18:00+00', 'Rating Park', 'bbbbbbbb-0000-0000-0000-000000000401', 'endurance'),
  (4002, '2026-04-08 18:00+00', 'Rating Park', 'bbbbbbbb-0000-0000-0000-000000000401', 'endurance');

insert into public.curated_race_results
  (subsession_id, race_number, cust_id, display_name, finish_position, laps_complete,
   interval_ten_thousandths, average_lap_ten_thousandths, starting_position, incidents, laps_led,
   car_name, reason_out)
values
  (4001, 1, 940401, 'a1', 1, 20, 0, 900000, 1, 0, 20, null, 'Running'),
  (4001, 1, 940402, 'a2', 2, 20, 10000, 900500, 2, 0, 0, null, 'Running'),
  (4001, 1, 940403, 'a3', 3, 20, 20000, 901000, 3, 0, 0, null, 'Running');

insert into public.curated_race_results
  (subsession_id, race_number, cust_id, display_name, finish_position, laps_complete,
   interval_ten_thousandths, average_lap_ten_thousandths, starting_position, incidents, laps_led,
   car_name, reason_out)
values
  (4002, 1, 940404, 'g1', 1, 20, 0, 900000, 1, 0, 20, null, 'Running'),
  (4002, 1, 940401, 'a1', 2, 20, 10000, 900500, 2, 0, 0, null, 'Running'),
  (4002, 1, 940405, 'g2', 3, 20, 20000, 901000, 3, 0, 0, null, 'Running'),
  (4002, 1, 940402, 'a2', 4, 20, 30000, 901500, 4, 0, 0, null, 'Running'),
  (4002, 1, 940406, 'd1', 5, 20, 40000, 902000, 5, 0, 0, null, 'Running');

-- An admin and a driver account (the auth.users insert creates a 'driver' profile); h is linked to a1.
insert into auth.users (id, email) values
  ('eeeeeeee-0000-0000-0000-000000000401', 'rating-admin@example.invalid'),
  ('eeeeeeee-0000-0000-0000-000000000402', 'rating-driver@example.invalid'),
  ('eeeeeeee-0000-0000-0000-000000000403', 'rating-h@example.invalid');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000000401', 'eeeeeeee-0000-0000-0000-000000000403');
insert into public.profiles (id, role) values ('eeeeeeee-0000-0000-0000-000000000401', 'admin');
insert into public.profiles (id, role) values ('eeeeeeee-0000-0000-0000-000000000402', 'driver')
  on conflict (id) do nothing;
insert into public.profiles (id, role, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000403', 'driver', '77777777-0000-0000-0000-000000000401');

select rating_fixture.flush();

savepoint fixture;

-- I01 The formula alone (BR1.5): three drivers at 1350, two at 1350, and a field of one ----------------
do $$
begin
  perform rating_fixture.expect('I01 three drivers at 1350',
    (select string_agg(round(v::numeric, 2)::text, ' ' order by i)
     from unnest(private.rating_race(array[1350, 1350, 1350]::double precision[], array[1, 2, 3])) with ordinality u (v, i)),
    '1416.33 1350.33 1284.33');
  perform rating_fixture.expect('I01 two drivers at 1350',
    (select string_agg(round(v::numeric, 2)::text, ' ' order by i)
     from unnest(private.rating_race(array[1350, 1350]::double precision[], array[1, 2])) with ordinality u (v, i)),
    '1400.00 1301.00');
  perform rating_fixture.expect('I01 a field of one is unchanged',
    private.rating_race(array[1500]::double precision[], array[1]), array[1500]::double precision[]);
  perform rating_fixture.expect('I01 equal ratings are an even chance',
    private.rating_chance(1350, 1350), 0.5::double precision);
  perform rating_fixture.expect('I01 the higher rating is favoured',
    private.rating_chance(2000, 1350) > 0.5, true);
  raise notice 'ok I01 formula';
end $$;
rollback to savepoint fixture;

-- I02 The first race and the two-class race, every kind (BR1.2-BR1.6) ------------------------------
do $$
begin
  perform rating_fixture.expect('I02 4001 overall', rating_fixture.after('overall', 4001),
    'a1=1416.33 a2=1350.33 a3=1284.33');
  perform rating_fixture.expect('I02 4001 alpha', rating_fixture.after('alpha', 4001),
    'a1=1416.33 a2=1350.33 a3=1284.33');
  perform rating_fixture.expect('I02 4002 overall from the earlier ratings', rating_fixture.after('overall', 4002),
    'a1=1453.59 a2=1311.56 d1=1271.64 g1=1430.04 g2=1350.84');
  perform rating_fixture.expect('I02 4002 overall positions', rating_fixture.pos('overall', 4002),
    'a1=2/5 a2=4/5 d1=5/5 g1=1/5 g2=3/5');
  perform rating_fixture.expect('I02 4002 alpha (class positions)', rating_fixture.after('alpha', 4002),
    'a1=1464.75 a2=1302.92');
  perform rating_fixture.expect('I02 4002 alpha positions', rating_fixture.pos('alpha', 4002), 'a1=1/2 a2=2/2');
  perform rating_fixture.expect('I02 4002 gamma', rating_fixture.after('gamma', 4002), 'g1=1400.00 g2=1301.00');
  perform rating_fixture.expect('I02 delta field of one skipped (BR1.6)', rating_fixture.after('delta', 4002), '');
  perform rating_fixture.expect('I02 no delta summary', rating_fixture.summary('delta'), '');
  perform rating_fixture.expect('I02 overall summary', rating_fixture.summary('overall'),
    'a1=1453.59/2 a2=1311.56/2 a3=1284.33/1 d1=1271.64/1 g1=1430.04/1 g2=1350.84/1');
  perform rating_fixture.expect('I02 queue emptied', (select count(*) from private.rating_queue), 0::bigint);
  perform rating_fixture.expect('I02 state recorded',
    (select s.last_run_at is not null and s.last_error is null from private.rating_state s), true);
  raise notice 'ok I02 fields per kind';
end $$;
rollback to savepoint fixture;

-- I03 The public list values (BR1.7): rounded, minimum and maximum include 1350, trend oldest first ---
do $$
begin
  perform rating_fixture.expect('I03 overall rows',
    (select string_agg(v.name || ':' || v."current" || '/' || v.last_change || '/' || v.minimum || '/' || v.maximum
                       || '/' || v.races || '/' || array_to_string(v.trend, ','), ' ' order by v.name)
     from public.series_ratings_shown v where v.kind = 'overall' and v.name in ('Rating a1', 'Rating a2', 'Rating a3')),
    'Rating a1:1454/37/1350/1454/2/1416,1454 Rating a2:1312/-39/1312/1350/2/1350,1312 Rating a3:1284/-66/1284/1350/1/1284');
  perform rating_fixture.expect('I03 a visible driver is linkable with their id and key',
    (select v.linkable and v.driver_id = rating_fixture.id('g1') and v.driver_key = rating_fixture.id('g1')::text
     from public.series_ratings_shown v where v.kind = 'gamma' and v.name = 'Rating g1'),
    true);
  raise notice 'ok I03 list values';
end $$;
rollback to savepoint fixture;

-- I04 A disqualified winner goes last (BR1.3) -------------------------------------------------------
insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, format) values
  (4003, '2026-04-15 18:00+00', 'Rating Park', 'bbbbbbbb-0000-0000-0000-000000000401', 'endurance');
insert into public.curated_race_results
  (subsession_id, race_number, cust_id, display_name, finish_position, laps_complete,
   interval_ten_thousandths, average_lap_ten_thousandths, starting_position, incidents, laps_led,
   car_name, reason_out)
values
  (4003, 1, 940401, 'a1', 1, 20, 0, 900000, 1, 0, 20, null, 'Disqualified'),
  (4003, 1, 940402, 'a2', 2, 20, 10000, 900500, 2, 0, 0, null, 'Running'),
  (4003, 1, 940403, 'a3', 3, 20, 20000, 901000, 3, 0, 0, null, 'Running');
select rating_fixture.flush();
do $$
begin
  perform rating_fixture.expect('I04 overall positions', rating_fixture.pos('overall', 4003), 'a1=3/3 a2=1/3 a3=2/3');
  perform rating_fixture.expect('I04 alpha positions', rating_fixture.pos('alpha', 4003), 'a1=3/3 a2=1/3 a3=2/3');
  perform rating_fixture.expect('I04 the disqualified winner loses rating',
    (select s.rating_after < s.rating_before from private.rating_steps s
     where s.kind = 'overall' and s.subsession_id = 4003 and s.driver_id = rating_fixture.id('a1')),
    true);
  perform rating_fixture.expect('I04 earlier rounds untouched', rating_fixture.after('overall', 4002),
    'a1=1453.59 a2=1311.56 d1=1271.64 g1=1430.04 g2=1350.84');
  raise notice 'ok I04 DSQ last';
end $$;
rollback to savepoint fixture;

-- I05 A correction to the first race re-rates the later one (BR2.1, BR2.3) ---------------------------
update public.curated_race_results set finish_position = 9 where subsession_id = 4001 and cust_id = 940401;
update public.curated_race_results set finish_position = 1 where subsession_id = 4001 and cust_id = 940402;
update public.curated_race_results set finish_position = 2 where subsession_id = 4001 and cust_id = 940401;
do $$
begin
  perform rating_fixture.expect('I05 the write queued a recompute',
    (select count(*) > 0 and min(q.pending_from) = '2026-04-01 18:00+00'::timestamptz from private.rating_queue q), true);
end $$;
select rating_fixture.flush();
do $$
begin
  perform rating_fixture.expect('I05 4001 overall', rating_fixture.after('overall', 4001),
    'a1=1350.33 a2=1416.33 a3=1284.33');
  perform rating_fixture.expect('I05 4002 overall', rating_fixture.after('overall', 4002),
    'a1=1390.76 a2=1374.39 d1=1271.64 g1=1430.04 g2=1350.84');
  perform rating_fixture.expect('I05 4002 alpha', rating_fixture.after('alpha', 4002), 'a1=1401.92 a2=1365.75');
  perform rating_fixture.expect('I05 summary follows', rating_fixture.summary('alpha'),
    'a1=1401.92/2 a2=1365.75/2 a3=1284.33/1');
  perform rating_fixture.expect('I05 queue emptied', (select count(*) from private.rating_queue), 0::bigint);
  raise notice 'ok I05 correction';
end $$;
rollback to savepoint fixture;

-- I06 A moved round re-rates from its old time (BR1.2, BR2.1) -----------------------------------------
update public.curated_rounds set start_time = '2026-04-10 18:00+00' where subsession_id = 4001;
do $$
begin
  perform rating_fixture.expect('I06 queued from the old start time',
    (select min(q.pending_from) from private.rating_queue q), '2026-04-01 18:00+00'::timestamptz);
end $$;
select rating_fixture.flush();
do $$
begin
  perform rating_fixture.expect('I06 4002 now first', rating_fixture.after('overall', 4002),
    'a1=1389.80 a2=1310.60 d1=1271.00 g1=1429.40 g2=1350.20');
  perform rating_fixture.expect('I06 4001 now second', rating_fixture.after('overall', 4001),
    'a1=1454.20 a2=1312.87 a3=1284.33');
  perform rating_fixture.expect('I06 4001 stored with its new time',
    (select min(s.race_started_at) from private.rating_steps s where s.subsession_id = 4001),
    '2026-04-10 18:00+00'::timestamptz);
  raise notice 'ok I06 moved round';
end $$;
rollback to savepoint fixture;

-- I07 A deleted round re-rates from the time its steps were rated (BR2.1) ---------------------------
delete from public.curated_rounds where subsession_id = 4001;
do $$
begin
  perform rating_fixture.expect('I07 queued from the deleted round''s time',
    (select min(q.pending_from) from private.rating_queue q), '2026-04-01 18:00+00'::timestamptz);
end $$;
select rating_fixture.flush();
do $$
begin
  perform rating_fixture.expect('I07 no steps left for 4001', rating_fixture.after('overall', 4001), '');
  perform rating_fixture.expect('I07 4002 from 1350', rating_fixture.after('overall', 4002),
    'a1=1389.80 a2=1310.60 d1=1271.00 g1=1429.40 g2=1350.20');
  perform rating_fixture.expect('I07 a3 has no summary any more', rating_fixture.summary('alpha'),
    'a1=1400.00/1 a2=1301.00/1');
  raise notice 'ok I07 deleted round';
end $$;
rollback to savepoint fixture;

-- I08 Posting a round queues a recompute (final positions from then on) ---------------------------
insert into public.round_incident_status (subsession_id, posted) values (4002, true);
do $$
begin
  perform rating_fixture.expect('I08 posting queued from the round''s time',
    (select min(q.pending_from) from private.rating_queue q), '2026-04-08 18:00+00'::timestamptz);
end $$;
select rating_fixture.flush();
do $$
begin
  perform rating_fixture.expect('I08 same ratings with no penalties', rating_fixture.after('overall', 4002),
    'a1=1453.59 a2=1311.56 d1=1271.64 g1=1430.04 g2=1350.84');
  perform rating_fixture.expect('I08 queue emptied', (select count(*) from private.rating_queue), 0::bigint);
  raise notice 'ok I08 posting';
end $$;
rollback to savepoint fixture;

-- I09 The kill switch leaves entries queued for both the at-commit and the scheduled run (BR2.2, BR2.6)
update public.scoring_settings set triggers_enabled = false;
insert into private.rating_queue (pending_from) values ('2026-04-01 18:00+00');
select rating_fixture.flush();
do $$
begin
  perform rating_fixture.expect('I09 still queued at commit', (select count(*) from private.rating_queue), 1::bigint);
  perform rating_fixture.expect('I09 scheduled run paused', public.rating_process_pending() ->> 'status', 'paused');
  perform rating_fixture.expect('I09 still queued after the scheduled run', (select count(*) from private.rating_queue), 1::bigint);
  update public.scoring_settings set triggers_enabled = true;
  perform rating_fixture.expect('I09 scheduled run once switched back on', public.rating_process_pending() ->> 'status', 'ok');
  perform rating_fixture.expect('I09 queue emptied', (select count(*) from private.rating_queue), 0::bigint);
  perform rating_fixture.expect('I09 nothing left: idle', public.rating_process_pending() ->> 'status', 'idle');
  raise notice 'ok I09 kill switch';
end $$;
rollback to savepoint fixture;

-- I10 A failing at-commit recompute never fails the results write; the scheduled run retries (BR2.4) --
create function rating_fixture.refuse() returns trigger
  language plpgsql as $$
begin
  raise exception 'forced rating failure';
end;
$$;
create trigger rating_fixture_refuse before insert on private.rating_steps
  for each row execute function rating_fixture.refuse();
-- d1 is alone in Delta, so removing them changes only the overall field of 4002.
delete from public.curated_race_results where subsession_id = 4002 and cust_id = 940406;
select rating_fixture.flush();
do $$
begin
  perform rating_fixture.expect('I10 the error is recorded',
    (select s.last_error like 'at commit: forced rating failure%' from private.rating_state s), true);
  perform rating_fixture.expect('I10 the entries stay queued', (select count(*) > 0 from private.rating_queue), true);
  perform rating_fixture.expect('I10 the old steps survive the undone recompute', rating_fixture.after('overall', 4002),
    'a1=1453.59 a2=1311.56 d1=1271.64 g1=1430.04 g2=1350.84');
  perform rating_fixture.expect('I10 the scheduled run reports the error',
    public.rating_process_pending() ->> 'status', 'error');
  drop trigger rating_fixture_refuse on private.rating_steps;
  perform rating_fixture.expect('I10 the scheduled run retries', public.rating_process_pending() ->> 'status', 'ok');
  perform rating_fixture.expect('I10 queue emptied', (select count(*) from private.rating_queue), 0::bigint);
  raise notice 'ok I10 failure recorded, write kept';
end $$;
rollback to savepoint fixture;

-- I11 More than 40 pending races are left for the scheduled run (BR2.2) -----------------------------
insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, format)
select 4100 + g, '2026-05-01 18:00+00'::timestamptz + make_interval(days => g), 'Rating Park',
       'bbbbbbbb-0000-0000-0000-000000000401', 'endurance'
from generate_series(1, 40) g;
insert into public.curated_race_results
  (subsession_id, race_number, cust_id, display_name, finish_position, laps_complete,
   interval_ten_thousandths, average_lap_ten_thousandths, starting_position, incidents, laps_led,
   car_name, reason_out)
select 4100 + g, 1, c.cust_id, c.code, row_number() over (partition by g order by c.code), 20, 0, 900000, 1, 0, 0,
       null, 'Running'
from generate_series(1, 40) g cross join rating_fixture.code c where c.code in ('a1', 'a2');
delete from public.curated_race_results where subsession_id = 4001 and cust_id = 940403;
select rating_fixture.flush();
do $$
begin
  perform rating_fixture.expect('I11 42 races pending: left queued', (select count(*) > 0 from private.rating_queue), true);
  perform rating_fixture.expect('I11 scheduled run takes them all', (public.rating_process_pending() ->> 'races')::integer, 42);
  perform rating_fixture.expect('I11 a1 rated in every race', (select races from private.rating_summary
    where kind = 'overall' and driver_id = rating_fixture.id('a1')), 42);
  raise notice 'ok I11 range cap';
end $$;
rollback to savepoint fixture;

-- I12 The public list masks a hidden driver for anon (BR2.5, FR7.3, NFR4) --------------------------
insert into public.account_settings (profile_id, hide_name, hide_profile) values
  ('eeeeeeee-0000-0000-0000-000000000403', true, false);
do $$
begin
  perform rating_fixture.expect('I12 hidden row as anon',
    rating_fixture.read_as('anon', format($q$select v.name || '/' || v.linkable || '/' || coalesce(v.driver_id::text, '-')
      || '/' || (v.driver_key like 'h%%') || '/' || (v.driver_key <> %L) from public.series_ratings_shown v
      where v.kind = 'overall' and v."current" = 1454$q$, rating_fixture.id('a1')::text)),
    'Hidden Driver/false/-/true/true');
  perform rating_fixture.expect('I12 no real name anywhere in the list as anon',
    rating_fixture.read_as('anon', $q$select count(*)::text from public.series_ratings_shown v where v.name = 'Rating a1'$q$),
    '0');
  perform rating_fixture.expect('I12 the key is stable across kinds',
    rating_fixture.read_as('anon', $q$select count(distinct v.driver_key)::text from public.series_ratings_shown v
      where v.name = 'Hidden Driver'$q$),
    '1');
  perform rating_fixture.expect('I12 an admin sees the name',
    rating_fixture.read_as('eeeeeeee-0000-0000-0000-000000000401',
      $q$select v.name from public.series_ratings_shown v where v.kind = 'overall' and v."current" = 1454$q$),
    'Rating a1');
  raise notice 'ok I12 masking';
end $$;
rollback to savepoint fixture;

-- I13 Grants: private tables closed, the scheduled run service-only, the rebuild full-admin only (BR2.5, BR2.7)
do $$
declare
  v_table text;
  v_role text;
begin
  foreach v_table in array array['private.rating_steps', 'private.rating_summary', 'private.rating_queue', 'private.rating_state'] loop
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      perform rating_fixture.expect('I13 ' || v_table || ' select for ' || v_role,
        has_table_privilege(v_role, v_table, 'select'), false);
      perform rating_fixture.expect('I13 ' || v_table || ' insert for ' || v_role,
        has_table_privilege(v_role, v_table, 'insert'), false);
    end loop;
  end loop;
  perform rating_fixture.expect('I13 list readable by anon',
    has_table_privilege('anon', 'public.series_ratings_shown', 'select'), true);
  perform rating_fixture.expect('I13 list not writable by authenticated',
    has_table_privilege('authenticated', 'public.series_ratings_shown', 'insert'), false);
  perform rating_fixture.expect('I13 scheduled run refused to anon',
    has_function_privilege('anon', 'public.rating_process_pending()', 'execute'), false);
  perform rating_fixture.expect('I13 scheduled run refused to authenticated',
    has_function_privilege('authenticated', 'public.rating_process_pending()', 'execute'), false);
  perform rating_fixture.expect('I13 scheduled run allowed to service_role',
    has_function_privilege('service_role', 'public.rating_process_pending()', 'execute'), true);
  perform rating_fixture.expect('I13 rebuild refused to anon',
    has_function_privilege('anon', 'public.rating_rebuild()', 'execute'), false);
  perform rating_fixture.expect('I13 recompute refused to authenticated',
    has_function_privilege('authenticated', 'private.rating_recompute(timestamptz)', 'execute'), false);
  perform rating_fixture.expect('I13 anon reading steps',
    rating_fixture.state_as('anon', 'select count(*) from private.rating_steps'), '42501');
  perform rating_fixture.expect('I13 a driver calling the scheduled run',
    rating_fixture.state_as('eeeeeeee-0000-0000-0000-000000000402', 'select public.rating_process_pending()'), '42501');
  perform rating_fixture.expect('I13 a driver calling the rebuild',
    rating_fixture.state_as('eeeeeeee-0000-0000-0000-000000000402', 'select public.rating_rebuild()'), '42501');
  perform rating_fixture.expect('I13 the service role runs the scheduled run',
    rating_fixture.state_as('service_role', 'select public.rating_process_pending()'), 'ok');
  perform rating_fixture.expect('I13 a full admin rebuilds',
    rating_fixture.state_as('eeeeeeee-0000-0000-0000-000000000401', 'select public.rating_rebuild()'), 'ok');
  perform rating_fixture.expect('I13 the rebuild gives the same ratings', rating_fixture.after('overall', 4002),
    'a1=1453.59 a2=1311.56 d1=1271.64 g1=1430.04 g2=1350.84');
  raise notice 'ok I13 grants';
end $$;
rollback to savepoint fixture;

-- I14 Full recompute duration at fixture size (NFR8; reported, not enforced) ------------------------
do $$
declare
  v_races integer;
begin
  v_races := private.rating_recompute('-infinity'::timestamptz);
  raise notice 'I14 timing: full recompute of % races took % ms (rating_state.last_run_ms)',
    v_races, (select s.last_run_ms from private.rating_state s);
  perform rating_fixture.expect('I14 every race rated', v_races, 2);
  raise notice 'ok I14 timing reported';
end $$;
rollback to savepoint fixture;

rollback;
