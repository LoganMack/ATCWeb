-- Round stats fixtures for round_driver_stats, round_team_stats, round_penalty_points, the deferred
-- refresh, the issues table and rebuild_season_stats (unit precompute, BR1.1, BR2.1-BR2.5, BR3.1,
-- BR3.2, BR5.1), numbered after scoring-fixtures.sql (C52-C76; the
-- C67 timing report runs last), and the freshness status round_stats_status (C71-C76).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- scoring-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/round-stats-fixtures.sql
--
-- Same conventions as scoring-fixtures.sql (supabase/checks/README.md): every assertion calls
-- round_stats_fixture.expect(), which raises naming the case; one transaction, rolled back at the end;
-- each case runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`.
--
-- The refresh runs at commit (a deferred constraint trigger), and this file never commits, so
-- round_stats_fixture.flush() fires it on demand with SET CONSTRAINTS ... IMMEDIATE.
--
-- Base round 3001 (season "Stats Season 1", endurance, 2 races, 20 laps each). Ruleset: [100, 80,
-- 60, 40, 30, 20], classified minimum 5, class podium [8, 4, 2] for Gamma and Delta, finesse 1 at 0
-- incidents, class pole 4 (race 1). Teams: T1 = a1, a2, a3 (Alpha); T2 = g1, g2 (Gamma), d1 (Delta).
--   race 1: pos code start inc led car       race 2: pos code start inc led car
--           1   a1   2     2   15  Car X             1   g1   3     1   20  Car Z
--           2   g1   1     0   5   Car Y             2   a1   1     0   0   Car X
--           3   a2   3     1   0   ''                3   a2   2     1   0   Car X
--           4   d1   6     4   0   -                 4   g2   5     0   0   -
--           5   g2   4     0   0   -                 5   a3   4     2   0   -
--           6   a3   5     3   0   -                 6   d1   6     0   0   -
-- Qualifying gives the class pole to g1 (Gamma), a2 (Alpha) and d1 (Delta). Penalties (unposted):
-- a1 race 1, 10 points and 2 PP; x4 (no result in the round) a practice penalty of 3 PP.
--
-- Round 3002 (one race): g1, g2, d1, x1, x2, x3 (AI driver), a3, a2, a1 in that order, 1 incident
-- each. Positions 7-9 all score the classified minimum (5), so T1's top 2 is a points tie.

begin;

set local client_min_messages = notice;

create schema round_stats_fixture;

create table round_stats_fixture.code (
  code text primary key,
  driver_id uuid not null unique
);

create function round_stats_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'round stats fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Fires the deferred refresh now, then defers it again.
create function round_stats_fixture.flush() returns void
  language plpgsql as $$
begin
  set constraints private.round_stats_drain immediate;
  set constraints private.round_stats_drain deferred;
end;
$$;

create function round_stats_fixture.id(p_code text) returns uuid
  language sql as $$
  select c.driver_id from round_stats_fixture.code c where c.code = p_code;
$$;

-- "<code>=<value>" for every round_driver_stats row of a round, ordered by code; '-' for null.
create function round_stats_fixture.col(p_subsession_id bigint, p_expr text) returns text
  language plpgsql as $$
declare
  v text;
begin
  execute format(
    'select string_agg(c.code || ''='' || coalesce((%s)::text, ''-''), '' '' order by c.code)
     from public.round_driver_stats t join round_stats_fixture.code c on c.driver_id = t.driver_id
     where t.subsession_id = $1', p_expr)
  into v using p_subsession_id;
  return coalesce(v, '');
end;
$$;

-- "<team>/<competition>=<points>/<starts>" for every round_team_stats row of a round.
create function round_stats_fixture.teams(p_subsession_id bigint) returns text
  language sql as $$
  select coalesce(string_agg(tm.name || '/' || t.competition || '=' || t.points || '/' || t.starts, ' '
                             order by tm.name, t.competition), '')
  from public.round_team_stats t join public.teams tm on tm.id = t.team_id
  where t.subsession_id = p_subsession_id;
$$;

-- "<code>=<penalty points>" for every round_penalty_points row of a round.
create function round_stats_fixture.pp(p_subsession_id bigint) returns text
  language sql as $$
  select coalesce(string_agg(c.code || '=' || t.penalty_points, ' ' order by c.code), '')
  from public.round_penalty_points t join round_stats_fixture.code c on c.driver_id = t.driver_id
  where t.subsession_id = p_subsession_id;
$$;

-- "<current>/<reason or ->" from round_stats_status for one season.
create function round_stats_fixture.status(p_season_id uuid) returns text
  language sql as $$
  select s."current" || '/' || coalesce(s.reason, '-')
  from public.round_stats_status(array[p_season_id]) s;
$$;

-- Base data ------------------------------------------------------------------------------------

insert into public.driver_statuses (id, name) values (1, 'Active');
insert into public.driver_classes (id, name, sort_order) values (1, 'Alpha', 1), (2, 'Gamma', 2), (3, 'Delta', 3);
insert into public.teams (id, name) values
  ('cccccccc-0000-0000-0000-000000000301', 'T1'),
  ('cccccccc-0000-0000-0000-000000000302', 'T2');

insert into public.scoring_rulesets (id, name, rules) values
  ('aaaaaaaa-0000-0000-0000-000000000301', 'Stats fixture', '{
    "base_points": {"endurance": [100, 80, 60, 40, 30, 20], "sprint": [50, 40, 30]},
    "classified_minimum": {"endurance": 5, "sprint": 2},
    "class_podium": {"endurance": [8, 4, 2], "sprint": [4, 2, 1], "applies_to": ["Gamma", "Delta"]},
    "bonuses": {
      "sublime_finesse": {"enabled": true, "endurance": 1, "max_incidents": 0},
      "class_pole": {"enabled": true, "endurance": 4, "sprint": 2}
    }
  }');

insert into public.seasons (id, number, name, scoring_ruleset_id, gamma_enabled, delta_enabled) values
  ('bbbbbbbb-0000-0000-0000-000000000301', 9301, 'Stats Season 1', 'aaaaaaaa-0000-0000-0000-000000000301', true, true);

insert into round_stats_fixture.code (code, driver_id) values
  ('a1', '77777777-0000-0000-0000-000000000301'),
  ('a2', '77777777-0000-0000-0000-000000000302'),
  ('a3', '77777777-0000-0000-0000-000000000303'),
  ('g1', '77777777-0000-0000-0000-000000000304'),
  ('g2', '77777777-0000-0000-0000-000000000305'),
  ('d1', '77777777-0000-0000-0000-000000000306'),
  ('x1', '77777777-0000-0000-0000-000000000307'),
  ('x2', '77777777-0000-0000-0000-000000000308'),
  ('x3', '77777777-0000-0000-0000-000000000309'),
  ('x4', '77777777-0000-0000-0000-000000000310');

insert into public.drivers (id, name, status_id, class_id, iracing_cust_id, is_ai)
select c.driver_id, 'Stats ' || c.code, 1,
       case left(c.code, 1) when 'g' then 2 when 'd' then 3 else 1 end,
       right(c.driver_id::text, 3)::integer,
       c.code = 'x3'
from round_stats_fixture.code c;

insert into public.team_rosters (season_id, team_id, driver_id)
select 'bbbbbbbb-0000-0000-0000-000000000301',
       case when c.code like 'a%' then 'cccccccc-0000-0000-0000-000000000301'::uuid
            else 'cccccccc-0000-0000-0000-000000000302'::uuid end,
       c.driver_id
from round_stats_fixture.code c
where c.code in ('a1', 'a2', 'a3', 'g1', 'g2', 'd1');

insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, format) values
  (3001, '2026-03-01 18:00+00', 'Stats Park', 'bbbbbbbb-0000-0000-0000-000000000301', 'endurance'),
  (3002, '2026-03-08 18:00+00', 'Stats Park', 'bbbbbbbb-0000-0000-0000-000000000301', 'endurance');

insert into public.curated_qualifying (subsession_id, cust_id, display_name, qual_position) values
  (3001, 304, 'g1', 1), (3001, 302, 'a2', 2), (3001, 306, 'd1', 3);

insert into public.curated_race_results
  (subsession_id, race_number, cust_id, display_name, finish_position, laps_complete,
   interval_ten_thousandths, average_lap_ten_thousandths, starting_position, incidents, laps_led,
   car_name, reason_out)
values
  (3001, 1, 301, 'a1', 1, 20, 0, 900000, 2, 2, 15, 'Car X', 'Running'),
  (3001, 1, 304, 'g1', 2, 20, 10000, 900500, 1, 0, 5, 'Car Y', 'Running'),
  (3001, 1, 302, 'a2', 3, 20, 20000, 901000, 3, 1, 0, '', 'Running'),
  (3001, 1, 306, 'd1', 4, 20, 30000, 901500, 6, 4, 0, null, 'Running'),
  (3001, 1, 305, 'g2', 5, 20, 40000, 902000, 4, 0, 0, null, 'Running'),
  (3001, 1, 303, 'a3', 6, 20, 50000, 902500, 5, 3, 0, null, 'Running'),
  (3001, 2, 304, 'g1', 1, 20, 0, 900000, 3, 1, 20, 'Car Z', 'Running'),
  (3001, 2, 301, 'a1', 2, 20, 10000, 900500, 1, 0, 0, 'Car X', 'Running'),
  (3001, 2, 302, 'a2', 3, 20, 20000, 901000, 2, 1, 0, 'Car X', 'Running'),
  (3001, 2, 305, 'g2', 4, 20, 30000, 901500, 5, 0, 0, null, 'Running'),
  (3001, 2, 303, 'a3', 5, 20, 40000, 902000, 4, 2, 0, null, 'Running'),
  (3001, 2, 306, 'd1', 6, 20, 50000, 902500, 6, 0, 0, null, 'Running');

insert into public.curated_race_results
  (subsession_id, race_number, cust_id, display_name, finish_position, laps_complete,
   interval_ten_thousandths, average_lap_ten_thousandths, starting_position, incidents, laps_led,
   car_name, reason_out)
values
  (3002, 1, 304, 'g1', 1, 20, 0, 900000, 1, 1, 20, null, 'Running'),
  (3002, 1, 305, 'g2', 2, 20, 10000, 900500, 2, 1, 0, null, 'Running'),
  (3002, 1, 306, 'd1', 3, 20, 20000, 901000, 3, 1, 0, null, 'Running'),
  (3002, 1, 307, 'x1', 4, 20, 30000, 901500, 4, 1, 0, 'Car Y', 'Running'),
  (3002, 1, 308, 'x2', 5, 20, 40000, 902000, 5, 1, 0, null, 'Running'),
  (3002, 1, 309, 'x3', 6, 20, 50000, 902500, 6, 1, 0, 'Car X', 'Running'),
  (3002, 1, 303, 'a3', 7, 20, 60000, 903000, 7, 1, 0, null, 'Running'),
  (3002, 1, 302, 'a2', 8, 20, 70000, 903500, 8, 1, 0, null, 'Running'),
  (3002, 1, 301, 'a1', 9, 20, 80000, 904000, 9, 1, 0, null, 'Running');

insert into public.penalties (subsession_id, race_number, session_type, driver_id, points_penalty, penalty_points) values
  (3001, 1, 'race', '77777777-0000-0000-0000-000000000301', 10, 2),
  (3001, 0, 'practice', '77777777-0000-0000-0000-000000000310', 0, 3);

-- An admin and a non-admin account (the auth.users insert creates a 'driver' profile).
insert into auth.users (id, email) values
  ('eeeeeeee-0000-0000-0000-000000000301', 'stats-admin@example.invalid'),
  ('eeeeeeee-0000-0000-0000-000000000302', 'stats-driver@example.invalid');
delete from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000301';
insert into public.profiles (id, role) values ('eeeeeeee-0000-0000-0000-000000000301', 'admin');
insert into public.profiles (id, role) values ('eeeeeeee-0000-0000-0000-000000000302', 'driver')
  on conflict (id) do nothing;

select round_stats_fixture.flush();

savepoint fixture;

-- C52 Per-driver numbers of a round, class and overall views (BR1.1) -----------------------------
do $$
begin
  perform round_stats_fixture.expect('C52 one row per driver with a score row',
    (select count(*) from public.round_driver_stats where subsession_id = 3001), 6::bigint);
  perform round_stats_fixture.expect('C52 overall_points', round_stats_fixture.col(3001, 't.overall_points'),
    'a1=181 a2=124 a3=50 d1=65 g1=185 g2=72');
  perform round_stats_fixture.expect('C52 class_points (class totals)', round_stats_fixture.col(3001, 't.class_points'),
    'a1=181 a2=124 a3=50 d1=81 g1=201 g2=80');
  perform round_stats_fixture.expect('C52 class and season', round_stats_fixture.col(3001, 't.class_id || ''/'' || (t.season_id = ''bbbbbbbb-0000-0000-0000-000000000301'')'),
    'a1=1/true a2=1/true a3=1/true d1=3/true g1=2/true g2=2/true');
  perform round_stats_fixture.expect('C52 starts', round_stats_fixture.col(3001, 't.starts'),
    'a1=2 a2=2 a3=2 d1=2 g1=2 g2=2');
  perform round_stats_fixture.expect('C52 class wins/podiums/top5s/top10s',
    round_stats_fixture.col(3001, 't.class_wins || ''/'' || t.class_podiums || ''/'' || t.class_top5s || ''/'' || t.class_top10s'),
    'a1=2/2/2/2 a2=0/2/2/2 a3=0/2/2/2 d1=2/2/2/2 g1=2/2/2/2 g2=0/2/2/2');
  perform round_stats_fixture.expect('C52 overall wins/podiums/top5s/top10s',
    round_stats_fixture.col(3001, 't.overall_wins || ''/'' || t.overall_podiums || ''/'' || t.overall_top5s || ''/'' || t.overall_top10s'),
    'a1=1/2/2/2 a2=0/2/2/2 a3=0/0/1/2 d1=0/0/1/2 g1=1/2/2/2 g2=0/0/2/2');
  perform round_stats_fixture.expect('C52 overall pole (race 1 grid) / class pole (pole bonus)',
    round_stats_fixture.col(3001, 't.overall_pole || ''/'' || t.class_pole'),
    'a1=false/false a2=false/true a3=false/false d1=false/true g1=true/true g2=false/false');
  perform round_stats_fixture.expect('C52 laps/laps led', round_stats_fixture.col(3001, 't.laps || ''/'' || t.laps_led'),
    'a1=40/15 a2=40/0 a3=40/0 d1=40/0 g1=40/25 g2=40/0');
  perform round_stats_fixture.expect('C52 net positions', round_stats_fixture.col(3001, 't.net_positions'),
    'a1=0 a2=-1 a3=-2 d1=2 g1=1 g2=0');
  perform round_stats_fixture.expect('C52 incidents', round_stats_fixture.col(3001, 't.incidents'),
    'a1=2 a2=2 a3=5 d1=4 g1=1 g2=0');
  perform round_stats_fixture.expect('C52 bonus (finesse + pole)', round_stats_fixture.col(3001, 't.bonus_points'),
    'a1=1 a2=4 a3=0 d1=5 g1=5 g2=2');
  perform round_stats_fixture.expect('C52 bonus equals the stored raw bonuses',
    (select sum(t.bonus_points) from public.round_driver_stats t where t.subsession_id = 3001),
    (select sum(r.raw_finesse_bonus + r.raw_pole_bonus) from public.race_score_results r where r.subsession_id = 3001));
  raise notice 'ok C52 per-driver numbers';
end $$;
rollback to savepoint fixture;

-- C53 Cars, team race counts and team points, top 2 per race summed (BR1.1, design review) ------
do $$
begin
  perform round_stats_fixture.expect('C53 cars a1',
    (select t.cars from public.round_driver_stats t where t.subsession_id = 3001 and t.driver_id = round_stats_fixture.id('a1')),
    '{"Car X": 2}'::jsonb);
  perform round_stats_fixture.expect('C53 cars a2 (an empty car name is not a car)',
    (select t.cars from public.round_driver_stats t where t.subsession_id = 3001 and t.driver_id = round_stats_fixture.id('a2')),
    '{"Car X": 1}'::jsonb);
  perform round_stats_fixture.expect('C53 cars g1',
    (select t.cars from public.round_driver_stats t where t.subsession_id = 3001 and t.driver_id = round_stats_fixture.id('g1')),
    '{"Car Y": 1, "Car Z": 1}'::jsonb);
  perform round_stats_fixture.expect('C53 no car', round_stats_fixture.col(3001, '(t.cars = ''{}''::jsonb)'),
    'a1=false a2=false a3=true d1=true g1=false g2=true');
  perform round_stats_fixture.expect('C53 team as scored',
    round_stats_fixture.col(3001, '(select tm.name from public.teams tm where tm.id = t.team_id)'),
    'a1=T1 a2=T1 a3=T1 d1=T2 g1=T2 g2=T2');
  perform round_stats_fixture.expect('C53 races under / scored for the team',
    round_stats_fixture.col(3001, 't.races_under_team || ''/'' || t.races_scored_for_team'),
    'a1=2/2 a2=2/2 a3=2/0 d1=2/1 g1=2/2 g2=2/1');
  -- T1 164 + 141; T2 129 + 141; Alpha (T1) by overall total; Delta (T2: d1 only) by class total 52 + 29.
  perform round_stats_fixture.expect('C53 team points per competition', round_stats_fixture.teams(3001),
    'T1/1=305/6 T1/overall=305/6 T2/3=81/2 T2/overall=270/6');
  raise notice 'ok C53 cars, team races and team points';
end $$;
rollback to savepoint fixture;

-- C54 Team top 2 on a points tie: shown position, then driver id; AI drivers (design review) -----
do $$
begin
  perform round_stats_fixture.expect('C54 every score row has a row, the AI driver too',
    (select count(*) from public.round_driver_stats where subsession_id = 3002), 9::bigint);
  -- a3 (P7), a2 (P8) and a1 (P9) all score 5: a3 and a2 count, whatever the driver ids say.
  perform round_stats_fixture.expect('C54 scored for the team',
    round_stats_fixture.col(3002, 't.races_under_team || ''/'' || t.races_scored_for_team'),
    'a1=1/0 a2=1/1 a3=1/1 d1=1/0 g1=1/1 g2=1/1 x1=0/0 x2=0/0 x3=0/0');
  perform round_stats_fixture.expect('C54 team points', round_stats_fixture.teams(3002),
    'T1/1=10/3 T1/overall=10/3 T2/3=68/1 T2/overall=180/3');
  perform round_stats_fixture.expect('C54 x1 raw stats',
    round_stats_fixture.col(3002, 'case when c.code = ''x1'' then t.laps || ''/'' || t.incidents || ''/'' || t.cars::text end'),
    'a1=- a2=- a3=- d1=- g1=- g2=- x1=20/1/{"Car Y": 1} x2=- x3=-');
  perform round_stats_fixture.expect('C54 AI driver: no raw result (laps, incidents, cars)',
    round_stats_fixture.col(3002, 'case when c.code = ''x3'' then t.laps || ''/'' || t.incidents || ''/'' || t.cars::text || ''/'' || t.overall_points end'),
    'a1=- a2=- a3=- d1=- g1=- g2=- x1=- x2=- x3=0/0/{}/20');
  perform round_stats_fixture.expect('C54 overall pole', round_stats_fixture.col(3002, 't.overall_pole'),
    'a1=false a2=false a3=false d1=false g1=true g2=false x1=false x2=false x3=false');
  raise notice 'ok C54 team top 2 tie order and AI drivers';
end $$;
rollback to savepoint fixture;

-- C55 Unposted shows the raw set with no penalty points; posting switches, unposting back (BR3.1)
do $$
begin
  perform round_stats_fixture.expect('C55 unposted: raw', round_stats_fixture.col(3001, 't.final_visible || ''/'' || t.overall_points'),
    'a1=false/181 a2=false/124 a3=false/50 d1=false/65 g1=false/185 g2=false/72');
  perform round_stats_fixture.expect('C55 unposted: no penalty points', round_stats_fixture.pp(3001), '');

  insert into public.round_incident_status (subsession_id, posted, posted_at) values (3001, true, now());
  perform round_stats_fixture.flush();
  perform round_stats_fixture.expect('C55 posted: final', round_stats_fixture.col(3001, 't.final_visible || ''/'' || t.overall_points || ''/'' || t.class_points'),
    'a1=true/171/171 a2=true/124/124 a3=true/50/50 d1=true/65/81 g1=true/185/201 g2=true/72/80');
  perform round_stats_fixture.expect('C55 posted: penalty points', round_stats_fixture.pp(3001), 'a1=2 x4=3');
  perform round_stats_fixture.expect('C55 posted: team points', round_stats_fixture.teams(3001),
    'T1/1=295/6 T1/overall=295/6 T2/3=81/2 T2/overall=270/6');

  update public.round_incident_status set posted = false where subsession_id = 3001;
  perform round_stats_fixture.flush();
  perform round_stats_fixture.expect('C55 unposted again: raw', round_stats_fixture.col(3001, 't.final_visible || ''/'' || t.overall_points'),
    'a1=false/181 a2=false/124 a3=false/50 d1=false/65 g1=false/185 g2=false/72');
  perform round_stats_fixture.expect('C55 unposted again: no penalty points', round_stats_fixture.pp(3001), '');
  raise notice 'ok C55 posting and unposting';
end $$;
rollback to savepoint fixture;

-- C56 A refresh run in an admin session still stores the raw set of an unposted round (BR3.1) ----
insert into public.penalties (subsession_id, race_number, session_type, driver_id, points_penalty, penalty_points)
values (3001, 2, 'race', '77777777-0000-0000-0000-000000000304', 5, 1);
-- Removed here so the refresh has to write it back; the guard does not cover deletes.
delete from public.round_driver_stats where subsession_id = 3001 and driver_id = '77777777-0000-0000-0000-000000000304';
do $$
declare
  v_admin boolean;
begin
  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-0000-0000-000000000301","role":"authenticated"}', true);
  set local role authenticated;
  v_admin := public.is_admin();
  -- The refresh fires here, inside the admin's session.
  set constraints all immediate;
  reset role;
  set constraints private.round_stats_drain deferred;
  perform set_config('request.jwt.claims', '', true);
  perform round_stats_fixture.expect('C56 the session was an admin', v_admin, true);

  perform round_stats_fixture.expect('C56 the final set changed',
    (select sum(r.final_overall_total) from public.race_score_results r
     where r.subsession_id = 3001 and r.driver_id = round_stats_fixture.id('g1')), 180::bigint);
  perform round_stats_fixture.expect('C56 stored rows are the raw set',
    round_stats_fixture.col(3001, 't.final_visible || ''/'' || t.overall_points'),
    'a1=false/181 a2=false/124 a3=false/50 d1=false/65 g1=false/185 g2=false/72');
  perform round_stats_fixture.expect('C56 no penalty points stored', round_stats_fixture.pp(3001), '');
  perform round_stats_fixture.expect('C56 it did refresh (g1 written back)',
    (select count(*) from public.round_driver_stats t where t.subsession_id = 3001), 6::bigint);
  raise notice 'ok C56 admin-session refresh keeps the raw set';
end $$;
rollback to savepoint fixture;

-- C57 Anon reads the stats tables but cannot write them; issues are for admins only (BR3.2) -------
insert into public.round_stats_issues (subsession_id, season_id, error_message)
values (3001, 'bbbbbbbb-0000-0000-0000-000000000301', 'fixture issue');
do $$
declare
  v bigint;
begin
  perform round_stats_fixture.expect('C57 anon select driver stats', has_table_privilege('anon', 'public.round_driver_stats', 'select'), true);
  perform round_stats_fixture.expect('C57 anon select team stats', has_table_privilege('anon', 'public.round_team_stats', 'select'), true);
  perform round_stats_fixture.expect('C57 anon select penalty points', has_table_privilege('anon', 'public.round_penalty_points', 'select'), true);
  perform round_stats_fixture.expect('C57 anon insert driver stats', has_table_privilege('anon', 'public.round_driver_stats', 'insert'), false);
  perform round_stats_fixture.expect('C57 authenticated update team stats', has_table_privilege('authenticated', 'public.round_team_stats', 'update'), false);
  perform round_stats_fixture.expect('C57 authenticated delete penalty points', has_table_privilege('authenticated', 'public.round_penalty_points', 'delete'), false);
  perform round_stats_fixture.expect('C57 anon select issues', has_table_privilege('anon', 'public.round_stats_issues', 'select'), false);
  perform round_stats_fixture.expect('C57 anon select pending', has_table_privilege('anon', 'private.round_stats_pending', 'select'), false);
  perform round_stats_fixture.expect('C57 anon execute rebuild', has_function_privilege('anon', 'public.rebuild_season_stats(uuid)', 'execute'), false);
  perform round_stats_fixture.expect('C57 authenticated execute refresh', has_function_privilege('authenticated', 'private.refresh_round_stats(bigint[])', 'execute'), false);
  perform round_stats_fixture.expect('C57 RLS on every table',
    (select bool_and(c.relrowsecurity) from pg_class c
     where c.oid in ('public.round_driver_stats'::regclass, 'public.round_team_stats'::regclass,
                     'public.round_penalty_points'::regclass, 'public.round_stats_issues'::regclass,
                     'private.round_stats_pending'::regclass)), true);

  set local role anon;
  select count(*) into v from public.round_driver_stats where subsession_id = 3001;
  reset role;
  perform round_stats_fixture.expect('C57 anon reads the rows', v, 6::bigint);

  begin
    set local role anon;
    insert into public.round_penalty_points (subsession_id, driver_id, season_id, penalty_points, refreshed_at)
    values (3001, '77777777-0000-0000-0000-000000000301', 'bbbbbbbb-0000-0000-0000-000000000301', 9, now());
    reset role;
    raise exception 'round stats fixture failed: C57 anon wrote round_penalty_points';
  exception when insufficient_privilege then
    reset role;
  end;
  begin
    set local role anon;
    perform 1 from public.round_stats_issues;
    reset role;
    raise exception 'round stats fixture failed: C57 anon read round_stats_issues';
  exception when insufficient_privilege then
    reset role;
  end;

  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-0000-0000-000000000302","role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into v from public.round_stats_issues;
  reset role;
  perform round_stats_fixture.expect('C57 a non-admin sees no issue', v, 0::bigint);

  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-0000-0000-000000000301","role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into v from public.round_stats_issues;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform round_stats_fixture.expect('C57 an admin sees the issue', v, 1::bigint);
  raise notice 'ok C57 read access';
end $$;
rollback to savepoint fixture;

-- C58 The write guard refuses a direct insert or update, even with table rights ----------------
do $$
declare
  v_message text;
begin
  begin
    insert into public.round_driver_stats select * from public.round_driver_stats where subsession_id = 3001 limit 1;
    raise exception 'round stats fixture failed: C58 a direct insert was accepted';
  exception when insufficient_privilege then
    get stacked diagnostics v_message = message_text;
  end;
  perform round_stats_fixture.expect('C58 insert message', v_message, 'round_driver_stats is written only by the round stats refresh');
  begin
    update public.round_team_stats set points = 0 where subsession_id = 3001;
    raise exception 'round stats fixture failed: C58 a direct update was accepted';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok C58 guard refuses direct writes';
end $$;
rollback to savepoint fixture;

-- C59 The kill switch stops the refresh; rebuild_season_stats still works (BR2.2) ---------------
update public.scoring_settings set triggers_enabled = false;
insert into public.round_incident_status (subsession_id, posted, posted_at) values (3001, true, now());
do $$
begin
  perform round_stats_fixture.expect('C59 nothing queued',
    (select count(*) from private.round_stats_pending), 0::bigint);
  perform round_stats_fixture.flush();
  perform round_stats_fixture.expect('C59 not refreshed',
    (select count(*) from public.round_driver_stats where subsession_id = 3001 and final_visible), 0::bigint);
  perform round_stats_fixture.expect('C59 rebuild refreshes every round of the season',
    (select count(*) from public.rebuild_season_stats('bbbbbbbb-0000-0000-0000-000000000301') f where f.error_message is null),
    2::bigint);
  perform round_stats_fixture.expect('C59 rebuilt from the final set',
    (select count(*) from public.round_driver_stats where subsession_id = 3001 and final_visible), 6::bigint);
  raise notice 'ok C59 kill switch';
end $$;
rollback to savepoint fixture;

-- C60 A failed build of a posted round keeps the old rows exactly, records an issue, and the write
-- still commits (BR2.4). The failure is on the last write (penalty points), after the driver and
-- team rows were already replaced, so the whole round must roll back.
insert into public.round_incident_status (subsession_id, posted, posted_at) values (3001, true, now());
select round_stats_fixture.flush();
create function round_stats_fixture.fail_insert() returns trigger
  language plpgsql as $$
begin
  raise exception 'forced failure for round %', new.subsession_id;
end;
$$;
create trigger round_stats_fixture_fail before insert on public.round_penalty_points
  for each row when (new.subsession_id = 3001) execute function round_stats_fixture.fail_insert();
-- g2 race 2: 5 points and 4 PP. A successful refresh would store g2 = 67 and g2 = 4 PP.
insert into public.penalties (subsession_id, race_number, session_type, driver_id, points_penalty, penalty_points)
values (3001, 2, 'race', '77777777-0000-0000-0000-000000000305', 5, 4);
select round_stats_fixture.flush();
do $$
begin
  perform round_stats_fixture.expect('C60 the penalty was saved',
    (select count(*) from public.penalties where subsession_id = 3001 and driver_id = round_stats_fixture.id('g2')), 1::bigint);
  perform round_stats_fixture.expect('C60 the round was rescored',
    (select sum(final_overall_total) from public.race_score_results
     where subsession_id = 3001 and driver_id = round_stats_fixture.id('g2')), 67::bigint);
  perform round_stats_fixture.expect('C60 old driver rows kept',
    round_stats_fixture.col(3001, 't.final_visible || ''/'' || t.overall_points || ''/'' || t.class_points || ''/'' || t.class_wins || ''/'' || t.overall_podiums'),
    'a1=true/171/171/2/2 a2=true/124/124/0/2 a3=true/50/50/0/0 d1=true/65/81/2/0 g1=true/185/201/2/2 g2=true/72/80/0/0');
  perform round_stats_fixture.expect('C60 old team rows kept', round_stats_fixture.teams(3001),
    'T1/1=295/6 T1/overall=295/6 T2/3=81/2 T2/overall=270/6');
  perform round_stats_fixture.expect('C60 old penalty points kept', round_stats_fixture.pp(3001), 'a1=2 x4=3');
  perform round_stats_fixture.expect('C60 issue recorded',
    (select error_message from public.round_stats_issues where subsession_id = 3001),
    'Refresh failed: forced failure for round 3001');
  perform round_stats_fixture.expect('C60 the other round is untouched',
    (select count(*) from public.round_stats_issues where subsession_id = 3002), 0::bigint);
end $$;
drop trigger round_stats_fixture_fail on public.round_penalty_points;
do $$
begin
  perform 1 from public.rebuild_season_stats('bbbbbbbb-0000-0000-0000-000000000301');
  perform round_stats_fixture.expect('C60 the rebuild clears the issue',
    (select count(*) from public.round_stats_issues where subsession_id = 3001), 0::bigint);
  perform round_stats_fixture.expect('C60 the rebuild stores the new values',
    round_stats_fixture.col(3001, 'case when c.code = ''g2'' then t.overall_points end'),
    'a1=- a2=- a3=- d1=- g1=- g2=67');
  perform round_stats_fixture.expect('C60 the rebuild stores the new penalty points', round_stats_fixture.pp(3001), 'a1=2 g2=4 x4=3');
  raise notice 'ok C60 failure recorded, rows and write kept';
end $$;
rollback to savepoint fixture;

-- C61 rebuild_season_stats refuses a non-admin and an unknown season (BR2.5) ---------------------
do $$
declare
  v bigint;
begin
  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-0000-0000-000000000302","role":"authenticated"}', true);
  set local role authenticated;
  begin
    perform 1 from public.rebuild_season_stats('bbbbbbbb-0000-0000-0000-000000000301');
    reset role;
    raise exception 'round stats fixture failed: C61 a non-admin rebuilt a season';
  exception when insufficient_privilege then
    reset role;
  end;

  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-0000-0000-000000000301","role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into v from public.rebuild_season_stats('bbbbbbbb-0000-0000-0000-000000000301');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform round_stats_fixture.expect('C61 an admin rebuilds every round', v, 2::bigint);

  begin
    perform 1 from public.rebuild_season_stats('bbbbbbbb-0000-0000-0000-000000000399');
    raise exception 'round stats fixture failed: C61 an unknown season was accepted';
  exception when others then
    if sqlerrm not like 'No such season:%' then
      raise;
    end if;
  end;
  raise notice 'ok C61 rebuild access';
end $$;
rollback to savepoint fixture;

-- C62 A penalty-points-only change in a locked season refreshes round_penalty_points (review R-03)
insert into public.round_incident_status (subsession_id, posted, posted_at) values (3001, true, now());
select round_stats_fixture.flush();
update public.seasons set standings_locked_at = now() where id = 'bbbbbbbb-0000-0000-0000-000000000301';
create table round_stats_fixture.score_writes (n integer not null);
create function round_stats_fixture.count_score_write() returns trigger
  language plpgsql as $$
begin
  insert into round_stats_fixture.score_writes values (1);
  return null;
end;
$$;
create trigger round_stats_fixture_score_writes after insert or delete on public.race_score_results
  for each statement execute function round_stats_fixture.count_score_write();
do $$
begin
  insert into public.penalties (subsession_id, race_number, session_type, driver_id, penalty_points)
  values (3001, 1, 'race', '77777777-0000-0000-0000-000000000305', 4);
  perform round_stats_fixture.flush();
  perform round_stats_fixture.expect('C62 score_round wrote nothing (locked, unchanged)',
    (select count(*) from round_stats_fixture.score_writes), 0::bigint);
  perform round_stats_fixture.expect('C62 penalty points refreshed', round_stats_fixture.pp(3001), 'a1=2 g2=4 x4=3');
  raise notice 'ok C62 penalty-points-only change in a locked season';
end $$;
rollback to savepoint fixture;

-- C63 A penalty for a driver with no score row lands in round_penalty_points only (review R-02) ---
insert into public.round_incident_status (subsession_id, posted, posted_at) values (3001, true, now());
select round_stats_fixture.flush();
do $$
begin
  perform round_stats_fixture.expect('C63 x4 has penalty points',
    (select penalty_points from public.round_penalty_points
     where subsession_id = 3001 and driver_id = round_stats_fixture.id('x4')), 3);
  perform round_stats_fixture.expect('C63 x4 has no driver row (no appearance, no pool round)',
    (select count(*) from public.round_driver_stats
     where subsession_id = 3001 and driver_id = round_stats_fixture.id('x4')), 0::bigint);
  raise notice 'ok C63 penalty without a score row';
end $$;
rollback to savepoint fixture;

-- C64 One import touching a round refreshes it once (review R-06) -------------------------------
create table round_stats_fixture.refreshes (subsession_id bigint not null);
create function round_stats_fixture.count_refresh() returns trigger
  language plpgsql as $$
begin
  insert into round_stats_fixture.refreshes select distinct n.subsession_id from new_rows n;
  return null;
end;
$$;
create trigger round_stats_fixture_count after insert on public.round_driver_stats
  referencing new table as new_rows for each statement execute function round_stats_fixture.count_refresh();
insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, format) values
  (3003, '2026-03-15 18:00+00', 'Stats Park', 'bbbbbbbb-0000-0000-0000-000000000301', 'endurance');
insert into public.curated_race_results
  (subsession_id, race_number, cust_id, display_name, finish_position, laps_complete, interval_ten_thousandths,
   starting_position, incidents)
values
  (3003, 1, 301, 'a1', 1, 20, 0, 1, 0), (3003, 1, 302, 'a2', 2, 20, 10000, 2, 0), (3003, 1, 304, 'g1', 3, 20, 20000, 3, 0),
  (3003, 2, 304, 'g1', 1, 20, 0, 3, 0), (3003, 2, 301, 'a1', 2, 20, 10000, 1, 0), (3003, 2, 302, 'a2', 3, 20, 20000, 2, 0);
update public.curated_race_results set incidents = 2 where subsession_id = 3003 and cust_id = 302;
insert into public.penalties (subsession_id, race_number, session_type, driver_id, points_penalty, penalty_points)
values (3003, 1, 'race', '77777777-0000-0000-0000-000000000301', 3, 1);
insert into public.round_incident_status (subsession_id, posted, posted_at) values (3003, true, now());
select round_stats_fixture.flush();
do $$
begin
  perform round_stats_fixture.expect('C64 the imported round refreshed once',
    (select count(*) from round_stats_fixture.refreshes where subsession_id = 3003), 1::bigint);
  perform round_stats_fixture.expect('C64 no other round refreshed',
    (select count(*) from round_stats_fixture.refreshes where subsession_id <> 3003), 0::bigint);
  perform round_stats_fixture.expect('C64 the refresh saw every write',
    round_stats_fixture.col(3003, 't.final_visible || ''/'' || t.incidents'), 'a1=true/0 a2=true/4 g1=true/0');
  perform round_stats_fixture.expect('C64 queue drained', (select count(*) from private.round_stats_pending), 0::bigint);
  raise notice 'ok C64 one refresh per import';
end $$;
rollback to savepoint fixture;

-- C65 A cascade delete of a round leaves no stats and raises nothing (review R-06) --------------
insert into public.round_stats_issues (subsession_id, season_id, error_message)
values (3001, 'bbbbbbbb-0000-0000-0000-000000000301', 'fixture issue');
delete from public.curated_rounds where subsession_id = 3001;
select round_stats_fixture.flush();
do $$
begin
  perform round_stats_fixture.expect('C65 driver rows gone',
    (select count(*) from public.round_driver_stats where subsession_id = 3001), 0::bigint);
  perform round_stats_fixture.expect('C65 team rows gone',
    (select count(*) from public.round_team_stats where subsession_id = 3001), 0::bigint);
  perform round_stats_fixture.expect('C65 penalty points gone',
    (select count(*) from public.round_penalty_points where subsession_id = 3001), 0::bigint);
  perform round_stats_fixture.expect('C65 the deleted round''s issue is cleared',
    (select count(*) from public.round_stats_issues where subsession_id = 3001), 0::bigint);
  perform round_stats_fixture.expect('C65 the other round is untouched',
    (select count(*) from public.round_driver_stats where subsession_id = 3002), 9::bigint);
  raise notice 'ok C65 cascade delete';
end $$;
rollback to savepoint fixture;

-- C66 A round left with no score rows has no stats (review R-06) --------------------------------
update public.curated_rounds set format = null where subsession_id = 3001;
select round_stats_fixture.flush();
do $$
begin
  perform round_stats_fixture.expect('C66 no score rows',
    (select count(*) from public.race_score_results where subsession_id = 3001), 0::bigint);
  perform round_stats_fixture.expect('C66 no driver rows',
    (select count(*) from public.round_driver_stats where subsession_id = 3001), 0::bigint);
  perform round_stats_fixture.expect('C66 no team rows',
    (select count(*) from public.round_team_stats where subsession_id = 3001), 0::bigint);
  perform round_stats_fixture.expect('C66 not a refresh failure',
    (select count(*) from public.round_stats_issues where subsession_id = 3001), 0::bigint);
  raise notice 'ok C66 round with no score rows';
end $$;
rollback to savepoint fixture;

-- C68 Unposting while the build fails leaves no rows for the round: missing, never penalised (BR3.1)
insert into public.round_incident_status (subsession_id, posted, posted_at) values (3001, true, now());
select round_stats_fixture.flush();
create function round_stats_fixture.fail_insert() returns trigger
  language plpgsql as $$
begin
  raise exception 'forced failure for round %', new.subsession_id;
end;
$$;
create trigger round_stats_fixture_fail before insert on public.round_driver_stats
  for each row when (new.subsession_id = 3001) execute function round_stats_fixture.fail_insert();
update public.round_incident_status set posted = false where subsession_id = 3001;
select round_stats_fixture.flush();
do $$
begin
  perform round_stats_fixture.expect('C68 the unposting was saved',
    (select posted from public.round_incident_status where subsession_id = 3001), false);
  perform round_stats_fixture.expect('C68 no driver rows',
    (select count(*) from public.round_driver_stats where subsession_id = 3001), 0::bigint);
  perform round_stats_fixture.expect('C68 no team rows',
    (select count(*) from public.round_team_stats where subsession_id = 3001), 0::bigint);
  perform round_stats_fixture.expect('C68 no penalty points',
    (select count(*) from public.round_penalty_points where subsession_id = 3001), 0::bigint);
  perform round_stats_fixture.expect('C68 issue recorded',
    (select error_message from public.round_stats_issues where subsession_id = 3001),
    'Refresh failed: forced failure for round 3001');
  perform round_stats_fixture.expect('C68 the other round keeps its rows',
    (select count(*) from public.round_driver_stats where subsession_id = 3002), 9::bigint);
  raise notice 'ok C68 failed refresh of an unposted round leaves no rows';
end $$;
rollback to savepoint fixture;

-- C69 Unposting with the kill switch off still switches the rows to the raw set (BR3.1, BR2.2) ----
insert into public.round_incident_status (subsession_id, posted, posted_at) values (3001, true, now());
select round_stats_fixture.flush();
update public.scoring_settings set triggers_enabled = false;
update public.round_incident_status set posted = false where subsession_id = 3001;
select round_stats_fixture.flush();
do $$
begin
  perform round_stats_fixture.expect('C69 raw set after unposting',
    round_stats_fixture.col(3001, 't.final_visible || ''/'' || t.overall_points'),
    'a1=false/181 a2=false/124 a3=false/50 d1=false/65 g1=false/185 g2=false/72');
  perform round_stats_fixture.expect('C69 no penalty points', round_stats_fixture.pp(3001), '');
  perform round_stats_fixture.expect('C69 queue drained', (select count(*) from private.round_stats_pending), 0::bigint);
end $$;
-- Other inputs keep honouring the switch: posting again is not refreshed.
update public.round_incident_status set posted = true where subsession_id = 3001;
select round_stats_fixture.flush();
do $$
begin
  perform round_stats_fixture.expect('C69 a posting with the switch off is not refreshed',
    (select count(*) from public.round_driver_stats where subsession_id = 3001 and final_visible), 0::bigint);
  raise notice 'ok C69 unposting with the kill switch off';
end $$;
rollback to savepoint fixture;

-- C70 Deleting a posted status row with the kill switch off also switches to the raw set (BR3.1) --
insert into public.round_incident_status (subsession_id, posted, posted_at) values (3001, true, now());
select round_stats_fixture.flush();
update public.scoring_settings set triggers_enabled = false;
delete from public.round_incident_status where subsession_id = 3001;
select round_stats_fixture.flush();
do $$
begin
  perform round_stats_fixture.expect('C70 raw set after the status row is deleted',
    round_stats_fixture.col(3001, 't.final_visible || ''/'' || t.overall_points'),
    'a1=false/181 a2=false/124 a3=false/50 d1=false/65 g1=false/185 g2=false/72');
  perform round_stats_fixture.expect('C70 no penalty points', round_stats_fixture.pp(3001), '');
  raise notice 'ok C70 deleted posted status with the kill switch off';
end $$;
rollback to savepoint fixture;

-- C71 round_stats_status: current after a refresh, posted or not --------------------------------
do $$
begin
  perform round_stats_fixture.expect('C71 current after the base refresh',
    round_stats_fixture.status('bbbbbbbb-0000-0000-0000-000000000301'), 'true/-');
end $$;
insert into public.round_incident_status (subsession_id, posted, posted_at) values (3001, true, now());
select round_stats_fixture.flush();
do $$
begin
  perform round_stats_fixture.expect('C71 current after posting and its refresh',
    round_stats_fixture.status('bbbbbbbb-0000-0000-0000-000000000301'), 'true/-');
  perform round_stats_fixture.expect('C71 one row per season, unknown seasons named',
    (select string_agg(s.season_id || '=' || s."current" || '/' || coalesce(s.reason, '-'), ' ' order by s.season_id)
     from public.round_stats_status(array['bbbbbbbb-0000-0000-0000-000000000301'::uuid,
                                          'bbbbbbbb-0000-0000-0000-000000000399'::uuid,
                                          'bbbbbbbb-0000-0000-0000-000000000301'::uuid, null]) s),
    'bbbbbbbb-0000-0000-0000-000000000301=true/- bbbbbbbb-0000-0000-0000-000000000399=false/No such season');
  raise notice 'ok C71 status current after a refresh';
end $$;
rollback to savepoint fixture;

-- C72 round_stats_status: not current with the kill switch off ---------------------------------
update public.scoring_settings set triggers_enabled = false;
do $$
begin
  perform round_stats_fixture.expect('C72 kill switch off',
    round_stats_fixture.status('bbbbbbbb-0000-0000-0000-000000000301'), 'false/The scoring kill switch is off');
  raise notice 'ok C72 status with the kill switch off';
end $$;
rollback to savepoint fixture;

-- C73 round_stats_status: not current while a round has a refresh issue ------------------------
insert into public.round_stats_issues (subsession_id, season_id, error_message)
values (3002, 'bbbbbbbb-0000-0000-0000-000000000301', 'fixture issue');
do $$
begin
  perform round_stats_fixture.expect('C73 refresh issue',
    round_stats_fixture.status('bbbbbbbb-0000-0000-0000-000000000301'),
    'false/A round of this season has a recorded refresh issue');
  raise notice 'ok C73 status with a refresh issue';
end $$;
rollback to savepoint fixture;

-- C74 round_stats_status: not current when the stats are older than the scores ------------------
do $$
begin
  -- Rescored, and its refresh not run yet (it waits for commit).
  perform public.score_round(3001);
  perform round_stats_fixture.expect('C74 stats older than scores',
    round_stats_fixture.status('bbbbbbbb-0000-0000-0000-000000000301'), 'false/Stored stats are older than the scores');
  perform round_stats_fixture.flush();
  perform round_stats_fixture.expect('C74 current again after the refresh',
    round_stats_fixture.status('bbbbbbbb-0000-0000-0000-000000000301'), 'true/-');
  raise notice 'ok C74 status when stats are older than scores';
end $$;
rollback to savepoint fixture;

-- C75 round_stats_status: not current when the stored shown set disagrees with the posting -------
-- Posted, refresh not run yet. Within one transaction updated_at (now()) is not later than
-- refreshed_at, so it is the final_visible check that catches it here.
insert into public.round_incident_status (subsession_id, posted, posted_at) values (3001, true, now());
do $$
begin
  perform round_stats_fixture.expect('C75 posted but stored raw',
    round_stats_fixture.status('bbbbbbbb-0000-0000-0000-000000000301'),
    'false/Stored stats do not match a round''s posting status');
  perform round_stats_fixture.flush();
  perform round_stats_fixture.expect('C75 current after the refresh',
    round_stats_fixture.status('bbbbbbbb-0000-0000-0000-000000000301'), 'true/-');
end $$;
-- A deleted posted status row, refresh not run yet: stored final, now unposted.
delete from public.round_incident_status where subsession_id = 3001;
do $$
begin
  perform round_stats_fixture.expect('C75 unposted by deletion but stored final',
    round_stats_fixture.status('bbbbbbbb-0000-0000-0000-000000000301'),
    'false/Stored stats do not match a round''s posting status');
  raise notice 'ok C75 status when the posting disagrees';
end $$;
rollback to savepoint fixture;

-- C76 round_stats_status: anon and authenticated can call it; the helper stays closed -----------
do $$
declare
  v boolean;
begin
  perform round_stats_fixture.expect('C76 anon execute', has_function_privilege('anon', 'public.round_stats_status(uuid[])', 'execute'), true);
  perform round_stats_fixture.expect('C76 authenticated execute', has_function_privilege('authenticated', 'public.round_stats_status(uuid[])', 'execute'), true);
  perform round_stats_fixture.expect('C76 anon execute helper', has_function_privilege('anon', 'private.round_stats_stale_reason(uuid)', 'execute'), false);
  set local role anon;
  select s."current" into v from public.round_stats_status(array['bbbbbbbb-0000-0000-0000-000000000301'::uuid]) s;
  reset role;
  perform round_stats_fixture.expect('C76 anon reads the status', v, true);
  raise notice 'ok C76 status access';
end $$;
rollback to savepoint fixture;

-- C67 Timing at real-round size: reports the refresh's added time over score_round (BR5.1) -------
-- Last in the file so a slow runner cannot stop the cases above. It reports and never fails: the
-- owner accepted about 30% on 2026-10-23 (the limit was 20%).
-- Production's largest round (subsession 71031341, read-only on 2026-10-22): 120 score rows
-- (2 races x 60 drivers), 120 raw results, 24 penalties. The fixture round has the same counts:
-- 60 drivers in 20 teams of 3, every class, 24 penalties (time, points and PP).
insert into public.teams (id, name)
select ('cccccccc-0000-0000-0000-' || lpad((400 + t)::text, 12, '0'))::uuid, 'Timing team ' || t
from generate_series(1, 20) as t;
insert into public.drivers (id, name, status_id, class_id, iracing_cust_id)
select ('66666666-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'Timing ' || n, 1, (n % 3) + 1, 5000 + n
from generate_series(1, 60) as n;
insert into public.team_rosters (season_id, team_id, driver_id)
select 'bbbbbbbb-0000-0000-0000-000000000301',
       ('cccccccc-0000-0000-0000-' || lpad((400 + (n - 1) / 3 + 1)::text, 12, '0'))::uuid,
       ('66666666-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
from generate_series(1, 60) as n;
insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, format) values
  (3100, '2026-04-01 18:00+00', 'Stats Park', 'bbbbbbbb-0000-0000-0000-000000000301', 'endurance');
insert into public.curated_race_results
  (subsession_id, race_number, cust_id, display_name, finish_position, laps_complete, interval_ten_thousandths,
   average_lap_ten_thousandths, starting_position, incidents, laps_led, car_name, reason_out)
select 3100, r, 5000 + n, 'Timing ' || n, p.pos, 20, (p.pos - 1) * 10000, 900000 + p.pos * 100, n, n % 4,
       case when p.pos = 1 then 20 else 0 end, 'Car ' || (n % 3), 'Running'
from generate_series(1, 2) as r
cross join generate_series(1, 60) as n
cross join lateral (select ((n - 1 + 7 * r) % 60) + 1 as pos) p;
insert into public.penalties (subsession_id, race_number, session_type, driver_id, time_penalty_seconds, points_penalty, penalty_points)
select 3100, 1, 'race', ('66666666-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       case when n % 2 = 1 then 5 end, case when n % 2 = 0 then 2 else 0 end, 1
from generate_series(1, 24) as n;
insert into public.round_incident_status (subsession_id, posted, posted_at) values (3100, true, now());
select round_stats_fixture.flush();
-- Switches the queueing triggers score_round's writes fire, and the drain, off or on.
create function round_stats_fixture.set_round_stats_triggers(p_enabled boolean) returns void
  language plpgsql as $$
declare
  v_action text := case when p_enabled then 'enable' else 'disable' end;
begin
  execute format('alter table public.race_score_results %s trigger round_stats_on_race_score_results_insert', v_action);
  execute format('alter table public.race_score_results %s trigger round_stats_on_race_score_results_update', v_action);
  execute format('alter table public.race_score_results %s trigger round_stats_on_race_score_results_delete', v_action);
  execute format('alter table private.round_stats_pending %s trigger round_stats_drain', v_action);
end;
$$;
do $$
declare
  v_t0 timestamp with time zone;
  v_elapsed interval;
  v_without interval;
  v_with interval;
  v_added numeric;
begin
  perform round_stats_fixture.expect('C67 real-round size: score rows',
    (select count(*) from public.race_score_results where subsession_id = 3100), 120::bigint);
  perform round_stats_fixture.expect('C67 real-round size: driver rows',
    (select count(*) from public.round_driver_stats where subsession_id = 3100), 60::bigint);
  -- The fastest of five runs each, interleaved, so one slow run on a shared runner cannot decide it.
  -- The baseline runs score_round with the round stats queueing triggers and the drain disabled, so
  -- the added time counts the queueing as well as the one refresh a "with" run's writes queue.
  for i in 1 .. 5 loop
    perform round_stats_fixture.set_round_stats_triggers(false);
    v_t0 := clock_timestamp();
    perform public.score_round(3100);
    v_elapsed := clock_timestamp() - v_t0;
    v_without := least(coalesce(v_without, v_elapsed), v_elapsed);
    perform round_stats_fixture.expect('C67 nothing queued by the baseline',
      (select count(*) from private.round_stats_pending), 0::bigint);
    perform round_stats_fixture.set_round_stats_triggers(true);

    v_t0 := clock_timestamp();
    perform public.score_round(3100);
    perform round_stats_fixture.flush();
    v_elapsed := clock_timestamp() - v_t0;
    v_with := least(coalesce(v_with, v_elapsed), v_elapsed);
  end loop;
  v_added := extract(epoch from (v_with - v_without)) / nullif(extract(epoch from v_without), 0);
  raise notice 'C67 timing: score_round % ms, with the refresh % ms, added % %% (owner accepted ~30%% on 2026-10-23; limit was 20%%)',
    round(extract(epoch from v_without) * 1000, 2), round(extract(epoch from v_with) * 1000, 2),
    round(coalesce(v_added, 0) * 100, 1);
  raise notice 'ok C67 timing at real-round size (reported, not enforced)';
end $$;
rollback to savepoint fixture;

rollback;
