-- Scoring fixtures for score_round, score_round_preview, the scoring triggers, the write guard and
-- race_score_results_public (unit scoring-ownership, BR1.3, BR2.1-BR2.6, BR3.1-BR3.7, BR4.1, BR4.2).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild):
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/scoring-fixtures.sql
--
-- Convention (see supabase/checks/README.md): every assertion calls scoring_fixture.expect(), which
-- raises an exception naming the case when the actual value differs from the expected one, so the
-- first failure stops psql with a non-zero exit. Everything runs in one transaction that is rolled
-- back at the end, and each case runs after `savepoint fixture` and is undone with
-- `rollback to savepoint fixture`, so cases never see each other's rows and nothing is left behind.
--
-- Base round 1001 (season "Fixture Season 1", endurance, plain ruleset: [100,80,60,40,30],
-- classified_minimum 5, class podium [8,4,2] for Gamma/Delta). Leader average lap 90.0000 s.
--   cust driver class  pos laps interval   avg lap    start
--   101  d1     Alpha  1   20   0          900000     1
--   102  d2     Alpha  2   20   50000      902500     2
--   103  d3     Alpha  3   20   120000     906000     3
--   105  d5     Gamma  4   20   200000     910000     7
--   106  d6     Gamma  5   19   -1 (1L)    950000     6
--   107  (not on the roster) 6 19 -1     960000     5
--   104  d4     Alpha  7   19   -1 (1L)    1000000    4
--   108  d7     Alpha  8   5    -1         1100000    8   (unclassified: under 50% of 20 laps)
-- Times are in ten-thousandths of a second, as curated_race_results stores them.

begin;

set local client_min_messages = notice;

create schema scoring_fixture;

-- "<cust>=<value>" for every stored row of a round, ordered by cust id; '-' for null.
create function scoring_fixture.col(p_subsession_id bigint, p_expr text) returns text
  language plpgsql as $$
declare
  v text;
begin
  execute format(
    'select string_agg(d.iracing_cust_id || ''='' || coalesce((%s)::text, ''-''), '' '' order by d.iracing_cust_id)
     from public.race_score_results r join public.drivers d on d.id = r.driver_id
     where r.subsession_id = $1', p_expr)
  into v using p_subsession_id;
  return coalesce(v, '');
end;
$$;

-- The same for the rows score_round_preview returns with the given switches.
create function scoring_fixture.preview_col(p_subsession_id bigint, p_switches jsonb, p_expr text) returns text
  language plpgsql as $$
declare
  v text;
begin
  execute format(
    'select string_agg(d.iracing_cust_id || ''='' || coalesce((%s)::text, ''-''), '' '' order by d.iracing_cust_id)
     from public.score_round_preview($1, $2) r join public.drivers d on d.id = r.driver_id', p_expr)
  into v using p_subsession_id, p_switches;
  return coalesce(v, '');
end;
$$;

create function scoring_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'scoring fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

create function scoring_fixture.last_scored(p_subsession_id bigint) returns timestamp with time zone
  language sql as $$
  select max(r.scored_at) from public.race_score_results r where r.subsession_id = p_subsession_id;
$$;

-- Base data ------------------------------------------------------------------------------------

insert into public.driver_statuses (id, name) values (1, 'Active');
insert into public.driver_classes (id, name, sort_order) values (1, 'Alpha', 1), (2, 'Gamma', 2), (3, 'Delta', 3);
insert into public.teams (id, name) values ('cccccccc-0000-0000-0000-000000000001', 'Fixture Team');

insert into public.scoring_rulesets (id, name, rules) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Fixture plain', '{
    "base_points": {"endurance": [100, 80, 60, 40, 30], "sprint": [50, 40, 30]},
    "classified_minimum": {"endurance": 5, "sprint": 2},
    "class_podium": {"endurance": [8, 4, 2], "sprint": [4, 2, 1], "applies_to": ["Gamma", "Delta"]},
    "bonuses": {}
  }'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Fixture bonus', '{
    "base_points": {"endurance": [100, 80, 60, 40, 30], "sprint": [50, 40, 30]},
    "classified_minimum": {"endurance": 5, "sprint": 2},
    "class_podium": {"endurance": [8, 4, 2], "sprint": [4, 2, 1], "applies_to": ["Gamma", "Delta"]},
    "bonuses": {
      "naked_aggression": {"enabled": true, "endurance": 3},
      "sublime_finesse": {"enabled": true, "endurance": 1, "max_incidents": 0},
      "fastest_lap": {"enabled": true, "per": "race", "top_x": 3, "endurance": 2}
    }
  }'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Fixture broken', '{
    "base_points": {"endurance": [100, 80, 60]},
    "classified_minimum": {"sprint": 2}
  }');

insert into public.seasons (id, number, name, scoring_ruleset_id, gamma_enabled, delta_enabled) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 9001, 'Fixture Season 1', 'aaaaaaaa-0000-0000-0000-000000000001', true, true),
  ('bbbbbbbb-0000-0000-0000-000000000002', 9002, 'Fixture Season 2', 'aaaaaaaa-0000-0000-0000-000000000001', true, true),
  ('bbbbbbbb-0000-0000-0000-000000000003', 9003, 'Fixture Season 3', 'aaaaaaaa-0000-0000-0000-000000000003', true, true);

insert into public.drivers (id, name, status_id, class_id, iracing_cust_id) values
  ('dddddddd-0000-0000-0000-000000000001', 'Fixture d1', 1, 1, 101),
  ('dddddddd-0000-0000-0000-000000000002', 'Fixture d2', 1, 1, 102),
  ('dddddddd-0000-0000-0000-000000000003', 'Fixture d3', 1, 1, 103),
  ('dddddddd-0000-0000-0000-000000000004', 'Fixture d4', 1, 1, 104),
  ('dddddddd-0000-0000-0000-000000000005', 'Fixture d5', 1, 2, 105),
  ('dddddddd-0000-0000-0000-000000000006', 'Fixture d6', 1, 2, 106),
  ('dddddddd-0000-0000-0000-000000000007', 'Fixture d7', 1, 1, 108);

insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, format) values
  (1001, '2026-01-01 18:00+00', 'Fixture Park', 'bbbbbbbb-0000-0000-0000-000000000001', 'endurance');

insert into public.curated_race_results
  (subsession_id, race_number, cust_id, display_name, finish_position, laps_complete,
   interval_ten_thousandths, average_lap_ten_thousandths, starting_position, incidents,
   best_lap_ten_thousandths, laps_led, reason_out)
