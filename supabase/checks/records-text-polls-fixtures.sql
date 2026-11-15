-- Records and text polls fixtures for 20261118120000_records_text_polls.sql (intent 261115-records-nav-polls;
-- rules BR1.1, BR1.3, BR1.9, BR5.1, BR5.2, BR6.3-BR6.5; NFR3, NFR4): round_best_laps_shown (one row per round
-- and class, the lap tie-break, the no-class row, exhibition and test rounds and empty laps left out, masking
-- for anon, settings and grants), Text questions (save and read back, the max length range, no options), and
-- Circuits options (save and read back, an unknown layout, a duplicate layout, a layout with an image, a
-- deleted layout), and a payload without the new fields saving as before (R01-R07).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- notification-inbox-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/records-text-polls-fixtures.sql
--
-- Same conventions as poll-fixtures.sql (supabase/checks/README.md): every assertion calls
-- records_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each case
-- runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`. Callers are impersonated
-- with request.jwt.claims and the role setting. Score rows are written directly with the scoring writer
-- switch on.
--
-- Rounds (season Zr): 9918001 normal, 9918002 normal (round_overrides row with both flags off), 9918003
-- exhibition, 9918004 test. Drivers: Zr Hidden (Gamma, its account hides the name), Zr Gamma (Gamma),
-- Zr Delta (Delta); one unrostered entrant (cust 991800099, no class).
--   9918001 race 1: Zr Hidden 90.0000s P3, Zr Gamma 90.0000s P1, Zr Delta 95.0000s P2, entrant 88.0000s P4.
--   9918001 race 2: Zr Hidden 90.0000s P1, Zr Delta 0 (empty lap) P2, entrant no lap P3.
--   9918002 race 1: Zr Hidden 91.0000s P1.
--   9918003 and 9918004 race 1: Zr Gamma 80.0000s P1 (faster, but never counted).

begin;

set local client_min_messages = notice;

create schema records_fixture;

create function records_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'records fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

create function records_fixture.act_as(p_who text) returns void
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

create function records_fixture.as_owner() returns void
  language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- The first value p_sql returns as p_who, as text (raises when p_sql fails).
create function records_fixture.text_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v text;
begin
  perform records_fixture.act_as(p_who);
  execute p_sql into v;
  perform records_fixture.as_owner();
  return v;
end;
$$;

-- The view's rows for the fixture rounds as p_who: 'round/class:cust/name/race/finish/lap' in round, class order.
create function records_fixture.rows_as(p_who text) returns text
  language sql as $$
  select records_fixture.text_as(p_who, $q$
    select coalesce(string_agg(format('%s/%s:%s/%s/%s/%s/%s', b.subsession_id - 9918000,
             coalesce(k.name, 'none'), case when b.cust_id < 0 then 'masked' else b.cust_id::text end,
             b.display_name, b.race_number, b.finish_position, b.best_lap_ten_thousandths),
             ',' order by b.subsession_id, k.name nulls last), '')
    from public.round_best_laps_shown b
    left join public.driver_classes k on k.id = b.class_id
    where b.subsession_id between 9918001 and 9918004$q$);
$$;

-- One race result row as loaded from iRacing.
create function records_fixture.race(p_round bigint, p_race integer, p_cust bigint, p_name text,
                                     p_finish integer, p_lap bigint) returns void
  language sql as $$
  insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, car_name,
                                           finish_position, best_lap_ten_thousandths)
  values (p_round, p_race, p_cust, p_name, 'Zr Car', p_finish, p_lap);
$$;

-- One score row (raw and final alike) giving the driver's class in that race.
create function records_fixture.score(p_round bigint, p_race integer, p_driver uuid, p_class text,
                                      p_finish integer) returns void
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
  select p_round, p_race, p_driver, c.season_id, k.id, null, p_finish, true, false,
    p_finish, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    p_finish, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, now()
  from public.curated_rounds c, public.driver_classes k
  where c.subsession_id = p_round and k.name = p_class;
  perform set_config('atc.scoring_writer', 'off', true);
end;
$$;

-- What save_poll answers the admin: the unused paths it returns, or the error message.
create function records_fixture.save(p_poll uuid, p_payload jsonb) returns text
  language plpgsql as $$
declare
  v_expected timestamptz := (select updated_at from public.polls where id = p_poll);
begin
  return records_fixture.text_as('eeeeeeee-0000-0000-0000-0000000018a1',
    format('select public.save_poll(%L, %L, %L)::text', p_poll, v_expected, p_payload));
exception when others then
  perform records_fixture.as_owner();
  return sqlerrm;
end;
$$;

create function records_fixture.new_poll(p_title text) returns uuid
  language sql as $$
  select records_fixture.text_as('eeeeeeee-0000-0000-0000-0000000018a1',
    format('select public.create_poll(%L)::text', p_title))::uuid;
$$;

-- A one-question payload.
create function records_fixture.payload(p_section jsonb) returns jsonb
  language sql as $$
  select jsonb_build_object('title', 'Zr poll', 'sections', jsonb_build_array(p_section));
$$;

grant usage on schema records_fixture to anon, authenticated;
grant execute on all functions in schema records_fixture to anon, authenticated;

-- Base data ------------------------------------------------------------------------------------------------

update public.scoring_settings set triggers_enabled = false;

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (918, 'Active')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select v.id, v.name, v.sort_order from (values (918, 'Gamma', 2), (919, 'Delta', 3)) v (id, name, sort_order)
where not exists (select 1 from public.driver_classes k where k.name = v.name);

insert into public.seasons (id, number, name) values ('bbbbbbbb-0000-0000-0000-000000000918', 9918, 'Zr');

insert into public.drivers (id, name, car_number, status_id, class_id, iracing_cust_id, is_ai)
select v.id::uuid, v.name, v.car, (select id from public.driver_statuses where name = 'Active'),
       (select id from public.driver_classes where name = v.class), v.cust, false
from (values
  ('99999999-0000-0000-0000-000000001801', 'Zr Hidden', 981, 'Gamma', 991800001),
  ('99999999-0000-0000-0000-000000001802', 'Zr Gamma', 982, 'Gamma', 991800002),
  ('99999999-0000-0000-0000-000000001803', 'Zr Delta', 983, 'Delta', 991800003)
) v (id, name, car, class, cust);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-0000000018a1', 'zr-adm@example.test', now(), '{"display_name":"Zr Admin"}'),
  ('eeeeeeee-0000-0000-0000-0000000018a2', 'zr-hid@example.test', now(), '{"display_name":"Zr Hidden"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-0000000018a1', 'eeeeeeee-0000-0000-0000-0000000018a2');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-0000000018a1', 'admin', 'Zr Admin', null),
  ('eeeeeeee-0000-0000-0000-0000000018a2', 'driver', 'Zr Hidden', '99999999-0000-0000-0000-000000001801');
insert into public.account_settings (profile_id, hide_name) values ('eeeeeeee-0000-0000-0000-0000000018a2', true);

insert into public.curated_rounds (subsession_id, start_time, track_name, layout, season_id) values
  (9918001, '2026-06-05 18:00+00', 'Zr Park', 'Grand Prix', 'bbbbbbbb-0000-0000-0000-000000000918'),
  (9918002, '2026-06-12 18:00+00', 'Zr Park', null, 'bbbbbbbb-0000-0000-0000-000000000918'),
  (9918003, '2026-06-19 18:00+00', 'Zr Park', 'Grand Prix', 'bbbbbbbb-0000-0000-0000-000000000918'),
  (9918004, '2026-06-26 18:00+00', 'Zr Park', 'Grand Prix', 'bbbbbbbb-0000-0000-0000-000000000918');

insert into public.round_overrides (subsession_id, is_exhibition, is_test) values
  (9918002, false, false), (9918003, true, false), (9918004, false, true);

select records_fixture.race(9918001, 1, 991800001, 'Zr Hidden', 3, 900000);
select records_fixture.race(9918001, 1, 991800002, 'Zr Gamma', 1, 900000);
select records_fixture.race(9918001, 1, 991800003, 'Zr Delta', 2, 950000);
select records_fixture.race(9918001, 1, 991800099, 'Zr Entrant', 4, 880000);
select records_fixture.race(9918001, 2, 991800001, 'Zr Hidden', 1, 900000);
select records_fixture.race(9918001, 2, 991800003, 'Zr Delta', 2, 0);
select records_fixture.race(9918001, 2, 991800099, 'Zr Entrant', 3, null);
select records_fixture.race(9918002, 1, 991800001, 'Zr Hidden', 1, 910000);
select records_fixture.race(9918003, 1, 991800002, 'Zr Gamma', 1, 800000);
select records_fixture.race(9918004, 1, 991800002, 'Zr Gamma', 1, 800000);

select records_fixture.score(9918001, 1, '99999999-0000-0000-0000-000000001801', 'Gamma', 3);
select records_fixture.score(9918001, 1, '99999999-0000-0000-0000-000000001802', 'Gamma', 1);
select records_fixture.score(9918001, 1, '99999999-0000-0000-0000-000000001803', 'Delta', 2);
select records_fixture.score(9918001, 2, '99999999-0000-0000-0000-000000001801', 'Gamma', 1);
select records_fixture.score(9918001, 2, '99999999-0000-0000-0000-000000001803', 'Delta', 2);
select records_fixture.score(9918002, 1, '99999999-0000-0000-0000-000000001801', 'Gamma', 1);
select records_fixture.score(9918003, 1, '99999999-0000-0000-0000-000000001802', 'Gamma', 1);
select records_fixture.score(9918004, 1, '99999999-0000-0000-0000-000000001802', 'Gamma', 1);

insert into public.circuits (id, name) values ('cccccccc-0000-0000-0000-000000001801', 'Zr Park');
insert into public.circuit_layouts (id, circuit_id, name) values
  ('cccccccc-0000-0000-0000-000000001811', 'cccccccc-0000-0000-0000-000000001801', 'Grand Prix'),
  ('cccccccc-0000-0000-0000-000000001812', 'cccccccc-0000-0000-0000-000000001801', 'National');

savepoint fixture;

-- R01 One row per round and class, the tie-break, the no-class row, and the rounds and laps left out --------
--     (BR1.1, BR1.3, BR1.9). Gamma in 9918001: 90.0000 three times; race 1 beats race 2, then P1 beats P3.
do $$
begin
  perform records_fixture.expect('R01 admin rows', records_fixture.rows_as('eeeeeeee-0000-0000-0000-0000000018a1'),
    '1/Delta:991800003/Zr Delta/1/2/950000,1/Gamma:991800002/Zr Gamma/1/1/900000,'
    '1/none:991800099/Zr Entrant/1/4/880000,2/Gamma:991800001/Zr Hidden/1/1/910000');
  perform records_fixture.expect('R01 track, layout and start time',
    (select track_name || '/' || coalesce(layout, 'null') || '/' || start_time::text
     from public.round_best_laps_shown where subsession_id = 9918002),
    'Zr Park/null/2026-06-12 18:00:00+00');
  raise notice 'ok R01 rows and tie-break';
end $$;
rollback to savepoint fixture;

-- R02 A hidden holder is masked for anon, with a stand-in cust_id; the lap and round still show (NFR3) -----
do $$
begin
  perform records_fixture.expect('R02 anon rows', records_fixture.rows_as('anon'),
    '1/Delta:991800003/Zr Delta/1/2/950000,1/Gamma:991800002/Zr Gamma/1/1/900000,'
    '1/none:991800099/Zr Entrant/1/4/880000,2/Gamma:masked/Hidden Driver/1/1/910000');
  raise notice 'ok R02 masking';
end $$;
rollback to savepoint fixture;

-- R03 Owner rights, security barrier, select only for anon and authenticated --------------------------------
do $$
begin
  perform records_fixture.expect('R03 options',
    (select array_to_string(reloptions, ',') from pg_class where oid = 'public.round_best_laps_shown'::regclass),
    'security_invoker=false,security_barrier=true');
  perform records_fixture.expect('R03 anon select', has_table_privilege('anon', 'public.round_best_laps_shown', 'select'), true);
  perform records_fixture.expect('R03 authenticated select',
    has_table_privilege('authenticated', 'public.round_best_laps_shown', 'select'), true);
  perform records_fixture.expect('R03 anon insert', has_table_privilege('anon', 'public.round_best_laps_shown', 'insert'), false);
  perform records_fixture.expect('R03 authenticated delete',
    has_table_privilege('authenticated', 'public.round_best_laps_shown', 'delete'), false);
  raise notice 'ok R03 settings and grants';
end $$;
rollback to savepoint fixture;

-- R04 Text questions save and read back; the max length range and no options (BR5.1, BR5.2) ----------------
do $$
declare
  v_poll uuid := records_fixture.new_poll('Zr text');
begin
  perform records_fixture.expect('R04 save',
    records_fixture.save(v_poll, records_fixture.payload(
      jsonb_build_object('name', 'Why', 'answer_type', 'text', 'text_max_length', 250))), '{}');
  perform records_fixture.expect('R04 read back',
    (select answer_type || '/' || text_max_length::text || '/' ||
            (select count(*) from public.poll_options o where o.section_id = s.id)::text
     from public.poll_sections s where s.poll_id = v_poll),
    'text/250/0');
  perform records_fixture.expect('R04 empty options list',
    records_fixture.save(v_poll, records_fixture.payload(jsonb_build_object('name', 'Why', 'answer_type', 'text',
      'text_max_length', 1, 'options', '[]'::jsonb))), '{}');
  perform records_fixture.expect('R04 zero',
    records_fixture.save(v_poll, records_fixture.payload(
      jsonb_build_object('name', 'Why', 'answer_type', 'text', 'text_max_length', 0))),
    'invalid:section.1.text_max_length:range');
  perform records_fixture.expect('R04 over 500',
    records_fixture.save(v_poll, records_fixture.payload(
      jsonb_build_object('name', 'Why', 'answer_type', 'text', 'text_max_length', 501))),
    'invalid:section.1.text_max_length:range');
  perform records_fixture.expect('R04 fraction',
    records_fixture.save(v_poll, records_fixture.payload(
      jsonb_build_object('name', 'Why', 'answer_type', 'text', 'text_max_length', 20.5))),
    'invalid:section.1.text_max_length:range');
  perform records_fixture.expect('R04 missing',
    records_fixture.save(v_poll, records_fixture.payload(jsonb_build_object('name', 'Why', 'answer_type', 'text'))),
    'invalid:section.1.text_max_length:range');
  perform records_fixture.expect('R04 with options',
    records_fixture.save(v_poll, records_fixture.payload(jsonb_build_object('name', 'Why', 'answer_type', 'text',
      'text_max_length', 200, 'options', jsonb_build_array(jsonb_build_object('name', 'A'))))),
    'invalid:section.1.options:count');
  -- Switching back to Pick one stores no max length, whatever the payload carries.
  perform records_fixture.expect('R04 back to single',
    records_fixture.save(v_poll, records_fixture.payload(jsonb_build_object('name', 'Why', 'answer_type', 'single',
      'text_max_length', 200, 'options', jsonb_build_array(jsonb_build_object('name', 'A'), jsonb_build_object('name', 'B'))))),
    '{}');
  perform records_fixture.expect('R04 no max length on single',
    (select answer_type || '/' || coalesce(text_max_length::text, 'null') from public.poll_sections where poll_id = v_poll),
    'single/null');
  -- The table refuses a Text question with no max length, even from the owner.
  begin
    insert into public.poll_sections (poll_id, name, answer_type, position) values (v_poll, 'Bare', 'text', 9);
    perform records_fixture.expect('R04 table check', 'inserted', 'refused');
  exception when check_violation then
    null;
  end;
  raise notice 'ok R04 text questions';
end $$;
rollback to savepoint fixture;

-- R05 Circuits options: save and read back, unknown, duplicate, with an image (BR6.3, BR6.4) ----------------
do $$
declare
  v_poll uuid := records_fixture.new_poll('Zr circuits');
  v_gp jsonb := jsonb_build_object('name', 'Zr Park — Grand Prix', 'layout_id', 'cccccccc-0000-0000-0000-000000001811');
  v_nat jsonb := jsonb_build_object('name', 'Zr Park — National', 'layout_id', 'cccccccc-0000-0000-0000-000000001812');
begin
  perform records_fixture.expect('R05 save',
    records_fixture.save(v_poll, records_fixture.payload(jsonb_build_object('name', 'Next', 'answer_type', 'single',
      'options', jsonb_build_array(v_gp, v_nat)))), '{}');
  perform records_fixture.expect('R05 read back',
    (select string_agg(o.name || '=' || o.layout_id::text, ',' order by o.position)
     from public.poll_options o join public.poll_sections s on s.id = o.section_id where s.poll_id = v_poll),
    'Zr Park — Grand Prix=cccccccc-0000-0000-0000-000000001811,Zr Park — National=cccccccc-0000-0000-0000-000000001812');
  perform records_fixture.expect('R05 unknown layout',
    records_fixture.save(v_poll, records_fixture.payload(jsonb_build_object('name', 'Next', 'answer_type', 'single',
      'options', jsonb_build_array(v_gp, jsonb_set(v_nat, '{layout_id}', '"cccccccc-0000-0000-0000-000000001899"'))))),
    'invalid:section.1.option.2.layout:foreign');
  perform records_fixture.expect('R05 malformed layout',
    records_fixture.save(v_poll, records_fixture.payload(jsonb_build_object('name', 'Next', 'answer_type', 'single',
      'options', jsonb_build_array(v_gp, jsonb_set(v_nat, '{layout_id}', '"nope"'))))),
    'invalid:section.1.option.2.layout:foreign');
  perform records_fixture.expect('R05 duplicate layout',
    records_fixture.save(v_poll, records_fixture.payload(jsonb_build_object('name', 'Next', 'answer_type', 'single',
      'options', jsonb_build_array(v_gp, jsonb_set(v_gp, '{name}', '"Other name"'))))),
    'invalid:section.1.option.2.layout:duplicate');
  perform records_fixture.expect('R05 layout with an image',
    records_fixture.save(v_poll, records_fixture.payload(jsonb_build_object('name', 'Next', 'answer_type', 'single',
      'options', jsonb_build_array(v_gp, v_nat || jsonb_build_object('image_path', v_poll::text || '/nat-1700000000000.png'))))),
    'invalid:section.1.option.2.layout:image');
  -- The same layout in two questions is fine.
  perform records_fixture.expect('R05 two questions',
    records_fixture.save(v_poll, jsonb_build_object('title', 'Zr poll', 'sections', jsonb_build_array(
      jsonb_build_object('name', 'One', 'answer_type', 'stars', 'options', jsonb_build_array(v_gp)),
      jsonb_build_object('name', 'Two', 'answer_type', 'stars', 'options', jsonb_build_array(v_gp))))), '{}');
  raise notice 'ok R05 circuits options';
end $$;
rollback to savepoint fixture;

-- R06 A deleted layout leaves the option with its saved name and no layout (BR6.5) ---------------------------
do $$
declare
  v_poll uuid := records_fixture.new_poll('Zr deleted');
begin
  perform records_fixture.expect('R06 save',
    records_fixture.save(v_poll, records_fixture.payload(jsonb_build_object('name', 'Next', 'answer_type', 'stars',
      'options', jsonb_build_array(jsonb_build_object('name', 'Zr Park — National',
        'layout_id', 'cccccccc-0000-0000-0000-000000001812'))))), '{}');
  delete from public.circuit_layouts where id = 'cccccccc-0000-0000-0000-000000001812';
  perform records_fixture.expect('R06 option kept',
    (select o.name || '/' || coalesce(o.layout_id::text, 'null')
     from public.poll_options o join public.poll_sections s on s.id = o.section_id where s.poll_id = v_poll),
    'Zr Park — National/null');
  raise notice 'ok R06 deleted layout';
end $$;
rollback to savepoint fixture;

-- R07 A payload without the new fields (the code on main) saves as before (NFR4) ---------------------------
do $$
declare
  v_poll uuid := records_fixture.new_poll('Zr old');
begin
  perform records_fixture.expect('R07 save',
    records_fixture.save(v_poll, jsonb_build_object('title', 'Zr old', 'sections', jsonb_build_array(
      jsonb_build_object('name', 'Track', 'answer_type', 'single', 'options', jsonb_build_array(
        jsonb_build_object('name', 'Spa', 'image_path', v_poll::text || '/spa-1700000000000.png'),
        jsonb_build_object('name', 'Monza')))))), '{}');
  perform records_fixture.expect('R07 read back',
    (select string_agg(o.name || '/' || coalesce(o.image_path, 'null') || '/' || coalesce(o.layout_id::text, 'null'),
                       ',' order by o.position)
     from public.poll_options o join public.poll_sections s on s.id = o.section_id where s.poll_id = v_poll),
    'Spa/' || v_poll::text || '/spa-1700000000000.png/null,Monza/null/null');
  perform records_fixture.expect('R07 still refuses a Star rating with no option',
    records_fixture.save(v_poll, records_fixture.payload(jsonb_build_object('name', 'Rate', 'answer_type', 'stars',
      'options', '[]'::jsonb))),
    'invalid:section.1.options:count');
  raise notice 'ok R07 old payload';
end $$;
rollback to savepoint fixture;

rollback;
