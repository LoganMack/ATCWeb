-- Incident management fixtures for 20261101120000_incident_management.sql (U5 incident-management): the
-- grants and lockdown, driver comments (read access per caller, every error code, deletes and cascade),
-- my_incidents() (isolation, pending and posted rows, a round that gets posted, a dismissed appeal, the
-- window with its default and a malformed setting, the points difference, the 200-row cap, anon, the
-- seeded-volume timing), can_appeal_penalty() and the replaced submit_incident_appeal (penalized, involved
-- and uninvolved callers, a second appeal, a closed window, legacy duplicates, the round page's call
-- shape), the own-appeal read policy and the U7 reviewed trigger (M01-M18).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- notifications-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/incident-management-fixtures.sql
--
-- Same conventions as notifications-fixtures.sql (supabase/checks/README.md): every assertion calls
-- incident_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each
-- case runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`. Callers are
-- impersonated with request.jwt.claims and the role setting. now() is fixed for the whole transaction.
--
-- Accounts: admin_in (admin, linked to Dee Steward, so involved in report R1); admin_out (admin, no
-- driver); a (Ana Mine), b (Ben Other), c (Cyd Third); u (no driver).
-- Rounds: 9908001 posted 1 hour ago (window open), 9908002 posted 48 hours ago (closed), 9908003 has a
-- status row with posted = false, 9908004 has no status row.
-- Reports: R1 (9908003: Ana, Ben, Dee, open), R2 (9908004: Ana, Cyd, logged), R3 (9908003: Ana, dismissed),
-- R4 (9908001, posted: Ana).
-- Penalties: P1 (9908001: Ana penalized, Ben involved, 3 PP), P2 (9908002: Ana, closed, no appeal),
-- P3 (9908002: Ben penalized, Ana involved, Ana has a dismissed appeal), P4 (9908001: Cyd only),
-- P5 (9908001: racing incident, Ana and Cyd involved).

begin;

set local client_min_messages = notice;

create schema incident_fixture;

create function incident_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'incident management fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Acts as p_who ('anon' or an account id) until incident_fixture.as_owner().
create function incident_fixture.act_as(p_who text) returns void
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

create function incident_fixture.as_owner() returns void
  language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- Runs p_sql as p_who; an error stops the fixture.
create function incident_fixture.exec_as(p_who text, p_sql text) returns void
  language plpgsql as $$
begin
  perform incident_fixture.act_as(p_who);
  execute p_sql;
  perform incident_fixture.as_owner();
end;
$$;

-- The first value p_sql returns as p_who, as text.
create function incident_fixture.text_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v text;
begin
  perform incident_fixture.act_as(p_who);
  execute p_sql into v;
  perform incident_fixture.as_owner();
  return v;
end;
$$;

-- The SQLSTATE p_sql fails with as p_who, or 'ok'. On an error the block's own rollback puts the role back.
create function incident_fixture.state_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform incident_fixture.act_as(p_who);
  execute p_sql;
  perform incident_fixture.as_owner();
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- The code before the first ':' of the error p_sql raises as p_who ('ALREADY_APPEALED: ...' ->
-- 'ALREADY_APPEALED'), or 'ok'.
create function incident_fixture.code_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform incident_fixture.act_as(p_who);
  execute p_sql;
  perform incident_fixture.as_owner();
  return 'ok';
exception when others then
  return split_part(sqlerrm, ':', 1);
end;
$$;

-- Short names for the rows my_incidents() returns.
create table incident_fixture.names (id uuid primary key, label text not null);

-- p_who's list as labels, in the order returned.
create function incident_fixture.list(p_who text) returns text
  language sql as $$
  select incident_fixture.text_as(p_who,
    $q$select coalesce(string_agg(coalesce(n.label, '?'), ',' order by m.ordinality), '')
       from public.my_incidents() with ordinality m
       left join incident_fixture.names n on n.id = m.id$q$);
$$;

-- One column of p_who's row for p_id, as text.
create function incident_fixture.field(p_who text, p_id uuid, p_column text) returns text
  language sql as $$
  select incident_fixture.text_as(p_who,
    format('select (%s)::text from public.my_incidents() m where m.id = %L', p_column, p_id));
$$;

-- An appeal with no files, the way the site's createIncidentAppeal calls it through PostgREST (named args).
create function incident_fixture.appeal_sql(p_penalty uuid) returns text
  language sql as $$
  select format($q$select public.submit_incident_appeal(p_id => %L, p_penalty_id => %L, p_message => 'Please review', p_files => '[]'::jsonb)$q$,
                gen_random_uuid(), p_penalty);
$$;

grant usage on schema incident_fixture to anon, authenticated;
grant execute on all functions in schema incident_fixture to anon, authenticated;
grant select on incident_fixture.names to anon, authenticated;

-- Base data ------------------------------------------------------------------------------------

-- No scoring or round-stats side effects from the rows below.
update public.scoring_settings set triggers_enabled = false;

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (841, 'Active')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select 841, 'Alpha', 1 where not exists (select 1 from public.driver_classes where name = 'Alpha');

insert into public.seasons (id, number, name) values ('bbbbbbbb-0000-0000-0000-000000000801', 9841, 'Zm Season');

insert into public.drivers (id, name, car_number, status_id, class_id, is_ai) values
  ('99999999-0000-0000-0000-000000000801', 'Ana Mine', 881,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false),
  ('99999999-0000-0000-0000-000000000802', 'Ben Other', 882,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false),
  ('99999999-0000-0000-0000-000000000803', 'Cyd Third', 883,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false),
  ('99999999-0000-0000-0000-000000000804', 'Dee Steward', 884,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false);

-- The auth.users insert creates a 'driver' profile; the admins and the linked accounts are re-inserted,
-- because as postgres the profiles guard refuses a role or driver change.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000801', 'im-admin-in@example.test', now(), '{"display_name":"Admin In"}'),
  ('eeeeeeee-0000-0000-0000-000000000802', 'im-admin-out@example.test', now(), '{"display_name":"Admin Out"}'),
  ('eeeeeeee-0000-0000-0000-000000000803', 'im-a@example.test', now(), '{"display_name":"Owner A"}'),
  ('eeeeeeee-0000-0000-0000-000000000804', 'im-b@example.test', now(), '{"display_name":"Owner B"}'),
  ('eeeeeeee-0000-0000-0000-000000000805', 'im-c@example.test', now(), '{"display_name":"Owner C"}'),
  ('eeeeeeee-0000-0000-0000-000000000806', 'im-u@example.test', now(), '{"display_name":"Unlinked U"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000000801', 'eeeeeeee-0000-0000-0000-000000000802',
                                         'eeeeeeee-0000-0000-0000-000000000803', 'eeeeeeee-0000-0000-0000-000000000804',
                                         'eeeeeeee-0000-0000-0000-000000000805');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000801', 'admin', 'Admin In', '99999999-0000-0000-0000-000000000804'),
  ('eeeeeeee-0000-0000-0000-000000000802', 'admin', 'Admin Out', null),
  ('eeeeeeee-0000-0000-0000-000000000803', 'driver', 'Owner A', '99999999-0000-0000-0000-000000000801'),
  ('eeeeeeee-0000-0000-0000-000000000804', 'driver', 'Owner B', '99999999-0000-0000-0000-000000000802'),
  ('eeeeeeee-0000-0000-0000-000000000805', 'driver', 'Owner C', '99999999-0000-0000-0000-000000000803');

insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, round_number) values
  (9908001, '2026-06-05 18:00+00', 'Zm Park', 'bbbbbbbb-0000-0000-0000-000000000801', 2),
  (9908002, '2026-06-01 18:00+00', 'Zm Park', 'bbbbbbbb-0000-0000-0000-000000000801', 1),
  (9908003, '2026-06-10 18:00+00', 'Zm Park', 'bbbbbbbb-0000-0000-0000-000000000801', 3),
  (9908004, '2026-06-12 18:00+00', 'Zm Park', 'bbbbbbbb-0000-0000-0000-000000000801', 4);

insert into public.round_incident_status (subsession_id, posted, posted_at) values
  (9908001, true, now() - interval '1 hour'),
  (9908002, true, now() - interval '48 hours'),
  (9908003, false, null);

insert into public.incident_reports (id, subsession_id, session, lap, turn, description, status) values
  ('aaaaaaaa-0000-0000-0000-000000000801', 9908003, 'race:1', 4, '3', 'Contact at <script>alert(1)</script> "T3"', 'open'),
  ('aaaaaaaa-0000-0000-0000-000000000802', 9908004, 'race:2', 7, '10b', null, 'logged'),
  ('aaaaaaaa-0000-0000-0000-000000000803', 9908003, 'race:1', 9, '1', 'Dismissed one', 'dismissed'),
  ('aaaaaaaa-0000-0000-0000-000000000804', 9908001, 'race:1', 2, '5', 'Posted round', 'open');
insert into public.incident_report_drivers (report_id, driver_id) values
  ('aaaaaaaa-0000-0000-0000-000000000801', '99999999-0000-0000-0000-000000000801'),
  ('aaaaaaaa-0000-0000-0000-000000000801', '99999999-0000-0000-0000-000000000802'),
  ('aaaaaaaa-0000-0000-0000-000000000801', '99999999-0000-0000-0000-000000000804'),
  ('aaaaaaaa-0000-0000-0000-000000000802', '99999999-0000-0000-0000-000000000801'),
  ('aaaaaaaa-0000-0000-0000-000000000802', '99999999-0000-0000-0000-000000000803'),
  ('aaaaaaaa-0000-0000-0000-000000000803', '99999999-0000-0000-0000-000000000801'),
  ('aaaaaaaa-0000-0000-0000-000000000804', '99999999-0000-0000-0000-000000000801');

insert into public.penalties (id, subsession_id, race_number, driver_id, lap, description, penalty_points,
                              time_penalty_seconds, points_penalty) values
  ('cccccccc-0000-0000-0000-000000000801', 9908001, 1, '99999999-0000-0000-0000-000000000801', 5, 'P1', 3, 5, 0),
  ('cccccccc-0000-0000-0000-000000000802', 9908002, 1, '99999999-0000-0000-0000-000000000801', 3, 'P2', 2, null, 0),
  ('cccccccc-0000-0000-0000-000000000803', 9908002, 1, '99999999-0000-0000-0000-000000000802', 8, 'P3', 2, null, 0),
  ('cccccccc-0000-0000-0000-000000000804', 9908001, 1, '99999999-0000-0000-0000-000000000803', 6, 'P4', 1, null, 0),
  ('cccccccc-0000-0000-0000-000000000805', 9908001, 1, null, 9, 'P5', 0, null, 0);
insert into public.penalty_involved_drivers (penalty_id, driver_id) values
  ('cccccccc-0000-0000-0000-000000000801', '99999999-0000-0000-0000-000000000802'),
  ('cccccccc-0000-0000-0000-000000000803', '99999999-0000-0000-0000-000000000801'),
  ('cccccccc-0000-0000-0000-000000000805', '99999999-0000-0000-0000-000000000801'),
  ('cccccccc-0000-0000-0000-000000000805', '99999999-0000-0000-0000-000000000803');

insert into public.incident_appeals (id, subsession_id, penalty_id, message, submitter_id, status) values
  ('dddddddd-0000-0000-0000-000000000801', 9908002, 'cccccccc-0000-0000-0000-000000000803', 'Not me',
   'eeeeeeee-0000-0000-0000-000000000803', 'dismissed');

insert into public.account_settings (profile_id, notify_appeal_reviewed) values
  ('eeeeeeee-0000-0000-0000-000000000803', true);

insert into incident_fixture.names (id, label) values
  ('aaaaaaaa-0000-0000-0000-000000000801', 'R1'), ('aaaaaaaa-0000-0000-0000-000000000802', 'R2'),
  ('aaaaaaaa-0000-0000-0000-000000000803', 'R3'), ('aaaaaaaa-0000-0000-0000-000000000804', 'R4'),
  ('cccccccc-0000-0000-0000-000000000801', 'P1'), ('cccccccc-0000-0000-0000-000000000802', 'P2'),
  ('cccccccc-0000-0000-0000-000000000803', 'P3'), ('cccccccc-0000-0000-0000-000000000804', 'P4'),
  ('cccccccc-0000-0000-0000-000000000805', 'P5');

savepoint fixture;

-- M01 Grants: the comments table is closed except select and delete for authenticated; the new functions
--     are definers with an empty search_path for authenticated only; the helpers are closed to everyone;
--     the replaced appeal function keeps its search_path and grants (NFR1.1-NFR1.5) ----------------------
do $$
declare
  v_fn record;
  v_found integer := 0;
begin
  perform incident_fixture.expect('M01 row level security',
    (select c.relrowsecurity from pg_class c where c.oid = 'public.driver_incident_comments'::regclass), true);
  perform incident_fixture.expect('M01 anon table privileges',
    has_table_privilege('anon', 'public.driver_incident_comments', 'select, insert, update, delete'), false);
  perform incident_fixture.expect('M01 authenticated select and delete',
    has_table_privilege('authenticated', 'public.driver_incident_comments', 'select')
    and has_table_privilege('authenticated', 'public.driver_incident_comments', 'delete'), true);
  perform incident_fixture.expect('M01 authenticated insert or update',
    has_table_privilege('authenticated', 'public.driver_incident_comments', 'insert, update'), false);

  for v_fn in
    select p.oid, p.proname, p.prosecdef, p.proconfig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any (array['my_incidents', 'add_my_incident_comment', 'can_appeal_penalty'])
  loop
    v_found := v_found + 1;
    perform incident_fixture.expect('M01 ' || v_fn.proname || ' anon execute',
      has_function_privilege('anon', v_fn.oid, 'execute'), false);
    perform incident_fixture.expect('M01 ' || v_fn.proname || ' authenticated execute',
      has_function_privilege('authenticated', v_fn.oid, 'execute'), true);
    perform incident_fixture.expect('M01 ' || v_fn.proname || ' security definer', v_fn.prosecdef, true);
    perform incident_fixture.expect('M01 ' || v_fn.proname || ' empty search_path',
      'search_path=""' = any (v_fn.proconfig), true);
  end loop;
  perform incident_fixture.expect('M01 every public function exists', v_found, 3);

  for v_fn in
    select p.oid, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = any (array['appeal_window_closes_at', 'caller_driver_id', 'is_penalty_party'])
  loop
    perform incident_fixture.expect('M01 ' || v_fn.proname || ' closed',
      has_function_privilege('anon', v_fn.oid, 'execute') or has_function_privilege('authenticated', v_fn.oid, 'execute')
      or has_function_privilege('service_role', v_fn.oid, 'execute'), false);
  end loop;

  perform incident_fixture.expect('M01 appeal search_path',
    (select 'search_path=public' = any (p.proconfig) from pg_proc p
     where p.oid = 'public.submit_incident_appeal(uuid, uuid, text, jsonb)'::regprocedure), true);
  perform incident_fixture.expect('M01 appeal grants',
    concat_ws(',',
      has_function_privilege('anon', 'public.submit_incident_appeal(uuid, uuid, text, jsonb)', 'execute')::text,
      has_function_privilege('authenticated', 'public.submit_incident_appeal(uuid, uuid, text, jsonb)', 'execute')::text,
      has_function_privilege('service_role', 'public.submit_incident_appeal(uuid, uuid, text, jsonb)', 'execute')::text),
    'false,true,true');
  raise notice 'ok M01 grants';
end $$;
rollback to savepoint fixture;

-- M02 Ana comments on R1 once; her list then shows it as sent (BR11.5, BR11.6) ---------------------------
do $$
declare
  v_id text;
begin
  perform incident_fixture.expect('M02 not sent yet',
    incident_fixture.field('eeeeeeee-0000-0000-0000-000000000803', 'aaaaaaaa-0000-0000-0000-000000000801', 'm.my_comment_exists'),
    'false');
  v_id := incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000803',
    $q$select public.add_my_incident_comment('aaaaaaaa-0000-0000-0000-000000000801', '  I braked early <b>"really"</b>  ')$q$);
  perform incident_fixture.expect('M02 stored trimmed, for Ana''s driver',
    (select concat_ws('|', c.body, c.driver_id::text, c.author_id::text) from public.driver_incident_comments c where c.id = v_id::uuid),
    'I braked early <b>"really"</b>|99999999-0000-0000-0000-000000000801|eeeeeeee-0000-0000-0000-000000000803');
  perform incident_fixture.expect('M02 sent',
    incident_fixture.field('eeeeeeee-0000-0000-0000-000000000803', 'aaaaaaaa-0000-0000-0000-000000000801', 'm.my_comment_exists'),
    'true');
  raise notice 'ok M02 comment';
end $$;
rollback to savepoint fixture;

-- M03 Every comment refusal, with nothing written (BR11.6; NFR1.2) -------------------------------------
do $$
declare
  v_ana text := 'eeeeeeee-0000-0000-0000-000000000803';
begin
  perform incident_fixture.exec_as(v_ana,
    $q$select public.add_my_incident_comment('aaaaaaaa-0000-0000-0000-000000000801', 'First')$q$);
  perform incident_fixture.expect('M03 second comment', incident_fixture.code_as(v_ana,
    $q$select public.add_my_incident_comment('aaaaaaaa-0000-0000-0000-000000000801', 'Second')$q$), 'ALREADY_COMMENTED');
  perform incident_fixture.expect('M03 dismissed report', incident_fixture.code_as(v_ana,
    $q$select public.add_my_incident_comment('aaaaaaaa-0000-0000-0000-000000000803', 'Late')$q$), 'CLOSED');
  perform incident_fixture.expect('M03 posted round', incident_fixture.code_as(v_ana,
    $q$select public.add_my_incident_comment('aaaaaaaa-0000-0000-0000-000000000804', 'Late')$q$), 'CLOSED');
  perform incident_fixture.expect('M03 not named', incident_fixture.code_as('eeeeeeee-0000-0000-0000-000000000805',
    $q$select public.add_my_incident_comment('aaaaaaaa-0000-0000-0000-000000000801', 'Me too')$q$), 'NOT_INVOLVED');
  perform incident_fixture.expect('M03 unlinked account', incident_fixture.code_as('eeeeeeee-0000-0000-0000-000000000806',
    $q$select public.add_my_incident_comment('aaaaaaaa-0000-0000-0000-000000000801', 'Hi')$q$), 'NOT_INVOLVED');
  perform incident_fixture.expect('M03 unknown report', incident_fixture.code_as(v_ana,
    $q$select public.add_my_incident_comment(gen_random_uuid(), 'Hi')$q$), 'NOT_INVOLVED');
  perform incident_fixture.expect('M03 blank body', incident_fixture.code_as(v_ana,
    $q$select public.add_my_incident_comment('aaaaaaaa-0000-0000-0000-000000000802', '   ')$q$), 'INVALID');
  perform incident_fixture.expect('M03 over 2000 characters', incident_fixture.code_as(v_ana,
    $q$select public.add_my_incident_comment('aaaaaaaa-0000-0000-0000-000000000802', repeat('x', 2001))$q$), 'INVALID');
  perform incident_fixture.expect('M03 2000 characters fit', incident_fixture.code_as(v_ana,
    $q$select public.add_my_incident_comment('aaaaaaaa-0000-0000-0000-000000000802', repeat('x', 2000))$q$), 'ok');
  perform incident_fixture.expect('M03 anon', incident_fixture.state_as('anon',
    $q$select public.add_my_incident_comment('aaaaaaaa-0000-0000-0000-000000000801', 'Hi')$q$), '42501');
  perform incident_fixture.expect('M03 only the two good comments',
    (select count(*)::int from public.driver_incident_comments), 2);
  raise notice 'ok M03 comment refusals';
end $$;
rollback to savepoint fixture;

-- M04 Who reads comments: the author, uninvolved admins; not another driver, an involved admin or anon
--     (BR11.7; NFR1.1) -------------------------------------------------------------------------------
do $$
declare
  v_count text := 'select count(*) from public.driver_incident_comments';
begin
  perform incident_fixture.exec_as('eeeeeeee-0000-0000-0000-000000000803',
    $q$select public.add_my_incident_comment('aaaaaaaa-0000-0000-0000-000000000801', 'Ana says')$q$);
  perform incident_fixture.exec_as('eeeeeeee-0000-0000-0000-000000000804',
    $q$select public.add_my_incident_comment('aaaaaaaa-0000-0000-0000-000000000801', 'Ben says')$q$);
  perform incident_fixture.expect('M04 author reads own',
    incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000803', $q$select string_agg(body, ',') from public.driver_incident_comments$q$),
    'Ana says');
  perform incident_fixture.expect('M04 other driver', incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000805', v_count), '0');
  perform incident_fixture.expect('M04 involved admin', incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000801', v_count), '0');
  perform incident_fixture.expect('M04 uninvolved admin', incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000802', v_count), '2');
  perform incident_fixture.expect('M04 anon', incident_fixture.state_as('anon', v_count), '42501');
  raise notice 'ok M04 comment readers';
end $$;
rollback to savepoint fixture;

-- M05 Direct writes: a driver cannot insert, edit or delete; an admin can delete; deleting a report removes
--     its comments (NFR1.1 amended) -------------------------------------------------------------------
do $$
declare
  v_ana text := 'eeeeeeee-0000-0000-0000-000000000803';
begin
  perform incident_fixture.exec_as(v_ana,
    $q$select public.add_my_incident_comment('aaaaaaaa-0000-0000-0000-000000000801', 'Final')$q$);
  perform incident_fixture.expect('M05 driver insert', incident_fixture.state_as(v_ana,
    $q$insert into public.driver_incident_comments (report_id, driver_id, author_id, body)
       values ('aaaaaaaa-0000-0000-0000-000000000802', '99999999-0000-0000-0000-000000000801', 'eeeeeeee-0000-0000-0000-000000000803', 'x')$q$),
    '42501');
  perform incident_fixture.expect('M05 driver update', incident_fixture.state_as(v_ana,
    $q$update public.driver_incident_comments set body = 'Edited'$q$), '42501');
  perform incident_fixture.exec_as(v_ana, $q$delete from public.driver_incident_comments$q$);
  perform incident_fixture.expect('M05 driver delete removes nothing',
    (select string_agg(body, ',') from public.driver_incident_comments), 'Final');
  perform incident_fixture.exec_as('eeeeeeee-0000-0000-0000-000000000802', $q$delete from public.driver_incident_comments$q$);
  perform incident_fixture.expect('M05 admin delete', (select count(*)::int from public.driver_incident_comments), 0);

  perform incident_fixture.exec_as(v_ana,
    $q$select public.add_my_incident_comment('aaaaaaaa-0000-0000-0000-000000000801', 'Again')$q$);
  delete from public.incident_reports where id = 'aaaaaaaa-0000-0000-0000-000000000801';
  perform incident_fixture.expect('M05 cascade', (select count(*)::int from public.driver_incident_comments), 0);
  raise notice 'ok M05 writes and cascade';
end $$;
rollback to savepoint fixture;

-- M06 Each driver gets only their own rows: pending reports in unposted rounds (status row false or none),
--     then posted penalties in the window or appealed, newest first (BR11.1-BR11.4; NFR1.3) --------------
do $$
begin
  perform incident_fixture.expect('M06 Ana', incident_fixture.list('eeeeeeee-0000-0000-0000-000000000803'), 'R2,R1,P5,P1,P3');
  perform incident_fixture.expect('M06 Ben', incident_fixture.list('eeeeeeee-0000-0000-0000-000000000804'), 'R1,P1');
  perform incident_fixture.expect('M06 Cyd', incident_fixture.list('eeeeeeee-0000-0000-0000-000000000805'), 'R2,P5,P4');
  perform incident_fixture.expect('M06 unlinked', incident_fixture.list('eeeeeeee-0000-0000-0000-000000000806'), '');
  perform incident_fixture.expect('M06 unlinked admin', incident_fixture.list('eeeeeeee-0000-0000-0000-000000000802'), '');
  perform incident_fixture.expect('M06 anon', incident_fixture.state_as('anon', 'select count(*) from public.my_incidents()'), '42501');
  raise notice 'ok M06 isolation and listing';
end $$;
rollback to savepoint fixture;

-- M07 Row fields: cars only, the round label, the raw description, the window and appeal state; never the
--     reporter (BR11.4, BR11.18) ---------------------------------------------------------------------
do $$
declare
  v_ana text := 'eeeeeeee-0000-0000-0000-000000000803';
begin
  perform incident_fixture.expect('M07 R1', incident_fixture.field(v_ana, 'aaaaaaaa-0000-0000-0000-000000000801',
    $q$concat_ws('|', m.kind, m.round_label, m.session, m.lap::text, m.turn, m.description, coalesce(m.penalized_car, '-'),
                 array_to_string(m.involved_cars, ' '), m.my_appeal_status, m.i_am_penalized::text)$q$),
    'pending_report|Zm Season · Round 3 · Zm Park|race:1|4|3|Contact at <script>alert(1)</script> "T3"|-|882 884|none|false');
  perform incident_fixture.expect('M07 P1', incident_fixture.field(v_ana, 'cccccccc-0000-0000-0000-000000000801',
    $q$concat_ws('|', m.kind, m.penalized_car, array_to_string(m.involved_cars, ' '), m.i_am_penalized::text,
                 m.my_appeal_status, (m.appeal_window_closes_at = now() + interval '23 hours')::text,
                 m.points_before::text, m.points_after::text)$q$),
    'posted_penalty|881|882|true|none|true|3|3');
  perform incident_fixture.expect('M07 P5 racing incident', incident_fixture.field(v_ana, 'cccccccc-0000-0000-0000-000000000805',
    $q$concat_ws('|', coalesce(m.penalized_car, '-'), array_to_string(m.involved_cars, ' '), m.i_am_penalized::text)$q$),
    '-|881 883|false');
  perform incident_fixture.expect('M07 P3 dismissed appeal stays', incident_fixture.field(v_ana, 'cccccccc-0000-0000-0000-000000000803',
    $q$concat_ws('|', m.my_appeal_status, m.i_am_penalized::text)$q$), 'dismissed|false');
  perform incident_fixture.expect('M07 no reporter column',
    (select count(*)::int from pg_proc p, unnest(p.proargnames) a
     where p.oid = 'public.my_incidents()'::regprocedure and a like 'reporter%'), 0);
  raise notice 'ok M07 row fields';
end $$;
rollback to savepoint fixture;

-- M08 Posting round 9908003 drops its pending reports from the list (Q1 A) ------------------------------
do $$
begin
  update public.round_incident_status set posted = true, posted_at = now() where subsession_id = 9908003;
  perform incident_fixture.expect('M08 Ana', incident_fixture.list('eeeeeeee-0000-0000-0000-000000000803'), 'R2,P5,P1,P3');
  perform incident_fixture.expect('M08 Ben', incident_fixture.list('eeeeeeee-0000-0000-0000-000000000804'), 'P1');
  raise notice 'ok M08 posted round';
end $$;
rollback to savepoint fixture;

-- M09 The window: the setting in hours, default 24 when it is missing or malformed; a closed window drops an
--     unappealed penalty (BR11.3 amended) ------------------------------------------------------------
do $$
declare
  v_ana text := 'eeeeeeee-0000-0000-0000-000000000803';
begin
  delete from public.site_settings where setting_key = 'incident_appeal_period_hours';
  perform incident_fixture.expect('M09 default 24 hours', incident_fixture.field(v_ana, 'cccccccc-0000-0000-0000-000000000801',
    $q$(m.appeal_window_closes_at = now() + interval '23 hours')$q$), 'true');
  insert into public.site_settings (setting_key, value) values ('incident_appeal_period_hours', 'abc');
  perform incident_fixture.expect('M09 malformed means 24', incident_fixture.field(v_ana, 'cccccccc-0000-0000-0000-000000000801',
    $q$(m.appeal_window_closes_at = now() + interval '23 hours')$q$), 'true');
  update public.site_settings set value = '72' where setting_key = 'incident_appeal_period_hours';
  perform incident_fixture.expect('M09 72 hours reopens P2', incident_fixture.list(v_ana), 'R2,R1,P5,P1,P3,P2');
  update public.site_settings set value = '0' where setting_key = 'incident_appeal_period_hours';
  perform incident_fixture.expect('M09 zero hours closes P1 and P5', incident_fixture.list(v_ana), 'R2,R1,P3');
  raise notice 'ok M09 window';
end $$;
rollback to savepoint fixture;

-- M10 The points difference uses effectivePenaltyPoints' formula; a time-only change is flagged (BR11.11) -
do $$
declare
  v_ana text := 'eeeeeeee-0000-0000-0000-000000000803';
  v_cols text := $q$concat_ws('|', m.points_before::text, m.points_after::text, m.time_or_points_changed::text)$q$;
begin
  update public.penalties set is_appealed = true, appeal_penalty_points = 1, appeal_time_penalty_seconds = 5
  where id = 'cccccccc-0000-0000-0000-000000000801';
  perform incident_fixture.expect('M10 reduced', incident_fixture.field(v_ana, 'cccccccc-0000-0000-0000-000000000801', v_cols), '3|1|false');
  update public.penalties set appeal_penalty_points = 3, appeal_time_penalty_seconds = null
  where id = 'cccccccc-0000-0000-0000-000000000801';
  perform incident_fixture.expect('M10 time only', incident_fixture.field(v_ana, 'cccccccc-0000-0000-0000-000000000801', v_cols), '3|3|true');
  update public.penalties set is_appealed = false, appeal_penalty_points = 0 where id = 'cccccccc-0000-0000-0000-000000000801';
  perform incident_fixture.expect('M10 not appealed', incident_fixture.field(v_ana, 'cccccccc-0000-0000-0000-000000000801', v_cols), '3|3|false');
  raise notice 'ok M10 points difference';
end $$;
rollback to savepoint fixture;

-- M11 Volume: 50 posted rounds and 500 penalties; Ana gets her 200 newest rows and only hers, in under
--     50 ms (NFR3.2, NFR3.4) ------------------------------------------------------------------------
do $$
declare
  v_ana text := 'eeeeeeee-0000-0000-0000-000000000803';
  v_started timestamptz;
  v_best interval := interval '1 hour';
  v_count text;
begin
  insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, round_number)
  select 9909000 + g, now() - make_interval(hours => g), 'Zm Volume', 'bbbbbbbb-0000-0000-0000-000000000801', 10 + g
  from generate_series(1, 50) g;
  insert into public.round_incident_status (subsession_id, posted, posted_at)
  select 9909000 + g, true, now() - interval '30 minutes' from generate_series(1, 50) g;
  -- Half Ana's, half Ben's.
  insert into public.penalties (subsession_id, race_number, driver_id, lap, penalty_points)
  select 9909000 + 1 + (g % 50), 1,
         case when g % 2 = 0 then '99999999-0000-0000-0000-000000000801'::uuid else '99999999-0000-0000-0000-000000000802'::uuid end,
         g, 1
  from generate_series(1, 500) g;

  v_count := incident_fixture.text_as(v_ana, 'select count(*) from public.my_incidents()');
  perform incident_fixture.expect('M11 capped at 200', v_count, '200');
  perform incident_fixture.expect('M11 only Ana''s rows', incident_fixture.text_as(v_ana,
    $q$select count(*) from public.my_incidents() m
       where m.kind = 'posted_penalty'
         and not exists (select 1 from incident_fixture.names n where n.id = m.id)
         and not m.i_am_penalized$q$), '0');
  perform incident_fixture.expect('M11 newest first', incident_fixture.text_as(v_ana,
    $q$select (min(m.occurred_at) >= now() - interval '50 hours')::text from public.my_incidents() m$q$), 'true');

  for i in 1..3 loop
    perform incident_fixture.act_as(v_ana);
    v_started := clock_timestamp();
    perform count(*) from public.my_incidents();
    v_best := least(v_best, clock_timestamp() - v_started);
    perform incident_fixture.as_owner();
  end loop;
  raise notice 'M11 my_incidents() best of 3 at 500 penalties: %', v_best;
  perform incident_fixture.expect('M11 under 50 ms', v_best < interval '50 milliseconds', true);
  raise notice 'ok M11 volume';
end $$;
rollback to savepoint fixture;

-- M12 can_appeal_penalty: involved and penalized drivers may; others, closed windows and unknown ids may not
--     (BR11.9; NFR1.5) ------------------------------------------------------------------------------
do $$
begin
  perform incident_fixture.expect('M12 penalized', incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000803',
    $q$select public.can_appeal_penalty('cccccccc-0000-0000-0000-000000000801')$q$), 'ok');
  perform incident_fixture.expect('M12 involved', incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000804',
    $q$select public.can_appeal_penalty('cccccccc-0000-0000-0000-000000000801')$q$), 'ok');
  perform incident_fixture.expect('M12 racing incident involved', incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000805',
    $q$select public.can_appeal_penalty('cccccccc-0000-0000-0000-000000000805')$q$), 'ok');
  perform incident_fixture.expect('M12 uninvolved driver', incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000805',
    $q$select public.can_appeal_penalty('cccccccc-0000-0000-0000-000000000801')$q$), 'NOT_INVOLVED');
  perform incident_fixture.expect('M12 uninvolved admin', incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000802',
    $q$select public.can_appeal_penalty('cccccccc-0000-0000-0000-000000000801')$q$), 'NOT_INVOLVED');
  perform incident_fixture.expect('M12 closed', incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000803',
    $q$select public.can_appeal_penalty('cccccccc-0000-0000-0000-000000000802')$q$), 'CLOSED');
  perform incident_fixture.expect('M12 unknown', incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000803',
    $q$select public.can_appeal_penalty(gen_random_uuid())$q$), 'UNKNOWN');
  perform incident_fixture.expect('M12 anon', incident_fixture.state_as('anon',
    $q$select public.can_appeal_penalty('cccccccc-0000-0000-0000-000000000801')$q$), '42501');
  raise notice 'ok M12 pre-check';
end $$;
rollback to savepoint fixture;

-- M13 submit_incident_appeal through the round page's call shape: penalized and involved drivers succeed,
--     once each; others and closed windows are refused with codes (BR11.9; NFR1.4) ------------------------
do $$
declare
  v_ana text := 'eeeeeeee-0000-0000-0000-000000000803';
begin
  perform incident_fixture.expect('M13 penalized', incident_fixture.code_as(v_ana,
    incident_fixture.appeal_sql('cccccccc-0000-0000-0000-000000000801')), 'ok');
  perform incident_fixture.expect('M13 second appeal', incident_fixture.code_as(v_ana,
    incident_fixture.appeal_sql('cccccccc-0000-0000-0000-000000000801')), 'ALREADY_APPEALED');
  perform incident_fixture.expect('M13 pre-check agrees', incident_fixture.text_as(v_ana,
    $q$select public.can_appeal_penalty('cccccccc-0000-0000-0000-000000000801')$q$), 'ALREADY_APPEALED');
  perform incident_fixture.expect('M13 involved', incident_fixture.code_as('eeeeeeee-0000-0000-0000-000000000804',
    incident_fixture.appeal_sql('cccccccc-0000-0000-0000-000000000801')), 'ok');
  perform incident_fixture.expect('M13 uninvolved', incident_fixture.code_as('eeeeeeee-0000-0000-0000-000000000805',
    incident_fixture.appeal_sql('cccccccc-0000-0000-0000-000000000801')), 'NOT_INVOLVED');
  perform incident_fixture.expect('M13 closed', incident_fixture.code_as(v_ana,
    incident_fixture.appeal_sql('cccccccc-0000-0000-0000-000000000802')), 'CLOSED');
  perform incident_fixture.expect('M13 the old checks stay', incident_fixture.code_as(v_ana,
    $q$select public.submit_incident_appeal(gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000805', '   ', '[]'::jsonb)$q$),
    'invalid message');
  perform incident_fixture.expect('M13 rows written',
    (select string_agg(a.submitter_id::text || '/' || a.status || '/' || a.submitter_name, ',' order by a.submitter_name)
     from public.incident_appeals a where a.penalty_id = 'cccccccc-0000-0000-0000-000000000801'),
    'eeeeeeee-0000-0000-0000-000000000803/open/Ana Mine,eeeeeeee-0000-0000-0000-000000000804/open/Ben Other');
  perform incident_fixture.expect('M13 list shows appealed', incident_fixture.field(v_ana, 'cccccccc-0000-0000-0000-000000000801',
    'm.my_appeal_status'), 'open');
  raise notice 'ok M13 appeal rules';
end $$;
rollback to savepoint fixture;

-- M14 Legacy duplicates (two appeals by one account from the old limit) are left alone; the newest one's
--     status shows, and a further appeal is refused (BR11.17 amended) ---------------------------------------
do $$
declare
  v_ana text := 'eeeeeeee-0000-0000-0000-000000000803';
begin
  insert into public.incident_appeals (id, subsession_id, penalty_id, message, submitter_id, status, created_at) values
    ('dddddddd-0000-0000-0000-000000000811', 9908001, 'cccccccc-0000-0000-0000-000000000801', 'Old', v_ana::uuid, 'reviewed', now() - interval '20 minutes'),
    ('dddddddd-0000-0000-0000-000000000812', 9908001, 'cccccccc-0000-0000-0000-000000000801', 'Newer', v_ana::uuid, 'open', now() - interval '10 minutes');
  perform incident_fixture.expect('M14 newest status', incident_fixture.field(v_ana, 'cccccccc-0000-0000-0000-000000000801',
    'm.my_appeal_status'), 'open');
  perform incident_fixture.expect('M14 refused', incident_fixture.code_as(v_ana,
    incident_fixture.appeal_sql('cccccccc-0000-0000-0000-000000000801')), 'ALREADY_APPEALED');
  perform incident_fixture.expect('M14 both kept',
    (select count(*)::int from public.incident_appeals where penalty_id = 'cccccccc-0000-0000-0000-000000000801'), 2);
  raise notice 'ok M14 legacy duplicates';
end $$;
rollback to savepoint fixture;

-- M15 A driver reads their own appeals, and nobody else's (BR11.16; NFR1.6) -----------------------------
do $$
begin
  perform incident_fixture.exec_as('eeeeeeee-0000-0000-0000-000000000804',
    incident_fixture.appeal_sql('cccccccc-0000-0000-0000-000000000801'));
  perform incident_fixture.expect('M15 Ana reads hers', incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000803',
    $q$select string_agg(id::text || '/' || status, ',') from public.incident_appeals$q$),
    'dddddddd-0000-0000-0000-000000000801/dismissed');
  perform incident_fixture.expect('M15 Ben reads only his', incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000804',
    $q$select string_agg(submitter_id::text, ',') from public.incident_appeals$q$), 'eeeeeeee-0000-0000-0000-000000000804');
  perform incident_fixture.expect('M15 Cyd reads none', incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000805',
    'select count(*) from public.incident_appeals'), '0');
  perform incident_fixture.expect('M15 driver cannot change status', incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000803',
    $q$with u as (update public.incident_appeals set status = 'reviewed' returning 1) select count(*) from u$q$), '0');
  perform incident_fixture.expect('M15 admin still reads all', incident_fixture.text_as('eeeeeeee-0000-0000-0000-000000000802',
    'select count(*) from public.incident_appeals'), '2');
  raise notice 'ok M15 own appeals';
end $$;
rollback to savepoint fixture;

-- M16 A reviewed appeal still queues U7's email, and the row then reads as reviewed (BR11.15; C7) -------
do $$
declare
  v_ana text := 'eeeeeeee-0000-0000-0000-000000000803';
begin
  perform incident_fixture.exec_as(v_ana, incident_fixture.appeal_sql('cccccccc-0000-0000-0000-000000000801'));
  perform incident_fixture.exec_as('eeeeeeee-0000-0000-0000-000000000802',
    $q$update public.incident_appeals set status = 'reviewed' where penalty_id = 'cccccccc-0000-0000-0000-000000000801'$q$);
  perform incident_fixture.expect('M16 email queued',
    (select count(*)::int from public.email_outbox o where o.kind = 'appeal_reviewed' and o.profile_id = v_ana::uuid), 1);
  perform incident_fixture.expect('M16 list status', incident_fixture.field(v_ana, 'cccccccc-0000-0000-0000-000000000801',
    'm.my_appeal_status'), 'reviewed');
  raise notice 'ok M16 reviewed trigger';
end $$;
rollback to savepoint fixture;

-- M17 An appealed penalty stays listed after its window closes (BR11.3 amended) ------------------------
do $$
declare
  v_ana text := 'eeeeeeee-0000-0000-0000-000000000803';
begin
  perform incident_fixture.exec_as(v_ana, incident_fixture.appeal_sql('cccccccc-0000-0000-0000-000000000801'));
  update public.round_incident_status set posted_at = now() - interval '30 hours' where subsession_id = 9908001;
  perform incident_fixture.expect('M17 Ana keeps P1, loses P5', incident_fixture.list(v_ana), 'R2,R1,P1,P3');
  perform incident_fixture.expect('M17 Ben loses P1', incident_fixture.list('eeeeeeee-0000-0000-0000-000000000804'), 'R1');
  raise notice 'ok M17 appealed after the window';
end $$;
rollback to savepoint fixture;

-- M18 Unposting a round hides its penalties again, appealed or not (penalties_shown agrees) --------------
do $$
declare
  v_ana text := 'eeeeeeee-0000-0000-0000-000000000803';
begin
  perform incident_fixture.exec_as(v_ana, incident_fixture.appeal_sql('cccccccc-0000-0000-0000-000000000801'));
  update public.round_incident_status set posted = false, posted_at = null where subsession_id = 9908001;
  perform incident_fixture.expect('M18 Ana', incident_fixture.list(v_ana), 'R2,R1,R4,P3');
  raise notice 'ok M18 unposted round';
end $$;
rollback to savepoint fixture;

rollback;