values
  (1001, 1, 101, 'd1', 1, 20, 0, 900000, 1, 2, 880000, 20, 'Running'),
  (1001, 1, 102, 'd2', 2, 20, 50000, 902500, 2, 0, 879000, 0, 'Running'),
  (1001, 1, 103, 'd3', 3, 20, 120000, 906000, 3, 1, 885000, 0, 'Running'),
  (1001, 1, 105, 'd5', 4, 20, 200000, 910000, 7, 4, 881000, 0, 'Running'),
  (1001, 1, 106, 'd6', 5, 19, -1, 950000, 6, 0, 890000, 0, 'Running'),
  (1001, 1, 107, 'guest', 6, 19, -1, 960000, 5, 2, 900000, 0, 'Running'),
  (1001, 1, 104, 'd4', 7, 19, -1, 1000000, 4, 3, 950000, 0, 'Running'),
  (1001, 1, 108, 'd7', 8, 5, -1, 1100000, 8, 0, 1000000, 0, 'Disconnected');

-- An admin and a non-admin account (the auth.users insert creates a 'driver' profile).
insert into auth.users (id, email) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'fixture-admin@example.invalid'),
  ('eeeeeeee-0000-0000-0000-000000000002', 'fixture-driver@example.invalid');
delete from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000001';
insert into public.profiles (id, role) values ('eeeeeeee-0000-0000-0000-000000000001', 'admin');
insert into public.profiles (id, role) values ('eeeeeeee-0000-0000-0000-000000000002', 'driver')
  on conflict (id) do nothing;

savepoint fixture;

-- C01 Raw scoring of the base round (triggers scored it on insert) ------------------------------
do $$
begin
  perform scoring_fixture.expect('C01 rows (no row for the unrostered entrant)',
    (select count(*) from public.race_score_results where subsession_id = 1001), 7::bigint);
  perform scoring_fixture.expect('C01 raw_position', scoring_fixture.col(1001, 'r.raw_position'),
    '101=1 102=2 103=3 104=7 105=4 106=5 108=8');
  perform scoring_fixture.expect('C01 raw_laps_down', scoring_fixture.col(1001, 'r.raw_laps_down'),
    '101=0 102=0 103=0 104=1 105=0 106=1 108=15');
  perform scoring_fixture.expect('C01 raw_gap_ms', scoring_fixture.col(1001, 'r.raw_gap_ms'),
    '101=0 102=5000 103=12000 104=- 105=20000 106=- 108=-');
  perform scoring_fixture.expect('C01 raw_race_time_ms', scoring_fixture.col(1001, 'r.raw_race_time_ms'),
    '101=1800000 102=1805000 103=1812000 104=1900000 105=1820000 106=1805000 108=550000');
  perform scoring_fixture.expect('C01 raw_finish_points', scoring_fixture.col(1001, 'r.raw_finish_points'),
    '101=100 102=80 103=60 104=5 105=40 106=30 108=0');
  perform scoring_fixture.expect('C01 raw_class_points', scoring_fixture.col(1001, 'r.raw_class_points'),
    '101=0 102=0 103=0 104=0 105=8 106=4 108=0');
  perform scoring_fixture.expect('C01 raw_overall_total', scoring_fixture.col(1001, 'r.raw_overall_total'),
    '101=100 102=80 103=60 104=5 105=40 106=30 108=0');
  perform scoring_fixture.expect('C01 raw_class_total', scoring_fixture.col(1001, 'r.raw_class_total'),
    '101=100 102=80 103=60 104=5 105=48 106=34 108=0');
  perform scoring_fixture.expect('C01 season and class', scoring_fixture.col(1001, 'r.season_id = ''bbbbbbbb-0000-0000-0000-000000000001'' and r.class_id = (case when d.iracing_cust_id in (105, 106) then 2 else 1 end)'),
    '101=true 102=true 103=true 104=true 105=true 106=true 108=true');
  raise notice 'ok C01 raw positions, gaps, race time, points and totals';
end $$;
rollback to savepoint fixture;

-- C02 classified_minimum past the end of a short table (Q4 A); today's rule gives 0 -----------
do $$
begin
  perform scoring_fixture.expect('C02 P7 past a 5-row table', scoring_fixture.col(1001, 'r.raw_finish_points'),
    '101=100 102=80 103=60 104=5 105=40 106=30 108=0');
  perform scoring_fixture.expect('C02 short-points-table off',
    scoring_fixture.preview_col(1001, '{"short-points-table": false}', 'r.raw_finish_points'),
    '101=100 102=80 103=60 104=0 105=40 106=30 108=0');
  raise notice 'ok C02 classified_minimum past the end of the table';
end $$;
rollback to savepoint fixture;

-- C03 Class position counts ranked non-DSQ rows, unclassified included (BR2.4) ----------------
do $$
begin
  perform scoring_fixture.expect('C03 classified flag', scoring_fixture.col(1001, 'r.classified'),
    '101=true 102=true 103=true 104=true 105=true 106=true 108=false');
  perform scoring_fixture.expect('C03 raw_class_position', scoring_fixture.col(1001, 'r.raw_class_position'),
    '101=1 102=2 103=3 104=4 105=1 106=2 108=5');
  perform scoring_fixture.expect('C03 class-position-ranking off',
    scoring_fixture.preview_col(1001, '{"class-position-ranking": false}', 'r.raw_class_position'),
    '101=1 102=2 103=3 104=4 105=1 106=2 108=-');
  raise notice 'ok C03 class position ranking';
end $$;
rollback to savepoint fixture;

-- C04 No time penalty: final equals raw, nobody penalised (BR2.3) ------------------------------
do $$
begin
  perform scoring_fixture.expect('C04 final differs from raw',
    (select count(*) from public.race_score_results r
     where r.subsession_id = 1001
       and row(r.final_position, r.final_class_position, r.final_laps_down, r.final_gap_ms, r.final_race_time_ms,
               r.final_finish_points, r.final_class_points, r.final_overall_total, r.final_class_total)
           is distinct from
           row(r.raw_position, r.raw_class_position, r.raw_laps_down, r.raw_gap_ms, r.raw_race_time_ms,
               r.raw_finish_points, r.raw_class_points, r.raw_overall_total, r.raw_class_total)),
    0::bigint);
  perform scoring_fixture.expect('C04 penalised', scoring_fixture.col(1001, 'r.penalised'),
    '101=false 102=false 103=false 104=false 105=false 106=false 108=false');
  raise notice 'ok C04 no time penalty keeps the raw order';
end $$;
rollback to savepoint fixture;

