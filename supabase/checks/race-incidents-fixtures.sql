-- Race incident adjustment fixtures for 20261119120000_race_incident_adjustments.sql (intent
-- 261117-incident-report-polish, unit results-edit; rules BR9.1-BR9.11; contract C2), cases A01-A08:
--   A01 callers of set_race_incidents (anon, a driver and Staff refused, a full admin accepted);
--   A02 the adjustments table: no direct writes for anyone, no reads for drivers, reads for admins and Staff;
--   A03 bad input, refused before anything is written;
--   A04 saves: the first adjustment keeps the original, a third value keeps it, setting it back removes it;
--   A05 two saves in a row and three drivers in one save, adjusted_by and the returned count;
--   A06 the re-import trigger (delete then insert, as raceResultsImport does it);
--   A07 original_incidents in curated_race_results_shown, for a hidden driver read as anon;
--   A08 settings and grants.
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- records-text-polls-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/race-incidents-fixtures.sql
--
-- Same conventions as the other fixture files (supabase/checks/README.md): every assertion calls
-- incidents_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each case
-- runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`. Callers are impersonated
-- with request.jwt.claims and the role setting. The scoring triggers are switched off: scoring has its own
-- fixtures, and these cases are about the counts and the adjustments.
--
-- Base data: round 9919001 (Zi Park), race 1 with Zi Hidden (cust 991900001, name hidden, 4 incidents),
-- Zi Driver (991900002, 2), Zi Third (991900003, 0) and Zi Null (991900004, no count); race 2 with Zi Driver (6).
-- Accounts: a full admin, Staff, and a driver (linked to Zi Driver).

begin;

set local client_min_messages = notice;

create schema incidents_fixture;

create function incidents_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'race incidents fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

create function incidents_fixture.act_as(p_who text) returns void
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

create function incidents_fixture.as_owner() returns void
  language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- The SQLSTATE p_sql fails with as p_who, or 'ok'.
create function incidents_fixture.state_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text := 'ok';
begin
  perform incidents_fixture.act_as(p_who);
  begin
    execute p_sql;
  exception when others then
    v_state := sqlstate;
  end;
  perform incidents_fixture.as_owner();
  return v_state;
end;
$$;

-- The error detail p_sql fails with as p_who ('' when none), or 'ok'.
create function incidents_fixture.detail_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v_detail text := 'ok';
begin
  perform incidents_fixture.act_as(p_who);
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
  end;
  perform incidents_fixture.as_owner();
  return v_detail;
end;
$$;

-- The first value p_sql returns as p_who, as text (raises when p_sql fails).
create function incidents_fixture.text_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v text;
begin
  perform incidents_fixture.act_as(p_who);
  execute p_sql into v;
  perform incidents_fixture.as_owner();
  return v;
end;
$$;

-- Saves p_changes for race p_race of the fixture round as the full admin and returns the function's reply.
create function incidents_fixture.save(p_race integer, p_changes text) returns jsonb
  language plpgsql as $$
declare
  v jsonb;
begin
  perform incidents_fixture.act_as('eeeeeeee-0000-0000-0000-0000000019a1');
  v := public.set_race_incidents(9919001, p_race, p_changes::jsonb);
  perform incidents_fixture.as_owner();
  return v;
end;
$$;

-- A driver's current count in curated_race_results.
create function incidents_fixture.count_of(p_race integer, p_cust bigint) returns integer
  language sql as $$
  select incidents from public.curated_race_results
  where subsession_id = 9919001 and race_number = p_race and cust_id = p_cust;
$$;

-- A driver's adjustment as 'original/adjusted', or 'none'.
create function incidents_fixture.adjustment_of(p_race integer, p_cust bigint) returns text
  language sql as $$
  select coalesce(
    (select original_incidents || '/' || adjusted_incidents from public.race_incident_adjustments
     where subsession_id = 9919001 and race_number = p_race and cust_id = p_cust),
    'none');
$$;

-- Re-imports race 1 the way raceResultsImport does: delete the race's rows, then insert them again with
-- the given counts (cust_id -> incidents; a missing key leaves the driver out of the import).
create function incidents_fixture.reimport(p_counts jsonb) returns void
  language plpgsql as $$
begin
  delete from public.curated_race_results where subsession_id = 9919001 and race_number = 1;
  insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, finish_position, incidents)
  select 9919001, 1, v.cust, v.name, v.pos, (p_counts ->> v.cust::text)::integer
  from (values (991900001::bigint, 'Zi Hidden', 1), (991900002, 'Zi Driver', 2), (991900003, 'Zi Third', 3),
               (991900004, 'Zi Null', 4)) v (cust, name, pos)
  where p_counts ? v.cust::text;
end;
$$;

grant usage on schema incidents_fixture to anon, authenticated;
grant execute on all functions in schema incidents_fixture to anon, authenticated;

-- Base data ------------------------------------------------------------------------------------------------

update public.scoring_settings set triggers_enabled = false;

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (919, 'Active')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select 919, 'Alpha', 1 where not exists (select 1 from public.driver_classes where name = 'Alpha');

insert into public.drivers (id, name, car_number, status_id, class_id, iracing_cust_id, is_ai)
select v.id::uuid, v.name, v.car, (select id from public.driver_statuses where name = 'Active'),
       (select id from public.driver_classes where name = 'Alpha'), v.cust, false
from (values
  ('99999999-0000-0000-0000-000000001901', 'Zi Hidden', 991, 991900001),
  ('99999999-0000-0000-0000-000000001902', 'Zi Driver', 992, 991900002)
) v (id, name, car, cust);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-0000000019a1', 'zi-adm@example.test', now(), '{"display_name":"Zi Admin"}'),
  ('eeeeeeee-0000-0000-0000-0000000019a2', 'zi-stf@example.test', now(), '{"display_name":"Zi Staff"}'),
  ('eeeeeeee-0000-0000-0000-0000000019a3', 'zi-drv@example.test', now(), '{"display_name":"Zi Driver"}'),
  ('eeeeeeee-0000-0000-0000-0000000019a4', 'zi-hid@example.test', now(), '{"display_name":"Zi Hidden"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-0000000019a1', 'eeeeeeee-0000-0000-0000-0000000019a2',
  'eeeeeeee-0000-0000-0000-0000000019a3', 'eeeeeeee-0000-0000-0000-0000000019a4');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-0000000019a1', 'admin', 'Zi Admin', null),
  ('eeeeeeee-0000-0000-0000-0000000019a2', 'staff', 'Zi Staff', null),
  ('eeeeeeee-0000-0000-0000-0000000019a3', 'driver', 'Zi Driver', '99999999-0000-0000-0000-000000001902'),
  ('eeeeeeee-0000-0000-0000-0000000019a4', 'driver', 'Zi Hidden', '99999999-0000-0000-0000-000000001901');
insert into public.account_settings (profile_id, hide_name) values ('eeeeeeee-0000-0000-0000-0000000019a4', true);

insert into public.curated_rounds (subsession_id, start_time, track_name) values
  (9919001, '2026-06-05 18:00+00', 'Zi Park');

insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, finish_position, incidents) values
  (9919001, 1, 991900001, 'Zi Hidden', 1, 4),
  (9919001, 1, 991900002, 'Zi Driver', 2, 2),
  (9919001, 1, 991900003, 'Zi Third', 3, 0),
  (9919001, 1, 991900004, 'Zi Null', 4, null),
  (9919001, 2, 991900002, 'Zi Driver', 1, 6);

savepoint fixture;

-- A01 Who can save (BR9.1) --------------------------------------------------------------------------------
do $$
declare
  v_call text := $q$select public.set_race_incidents(9919001, 1, '[{"cust_id": 991900002, "incidents": 5}]')$q$;
begin
  perform incidents_fixture.expect('A01 anon refused', incidents_fixture.state_as('anon', v_call), '42501');
  perform incidents_fixture.expect('A01 driver refused',
    incidents_fixture.state_as('eeeeeeee-0000-0000-0000-0000000019a3', v_call), '42501');
  perform incidents_fixture.expect('A01 Staff refused',
    incidents_fixture.state_as('eeeeeeee-0000-0000-0000-0000000019a2', v_call), '42501');
  perform incidents_fixture.expect('A01 nothing changed', incidents_fixture.count_of(1, 991900002), 2);
  perform incidents_fixture.expect('A01 full admin accepted',
    incidents_fixture.state_as('eeeeeeee-0000-0000-0000-0000000019a1', v_call), 'ok');
  perform incidents_fixture.expect('A01 count saved', incidents_fixture.count_of(1, 991900002), 5);
  raise notice 'ok A01 callers';
end $$;
rollback to savepoint fixture;

-- A02 The adjustments table is written only by the function and trigger, and read by admins and Staff -------
do $$
begin
  perform incidents_fixture.save(1, '[{"cust_id": 991900002, "incidents": 5}]');
  perform incidents_fixture.expect('A02 admin insert refused',
    incidents_fixture.state_as('eeeeeeee-0000-0000-0000-0000000019a1',
      $q$insert into public.race_incident_adjustments (subsession_id, race_number, cust_id, original_incidents,
         adjusted_incidents, adjusted_by) values (9919001, 1, 991900003, 0, 1, 'eeeeeeee-0000-0000-0000-0000000019a1')$q$),
    '42501');
  perform incidents_fixture.expect('A02 admin update refused',
    incidents_fixture.state_as('eeeeeeee-0000-0000-0000-0000000019a1',
      $q$update public.race_incident_adjustments set original_incidents = 9$q$), '42501');
  perform incidents_fixture.expect('A02 admin delete refused',
    incidents_fixture.state_as('eeeeeeee-0000-0000-0000-0000000019a1',
      $q$delete from public.race_incident_adjustments$q$), '42501');
  perform incidents_fixture.expect('A02 anon read refused',
    incidents_fixture.state_as('anon', $q$select count(*) from public.race_incident_adjustments$q$), '42501');
  perform incidents_fixture.expect('A02 driver reads nothing',
    incidents_fixture.text_as('eeeeeeee-0000-0000-0000-0000000019a3',
      $q$select count(*)::text from public.race_incident_adjustments$q$), '0');
  perform incidents_fixture.expect('A02 Staff reads the row',
    incidents_fixture.text_as('eeeeeeee-0000-0000-0000-0000000019a2',
      $q$select count(*)::text from public.race_incident_adjustments$q$), '1');
  perform incidents_fixture.expect('A02 admin reads the row',
    incidents_fixture.text_as('eeeeeeee-0000-0000-0000-0000000019a1',
      $q$select original_incidents || '/' || adjusted_incidents from public.race_incident_adjustments$q$), '2/5');
  raise notice 'ok A02 table access';
end $$;
rollback to savepoint fixture;

-- A03 Bad input is refused before anything is written (BR9.3, BR9.10) -------------------------------------
do $$
declare
  v_admin text := 'eeeeeeee-0000-0000-0000-0000000019a1';
  v_case record;
begin
  for v_case in
    select * from (values
      ('decimal', $q$select public.set_race_incidents(9919001, 1, '[{"cust_id": 991900002, "incidents": 3.5}]')$q$, '22023', '991900002'),
      ('text', $q$select public.set_race_incidents(9919001, 1, '[{"cust_id": 991900002, "incidents": "abc"}]')$q$, '22023', '991900002'),
      ('missing count', $q$select public.set_race_incidents(9919001, 1, '[{"cust_id": 991900002}]')$q$, '22023', '991900002'),
      ('negative', $q$select public.set_race_incidents(9919001, 1, '[{"cust_id": 991900002, "incidents": -1}]')$q$, '22023', '991900002'),
      ('over 999', $q$select public.set_race_incidents(9919001, 1, '[{"cust_id": 991900002, "incidents": 1000}]')$q$, '22023', '991900002'),
      ('negative cust_id', $q$select public.set_race_incidents(9919001, 1, '[{"cust_id": -5, "incidents": 1}]')$q$, '22023', ''),
      ('duplicate', $q$select public.set_race_incidents(9919001, 1, '[{"cust_id": 991900002, "incidents": 1}, {"cust_id": 991900002, "incidents": 3}]')$q$, '22023', '991900002'),
      ('empty', $q$select public.set_race_incidents(9919001, 1, '[]')$q$, '22023', ''),
      ('not an array', $q$select public.set_race_incidents(9919001, 1, '{"cust_id": 991900002, "incidents": 1}')$q$, '22023', ''),
      ('null changes', $q$select public.set_race_incidents(9919001, 1, null)$q$, '22023', ''),
      ('null round', $q$select public.set_race_incidents(null, 1, '[{"cust_id": 991900002, "incidents": 1}]')$q$, '22023', ''),
      ('race 0', $q$select public.set_race_incidents(9919001, 0, '[{"cust_id": 991900002, "incidents": 1}]')$q$, '22023', ''),
      ('null imported count', $q$select public.set_race_incidents(9919001, 1, '[{"cust_id": 991900004, "incidents": 1}]')$q$, '22023', '991900004'),
      ('not in race', $q$select public.set_race_incidents(9919001, 2, '[{"cust_id": 991900003, "incidents": 1}]')$q$, 'P0002', '991900003')
    ) c (label, sql, state, detail)
  loop
    perform incidents_fixture.expect('A03 ' || v_case.label || ' state', incidents_fixture.state_as(v_admin, v_case.sql), v_case.state);
    perform incidents_fixture.expect('A03 ' || v_case.label || ' detail', incidents_fixture.detail_as(v_admin, v_case.sql), v_case.detail);
  end loop;

  perform incidents_fixture.expect('A03 over 200 entries',
    incidents_fixture.state_as(v_admin, format('select public.set_race_incidents(9919001, 1, %L)',
      (select jsonb_agg(jsonb_build_object('cust_id', 991900100 + g, 'incidents', 1)) from generate_series(1, 201) g)::text)),
    '22023');
  perform incidents_fixture.expect('A03 a bad entry refuses the whole save',
    incidents_fixture.state_as(v_admin,
      $q$select public.set_race_incidents(9919001, 1, '[{"cust_id": 991900001, "incidents": 7}, {"cust_id": 991900002, "incidents": 3.5}]')$q$),
    '22023');
  perform incidents_fixture.expect('A03 nothing written', incidents_fixture.count_of(1, 991900001), 4);
  perform incidents_fixture.expect('A03 no adjustments', (select count(*) from public.race_incident_adjustments), 0::bigint);

  perform incidents_fixture.expect('A03 5.0 saves as 5',
    incidents_fixture.save(1, '[{"cust_id": 991900002, "incidents": 5.0}]') ->> 'changed', '1');
  perform incidents_fixture.expect('A03 5.0 count', incidents_fixture.count_of(1, 991900002), 5);
  raise notice 'ok A03 bad input';
end $$;
rollback to savepoint fixture;

-- A04 The original is kept once, and setting it back removes the adjustment (BR9.4-BR9.6) ------------------
do $$
begin
  perform incidents_fixture.save(1, '[{"cust_id": 991900002, "incidents": 5}]');
  perform incidents_fixture.expect('A04 first adjustment', incidents_fixture.adjustment_of(1, 991900002), '2/5');
  perform incidents_fixture.expect('A04 first count', incidents_fixture.count_of(1, 991900002), 5);

  perform incidents_fixture.save(1, '[{"cust_id": 991900002, "incidents": 8}]');
  perform incidents_fixture.expect('A04 third value keeps the original', incidents_fixture.adjustment_of(1, 991900002), '2/8');

  perform incidents_fixture.expect('A04 same value changes nothing',
    incidents_fixture.save(1, '[{"cust_id": 991900002, "incidents": 8}]') ->> 'changed', '0');

  perform incidents_fixture.save(1, '[{"cust_id": 991900002, "incidents": 2}]');
  perform incidents_fixture.expect('A04 set back removes it', incidents_fixture.adjustment_of(1, 991900002), 'none');
  perform incidents_fixture.expect('A04 set back count', incidents_fixture.count_of(1, 991900002), 2);
  perform incidents_fixture.expect('A04 no original in the view',
    (select original_incidents from public.curated_race_results_shown
     where subsession_id = 9919001 and race_number = 1 and cust_id = 991900002), null::integer);

  perform incidents_fixture.save(2, '[{"cust_id": 991900002, "incidents": 1}]');
  perform incidents_fixture.expect('A04 races are separate', incidents_fixture.adjustment_of(2, 991900002), '6/1');
  perform incidents_fixture.expect('A04 race 1 untouched', incidents_fixture.adjustment_of(1, 991900002), 'none');
  raise notice 'ok A04 original kept';
end $$;
rollback to savepoint fixture;

-- A05 Two saves in a row, three drivers at once, adjusted_by and the reply (BR9.5) ---------------------------
do $$
declare
  v_reply jsonb;
begin
  v_reply := incidents_fixture.save(1,
    '[{"cust_id": 991900001, "incidents": 6}, {"cust_id": 991900002, "incidents": 2}, {"cust_id": 991900003, "incidents": 4}]');
  perform incidents_fixture.expect('A05 unchanged rows not counted', v_reply ->> 'changed', '2');
  perform incidents_fixture.expect('A05 reply has scoring_issue', v_reply ? 'scoring_issue', true);
  perform incidents_fixture.expect('A05 first driver', incidents_fixture.adjustment_of(1, 991900001), '4/6');
  perform incidents_fixture.expect('A05 unchanged driver', incidents_fixture.adjustment_of(1, 991900002), 'none');
  perform incidents_fixture.expect('A05 third driver', incidents_fixture.adjustment_of(1, 991900003), '0/4');

  v_reply := incidents_fixture.save(1,
    '[{"cust_id": 991900001, "incidents": 4}, {"cust_id": 991900002, "incidents": 3}, {"cust_id": 991900003, "incidents": 5}]');
  perform incidents_fixture.expect('A05 second save changed', v_reply ->> 'changed', '3');
  perform incidents_fixture.expect('A05 reverted in the same save', incidents_fixture.adjustment_of(1, 991900001), 'none');
  perform incidents_fixture.expect('A05 new adjustment in the same save', incidents_fixture.adjustment_of(1, 991900002), '2/3');
  perform incidents_fixture.expect('A05 changed again', incidents_fixture.adjustment_of(1, 991900003), '0/5');
  perform incidents_fixture.expect('A05 counts', incidents_fixture.count_of(1, 991900001) || ',' ||
    incidents_fixture.count_of(1, 991900002) || ',' || incidents_fixture.count_of(1, 991900003), '4,3,5');
  perform incidents_fixture.expect('A05 adjusted_by',
    (select string_agg(distinct adjusted_by::text, ',') from public.race_incident_adjustments),
    'eeeeeeee-0000-0000-0000-0000000019a1');
  raise notice 'ok A05 several drivers';
end $$;
rollback to savepoint fixture;

-- A06 The re-import trigger (BR9.8, C2) -----------------------------------------------------------------------
do $$
begin
  -- The import agrees with the admin's count: the adjustment goes.
  perform incidents_fixture.save(1, '[{"cust_id": 991900002, "incidents": 5}]');
  perform incidents_fixture.reimport('{"991900001": 4, "991900002": 5, "991900003": 0, "991900004": null}');
  perform incidents_fixture.expect('A06 agree: no adjustment', incidents_fixture.adjustment_of(1, 991900002), 'none');
  perform incidents_fixture.expect('A06 agree: count', incidents_fixture.count_of(1, 991900002), 5);

  -- The import differs: the new import becomes the original and the admin's count stays.
  perform incidents_fixture.save(1, '[{"cust_id": 991900002, "incidents": 7}]');
  perform incidents_fixture.reimport('{"991900001": 4, "991900002": 3, "991900003": 0, "991900004": null}');
  perform incidents_fixture.expect('A06 differ: original refreshed', incidents_fixture.adjustment_of(1, 991900002), '3/7');
  perform incidents_fixture.expect('A06 differ: count kept', incidents_fixture.count_of(1, 991900002), 7);

  -- An imported count the table can't hold as an original: count and original stay.
  perform incidents_fixture.reimport('{"991900001": 4, "991900002": null, "991900003": 0, "991900004": null}');
  perform incidents_fixture.expect('A06 null: kept', incidents_fixture.adjustment_of(1, 991900002), '3/7');
  perform incidents_fixture.expect('A06 null: count', incidents_fixture.count_of(1, 991900002), 7);
  perform incidents_fixture.reimport('{"991900001": 4, "991900002": -1, "991900003": 0, "991900004": null}');
  perform incidents_fixture.expect('A06 negative: kept', incidents_fixture.adjustment_of(1, 991900002), '3/7');
  perform incidents_fixture.expect('A06 negative: count', incidents_fixture.count_of(1, 991900002), 7);
  perform incidents_fixture.reimport('{"991900001": 4, "991900002": 1000, "991900003": 0, "991900004": null}');
  perform incidents_fixture.expect('A06 over 999: kept', incidents_fixture.adjustment_of(1, 991900002), '3/7');
  perform incidents_fixture.expect('A06 over 999: count', incidents_fixture.count_of(1, 991900002), 7);

  -- A driver missing from the import: the adjustment stays, unused, and applies if the driver comes back.
  perform incidents_fixture.reimport('{"991900001": 4, "991900003": 0, "991900004": null}');
  perform incidents_fixture.expect('A06 missing: no row', incidents_fixture.count_of(1, 991900002), null::integer);
  perform incidents_fixture.expect('A06 missing: adjustment kept', incidents_fixture.adjustment_of(1, 991900002), '3/7');
  perform incidents_fixture.reimport('{"991900001": 4, "991900002": 3, "991900003": 0, "991900004": null}');
  perform incidents_fixture.expect('A06 back: count applied', incidents_fixture.count_of(1, 991900002), 7);

  -- A driver with no adjustment imports unchanged.
  perform incidents_fixture.expect('A06 others untouched', incidents_fixture.count_of(1, 991900001), 4);
  raise notice 'ok A06 re-import';
end $$;
rollback to savepoint fixture;

-- A07 The view shows the original, also for a hidden driver read as anon (BR9.7) ----------------------------
do $$
begin
  perform incidents_fixture.save(1, '[{"cust_id": 991900001, "incidents": 9}, {"cust_id": 991900002, "incidents": 5}]');
  perform incidents_fixture.expect('A07 anon sees the hidden driver masked with the original',
    incidents_fixture.text_as('anon',
      $q$select display_name || '/' || (cust_id = 991900001) || '/' || incidents || '/' || original_incidents
         from public.curated_race_results_shown where subsession_id = 9919001 and race_number = 1 and display_name = 'Hidden Driver'$q$),
    'Hidden Driver/false/9/4');
  perform incidents_fixture.expect('A07 anon sees the original',
    incidents_fixture.text_as('anon',
      $q$select incidents || '/' || original_incidents from public.curated_race_results_shown
         where subsession_id = 9919001 and race_number = 1 and cust_id = 991900002$q$),
    '5/2');
  perform incidents_fixture.expect('A07 unadjusted driver has no original',
    incidents_fixture.text_as('anon',
      $q$select coalesce(original_incidents::text, 'null') from public.curated_race_results_shown
         where subsession_id = 9919001 and race_number = 1 and cust_id = 991900003$q$),
    'null');
  perform incidents_fixture.expect('A07 who and when are not in the view',
    (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'curated_race_results_shown'
       and column_name in ('adjusted_by', 'adjusted_at')),
    0::bigint);
  perform incidents_fixture.expect('A07 original_incidents is the last column',
    (select column_name::text from information_schema.columns
     where table_schema = 'public' and table_name = 'curated_race_results_shown'
     order by ordinal_position desc limit 1),
    'original_incidents');
  raise notice 'ok A07 view';
end $$;
rollback to savepoint fixture;

-- A08 Settings and grants (NFR2.13, NFR2.19) ------------------------------------------------------------------
do $$
begin
  perform incidents_fixture.expect('A08 save function is a definer with an empty search_path',
    (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_proc p where p.oid = 'public.set_race_incidents(bigint, integer, jsonb)'::regprocedure),
    true);
  perform incidents_fixture.expect('A08 trigger function is a definer with an empty search_path',
    (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_proc p where p.oid = 'private.reapply_incident_adjustment()'::regprocedure),
    true);
  perform incidents_fixture.expect('A08 anon cannot execute',
    has_function_privilege('anon', 'public.set_race_incidents(bigint, integer, jsonb)', 'execute'), false);
  perform incidents_fixture.expect('A08 authenticated can execute',
    has_function_privilege('authenticated', 'public.set_race_incidents(bigint, integer, jsonb)', 'execute'), true);
  perform incidents_fixture.expect('A08 nobody calls the trigger function',
    has_function_privilege('authenticated', 'private.reapply_incident_adjustment()', 'execute'), false);
  perform incidents_fixture.expect('A08 RLS on',
    (select relrowsecurity from pg_class where oid = 'public.race_incident_adjustments'::regclass), true);
  perform incidents_fixture.expect('A08 no write grants',
    has_table_privilege('authenticated', 'public.race_incident_adjustments', 'insert')
      or has_table_privilege('authenticated', 'public.race_incident_adjustments', 'update')
      or has_table_privilege('authenticated', 'public.race_incident_adjustments', 'delete')
      or has_table_privilege('anon', 'public.race_incident_adjustments', 'select'),
    false);
  perform incidents_fixture.expect('A08 view options',
    (select reloptions @> array['security_barrier=true'] and not (reloptions @> array['security_invoker=true'])
     from pg_class where oid = 'public.curated_race_results_shown'::regclass),
    true);
  perform incidents_fixture.expect('A08 view is read-only for anon',
    has_table_privilege('anon', 'public.curated_race_results_shown', 'update'), false);
  raise notice 'ok A08 settings and grants';
end $$;
rollback to savepoint fixture;

rollback;
