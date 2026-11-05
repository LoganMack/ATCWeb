-- Race winners fixtures for 20261113120002_race_winners_for_rounds.sql (FR4.2, NFR1, NFR2; rules BR4.1-BR4.6):
-- class winners (disqualified and unclassified rows skipped), Alpha Team and Delta Team by their two best
-- rows, the Delta Team switch, races with missing classes, masked names for anon, the 200-round limit and the
-- grants (X01-X07).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- email-templates-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/race-winners-fixtures.sql
--
-- Same conventions as incident-management-fixtures.sql (supabase/checks/README.md): one transaction, rolled
-- back at the end; each case runs after `savepoint fixture` and is undone with `rollback to savepoint
-- fixture`; callers are impersonated with request.jwt.claims and the role setting. Score rows are written
-- directly with the scoring writer switch on, raw and final alike, so the raw/final rule of
-- race_score_results_public does not change the answers.
--
-- Season Zw On (Delta Team on): round 9913001.
--   Race 1, Alpha: A5 (DSQ, class P1, Blue), A1 (P2, Red, total 30 class 10 -> team 20), A2 (P3, Red, 20/8 -> 12),
--     A3 (P4, Blue, 40/6 -> 34), A4 (P5, Red, 15/4 -> 11, Red's third scorer).
--     Alpha Team: Blue 34 (A5 disqualified, single scorer) beats Red 32 (A1 + A2; with A4 it would be 43, and by
--     class total 50).
--   Race 1, Gamma: G1 (unclassified, class P1), G2 (P2). Delta: D1 (P1, Red, total 25), D2 (P2, Solo, total 30).
--     Delta Team: Solo 30 beats Red 25.
--   Race 2: only A2 (P1, Red).
-- Season Zw Off (Delta Team off): round 9913002, race 1: D1 (P1, Red).
-- A1's account hides its name.

begin;

set local client_min_messages = notice;

create schema winners_fixture;

create function winners_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'race winners fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

create function winners_fixture.act_as(p_who text) returns void
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

create function winners_fixture.as_owner() returns void
  language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

create function winners_fixture.text_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v text;
begin
  perform winners_fixture.act_as(p_who);
  execute p_sql into v;
  perform winners_fixture.as_owner();
  return v;
end;
$$;

-- The code before the first ':' of the error p_sql raises as p_who, or 'ok'.
create function winners_fixture.code_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform winners_fixture.act_as(p_who);
  execute p_sql;
  perform winners_fixture.as_owner();
  return 'ok';
exception when others then
  return split_part(sqlerrm, ':', 1);
end;
$$;

-- p_who's winners for p_rounds as 'round/race:slot=name' in the order returned.
create function winners_fixture.winners(p_who text, p_rounds bigint[]) returns text
  language sql as $$
  select winners_fixture.text_as(p_who, format(
    $q$select coalesce(string_agg(
              format('%%s/%%s:%%s=%%s', w.subsession_id - 9913000, w.race_number, w.slot, coalesce(w.driver_name, w.team_name)),
              ',' order by w.ordinality), '')
       from public.race_winners_for_rounds(%L::bigint[]) with ordinality w$q$, p_rounds));
$$;

-- One score row, raw and final alike. p_class_pos null = no class position.
create function winners_fixture.result(
  p_round bigint, p_race integer, p_driver uuid, p_class text, p_team uuid,
  p_class_pos integer, p_class_points integer, p_class_total integer,
  p_dsq boolean default false, p_classified boolean default true
) returns void
  language plpgsql as $$
begin
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
  select p_round, p_race, p_driver, c.season_id, k.id, p_team, coalesce(p_class_pos, 99), p_classified, p_dsq,
    p_class_pos, p_class_pos, 0, p_class_points, 0, 0, 0, 0, 0, 0, 0, p_class_total, p_class_total,
    p_class_pos, p_class_pos, 0, p_class_points, 0, 0, 0, 0, 0, 0, 0, 0, p_class_total, p_class_total,
    false, now()
  from public.curated_rounds c, public.driver_classes k
  where c.subsession_id = p_round and k.name = p_class;
  perform set_config('atc.scoring_writer', 'off', true);
end;
$$;

grant usage on schema winners_fixture to anon, authenticated;
grant execute on all functions in schema winners_fixture to anon, authenticated;

-- Base data ------------------------------------------------------------------------------------

-- No scoring or round-stats side effects from the rows below.
update public.scoring_settings set triggers_enabled = false;

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (913, 'Active')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select v.id, v.name, v.sort_order from (values (913, 'Alpha', 1), (914, 'Gamma', 2), (915, 'Delta', 3)) v (id, name, sort_order)
where not exists (select 1 from public.driver_classes k where k.name = v.name);

insert into public.seasons (id, number, name, delta_team_enabled) values
  ('bbbbbbbb-0000-0000-0000-000000000913', 9913, 'Zw On', true),
  ('bbbbbbbb-0000-0000-0000-000000000914', 9914, 'Zw Off', false);

insert into public.teams (id, name) values
  ('77777777-0000-0000-0000-000000000901', 'Zw Red'),
  ('77777777-0000-0000-0000-000000000902', 'Zw Blue'),
  ('77777777-0000-0000-0000-000000000903', 'Zw Solo');

insert into public.drivers (id, name, car_number, status_id, class_id, is_ai)
select v.id::uuid, v.name, v.car, (select id from public.driver_statuses where name = 'Active'),
       (select id from public.driver_classes where name = v.class), false
from (values
  ('99999999-0000-0000-0000-000000000901', 'Al One', 901, 'Alpha'),
  ('99999999-0000-0000-0000-000000000902', 'Al Two', 902, 'Alpha'),
  ('99999999-0000-0000-0000-000000000903', 'Al Three', 903, 'Alpha'),
  ('99999999-0000-0000-0000-000000000904', 'Al Four', 904, 'Alpha'),
  ('99999999-0000-0000-0000-000000000905', 'Al Five', 905, 'Alpha'),
  ('99999999-0000-0000-0000-000000000911', 'Ga One', 911, 'Gamma'),
  ('99999999-0000-0000-0000-000000000912', 'Ga Two', 912, 'Gamma'),
  ('99999999-0000-0000-0000-000000000921', 'De One', 921, 'Delta'),
  ('99999999-0000-0000-0000-000000000922', 'De Two', 922, 'Delta')
) v (id, name, car, class);

-- A1's own account hides its name from anon and other drivers.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000901', 'rw-a1@example.test', now(), '{"display_name":"Al One"}'),
  ('eeeeeeee-0000-0000-0000-000000000902', 'rw-admin@example.test', now(), '{"display_name":"Winners Admin"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000000901', 'eeeeeeee-0000-0000-0000-000000000902');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000901', 'driver', 'Al One', '99999999-0000-0000-0000-000000000901'),
  ('eeeeeeee-0000-0000-0000-000000000902', 'admin', 'Winners Admin', null);