-- C05 Lead-lap time penalty without a lap conversion (BR2.3 a) ---------------------------------
insert into public.penalties (subsession_id, race_number, driver_id, time_penalty_seconds)
values (1001, 1, 'dddddddd-0000-0000-0000-000000000001', 10);
do $$
begin
  perform scoring_fixture.expect('C05 final_position', scoring_fixture.col(1001, 'r.final_position'),
    '101=2 102=1 103=3 104=7 105=4 106=5 108=8');
  perform scoring_fixture.expect('C05 final_gap_ms re-zeroed to the new leader', scoring_fixture.col(1001, 'r.final_gap_ms'),
    '101=5000 102=0 103=7000 104=- 105=15000 106=- 108=-');
  perform scoring_fixture.expect('C05 final_finish_points', scoring_fixture.col(1001, 'r.final_finish_points'),
    '101=80 102=100 103=60 104=5 105=40 106=30 108=0');
  perform scoring_fixture.expect('C05 final_class_position', scoring_fixture.col(1001, 'r.final_class_position'),
    '101=2 102=1 103=3 104=4 105=1 106=2 108=5');
  perform scoring_fixture.expect('C05 final_race_time_ms adds the penalty', scoring_fixture.col(1001, 'r.final_race_time_ms'),
    '101=1810000 102=1805000 103=1812000 104=1900000 105=1820000 106=1805000 108=550000');
  perform scoring_fixture.expect('C05 penalised', scoring_fixture.col(1001, 'r.penalised'),
    '101=true 102=true 103=false 104=false 105=false 106=false 108=false');
  perform scoring_fixture.expect('C05 raw set untouched', scoring_fixture.col(1001, 'r.raw_position'),
    '101=1 102=2 103=3 104=7 105=4 106=5 108=8');
  raise notice 'ok C05 lead-lap time penalty';
end $$;
rollback to savepoint fixture;

-- C06 Lead-lap time penalty that converts to a lap down; cross-class ripple (Q13 A) -----------
insert into public.penalties (subsession_id, race_number, driver_id, time_penalty_seconds)
values (1001, 1, 'dddddddd-0000-0000-0000-000000000001', 95);
do $$
begin
  perform scoring_fixture.expect('C06 final_position', scoring_fixture.col(1001, 'r.final_position'),
    '101=5 102=1 103=2 104=7 105=3 106=4 108=8');
  perform scoring_fixture.expect('C06 final_laps_down', scoring_fixture.col(1001, 'r.final_laps_down'),
    '101=1 102=0 103=0 104=1 105=0 106=1 108=15');
  perform scoring_fixture.expect('C06 final_gap_ms', scoring_fixture.col(1001, 'r.final_gap_ms'),
    '101=- 102=0 103=7000 104=- 105=15000 106=- 108=-');
  perform scoring_fixture.expect('C06 final_finish_points', scoring_fixture.col(1001, 'r.final_finish_points'),
    '101=30 102=100 103=80 104=5 105=60 106=40 108=0');
  perform scoring_fixture.expect('C06 final_class_total', scoring_fixture.col(1001, 'r.final_class_total'),
    '101=30 102=100 103=80 104=5 105=68 106=44 108=0');
  perform scoring_fixture.expect('C06 cross-class-ripple off keeps Gamma on raw points',
    scoring_fixture.preview_col(1001, '{"cross-class-ripple": false}', 'r.final_finish_points'),
    '101=30 102=100 103=80 104=5 105=40 106=30 108=0');
  raise notice 'ok C06 lap conversion and cross-class ripple';
end $$;
rollback to savepoint fixture;

-- C07 Laps-down time penalty from the race-time estimate (BR2.3 b) -----------------------------
insert into public.penalties (subsession_id, race_number, driver_id, time_penalty_seconds)
values (1001, 1, 'dddddddd-0000-0000-0000-000000000006', 30);
do $$
begin
  perform scoring_fixture.expect('C07 final_position', scoring_fixture.col(1001, 'r.final_position'),
    '101=1 102=2 103=3 104=7 105=4 106=6 108=8');
  perform scoring_fixture.expect('C07 final_finish_points (P6 past the table)', scoring_fixture.col(1001, 'r.final_finish_points'),
    '101=100 102=80 103=60 104=5 105=40 106=5 108=0');
  perform scoring_fixture.expect('C07 final_race_time_ms', scoring_fixture.col(1001, 'r.final_race_time_ms'),
    '101=1800000 102=1805000 103=1812000 104=1900000 105=1820000 106=1835000 108=550000');
  perform scoring_fixture.expect('C07 penalised', scoring_fixture.col(1001, 'r.penalised'),
    '101=false 102=false 103=false 104=false 105=false 106=true 108=false');
  raise notice 'ok C07 laps-down estimate';
end $$;
rollback to savepoint fixture;

-- C08 Missing average-lap data keeps the raw slot (BR2.3 c) -----------------------------------
update public.curated_race_results set average_lap_ten_thousandths = null where subsession_id = 1001 and cust_id = 106;
insert into public.penalties (subsession_id, race_number, driver_id, time_penalty_seconds)
values (1001, 1, 'dddddddd-0000-0000-0000-000000000006', 30);
do $$
begin
  perform scoring_fixture.expect('C08 final_position', scoring_fixture.col(1001, 'r.final_position'),
    '101=1 102=2 103=3 104=7 105=4 106=5 108=8');
  perform scoring_fixture.expect('C08 final_laps_down', scoring_fixture.col(1001, 'r.final_laps_down'),
    '101=0 102=0 103=0 104=1 105=0 106=1 108=15');
  perform scoring_fixture.expect('C08 no race time without an average lap', scoring_fixture.col(1001, 'r.final_race_time_ms'),
    '101=1800000 102=1805000 103=1812000 104=1900000 105=1820000 106=- 108=550000');
  perform scoring_fixture.expect('C08 penalised', scoring_fixture.col(1001, 'r.penalised'),
    '101=false 102=false 103=false 104=false 105=false 106=false 108=false');
  raise notice 'ok C08 missing average-lap data';
end $$;
rollback to savepoint fixture;

-- C09 Mixed touched and untouched laps-down group pins the placement; the TypeScript order ----
-- (reorder-tie-break off) leaves the penalised row where it was. Round 1002, leader 100.0000 s.
insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, format) values
  (1002, '2026-01-08 18:00+00', 'Fixture Park', 'bbbbbbbb-0000-0000-0000-000000000001', 'endurance');
insert into public.curated_race_results
  (subsession_id, race_number, cust_id, display_name, finish_position, laps_complete,
   interval_ten_thousandths, average_lap_ten_thousandths, starting_position, incidents)
values
  (1002, 1, 101, 'L', 1, 10, 0, 1000000, 1, 0),
  (1002, 1, 102, 'A', 2, 9, -1, 1144500, 2, 0),
  (1002, 1, 103, 'B', 3, 9, -1, 1122300, 3, 0),
  (1002, 1, 104, 'T', 4, 9, -1, 1111200, 4, 0);
insert into public.penalties (subsession_id, race_number, driver_id, time_penalty_seconds)
values (1002, 1, 'dddddddd-0000-0000-0000-000000000004', 20);
do $$
begin
  -- Estimated gaps: A 300500, B 100700 (untouched, raw order kept), T 800 + 200000 = 200800.
  perform scoring_fixture.expect('C09 deterministic placement', scoring_fixture.col(1002, 'r.final_position'),
    '101=1 102=3 103=4 104=2');
  perform scoring_fixture.expect('C09 finish points follow it', scoring_fixture.col(1002, 'r.final_finish_points'),
    '101=100 102=60 103=40 104=80');
  perform scoring_fixture.expect('C09 reorder-tie-break off (V8 order)',
    scoring_fixture.preview_col(1002, '{"reorder-tie-break": false}', 'r.final_position'),
    '101=1 102=2 103=3 104=4');
  raise notice 'ok C09 mixed laps-down group placement';
