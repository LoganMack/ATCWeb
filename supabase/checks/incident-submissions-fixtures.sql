-- Incident Submissions fixtures for 20261110120000_incident_submissions.sql (incident-submissions-page), cases
-- S01-S06: what anon and a signed-in driver read from incident_submissions() on an unposted round (every
-- report, dismissed and logged ones too, numbered by submission time), that it returns only id, number,
-- session, lap and involved cars, that a posted round returns nothing, that the base tables stay closed to
-- anon, and the function's definer settings and grants.
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- staff-broadcaster-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/incident-submissions-fixtures.sql
--
-- Same conventions as incident-management-fixtures.sql (supabase/checks/README.md): every assertion calls
-- submissions_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each
-- case runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`.
--
-- Round 9911001 (unposted, status row false): R1 race:2 lap 4 (Ana, Ben; open), R2 race:1 lap 9 (Cyd;
-- dismissed), R3 qualifying:0 lap 1 (no cars; logged). Round 9911002 (posted): R4. Round 9911003 (no status
-- row): R5.

begin;

set local client_min_messages = notice;

create schema submissions_fixture;

create function submissions_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'incident submissions fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- The first value p_sql returns as p_who ('anon' or an account id), as text.
create function submissions_fixture.text_as(p_who text, p_sql text) returns text
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

-- p_who's list for a round as "number:session:lap:cars" entries, in the order returned.
create function submissions_fixture.list(p_who text, p_subsession bigint) returns text
  language sql as $$
  select submissions_fixture.text_as(p_who, format(
    $q$select coalesce(string_agg(format('%%s:%%s:%%s:%%s', s.submission_number, s.session, coalesce(s.lap::text, '-'),
                                         array_to_string(s.involved_cars, '/')), ',' order by s.ord), '')
       from (select t.*, row_number() over () as ord from public.incident_submissions(%s) t) s$q$, p_subsession));
$$;

grant usage on schema submissions_fixture to anon, authenticated;
grant execute on all functions in schema submissions_fixture to anon, authenticated;

-- Base data ------------------------------------------------------------------------------------

update public.scoring_settings set triggers_enabled = false;

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (891, 'Active')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select 891, 'Alpha', 1 where not exists (select 1 from public.driver_classes where name = 'Alpha');

insert into public.drivers (id, name, car_number, status_id, class_id, is_ai) values
  ('99999999-0000-0000-0000-000000000911', 'Ana Sub', 891,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false),
  ('99999999-0000-0000-0000-000000000912', 'Ben Sub', 892,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false),
  ('99999999-0000-0000-0000-000000000913', 'Cyd Sub', 893,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000911', 'sub-ana@example.test', now(), '{"display_name":"Ana Sub"}');
delete from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000911';
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000911', 'driver', 'Ana Sub', '99999999-0000-0000-0000-000000000911');

insert into public.curated_rounds (subsession_id, start_time, track_name) values
  (9911001, '2026-06-10 18:00+00', 'Zq Park'),
  (9911002, '2026-06-03 18:00+00', 'Zq Park'),
  (9911003, '2026-06-17 18:00+00', 'Zq Park');

insert into public.round_incident_status (subsession_id, posted, posted_at) values
  (9911001, false, null),
  (9911002, true, now() - interval '1 hour');

insert into public.incident_reports (id, subsession_id, session, lap, turn, description, status, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000000911', 9911001, 'race:2', 4, '3', 'Secret one', 'open', now() - interval '3 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000912', 9911001, 'race:1', 9, '1', 'Secret two', 'dismissed', now() - interval '2 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000913', 9911001, 'qualifying:0', 1, '7', null, 'logged', now() - interval '1 hour'),
  ('aaaaaaaa-0000-0000-0000-000000000914', 9911002, 'race:1', 2, '5', 'Posted round', 'open', now() - interval '4 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000915', 9911003, 'race:1', 6, '2', 'No status row', 'open', now() - interval '5 hours');
insert into public.incident_report_drivers (report_id, driver_id) values
  ('aaaaaaaa-0000-0000-0000-000000000911', '99999999-0000-0000-0000-000000000912'),
  ('aaaaaaaa-0000-0000-0000-000000000911', '99999999-0000-0000-0000-000000000911'),
  ('aaaaaaaa-0000-0000-0000-000000000912', '99999999-0000-0000-0000-000000000913'),
  ('aaaaaaaa-0000-0000-0000-000000000914', '99999999-0000-0000-0000-000000000911'),
  ('aaaaaaaa-0000-0000-0000-000000000915', '99999999-0000-0000-0000-000000000911');

savepoint fixture;

-- S01 Anon and a signed-in driver read every report of an unposted round, dismissed and logged ones too ----
do $$
begin
  perform submissions_fixture.expect('S01 anon', submissions_fixture.list('anon', 9911001),
    '1:race:2:4:891/892,2:race:1:9:893,3:qualifying:0:1:');
  perform submissions_fixture.expect('S01 driver',
    submissions_fixture.list('eeeeeeee-0000-0000-0000-000000000911', 9911001),
    '1:race:2:4:891/892,2:race:1:9:893,3:qualifying:0:1:');
  raise notice 'ok S01 unposted round listed';
end $$;
rollback to savepoint fixture;

-- S02 Only id, number, session, lap and involved cars come back -------------------------------------
do $$
begin
  perform submissions_fixture.expect('S02 result',
    pg_get_function_result('public.incident_submissions(bigint)'::regprocedure),
    'TABLE(id uuid, submission_number integer, session text, lap integer, involved_cars text[])');
  raise notice 'ok S02 columns';
end $$;
rollback to savepoint fixture;

-- S03 A posted round returns nothing; a round with no status row counts as unposted ------------------
do $$
begin
  perform submissions_fixture.expect('S03 posted', submissions_fixture.list('anon', 9911002), '');
  perform submissions_fixture.expect('S03 no status row', submissions_fixture.list('anon', 9911003), '1:race:1:6:891');
  raise notice 'ok S03 posted and no status row';
end $$;
rollback to savepoint fixture;

-- S04 Posting a round empties its list ---------------------------------------------------------------
do $$
begin
  update public.round_incident_status set posted = true, posted_at = now() where subsession_id = 9911001;
  perform submissions_fixture.expect('S04 after posting', submissions_fixture.list('anon', 9911001), '');
  raise notice 'ok S04 posting';
end $$;
rollback to savepoint fixture;

-- S05 The base tables stay closed to anon (no description, reporter or status through the API) ------------
do $$
begin
  perform submissions_fixture.expect('S05 reports',
    submissions_fixture.text_as('anon', 'select count(*)::text from public.incident_reports where subsession_id = 9911001'), '0');
  perform submissions_fixture.expect('S05 report drivers',
    submissions_fixture.text_as('anon', $q$select count(*)::text from public.incident_report_drivers
                                         where report_id = 'aaaaaaaa-0000-0000-0000-000000000911'$q$), '0');
  raise notice 'ok S05 base tables closed';
end $$;
rollback to savepoint fixture;

-- S06 Definer settings and grants ---------------------------------------------------------------------
do $$
declare
  v_fn regprocedure := 'public.incident_submissions(bigint)'::regprocedure;
begin
  perform submissions_fixture.expect('S06 definer', (select prosecdef from pg_proc where oid = v_fn), true);
  perform submissions_fixture.expect('S06 stable', (select provolatile::text from pg_proc where oid = v_fn), 's');
  perform submissions_fixture.expect('S06 search_path', (select proconfig from pg_proc where oid = v_fn), array['search_path=""']);
  perform submissions_fixture.expect('S06 anon', has_function_privilege('anon', v_fn, 'execute'), true);
  perform submissions_fixture.expect('S06 authenticated', has_function_privilege('authenticated', v_fn, 'execute'), true);
  raise notice 'ok S06 settings and grants';
end $$;
rollback to savepoint fixture;

rollback;