insert into public.account_settings (profile_id, hide_name) values ('eeeeeeee-0000-0000-0000-000000000901', true);

insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, round_number) values
  (9913001, '2026-06-05 18:00+00', 'Zw Park', 'bbbbbbbb-0000-0000-0000-000000000913', 1),
  (9913002, '2026-06-12 18:00+00', 'Zw Park', 'bbbbbbbb-0000-0000-0000-000000000914', 1);

select winners_fixture.result(9913001, 1, '99999999-0000-0000-0000-000000000905', 'Alpha', '77777777-0000-0000-0000-000000000902', 1, 50, 100, true);
select winners_fixture.result(9913001, 1, '99999999-0000-0000-0000-000000000901', 'Alpha', '77777777-0000-0000-0000-000000000901', 2, 10, 30);
select winners_fixture.result(9913001, 1, '99999999-0000-0000-0000-000000000902', 'Alpha', '77777777-0000-0000-0000-000000000901', 3, 8, 20);
select winners_fixture.result(9913001, 1, '99999999-0000-0000-0000-000000000903', 'Alpha', '77777777-0000-0000-0000-000000000902', 4, 6, 40);
select winners_fixture.result(9913001, 1, '99999999-0000-0000-0000-000000000904', 'Alpha', '77777777-0000-0000-0000-000000000901', 5, 4, 15);
select winners_fixture.result(9913001, 1, '99999999-0000-0000-0000-000000000911', 'Gamma', null, 1, 10, 30, false, false);
select winners_fixture.result(9913001, 1, '99999999-0000-0000-0000-000000000912', 'Gamma', null, 2, 8, 20);
select winners_fixture.result(9913001, 1, '99999999-0000-0000-0000-000000000921', 'Delta', '77777777-0000-0000-0000-000000000901', 1, 10, 25);
select winners_fixture.result(9913001, 1, '99999999-0000-0000-0000-000000000922', 'Delta', '77777777-0000-0000-0000-000000000903', 2, 8, 30);
select winners_fixture.result(9913001, 2, '99999999-0000-0000-0000-000000000902', 'Alpha', '77777777-0000-0000-0000-000000000901', 1, 10, 30);
select winners_fixture.result(9913002, 1, '99999999-0000-0000-0000-000000000921', 'Delta', '77777777-0000-0000-0000-000000000901', 1, 10, 25);

savepoint fixture;