end $$;
rollback to savepoint fixture;

-- C10 DSQ'd rows follow the ranked rows with no position, and keep a flat penalty (Q4 A) -----
update public.curated_race_results set reason_out = 'Disqualified' where subsession_id = 1001 and cust_id = 103;
insert into public.penalties (subsession_id, race_number, driver_id, time_penalty_seconds, points_penalty) values
  (1001, 1, 'dddddddd-0000-0000-0000-000000000001', 10, 0),
  (1001, 1, 'dddddddd-0000-0000-0000-000000000003', null, 10);
do $$
begin
  perform scoring_fixture.expect('C10 raw_position', scoring_fixture.col(1001, 'r.raw_position'),
    '101=1 102=2 103=- 104=7 105=4 106=5 108=8');
  perform scoring_fixture.expect('C10 final_position', scoring_fixture.col(1001, 'r.final_position'),
    '101=2 102=1 103=- 104=6 105=3 106=4 108=7');
  perform scoring_fixture.expect('C10 final_class_position', scoring_fixture.col(1001, 'r.final_class_position'),
    '101=2 102=1 103=- 104=3 105=1 106=2 108=4');
  perform scoring_fixture.expect('C10 final_finish_points', scoring_fixture.col(1001, 'r.final_finish_points'),
    '101=80 102=100 103=0 104=5 105=60 106=40 108=0');
  perform scoring_fixture.expect('C10 DSQ deduction and totals', scoring_fixture.col(1001, 'r.final_points_deduction || ''/'' || r.final_overall_total || ''/'' || r.final_class_total'),
    '101=0/80/80 102=0/100/100 103=10/-10/-10 104=0/5/5 105=0/60/68 106=0/40/44 108=0/0/0');
  perform scoring_fixture.expect('C10 dsq flag', scoring_fixture.col(1001, 'r.dsq'),
    '101=false 102=false 103=true 104=false 105=false 106=false 108=false');
  perform scoring_fixture.expect('C10 dsq-flat-penalty off',
    scoring_fixture.preview_col(1001, '{"dsq-flat-penalty": false}', 'r.final_points_deduction || ''/'' || r.final_overall_total'),
    '101=0/80 102=0/100 103=0/0 104=0/5 105=0/60 106=0/40 108=0/0');
  raise notice 'ok C10 DSQ rows and the DSQ flat penalty';
end $$;
rollback to savepoint fixture;

-- C11 Appeal values replace the original ones (BR2.1) -----------------------------------------
insert into public.penalties (subsession_id, race_number, driver_id, time_penalty_seconds, points_penalty,
                              is_appealed, appeal_time_penalty_seconds, appeal_points_penalty)
values (1001, 1, 'dddddddd-0000-0000-0000-000000000002', 10, 10, true, 0, 3);
do $$
begin
  perform scoring_fixture.expect('C11 no reorder from an appealed-away time penalty', scoring_fixture.col(1001, 'r.final_position'),
    '101=1 102=2 103=3 104=7 105=4 106=5 108=8');
  perform scoring_fixture.expect('C11 appealed points', scoring_fixture.col(1001, 'r.final_points_deduction || ''/'' || r.final_overall_total || ''/'' || r.penalised'),
    '101=0/100/false 102=3/77/true 103=0/60/false 104=0/5/false 105=0/40/false 106=0/30/false 108=0/0/false');
  raise notice 'ok C11 appeal values';
end $$;
rollback to savepoint fixture;

-- C12 A qualifying penalty lands on race 1 (BR2.2) ---------------------------------------------
insert into public.penalties (subsession_id, race_number, session_type, driver_id, points_penalty)
values (1001, 0, 'qualifying', 'dddddddd-0000-0000-0000-000000000002', 7);
do $$
begin
  perform scoring_fixture.expect('C12 race 1 deduction', scoring_fixture.col(1001, 'r.final_points_deduction'),
    '101=0 102=7 103=0 104=0 105=0 106=0 108=0');
  perform scoring_fixture.expect('C12 non-race-penalty off',
    scoring_fixture.preview_col(1001, '{"non-race-penalty": false}', 'r.final_points_deduction'),
    '101=0 102=0 103=0 104=0 105=0 106=0 108=0');
  raise notice 'ok C12 qualifying penalty on race 1';
end $$;
rollback to savepoint fixture;

-- C13 A deduction is subtracted from both totals (BR2.5, BR2.6) --------------------------------
insert into public.penalties (subsession_id, race_number, driver_id, points_penalty)
values (1001, 1, 'dddddddd-0000-0000-0000-000000000005', 5);
do $$
begin
  perform scoring_fixture.expect('C13 final totals', scoring_fixture.col(1001, 'r.final_points_deduction || ''/'' || r.final_overall_total || ''/'' || r.final_class_total'),
    '101=0/100/100 102=0/80/80 103=0/60/60 104=0/5/5 105=5/35/43 106=0/30/34 108=0/0/0');
  perform scoring_fixture.expect('C13 raw totals carry no deduction', scoring_fixture.col(1001, 'r.raw_overall_total || ''/'' || r.raw_class_total'),
    '101=100/100 102=80/80 103=60/60 104=5/5 105=40/48 106=30/34 108=0/0');
  perform scoring_fixture.expect('C13 deduction-sign off',
    scoring_fixture.preview_col(1001, '{"deduction-sign": false}', 'r.final_points_deduction || ''/'' || r.final_overall_total'),
    '101=0/100 102=0/80 103=0/60 104=0/5 105=0/40 106=0/30 108=0/0');
  perform scoring_fixture.expect('C13 overall-formula off (finish + finesse + pole - deduction)',
    scoring_fixture.preview_col(1001, '{"overall-formula": false}', 'r.final_overall_total'),
    '101=100 102=80 103=60 104=5 105=35 106=30 108=0');
  raise notice 'ok C13 deductions and totals';
end $$;
rollback to savepoint fixture;

-- C14 Bonuses priced from the final order (Q2 B); the seasons trigger rescored the round -------
update public.seasons set scoring_ruleset_id = 'aaaaaaaa-0000-0000-0000-000000000002'
where id = 'bbbbbbbb-0000-0000-0000-000000000001';
do $$
begin
  perform scoring_fixture.expect('C14 raw aggression (d5 gained 3)', scoring_fixture.col(1001, 'r.raw_aggression_bonus'),
    '101=0 102=0 103=0 104=0 105=3 106=0 108=0');
  perform scoring_fixture.expect('C14 raw finesse (0 incidents, classified)', scoring_fixture.col(1001, 'r.raw_finesse_bonus'),
    '101=0 102=1 103=0 104=0 105=0 106=1 108=0');
  perform scoring_fixture.expect('C14 raw fastest lap in the top 3', scoring_fixture.col(1001, 'r.raw_fastest_lap_bonus'),
    '101=0 102=2 103=0 104=0 105=0 106=0 108=0');
