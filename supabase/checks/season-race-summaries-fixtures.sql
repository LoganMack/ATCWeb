-- Season race summaries fixtures for 20261117120000_seasons_results_polish.sql (FR5.6, NFR1-NFR3; rules BR3.5,
-- BR5.6, BR10.1): per-race entrants, round entrants, laps, incidents, winners and the overall race time; the
-- unrostered entrant counted only overall; a disqualified P1 never wins; the 200-round limit; the grants; and the
-- full-admin seasons insert policy (S01-S06).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- race-winners-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/season-race-summaries-fixtures.sql
--
-- Same conventions as race-winners-fixtures.sql (supabase/checks/README.md): one transaction, rolled back at the
-- end; each case runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`; callers are
-- impersonated with request.jwt.claims and the role setting. Score rows are written directly with the scoring
-- writer switch on, raw and final alike.
--
-- Season Zs, round 9917001 (average lap 90.0000 s = 900000 ten-thousandths unless noted):
--   Race 1: A1 (Alpha, P1, class 1, 10 laps, 2 inc), A2 (Alpha, P2, class 2, 10 laps, 4 inc),
--           G1 (Gamma, P3, class 1, 9 laps, 0 inc), U (unrostered, P4, 8 laps, 6 inc).
--   Race 2: A2 alone (P1, class 1, 5 laps, 1 inc).
--   Race 3: A1 (P1 but disqualified, 3 laps), A2 (P2, class 2, 3 laps); 0 inc.

begin;

set local client_min_messages = notice;

create schema summaries_fixture;

create function summaries_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'season race summaries fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

create function summaries_fixture.act_as(p_who text) returns void
  language plpgsql as $$
begin
  if p_who = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_who, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
end;
$$;

create function summaries_fixture.as_owner() returns void
  language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

create function summaries_fixture.text_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v text;
begin
  perform summaries_fixture.act_as(p_who);
  execute p_sql into v;
  perform summaries_fixture.as_owner();
  return v;
end;
$$;

-- The code before the first ':' of the error p_sql raises as p_who, or 'ok'.
create function summaries_fixture.code_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform summaries_fixture.act_as(p_who);
  execute p_sql;
  perform summaries_fixture.as_owner();
  return 'ok';
exception when others then
  perform summaries_fixture.as_owner();
  return split_part(sqlerrm, ':', 1);
end;
$$;

-- p_who's summaries for p_rounds as 'race:scope=winner/drivers/round_drivers/laps/incidents/time', in the order
-- returned. The winner is the last four digits of its driver id (the fixture ids end in the car number), so no
-- drivers read runs as the caller; '-' when there is none.
create function summaries_fixture.summaries(p_who text, p_rounds bigint[]) returns text
  language sql as $$
  select summaries_fixture.text_as(p_who, format(
    $q$select coalesce(string_agg(
              format('%%s:%%s=%%s/%%s/%%s/%%s/%%s/%%s', s.race_number, s.scope,
                     coalesce(right(s.winner_driver_id::text, 4), '-'),
                     s.drivers, s.round_drivers, s.laps_total, s.incidents_total,
                     coalesce(s.race_time_ten_thousandths::text, '-')),
              ',' order by s.ordinality), '')
       from public.season_race_summaries(%L::bigint[]) with ordinality s$q$, p_rounds));
$$;

-- One iRacing result row and, for a rostered driver, its score row (raw and final alike).
create function summaries_fixture.result(
  p_race integer, p_cust bigint, p_name text, p_pos integer, p_laps integer, p_incidents integer,
  p_driver uuid default null, p_class text default null, p_class_pos integer default null,
  p_dsq boolean default false, p_average bigint default 900000
) returns void
  language plpgsql as $$
begin
  insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, finish_position,
    laps_complete, average_lap_ten_thousandths, incidents)
  values (9917001, p_race, p_cust, p_name, p_pos, p_laps, p_average, p_incidents);
  if p_driver is null then
    return;
  end if;
  perform set_config('atc.scoring_writer', 'on', true);
  insert into public.race_score_results (
    subsession_id, race_number, driver_id, season_id, class_id, team_id, finish_position, classified, dsq,
    raw_position, raw_class_position, raw_finish_points, raw_class_points, raw_finesse_bonus, raw_pole_bonus,
    raw_aggression_bonus, raw_lap_led_bonus, raw_fewest_incidents_bonus, raw_fastest_lap_bonus,
    raw_sprint_sweep_bonus, raw_overall_total, raw_class_total,
    final_position, final_class_position, final_finish_points, final_class_points, final_finesse_bonus,
    final_pole_bonus, final_aggression_bonus, final_lap_led_bonus, final_fewest_incidents_bonus,
    final_fastest_lap_bonus, final_sprint_sweep_bonus, final_points_deduction, final_overall_total,
    final_class_total, penalised, scored_at)
  select 9917001, p_race, p_driver, c.season_id, k.id, null, p_pos, true, p_dsq,
    p_pos, p_class_pos, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    p_pos, p_class_pos, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    false, now()
  from public.curated_rounds c, public.driver_classes k
  where c.subsession_id = 9917001 and k.name = p_class;
  perform set_config('atc.scoring_writer', 'off', true);
end;
$$;

grant usage on schema summaries_fixture to anon, authenticated;
grant execute on all functions in schema summaries_fixture to anon, authenticated;

-- Base data ------------------------------------------------------------------------------------

-- No scoring or round-stats side effects from the rows below.
update public.scoring_settings set triggers_enabled = false;

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (917, 'Active')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select v.id, v.name, v.sort_order from (values (917, 'Alpha', 1), (918, 'Gamma', 2), (919, 'Delta', 3)) v (id, name, sort_order)
where not exists (select 1 from public.driver_classes k where k.name = v.name);

insert into public.seasons (id, number, name) values
  ('bbbbbbbb-0000-0000-0000-000000000917', 9917, 'Zs');

insert into public.drivers (id, name, car_number, status_id, class_id, is_ai, iracing_cust_id)
select v.id::uuid, v.name, v.car, (select id from public.driver_statuses where name = 'Active'),
       (select id from public.driver_classes where name = v.class), false, v.cust
from (values
  ('99999999-0000-0000-0000-000000009171', 'Zs Alpha One', 9171, 'Alpha', 991700001),
  ('99999999-0000-0000-0000-000000009172', 'Zs Alpha Two', 9172, 'Alpha', 991700002),
  ('99999999-0000-0000-0000-000000009173', 'Zs Gamma One', 9173, 'Gamma', 991700011)
) v (id, name, car, class, cust);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000009171', 'zs-admin@example.test', now(), '{"display_name":"Zs Admin"}'),
  ('eeeeeeee-0000-0000-0000-000000009172', 'zs-staff@example.test', now(), '{"display_name":"Zs Staff"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000009171', 'eeeeeeee-0000-0000-0000-000000009172');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000009171', 'admin', 'Zs Admin', null),
  ('eeeeeeee-0000-0000-0000-000000009172', 'staff', 'Zs Staff', null);

insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, round_number) values
  (9917001, '2026-06-19 18:00+00', 'Zs Park', 'bbbbbbbb-0000-0000-0000-000000000917', 1);

select summaries_fixture.result(1, 991700001, 'Zs Alpha One', 1, 10, 2, '99999999-0000-0000-0000-000000009171', 'Alpha', 1);
select summaries_fixture.result(1, 991700002, 'Zs Alpha Two', 2, 10, 4, '99999999-0000-0000-0000-000000009172', 'Alpha', 2);
select summaries_fixture.result(1, 991700011, 'Zs Gamma One', 3, 9, 0, '99999999-0000-0000-0000-000000009173', 'Gamma', 1);
select summaries_fixture.result(1, 991700099, 'Zs Unrostered', 4, 8, 6);
select summaries_fixture.result(2, 991700002, 'Zs Alpha Two', 1, 5, 1, '99999999-0000-0000-0000-000000009172', 'Alpha', 1);
select summaries_fixture.result(3, 991700001, 'Zs Alpha One', 1, 3, 0, '99999999-0000-0000-0000-000000009171', 'Alpha', 1, true);
select summaries_fixture.result(3, 991700002, 'Zs Alpha Two', 2, 3, 0, '99999999-0000-0000-0000-000000009172', 'Alpha', 2);

savepoint fixture;

-- S01 Every race and scope, for anon: the unrostered entrant counts only overall, the overall race time is the
--     winner's laps times average lap, and a disqualified P1 leaves no overall winner (BR3.5, BR5.6) ----------
do $$
begin
  perform summaries_fixture.expect('S01 anon',
    summaries_fixture.summaries('anon', array[9917001]::bigint[]),
    '1:overall=9171/4/4/37/12/9000000,1:alpha=9171/2/2/20/6/-,1:gamma=9173/1/1/9/0/-,'
    '2:overall=9172/1/4/5/1/4500000,2:alpha=9172/1/2/5/1/-,'
    '3:overall=-/2/4/6/0/-,3:alpha=9172/2/2/6/0/-');
  raise notice 'ok S01 summaries';
end $$;
rollback to savepoint fixture;

-- S02 No laps or no average lap gives no race time; the winner still stands (BR3.5) --------------------------
do $$
begin
  update public.curated_race_results set average_lap_ten_thousandths = null
   where subsession_id = 9917001 and race_number = 2;
  perform summaries_fixture.expect('S02 no average lap',
    summaries_fixture.text_as('anon',
      $q$select coalesce(race_time_ten_thousandths::text, '-') || '/' || (winner_driver_id is not null)::text
           from public.season_race_summaries(array[9917001]::bigint[])
          where race_number = 2 and scope = 'overall'$q$), '-/true');
  raise notice 'ok S02 missing lap data';
end $$;
rollback to savepoint fixture;

-- S03 An empty list, a null list and an unknown round give no rows ----------------------------------------
do $$
begin
  perform summaries_fixture.expect('S03 empty list', summaries_fixture.summaries('anon', array[]::bigint[]), '');
  perform summaries_fixture.expect('S03 unknown round', summaries_fixture.summaries('anon', array[9917999]::bigint[]), '');
  perform summaries_fixture.expect('S03 null list',
    summaries_fixture.text_as('anon', 'select count(*)::text from public.season_race_summaries(null)'), '0');
  raise notice 'ok S03 no results';
end $$;
rollback to savepoint fixture;

-- S04 More than 200 rounds is refused; exactly 200 is fine (BR5.6) ------------------------------------------
do $$
begin
  perform summaries_fixture.expect('S04 201 rounds',
    summaries_fixture.code_as('anon',
      'select count(*) from public.season_race_summaries(array(select generate_series(1, 201))::bigint[])'),
    'TOO_MANY_ROUNDS');
  perform summaries_fixture.expect('S04 200 rounds',
    summaries_fixture.code_as('anon',
      'select count(*) from public.season_race_summaries(array(select generate_series(1, 200))::bigint[])'),
    'ok');
  raise notice 'ok S04 round limit';
end $$;
rollback to savepoint fixture;

-- S05 Security invoker with an empty search_path, executable by anon, authenticated and the service role ----
do $$
begin
  perform summaries_fixture.expect('S05 invoker',
    (select p.prosecdef from pg_proc p where p.oid = 'public.season_race_summaries(bigint[])'::regprocedure), false);
  perform summaries_fixture.expect('S05 search_path',
    (select p.proconfig from pg_proc p where p.oid = 'public.season_race_summaries(bigint[])'::regprocedure),
    array['search_path=""']);
  perform summaries_fixture.expect('S05 grants',
    has_function_privilege('anon', 'public.season_race_summaries(bigint[])', 'execute')
    and has_function_privilege('authenticated', 'public.season_race_summaries(bigint[])', 'execute')
    and has_function_privilege('service_role', 'public.season_race_summaries(bigint[])', 'execute'), true);
  raise notice 'ok S05 grants';
end $$;
rollback to savepoint fixture;

-- S06 Only a full admin may insert a season (BR10.1): staff and anon are refused --------------------------
do $$
begin
  perform summaries_fixture.expect('S06 full admin',
    summaries_fixture.code_as('eeeeeeee-0000-0000-0000-000000009171',
      $q$insert into public.seasons (number, name) values (9918, 'ATC9918')$q$), 'ok');
  perform summaries_fixture.expect('S06 staff refused',
    summaries_fixture.code_as('eeeeeeee-0000-0000-0000-000000009172',
      $q$insert into public.seasons (number, name) values (9919, 'ATC9919')$q$) <> 'ok', true);
  perform summaries_fixture.expect('S06 anon refused',
    summaries_fixture.code_as('anon',
      $q$insert into public.seasons (number, name) values (9920, 'ATC9920')$q$) <> 'ok', true);
  raise notice 'ok S06 season insert policy';
end $$;
rollback to savepoint fixture;

rollback;
