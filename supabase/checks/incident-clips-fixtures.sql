-- Incident clips and ordering fixtures for 20261111120000_incident_clips_and_ordering.sql
-- (incident-clips-and-ordering), cases K01-K08: the shared report order and numbers (sessions in event order,
-- laps, natural turn order, dismissed reports unnumbered) and that the public list matches it; the admin order
-- refused to anon and drivers; re-posting with Reset or Keep, unposting keeping the date, first_posted_at never
-- moving and no second "Incident Report Posted" email; report and incident clips (who may set them, the URL
-- check, empty clears, every row of an incident, no unnumbered incidents); turn and clip in penalties_shown
-- exactly when the round is posted; and the new functions' definer settings and grants.
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- incident-submissions-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/incident-clips-fixtures.sql
--
-- Same conventions as incident-submissions-fixtures.sql (supabase/checks/README.md): every assertion calls
-- clips_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each case
-- runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`.
--
-- Round 9912001 (unposted): reports labelled A-I by their description (see K01). Round 9912002 (posted on
-- 2026-05-01): report P1 and penalties for incidents 7 (two rows), 8 and one unnumbered row. Round 9912003:
-- no status row.

begin;

set local client_min_messages = notice;

create schema clips_fixture;

create function clips_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'incident clips fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Runs p_sql as p_who ('anon' or an account id) and returns its first value as text, 'ok' when it returns
-- nothing, the code before the first ':' for a P0001 error ('INVALID_URL: ...' -> 'INVALID_URL') or the
-- SQLSTATE for any other error (42501 for a refusal).
create function clips_fixture.run_as(p_who text, p_sql text) returns text
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
  begin
    execute p_sql into v;
    v := coalesce(v, 'ok');
  exception when others then
    v := case when sqlstate = 'P0001' then split_part(sqlerrm, ':', 1) else sqlstate end;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return v;
end;
$$;

-- The SQLSTATE p_sql fails with as the table owner, or 'ok'.
create function clips_fixture.error_state(p_sql text) returns text
  language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

grant usage on schema clips_fixture to anon, authenticated;
grant execute on all functions in schema clips_fixture to anon, authenticated;

-- Base data ------------------------------------------------------------------------------------

update public.scoring_settings set triggers_enabled = false;

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (921, 'Active')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select 921, 'Alpha', 1 where not exists (select 1 from public.driver_classes where name = 'Alpha');

insert into public.drivers (id, name, car_number, status_id, class_id, is_ai) values
  ('99999999-0000-0000-0000-000000000921', 'Kit Clip', 921,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false),
  ('99999999-0000-0000-0000-000000000922', 'Lou Clip', 922,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false);

-- The auth.users insert creates a 'driver' profile; the admin and staff ones are re-inserted, because as
-- postgres the profiles guard refuses a role change.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000921', 'clips-admin@example.test', now(), '{"display_name":"Clip Admin"}'),
  ('eeeeeeee-0000-0000-0000-000000000922', 'clips-staff@example.test', now(), '{"display_name":"Clip Staff"}'),
  ('eeeeeeee-0000-0000-0000-000000000923', 'clips-driver@example.test', now(), '{"display_name":"Kit Clip"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000000921', 'eeeeeeee-0000-0000-0000-000000000922',
  'eeeeeeee-0000-0000-0000-000000000923');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000921', 'admin', 'Clip Admin', null),
  ('eeeeeeee-0000-0000-0000-000000000922', 'staff', 'Clip Staff', null),
  ('eeeeeeee-0000-0000-0000-000000000923', 'driver', 'Kit Clip', '99999999-0000-0000-0000-000000000921');

insert into public.curated_rounds (subsession_id, start_time, track_name) values
  (9912001, '2026-06-10 18:00+00', 'Zk Park'),
  (9912002, '2026-05-01 18:00+00', 'Zk Park'),
  (9912003, '2026-06-17 18:00+00', 'Zk Park');

insert into public.round_incident_status (subsession_id, posted, posted_at) values
  (9912001, false, null),
  (9912002, true, '2026-05-01 20:00+00');

-- Submission times run against the event order, so a time-ordered list would come out wrong.
insert into public.incident_reports (id, subsession_id, session, lap, turn, description, status, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000000921', 9912001, 'race:1', 2, '10', 'A', 'open', now() - interval '6 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000922', 9912001, 'race:1', 2, '3', 'B', 'open', now() - interval '5 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000923', 9912001, 'race:1', 2, '10b', 'C', 'logged', now() - interval '4 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000924', 9912001, 'race:1', 2, 'T4', 'D', 'open', now() - interval '3 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000925', 9912001, 'race:1', 2, 'back straight', 'E', 'open', now() - interval '2 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000926', 9912001, 'practice:0', 5, '1', 'F', 'open', now() - interval '1 hour'),
  ('aaaaaaaa-0000-0000-0000-000000000927', 9912001, 'qualifying:0', 1, '2', 'G', 'dismissed', now() - interval '7 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000928', 9912001, 'race:2', 1, '1', 'H', 'open', now() - interval '8 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000929', 9912001, 'race:1', 1, 'Turn 12', 'I', 'open', now() - interval '9 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000930', 9912002, 'race:1', 3, '5', 'P1', 'logged', now() - interval '10 days');
insert into public.incident_report_drivers (report_id, driver_id) values
  ('aaaaaaaa-0000-0000-0000-000000000922', '99999999-0000-0000-0000-000000000921'),
  ('aaaaaaaa-0000-0000-0000-000000000922', '99999999-0000-0000-0000-000000000922');

insert into public.penalties (id, subsession_id, race_number, session_type, driver_id, incident_number, lap, turn,
                              description, penalty_points) values
  ('cccccccc-0000-0000-0000-000000000921', 9912002, 1, 'race', '99999999-0000-0000-0000-000000000921', '7', 3, 'T4', 'K7a', 1),
  ('cccccccc-0000-0000-0000-000000000922', 9912002, 1, 'race', '99999999-0000-0000-0000-000000000922', '7', 3, 'T4', 'K7b', 0),
  ('cccccccc-0000-0000-0000-000000000923', 9912002, 1, 'race', '99999999-0000-0000-0000-000000000921', '8', 6, null, 'K8', 1),
  ('cccccccc-0000-0000-0000-000000000924', 9912002, 1, 'race', '99999999-0000-0000-0000-000000000922', null, 9, null, 'Kn', 0),
  ('cccccccc-0000-0000-0000-000000000925', 9912001, 1, 'race', '99999999-0000-0000-0000-000000000921', '1', 2, '3', 'Ku', 1);

savepoint fixture;

-- K01 The shared order: Practice, Qualifying, Race 1 (lap 1, then lap 2 by turn 3, T4, 10, 10b, back straight),
-- Race 2; the dismissed G keeps its place but takes no number. The public list gives the same numbers -------------
do $$
declare
  v_admin_numbers text;
  v_public_numbers text;
begin
  perform clips_fixture.expect('K01 admin order',
    clips_fixture.run_as('eeeeeeee-0000-0000-0000-000000000921', $q$
      select string_agg(r.description || '=' || o."position" || '/' || coalesce(o.number::text, '-'), ',' order by o."position")
      from public.incident_report_order(9912001) o join public.incident_reports r on r.id = o.report_id$q$),
    'F=1/1,G=2/-,I=3/2,B=4/3,D=5/4,A=6/5,C=7/6,E=8/7,H=9/8');
  perform clips_fixture.expect('K01 staff reads it too',
    clips_fixture.run_as('eeeeeeee-0000-0000-0000-000000000922',
      'select count(*)::text from public.incident_report_order(9912001)'), '9');

  perform clips_fixture.expect('K01 public list',
    clips_fixture.run_as('anon', $q$
      select string_agg(s.submission_number || ':' || s.session || ':' || s.lap || ':' || array_to_string(s.involved_cars, '/'),
                        ',' order by s.ord)
      from (select t.*, row_number() over () as ord from public.incident_submissions(9912001) t) s$q$),
    '1:practice:0:5:,2:race:1:1:,3:race:1:2:921/922,4:race:1:2:,5:race:1:2:,6:race:1:2:,7:race:1:2:,8:race:2:1:');

  v_admin_numbers := clips_fixture.run_as('eeeeeeee-0000-0000-0000-000000000921', $q$
    select string_agg(o.report_id || '=' || o.number, ',' order by o.report_id)
    from public.incident_report_order(9912001) o where o.number is not null$q$);
  v_public_numbers := clips_fixture.run_as('anon', $q$
    select string_agg(s.id || '=' || s.submission_number, ',' order by s.id) from public.incident_submissions(9912001) s$q$);
  perform clips_fixture.expect('K01 same numbers on both screens', v_public_numbers, v_admin_numbers);

  update public.round_incident_status set posted = true, posted_at = now() where subsession_id = 9912001;
  perform clips_fixture.expect('K01 nothing public once posted',
    clips_fixture.run_as('anon', 'select count(*)::text from public.incident_submissions(9912001)'), '0');
  raise notice 'ok K01 shared order and numbers';
end $$;
rollback to savepoint fixture;

-- K02 The admin order is refused to anon and to a driver -------------------------------------------------------
do $$
begin
  perform clips_fixture.expect('K02 anon',
    clips_fixture.run_as('anon', 'select count(*)::text from public.incident_report_order(9912001)'), '42501');
  perform clips_fixture.expect('K02 driver',
    clips_fixture.run_as('eeeeeeee-0000-0000-0000-000000000923',
      'select count(*)::text from public.incident_report_order(9912001)'), '42501');
  perform clips_fixture.expect('K02 private order closed',
    clips_fixture.run_as('eeeeeeee-0000-0000-0000-000000000921',
      'select count(*)::text from private.incident_report_order(9912001)'), '42501');
  raise notice 'ok K02 admin order refused';
end $$;
rollback to savepoint fixture;

-- K03 Unpost keeps the date; Keep restores it; Reset sets a new one; first_posted_at never moves and no second
-- "Incident Report Posted" email is queued ---------------------------------------------------------------------
do $$
declare
  v_admin text := 'eeeeeeee-0000-0000-0000-000000000921';
  v_first timestamptz := (select first_posted_at from public.round_incident_status where subsession_id = 9912002);
  v_emails bigint := (select count(*) from public.email_outbox where kind = 'report_posted' and subject_id = '9912002');
begin
  perform clips_fixture.expect('K03 seeded first post', v_first is not null, true);

  perform clips_fixture.expect('K03 unpost',
    clips_fixture.run_as(v_admin, 'select public.set_round_incident_posted(9912002, false)::text'),
    jsonb_build_object('posted', false, 'reset', false, 'first_post', false,
                       'posted_at', '2026-05-01 20:00+00'::timestamptz)::text);
  perform clips_fixture.expect('K03 unposted keeps the date',
    (select posted::text || ' ' || posted_at from public.round_incident_status where subsession_id = 9912002),
    'false ' || '2026-05-01 20:00+00'::timestamptz);

  perform clips_fixture.expect('K03 keep',
    clips_fixture.run_as(v_admin, $q$select (public.set_round_incident_posted(9912002, true, false) ->> 'reset')$q$), 'false');
  perform clips_fixture.expect('K03 kept date',
    (select posted::text || ' ' || posted_at from public.round_incident_status where subsession_id = 9912002),
    'true ' || '2026-05-01 20:00+00'::timestamptz);

  perform clips_fixture.expect('K03 posting a posted round changes nothing',
    clips_fixture.run_as(v_admin, $q$select (public.set_round_incident_posted(9912002, true, true) ->> 'reset')$q$), 'false');
  perform clips_fixture.expect('K03 date unchanged',
    (select posted_at from public.round_incident_status where subsession_id = 9912002), '2026-05-01 20:00+00'::timestamptz);

  perform clips_fixture.run_as(v_admin, 'select public.set_round_incident_posted(9912002, false)::text');
  perform clips_fixture.expect('K03 reset',
    clips_fixture.run_as(v_admin, $q$select (public.set_round_incident_posted(9912002, true, true) ->> 'reset')$q$), 'true');
  perform clips_fixture.expect('K03 new date',
    (select posted_at from public.round_incident_status where subsession_id = 9912002), now());

  -- Keep after a reset keeps the latest date, not the first one.
  perform clips_fixture.run_as(v_admin, 'select public.set_round_incident_posted(9912002, false)::text');
  perform clips_fixture.run_as(v_admin, 'select public.set_round_incident_posted(9912002, true, false)::text');
  perform clips_fixture.expect('K03 keep after reset',
    (select posted_at from public.round_incident_status where subsession_id = 9912002), now());

  -- The default (no choice sent) is a reset.
  update public.round_incident_status set posted_at = '2026-05-02 20:00+00' where subsession_id = 9912002;
  perform clips_fixture.run_as(v_admin, 'select public.set_round_incident_posted(9912002, false)::text');
  perform clips_fixture.expect('K03 default resets',
    clips_fixture.run_as(v_admin, $q$select (public.set_round_incident_posted(9912002, true) ->> 'reset')$q$), 'true');

  perform clips_fixture.expect('K03 first_posted_at unchanged',
    (select first_posted_at from public.round_incident_status where subsession_id = 9912002), v_first);
  perform clips_fixture.expect('K03 no new email',
    (select count(*) from public.email_outbox where kind = 'report_posted' and subject_id = '9912002'), v_emails);
  raise notice 'ok K03 re-posting';
end $$;
rollback to savepoint fixture;

-- K04 A first post sets now() whatever the choice; staff may post; a driver and anon are refused -----------------
do $$
begin
  perform clips_fixture.expect('K04 first post by staff',
    clips_fixture.run_as('eeeeeeee-0000-0000-0000-000000000922',
      $q$select (public.set_round_incident_posted(9912003, true, false) - 'posted_at')::text$q$),
    '{"reset": true, "posted": true, "first_post": true}');
  perform clips_fixture.expect('K04 first post date',
    (select posted::text || ' ' || (posted_at = now())::text || ' ' || (first_posted_at is not null)::text
     from public.round_incident_status where subsession_id = 9912003), 'true true true');
  perform clips_fixture.expect('K04 driver refused',
    clips_fixture.run_as('eeeeeeee-0000-0000-0000-000000000923',
      'select public.set_round_incident_posted(9912001, true)::text'), '42501');
  perform clips_fixture.expect('K04 anon refused',
    clips_fixture.run_as('anon', 'select public.set_round_incident_posted(9912001, true)::text'), '42501');
  perform clips_fixture.expect('K04 refused writes nothing',
    (select posted from public.round_incident_status where subsession_id = 9912001), false);
  raise notice 'ok K04 first post and refusals';
end $$;
rollback to savepoint fixture;

-- K05 Report clips: admins and staff only, any status; the URL check; empty clears; a missing report --------------
do $$
declare
  v_admin text := 'eeeeeeee-0000-0000-0000-000000000921';
begin
  perform clips_fixture.expect('K05 driver refused',
    clips_fixture.run_as('eeeeeeee-0000-0000-0000-000000000923',
      $q$select public.set_incident_report_video('aaaaaaaa-0000-0000-0000-000000000921', 'https://youtu.be/abc')::text$q$),
    '42501');
  perform clips_fixture.expect('K05 javascript refused',
    clips_fixture.run_as(v_admin,
      $q$select public.set_incident_report_video('aaaaaaaa-0000-0000-0000-000000000921', 'javascript:alert(1)')::text$q$),
    'INVALID_URL');
  perform clips_fixture.expect('K05 501 characters refused',
    clips_fixture.run_as(v_admin, format('select public.set_incident_report_video(%L, %L)::text',
      'aaaaaaaa-0000-0000-0000-000000000921', 'https://x.test/' || repeat('a', 486))), 'INVALID_URL');
  perform clips_fixture.expect('K05 500 characters kept',
    clips_fixture.run_as(v_admin, format($q$select public.set_incident_report_video(%L, %L) ->> 'video_url'$q$,
      'aaaaaaaa-0000-0000-0000-000000000921', 'https://x.test/' || repeat('a', 485))), 'https://x.test/' || repeat('a', 485));
  perform clips_fixture.expect('K05 trimmed on a dismissed report',
    clips_fixture.run_as(v_admin,
      $q$select public.set_incident_report_video('aaaaaaaa-0000-0000-0000-000000000927', '  https://youtu.be/abc  ') ->> 'video_url'$q$),
    'https://youtu.be/abc');
  perform clips_fixture.expect('K05 stored',
    (select video_url from public.incident_reports where id = 'aaaaaaaa-0000-0000-0000-000000000927'), 'https://youtu.be/abc');
  perform clips_fixture.run_as('eeeeeeee-0000-0000-0000-000000000922',
    $q$select public.set_incident_report_video('aaaaaaaa-0000-0000-0000-000000000927', '   ')::text$q$);
  perform clips_fixture.expect('K05 staff cleared it',
    (select video_url from public.incident_reports where id = 'aaaaaaaa-0000-0000-0000-000000000927'), null::text);
  perform clips_fixture.expect('K05 missing report',
    clips_fixture.run_as(v_admin,
      $q$select public.set_incident_report_video('aaaaaaaa-0000-0000-0000-0000000009ff', 'https://youtu.be/abc')::text$q$),
    'REPORT_NOT_FOUND');
  perform clips_fixture.expect('K05 column check',
    clips_fixture.error_state($q$update public.incident_reports set video_url = 'ftp://x.test/a.mp4'
                                 where id = 'aaaaaaaa-0000-0000-0000-000000000921'$q$), '23514');
  raise notice 'ok K05 report clips';
end $$;
rollback to savepoint fixture;

-- K06 Incident clips: every row of the incident at once; no unnumbered incidents; a missing incident; refusals ----
do $$
declare
  v_admin text := 'eeeeeeee-0000-0000-0000-000000000921';
begin
  perform clips_fixture.expect('K06 both rows',
    clips_fixture.run_as(v_admin,
      $q$select public.set_incident_video(9912002, 'race', 1, '7', 'https://cdn.discordapp.com/a/b.mp4') ->> 'rows'$q$), '2');
  perform clips_fixture.expect('K06 stored on the incident only',
    (select string_agg(description || '=' || coalesce(video_url, '-'), ',' order by description)
     from public.penalties where subsession_id = 9912002),
    'K7a=https://cdn.discordapp.com/a/b.mp4,K7b=https://cdn.discordapp.com/a/b.mp4,K8=-,Kn=-');
  perform clips_fixture.expect('K06 empty number refused',
    clips_fixture.run_as(v_admin, $q$select public.set_incident_video(9912002, 'race', 1, ' ', 'https://x.test/a')::text$q$),
    'INCIDENT_NUMBER_REQUIRED');
  perform clips_fixture.expect('K06 null number refused',
    clips_fixture.run_as(v_admin, $q$select public.set_incident_video(9912002, 'race', 1, null, 'https://x.test/a')::text$q$),
    'INCIDENT_NUMBER_REQUIRED');
  perform clips_fixture.expect('K06 unnumbered row untouched',
    (select video_url from public.penalties where id = 'cccccccc-0000-0000-0000-000000000924'), null::text);
  perform clips_fixture.expect('K06 missing incident',
    clips_fixture.run_as(v_admin, $q$select public.set_incident_video(9912002, 'race', 1, '99', 'https://x.test/a')::text$q$),
    'INCIDENT_NOT_FOUND');
  perform clips_fixture.expect('K06 bad url',
    clips_fixture.run_as(v_admin, $q$select public.set_incident_video(9912002, 'race', 1, '7', 'data:text/html,hi')::text$q$),
    'INVALID_URL');
  perform clips_fixture.expect('K06 driver refused',
    clips_fixture.run_as('eeeeeeee-0000-0000-0000-000000000923',
      $q$select public.set_incident_video(9912002, 'race', 1, '7', 'https://x.test/a')::text$q$), '42501');
  perform clips_fixture.run_as(v_admin, $q$select public.set_incident_video(9912002, 'race', 1, '7', '')::text$q$);
  perform clips_fixture.expect('K06 cleared on both rows',
    (select count(*) from public.penalties where incident_number = '7' and subsession_id = 9912002 and video_url is null), 2::bigint);
  perform clips_fixture.expect('K06 turn check',
    clips_fixture.error_state($q$update public.penalties set turn = ' T4' where id = 'cccccccc-0000-0000-0000-000000000921'$q$),
    '23514');
  perform clips_fixture.expect('K06 turn length',
    clips_fixture.error_state(format('update public.penalties set turn = %L where id = %L', repeat('t', 81),
      'cccccccc-0000-0000-0000-000000000921')), '23514');
  raise notice 'ok K06 incident clips';
end $$;
rollback to savepoint fixture;

-- K07 penalties_shown shows turn and clip to anon for a posted round and nothing for an unposted one --------------
do $$
begin
  update public.penalties set video_url = 'https://youtu.be/k7' where subsession_id = 9912002 and incident_number = '7';
  update public.penalties set video_url = 'https://youtu.be/ku' where subsession_id = 9912001;
  perform clips_fixture.expect('K07 posted round',
    clips_fixture.run_as('anon', $q$select string_agg(coalesce(turn, '-') || '|' || coalesce(video_url, '-'), ',' order by id)
                                    from public.penalties_shown where subsession_id = 9912002 and incident_number = '7'$q$),
    'T4|https://youtu.be/k7,T4|https://youtu.be/k7');
  perform clips_fixture.expect('K07 unposted round',
    clips_fixture.run_as('anon', 'select count(*)::text from public.penalties_shown where subsession_id = 9912001'), '0');
  perform clips_fixture.expect('K07 admin sees the unposted round',
    clips_fixture.run_as('eeeeeeee-0000-0000-0000-000000000921',
      'select video_url from public.penalties_shown where subsession_id = 9912001'), 'https://youtu.be/ku');
  perform clips_fixture.expect('K07 view options',
    (select reloptions from pg_class where oid = 'public.penalties_shown'::regclass),
    array['security_invoker=false', 'security_barrier=true']);
  perform clips_fixture.expect('K07 anon has select only',
    has_table_privilege('anon', 'public.penalties_shown', 'select')
      and not has_table_privilege('anon', 'public.penalties_shown', 'update'), true);
  raise notice 'ok K07 penalties_shown';
end $$;
rollback to savepoint fixture;

-- K08 Definer settings and grants of the new functions ---------------------------------------------------------
do $$
declare
  v_fn regprocedure;
begin
  foreach v_fn in array array[
    'public.incident_report_order(bigint)'::regprocedure,
    'public.set_round_incident_posted(bigint, boolean, boolean)'::regprocedure,
    'public.set_incident_report_video(uuid, text)'::regprocedure,
    'public.set_incident_video(bigint, text, integer, text, text)'::regprocedure
  ] loop
    perform clips_fixture.expect('K08 definer ' || v_fn, (select prosecdef from pg_proc where oid = v_fn), true);
    perform clips_fixture.expect('K08 anon ' || v_fn, has_function_privilege('anon', v_fn, 'execute'), false);
    perform clips_fixture.expect('K08 authenticated ' || v_fn, has_function_privilege('authenticated', v_fn, 'execute'), true);
  end loop;
  v_fn := 'private.incident_report_order(bigint)'::regprocedure;
  perform clips_fixture.expect('K08 private anon', has_function_privilege('anon', v_fn, 'execute'), false);
  perform clips_fixture.expect('K08 private authenticated', has_function_privilege('authenticated', v_fn, 'execute'), false);
  perform clips_fixture.expect('K08 private search_path', (select proconfig from pg_proc where oid = v_fn), array['search_path=""']);
  raise notice 'ok K08 settings and grants';
end $$;
rollback to savepoint fixture;

rollback;