end $$;
insert into public.penalties (subsession_id, race_number, driver_id, time_penalty_seconds)
values (1001, 1, 'dddddddd-0000-0000-0000-000000000005', 100);
do $$
begin
  perform scoring_fixture.expect('C14 final_position', scoring_fixture.col(1001, 'r.final_position'),
    '101=1 102=2 103=3 104=7 105=6 106=4 108=8');
  perform scoring_fixture.expect('C14 final aggression moves to d6', scoring_fixture.col(1001, 'r.final_aggression_bonus'),
    '101=0 102=0 103=0 104=0 105=0 106=3 108=0');
  perform scoring_fixture.expect('C14 final totals', scoring_fixture.col(1001, 'r.final_overall_total || ''/'' || r.final_class_total'),
    '101=100/100 102=83/83 103=60/60 104=5/5 105=5/9 106=44/52 108=0/0');
  perform scoring_fixture.expect('C14 bonus-after-reorder off',
    scoring_fixture.preview_col(1001, '{"bonus-after-reorder": false}', 'r.final_aggression_bonus'),
    '101=0 102=0 103=0 104=0 105=3 106=0 108=0');
  raise notice 'ok C14 bonuses priced from the final order';
end $$;
rollback to savepoint fixture;

-- C15 Concealment through the view, as anon, a driver and an admin (BR4.1, BR4.2) ------------
insert into public.penalties (subsession_id, race_number, driver_id, time_penalty_seconds, points_penalty)
values (1001, 1, 'dddddddd-0000-0000-0000-000000000001', 10, 4);
do $$
declare
  v text;
begin
  set local role anon;
  select string_agg(format('%s:%s/%s/%s/%s/%s', v2.race_number, v2.shown_set, v2.shown_position,
                           v2.shown_points_deduction, v2.shown_penalised, v2.raw_position), ' ')
  into v from public.race_score_results_public v2
  where v2.subsession_id = 1001 and v2.driver_id = 'dddddddd-0000-0000-0000-000000000001';
  reset role;
  perform scoring_fixture.expect('C15 anon sees the raw set of an unposted round', v, '1:raw/1/0/f/1');

  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-0000-0000-000000000002","role":"authenticated"}', true);
  set local role authenticated;
  select string_agg(format('%s/%s/%s', v2.shown_set, v2.shown_position, v2.shown_points_deduction), ' ')
  into v from public.race_score_results_public v2
  where v2.subsession_id = 1001 and v2.driver_id = 'dddddddd-0000-0000-0000-000000000001';
  reset role;
  perform scoring_fixture.expect('C15 a signed-in driver sees the raw set', v, 'raw/1/0');

  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-0000-0000-000000000001","role":"authenticated"}', true);
  set local role authenticated;
  select string_agg(format('%s/%s/%s/%s/%s', v2.shown_set, v2.shown_position, v2.shown_points_deduction,
                           v2.shown_penalised, v2.shown_overall_total), ' ')
  into v from public.race_score_results_public v2
  where v2.subsession_id = 1001 and v2.driver_id = 'dddddddd-0000-0000-0000-000000000001';
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform scoring_fixture.expect('C15 an admin sees the final set before posting', v, 'final/2/4/t/76');

  insert into public.round_incident_status (subsession_id, posted, posted_at) values (1001, true, now());
  set local role anon;
  select string_agg(format('%s/%s/%s', v2.shown_set, v2.shown_position, v2.shown_points_deduction), ' ')
  into v from public.race_score_results_public v2
  where v2.subsession_id = 1001 and v2.driver_id = 'dddddddd-0000-0000-0000-000000000001';
  reset role;
  perform scoring_fixture.expect('C15 anon sees the final set once posted', v, 'final/2/4');
  raise notice 'ok C15 concealment';
end $$;
rollback to savepoint fixture;

-- C16 Privileges: the base table and score_round are closed to anon and authenticated ---------
do $$
begin
  perform scoring_fixture.expect('C16 anon select race_score_results', has_table_privilege('anon', 'public.race_score_results', 'select'), false);
  perform scoring_fixture.expect('C16 authenticated select race_score_results', has_table_privilege('authenticated', 'public.race_score_results', 'select'), false);
  perform scoring_fixture.expect('C16 authenticated insert race_score_results', has_table_privilege('authenticated', 'public.race_score_results', 'insert'), false);
  perform scoring_fixture.expect('C16 anon select the view', has_table_privilege('anon', 'public.race_score_results_public', 'select'), true);
  perform scoring_fixture.expect('C16 authenticated select the view', has_table_privilege('authenticated', 'public.race_score_results_public', 'select'), true);
  perform scoring_fixture.expect('C16 anon execute score_round', has_function_privilege('anon', 'public.score_round(bigint)', 'execute'), false);
  perform scoring_fixture.expect('C16 authenticated execute score_round', has_function_privilege('authenticated', 'public.score_round(bigint)', 'execute'), false);
  perform scoring_fixture.expect('C16 service_role execute score_round', has_function_privilege('service_role', 'public.score_round(bigint)', 'execute'), true);
  perform scoring_fixture.expect('C16 anon execute preview', has_function_privilege('anon', 'public.score_round_preview(bigint,jsonb)', 'execute'), false);
  perform scoring_fixture.expect('C16 anon execute rescore_season', has_function_privilege('anon', 'public.rescore_season(uuid)', 'execute'), false);
  perform scoring_fixture.expect('C16 anon execute scoring_compute', has_function_privilege('anon', 'private.scoring_compute(bigint,jsonb)', 'execute'), false);
  perform scoring_fixture.expect('C16 anon select scoring_settings', has_table_privilege('anon', 'public.scoring_settings', 'select'), false);
  perform scoring_fixture.expect('C16 RLS on race_score_results',
    (select c.relrowsecurity from pg_class c where c.oid = 'public.race_score_results'::regclass), true);
  begin
    set local role anon;
    perform 1 from public.race_score_results;
    reset role;
    raise exception 'scoring fixture failed: C16 anon could read race_score_results';
  exception when insufficient_privilege then
    reset role;
  end;
  raise notice 'ok C16 privileges';
end $$;
rollback to savepoint fixture;

-- C17 A no-op update and a non-scoring edit do not rescore (BR3.2) -----------------------------
do $$
declare
  v_before timestamp with time zone := scoring_fixture.last_scored(1001);