-- X01 Class and team winners in slot order, race by race, for an admin (real names) -------------------------
do $$
begin
  perform winners_fixture.expect('X01 admin, both rounds',
    winners_fixture.winners('eeeeeeee-0000-0000-0000-000000000902', array[9913001, 9913002]::bigint[]),
    '1/1:alpha=Al One,1/1:gamma=Ga Two,1/1:delta=De One,1/1:alpha_team=Zw Blue,1/1:delta_team=Zw Solo,'
    '1/2:alpha=Al Two,1/2:alpha_team=Zw Red,'
    '2/1:delta=De One');
  raise notice 'ok X01 winners';
end $$;
rollback to savepoint fixture;

-- X02 Anon reads the same winners with A1's name masked and flagged hidden (BR4.5) -------------------------
do $$
begin
  perform winners_fixture.expect('X02 anon',
    winners_fixture.winners('anon', array[9913001]::bigint[]),
    '1/1:alpha=Hidden Driver,1/1:gamma=Ga Two,1/1:delta=De One,1/1:alpha_team=Zw Blue,1/1:delta_team=Zw Solo,'
    '1/2:alpha=Al Two,1/2:alpha_team=Zw Red');
  perform winners_fixture.expect('X02 hidden flag',
    winners_fixture.text_as('anon',
      $q$select driver_hidden::text from public.race_winners_for_rounds(array[9913001]::bigint[])
         where race_number = 1 and slot = 'alpha'$q$), 'true');
  raise notice 'ok X02 masked names';
end $$;
rollback to savepoint fixture;

-- X03 Delta Team follows its season's switch (BR4.3) ------------------------------------------------------
do $$
begin
  update public.seasons set delta_team_enabled = false where id = 'bbbbbbbb-0000-0000-0000-000000000913';
  perform winners_fixture.expect('X03 switched off',
    winners_fixture.winners('anon', array[9913001]::bigint[]),
    '1/1:alpha=Hidden Driver,1/1:gamma=Ga Two,1/1:delta=De One,1/1:alpha_team=Zw Blue,'
    '1/2:alpha=Al Two,1/2:alpha_team=Zw Red');
  raise notice 'ok X03 delta team switch';
end $$;
rollback to savepoint fixture;

-- X04 A third scorer does not count, and Alpha Team ranks by total minus class points (BR4.2): with Blue's
--     only scorer gone, Red wins on its top two ---------------------------------------------------------------
do $$
begin
  delete from public.race_score_results where subsession_id = 9913001 and race_number = 1
    and driver_id = '99999999-0000-0000-0000-000000000903';
  perform winners_fixture.expect('X04 Red wins Alpha Team',
    winners_fixture.text_as('anon',
      $q$select team_name from public.race_winners_for_rounds(array[9913001]::bigint[])
         where race_number = 1 and slot = 'alpha_team'$q$), 'Zw Red');
  raise notice 'ok X04 team scoring';
end $$;
rollback to savepoint fixture;

-- X05 No rows, an empty list and a round without results give no winners (BR4.4) -------------------------
do $$
begin
  perform winners_fixture.expect('X05 empty list', winners_fixture.winners('anon', array[]::bigint[]), '');
  perform winners_fixture.expect('X05 unknown round', winners_fixture.winners('anon', array[9913999]::bigint[]), '');
  raise notice 'ok X05 no results';
end $$;
rollback to savepoint fixture;

-- X06 More than 200 rounds is refused; exactly 200 is fine (BR4.6) ----------------------------------------
do $$
begin
  perform winners_fixture.expect('X06 201 rounds',
    winners_fixture.code_as('anon',
      'select count(*) from public.race_winners_for_rounds(array(select generate_series(1, 201))::bigint[])'),
    'TOO_MANY_ROUNDS');
  perform winners_fixture.expect('X06 200 rounds',
    winners_fixture.code_as('anon',
      'select count(*) from public.race_winners_for_rounds(array(select generate_series(1, 200))::bigint[])'),
    'ok');
  raise notice 'ok X06 round limit';
end $$;
rollback to savepoint fixture;

-- X07 Security invoker with an empty search_path, executable by anon, authenticated and the service role --
do $$
begin
  perform winners_fixture.expect('X07 invoker',
    (select p.prosecdef from pg_proc p where p.oid = 'public.race_winners_for_rounds(bigint[])'::regprocedure), false);
  perform winners_fixture.expect('X07 search_path',
    (select p.proconfig from pg_proc p where p.oid = 'public.race_winners_for_rounds(bigint[])'::regprocedure),
    array['search_path=""']);
  perform winners_fixture.expect('X07 grants',
    has_function_privilege('anon', 'public.race_winners_for_rounds(bigint[])', 'execute')
    and has_function_privilege('authenticated', 'public.race_winners_for_rounds(bigint[])', 'execute')
    and has_function_privilege('service_role', 'public.race_winners_for_rounds(bigint[])', 'execute'), true);
  raise notice 'ok X07 grants';
end $$;
rollback to savepoint fixture;

rollback;