begin
  update public.curated_race_results set laps_complete = laps_complete where subsession_id = 1001;
  update public.curated_race_results set display_name = display_name || ' (renamed)', car_name = 'Fixture car'
  where subsession_id = 1001;
  update public.curated_rounds set track_name = 'Fixture Raceway' where subsession_id = 1001;
  perform scoring_fixture.expect('C17 scored_at unchanged', scoring_fixture.last_scored(1001), v_before);
  raise notice 'ok C17 no-op and non-scoring edits do not rescore';
end $$;
rollback to savepoint fixture;

-- C18 A penalty insert rescores the round (BR3.1) ----------------------------------------------
do $$
declare
  v_before timestamp with time zone := scoring_fixture.last_scored(1001);
begin
  insert into public.penalties (subsession_id, race_number, driver_id, is_warning)
  values (1001, 1, 'dddddddd-0000-0000-0000-000000000002', true);
  perform scoring_fixture.expect('C18 rescored', scoring_fixture.last_scored(1001) > v_before, true);
  perform scoring_fixture.expect('C18 a warning changes nothing', scoring_fixture.col(1001, 'r.penalised'),
    '101=false 102=false 103=false 104=false 105=false 106=false 108=false');
  raise notice 'ok C18 penalty insert rescores';
end $$;
rollback to savepoint fixture;

-- C19 Posting, locking, unlocking and profile edits do not rescore (BR3.2) ---------------------
do $$
declare
  v_before timestamp with time zone := scoring_fixture.last_scored(1001);
begin
  insert into public.round_incident_status (subsession_id, posted, posted_at) values (1001, true, now());
  update public.round_incident_status set posted = false where subsession_id = 1001;
  update public.seasons set standings_locked_at = now() where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  update public.seasons set standings_locked_at = null, name = 'Fixture Season 1 (renamed)'
  where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  update public.drivers set bio = 'Fixture bio', photo_url = 'https://example.invalid/d1.png', car_number = 42
  where id = 'dddddddd-0000-0000-0000-000000000001';
  perform scoring_fixture.expect('C19 scored_at unchanged', scoring_fixture.last_scored(1001), v_before);
  raise notice 'ok C19 posting, locking and profile edits do not rescore';
end $$;
rollback to savepoint fixture;

-- C20 A results edit rescores: a driver now past half distance becomes classified (BR3.1) ------
update public.curated_race_results set laps_complete = 15 where subsession_id = 1001 and cust_id = 108;
do $$
begin
  perform scoring_fixture.expect('C20 classified', scoring_fixture.col(1001, 'r.classified'),
    '101=true 102=true 103=true 104=true 105=true 106=true 108=true');
  perform scoring_fixture.expect('C20 P8 past the table scores classified_minimum', scoring_fixture.col(1001, 'r.raw_finish_points'),
    '101=100 102=80 103=60 104=5 105=40 106=30 108=5');
  raise notice 'ok C20 results edit rescores';
end $$;
rollback to savepoint fixture;

-- C21 A locked season accepts an edit that leaves its results unchanged (BR3.3) ---------------
update public.seasons set standings_locked_at = now() where id = 'bbbbbbbb-0000-0000-0000-000000000001';
do $$
declare
  v_before timestamp with time zone := scoring_fixture.last_scored(1001);
begin
  update public.scoring_rulesets set rules = rules || '{"note": "fixture"}'
  where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  insert into public.penalties (subsession_id, race_number, driver_id, is_warning)
  values (1001, 1, 'dddddddd-0000-0000-0000-000000000002', true);
  perform scoring_fixture.expect('C21 nothing rewritten', scoring_fixture.last_scored(1001), v_before);
  perform scoring_fixture.expect('C21 the penalty was saved',
    (select count(*) from public.penalties where subsession_id = 1001), 1::bigint);
  raise notice 'ok C21 unchanged-result edit in a locked season';
end $$;
rollback to savepoint fixture;

-- C22 A locked season refuses an edit that would change its results (BR3.3) -------------------
update public.seasons set standings_locked_at = now() where id = 'bbbbbbbb-0000-0000-0000-000000000001';
do $$
declare
  v_message text;
begin
  begin
    insert into public.penalties (subsession_id, race_number, driver_id, points_penalty)
    values (1001, 1, 'dddddddd-0000-0000-0000-000000000001', 5);
    raise exception 'scoring fixture failed: C22 the locked season accepted a changing penalty';
  exception when sqlstate 'SC001' then
    get stacked diagnostics v_message = message_text;
  end;
  perform scoring_fixture.expect('C22 message', v_message,
    'This change would alter results in Fixture Season 1, whose standings are locked. Unlock the season first.');
  perform scoring_fixture.expect('C22 the penalty was not saved',
    (select count(*) from public.penalties where subsession_id = 1001), 0::bigint);
  raise notice 'ok C22 locked season refuses a changing edit';
end $$;
rollback to savepoint fixture;

-- C23 Moving a round out of a locked season is refused (BR3.3, W2 step 4) ---------------------
update public.seasons set standings_locked_at = now() where id = 'bbbbbbbb-0000-0000-0000-000000000001';
do $$
declare
  v_message text;
begin
  begin
    update public.curated_rounds set season_id = 'bbbbbbbb-0000-0000-0000-000000000002' where subsession_id = 1001;
    raise exception 'scoring fixture failed: C23 a round left a locked season';
  exception when sqlstate 'SC001' then
    get stacked diagnostics v_message = message_text;
  end;
  perform scoring_fixture.expect('C23 names the locked season', v_message like '%Fixture Season 1,%', true);
  perform scoring_fixture.expect('C23 the round did not move',
    (select season_id from public.curated_rounds where subsession_id = 1001), 'bbbbbbbb-0000-0000-0000-000000000001'::uuid);
  raise notice 'ok C23 season move out of a locked season';
end $$;
rollback to savepoint fixture;

-- C24 A scoring fault is recorded and the save goes ahead (BR3.7) ------------------------------
-- A negative points penalty breaks final_points_deduction >= 0 inside score_round.
insert into public.penalties (subsession_id, race_number, driver_id, points_penalty)
values (1001, 1, 'dddddddd-0000-0000-0000-000000000001', -5);
do $$
begin
  perform scoring_fixture.expect('C24 the penalty was saved',
    (select count(*) from public.penalties where subsession_id = 1001), 1::bigint);
  perform scoring_fixture.expect('C24 issue recorded',
    (select message like 'Scoring failed:%final_points_deduction%' from public.scoring_issues where subsession_id = 1001), true);
  perform scoring_fixture.expect('C24 previous rows kept',
    (select count(*) from public.race_score_results where subsession_id = 1001), 7::bigint);
  raise notice 'ok C24 fault recorded, save kept';
end $$;
rollback to savepoint fixture;

-- C25 Unscorable rounds are recorded, not raised, and clear once fixed (BR3.5) ----------------
insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, format) values
  (1003, '2026-02-01 18:00+00', 'Fixture Park', null, 'endurance'),
  (1004, '2026-02-08 18:00+00', 'Fixture Park', 'bbbbbbbb-0000-0000-0000-000000000003', 'endurance');
insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, finish_position, laps_complete)
values (1003, 1, 101, 'd1', 1, 10), (1004, 1, 101, 'd1', 1, 10);
do $$
begin
  perform scoring_fixture.expect('C25 no season',
    (select message from public.scoring_issues where subsession_id = 1003), 'Round 1003 is not linked to a season');
  perform scoring_fixture.expect('C25 incomplete ruleset',
    (select message like '%has no classified_minimum for format endurance' from public.scoring_issues where subsession_id = 1004), true);
  perform scoring_fixture.expect('C25 no rows',
    (select count(*) from public.race_score_results where subsession_id in (1003, 1004)), 0::bigint);
  update public.scoring_rulesets set rules = rules || '{"classified_minimum": {"endurance": 1}}'
  where id = 'aaaaaaaa-0000-0000-0000-000000000003';
  perform scoring_fixture.expect('C25 fixed ruleset scores the round',
    (select count(*) from public.race_score_results where subsession_id = 1004), 1::bigint);
  perform scoring_fixture.expect('C25 issue cleared',
    (select count(*) from public.scoring_issues where subsession_id = 1004), 0::bigint);
  raise notice 'ok C25 unscorable rounds recorded';
end $$;
rollback to savepoint fixture;

-- C26 The guard refuses a direct insert or update (BR1.3) --------------------------------------
do $$
declare
  v_message text;
begin
  begin
    insert into public.race_score_results select * from public.race_score_results where subsession_id = 1001 limit 1;
    raise exception 'scoring fixture failed: C26 a direct insert was accepted';
  exception when insufficient_privilege then
    get stacked diagnostics v_message = message_text;
  end;
  perform scoring_fixture.expect('C26 insert message', v_message, 'race_score_results is written only by score_round()');
  begin
    update public.race_score_results set final_finish_points = 999 where subsession_id = 1001;
    raise exception 'scoring fixture failed: C26 a direct update was accepted';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok C26 guard refuses direct writes';
end $$;
rollback to savepoint fixture;

-- C27 Cascade deletes pass the guard; the driver delete rescores the others (BR1.3) ------------
delete from public.drivers where id = 'dddddddd-0000-0000-0000-000000000007';
delete from public.curated_rounds where subsession_id = 1001;
do $$
begin
  perform scoring_fixture.expect('C27 rows gone with the round',
    (select count(*) from public.race_score_results where subsession_id = 1001), 0::bigint);
  raise notice 'ok C27 cascade deletes';
end $$;
rollback to savepoint fixture;
delete from public.drivers where id = 'dddddddd-0000-0000-0000-000000000007';
do $$
begin
  perform scoring_fixture.expect('C27 the deleted driver''s rows are gone', scoring_fixture.col(1001, 'r.raw_position'),
    '101=1 102=2 103=3 104=7 105=4 106=5');
end $$;
rollback to savepoint fixture;

-- C28 The kill switch stops rescoring until a manual score_round (BR3.7) ----------------------
update public.scoring_settings set triggers_enabled = false;
do $$
declare
  v_before timestamp with time zone := scoring_fixture.last_scored(1001);
begin
  insert into public.penalties (subsession_id, race_number, driver_id, time_penalty_seconds)
  values (1001, 1, 'dddddddd-0000-0000-0000-000000000001', 10);
  perform scoring_fixture.expect('C28 not rescored', scoring_fixture.last_scored(1001), v_before);
  perform scoring_fixture.expect('C28 still the old order', scoring_fixture.col(1001, 'r.final_position'),
    '101=1 102=2 103=3 104=7 105=4 106=5 108=8');
  perform scoring_fixture.expect('C28 score_round row count', public.score_round(1001), 7);
  perform scoring_fixture.expect('C28 rescored by hand', scoring_fixture.col(1001, 'r.final_position'),
    '101=2 102=1 103=3 104=7 105=4 106=5 108=8');
  raise notice 'ok C28 kill switch';
end $$;
rollback to savepoint fixture;

-- C29 score_round_preview with no switches equals what score_round stored (W7 recompute) -----
insert into public.penalties (subsession_id, race_number, driver_id, time_penalty_seconds, points_penalty) values
  (1001, 1, 'dddddddd-0000-0000-0000-000000000001', 10, 2),
  (1001, 1, 'dddddddd-0000-0000-0000-000000000006', 30, 0);
do $$
begin
  perform scoring_fixture.expect('C29 preview differs from stored',
    (select count(*) from (
       (select to_jsonb(p) - 'scored_at' from public.score_round_preview(1001, '{}') p
        except
        select to_jsonb(r) - 'scored_at' from public.race_score_results r where r.subsession_id = 1001)
       union all
       (select to_jsonb(r) - 'scored_at' from public.race_score_results r where r.subsession_id = 1001
        except
        select to_jsonb(p) - 'scored_at' from public.score_round_preview(1001, '{}') p)
     ) d),
    0::bigint);
  perform scoring_fixture.expect('C29 every switch on equals {}',
    scoring_fixture.preview_col(1001, (select jsonb_object_agg(n, true) from unnest(private.scoring_switch_names()) n), 'r.final_position'),
    scoring_fixture.col(1001, 'r.final_position'));
  raise notice 'ok C29 preview equals stored';
end $$;
rollback to savepoint fixture;

-- C30 Preview and rescore_season checks: switch names, admin only (W1, BR3.4) -----------------
do $$
declare
  v_message text;
  v text;
begin
  begin
    perform 1 from public.score_round_preview(1001, '{"no-such-switch": false}');
    raise exception 'scoring fixture failed: C30 an unknown switch was accepted';
  exception when raise_exception then
    get stacked diagnostics v_message = message_text;
  end;
  perform scoring_fixture.expect('C30 unknown switch', v_message, 'Unknown or non-boolean scoring switch: no-such-switch');

  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-0000-0000-000000000002","role":"authenticated"}', true);
  set local role authenticated;
  begin
    perform 1 from public.score_round_preview(1001, '{}');
    reset role;
    raise exception 'scoring fixture failed: C30 a non-admin ran the preview';
  exception when insufficient_privilege then
    reset role;
  end;
  set local role authenticated;
  begin
    perform 1 from public.rescore_season('bbbbbbbb-0000-0000-0000-000000000001');
    reset role;
    raise exception 'scoring fixture failed: C30 a non-admin ran rescore_season';
  exception when insufficient_privilege then
    reset role;
  end;

  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-0000-0000-000000000001","role":"authenticated"}', true);
  set local role authenticated;
  select string_agg(format('%s=%s/%s', s.subsession_id, s.rows_written, coalesce(s.error_message, '-')), ' ' order by s.subsession_id)
  into v from public.rescore_season('bbbbbbbb-0000-0000-0000-000000000001') s;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform scoring_fixture.expect('C30 admin rescore_season', v, '1001=7/-');
  raise notice 'ok C30 preview and rescore_season checks';
end $$;
rollback to savepoint fixture;

-- C31 A round moved to another (unlocked) season is scored into it (W2 step 4) ----------------
update public.curated_rounds set season_id = 'bbbbbbbb-0000-0000-0000-000000000002' where subsession_id = 1001;
do $$
begin
  perform scoring_fixture.expect('C31 season_id follows the round',
    scoring_fixture.col(1001, 'r.season_id = ''bbbbbbbb-0000-0000-0000-000000000002'''),
    '101=true 102=true 103=true 104=true 105=true 106=true 108=true');
  raise notice 'ok C31 season move';
end $$;
rollback to savepoint fixture;

-- C32 A season class override rescores the driver's rounds (BR3.1) -----------------------------
insert into public.driver_season_classes (driver_id, season_id, class_id)
values ('dddddddd-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000001', 2);
do $$
begin
  perform scoring_fixture.expect('C32 class', scoring_fixture.col(1001, 'r.class_id'),
    '101=1 102=1 103=1 104=2 105=2 106=2 108=1');
  perform scoring_fixture.expect('C32 class position and points', scoring_fixture.col(1001, 'r.raw_class_position || ''/'' || r.raw_class_points'),
    '101=1/0 102=2/0 103=3/0 104=3/2 105=1/8 106=2/4 108=4/0');
  raise notice 'ok C32 season class override';
end $$;
rollback to savepoint fixture;

-- C33 A roster change sets the team; a driver class change rescores (BR3.1) --------------------
insert into public.team_rosters (season_id, team_id, driver_id)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001');
update public.drivers set class_id = 2 where id = 'dddddddd-0000-0000-0000-000000000002';
do $$
begin
  perform scoring_fixture.expect('C33 team', scoring_fixture.col(1001, 'r.team_id'),
    '101=cccccccc-0000-0000-0000-000000000001 102=- 103=- 104=- 105=- 106=- 108=-');
  perform scoring_fixture.expect('C33 class change', scoring_fixture.col(1001, 'r.class_id || ''/'' || r.raw_class_points'),
    '101=1/0 102=2/8 103=1/0 104=1/0 105=2/4 106=2/2 108=1/0');
  raise notice 'ok C33 roster and class changes';
end $$;
rollback to savepoint fixture;

-- C34 A deleted penalty rescores back to the raw order (BR3.1) ---------------------------------
insert into public.penalties (subsession_id, race_number, driver_id, time_penalty_seconds)
values (1001, 1, 'dddddddd-0000-0000-0000-000000000001', 10);
delete from public.penalties where subsession_id = 1001;
do $$
begin
  perform scoring_fixture.expect('C34 final_position', scoring_fixture.col(1001, 'r.final_position'),
    '101=1 102=2 103=3 104=7 105=4 106=5 108=8');
  raise notice 'ok C34 penalty delete rescores';
end $$;
rollback to savepoint fixture;

-- C35 unclassified-position off keeps an unclassified row in its raw slot (BR6.2) -------------
-- d3's DSQ closes a gap above d7, so the final set renumbers d7 from 8 to 7; today's results page
-- leaves an unclassified row where it finished.
update public.curated_race_results set reason_out = 'Disqualified' where subsession_id = 1001 and cust_id = 103;
insert into public.penalties (subsession_id, race_number, driver_id, time_penalty_seconds)
values (1001, 1, 'dddddddd-0000-0000-0000-000000000001', 10);
do $$
begin
  perform scoring_fixture.expect('C35 stored final_position renumbers d7', scoring_fixture.col(1001, 'r.final_position'),
    '101=2 102=1 103=- 104=6 105=3 106=4 108=7');
  perform scoring_fixture.expect('C35 unclassified-position off',
    scoring_fixture.preview_col(1001, '{"unclassified-position": false}', 'r.final_position || ''/'' || coalesce(r.final_class_position::text, ''-'')'),
    '101=2/2 102=1/1 103=- 104=6/3 105=3/1 106=4/2 108=8/4');
  raise notice 'ok C35 unclassified-position';
end $$;
rollback to savepoint fixture;

-- C36 per-class-pricing and cross-class-ripple each act alone (BR6.2) --------------------------
-- d1's lap conversion moves d1, d2 and d3 in their class and moves Gamma's d5 and d6 overall only.
insert into public.penalties (subsession_id, race_number, driver_id, time_penalty_seconds)
values (1001, 1, 'dddddddd-0000-0000-0000-000000000001', 95);
do $$
begin
  perform scoring_fixture.expect('C36 per-class-pricing off prices class movers from class position only',
    scoring_fixture.preview_col(1001, '{"per-class-pricing": false}', 'r.final_finish_points'),
    '101=60 102=100 103=80 104=5 105=60 106=40 108=0');
  perform scoring_fixture.expect('C36 both off: class movers from class position, everyone else raw',
    scoring_fixture.preview_col(1001, '{"per-class-pricing": false, "cross-class-ripple": false}', 'r.final_finish_points'),
    '101=60 102=100 103=80 104=5 105=40 106=30 108=0');
  perform scoring_fixture.expect('C36 cross-class-ripple alone moves Gamma when per-class-pricing is off',
    (select count(*) from public.score_round_preview(1001, '{"per-class-pricing": false, "cross-class-ripple": false}') a
     join public.score_round_preview(1001, '{"per-class-pricing": false}') b using (race_number, driver_id)
     where a.final_finish_points <> b.final_finish_points),
    2::bigint);
  raise notice 'ok C36 independent pricing switches';
end $$;
rollback to savepoint fixture;

-- C37 overall-formula off includes aggression on rows the overall standings adjust (BR6.2) ---
update public.seasons set scoring_ruleset_id = 'aaaaaaaa-0000-0000-0000-000000000002'
where id = 'bbbbbbbb-0000-0000-0000-000000000001';
insert into public.penalties (subsession_id, race_number, driver_id, time_penalty_seconds)
values (1001, 1, 'dddddddd-0000-0000-0000-000000000005', 100);
do $$
begin
  -- d6 moved from 5 to 4 and won aggression after the re-order: 40 + finesse 1 + aggression 3.
  -- d2 did not move, so its total leaves aggression and fastest lap out: 80 + finesse 1.
  perform scoring_fixture.expect('C37 overall-formula off',
    scoring_fixture.preview_col(1001, '{"overall-formula": false}', 'r.final_overall_total'),
    '101=100 102=81 103=60 104=5 105=5 106=44 108=0');
  perform scoring_fixture.expect('C37 raw set keeps the plain formula',
    scoring_fixture.preview_col(1001, '{"overall-formula": false}', 'r.raw_overall_total'),
    '101=100 102=81 103=60 104=5 105=40 106=31 108=0');
  raise notice 'ok C37 overall formula with aggression';
end $$;
rollback to savepoint fixture;

rollback;
