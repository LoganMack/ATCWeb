-- Interviews fixtures for 20261102120000_interviews_self_service.sql (U6 interviews): the grants on the new
-- functions; who reads race_interviews rows and race-interviews objects (uploader, another account, anon, an
-- admin); ownership after the account relinks to another driver; the uploader-only storage delete;
-- my_interview_audio_exists and delete_my_interview_record with every code, including an object with the same
-- name in another bucket; the re-upload lock on a submitted path; and a new recording after a full delete,
-- inside and outside the 7-day window (V01-V11); and the members' read through race_interviews_shown
-- (20261107120000_interviews_members_view.sql), which leaves out drivers hidden from the caller (V12).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- incident-management-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/interviews-fixtures.sql
--
-- Same conventions as incident-management-fixtures.sql (supabase/checks/README.md): every assertion calls
-- interview_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each case
-- runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`. Callers are impersonated
-- with request.jwt.claims and the role setting. now() is fixed for the whole transaction. Storage objects are
-- written straight into storage.objects, as the Storage API does under the caller's role.
--
-- Accounts: admin (admin, no driver); a (Ana Mine); b (Ben Other); u (no driver). Driver Zed New has no account
-- until V04 relinks a to it.
-- Rounds: 9909001 started 1 day ago (window open), 9909002 started 10 days ago (window closed).
-- Interviews: I1 (Ana, 9909001, submitted by a), I2 (Ben, 9909001, submitted by b), each with its object.

begin;

set local client_min_messages = notice;

-- Newer Storage versions refuse a direct delete from storage.objects unless this is set; older ones ignore it.
set local storage.allow_delete_query = 'true';

create schema interview_fixture;

create function interview_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'interviews fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Acts as p_who ('anon' or an account id) until interview_fixture.as_owner().
create function interview_fixture.act_as(p_who text) returns void
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

create function interview_fixture.as_owner() returns void
  language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- The first value p_sql returns as p_who, as text.
create function interview_fixture.text_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v text;
begin
  perform interview_fixture.act_as(p_who);
  execute p_sql into v;
  perform interview_fixture.as_owner();
  return v;
end;
$$;

-- The SQLSTATE p_sql fails with as p_who, or 'ok'. On an error the block's own rollback puts the role back.
create function interview_fixture.state_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform interview_fixture.act_as(p_who);
  execute p_sql;
  perform interview_fixture.as_owner();
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- The code before the first ':' of the error p_sql raises as p_who ('NOT_OWNER: ...' -> 'NOT_OWNER'), or 'ok'.
create function interview_fixture.code_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform interview_fixture.act_as(p_who);
  execute p_sql;
  perform interview_fixture.as_owner();
  return 'ok';
exception when others then
  return split_part(sqlerrm, ':', 1);
end;
$$;

-- How many race-interviews objects named p_name p_who can see, or delete when p_delete.
create function interview_fixture.objects_as(p_who text, p_name text, p_delete boolean default false) returns text
  language sql as $$
  select interview_fixture.text_as(p_who, case
    when p_delete then format(
      $q$with d as (delete from storage.objects where bucket_id = 'race-interviews' and name = %L returning 1)
         select count(*) from d$q$, p_name)
    else format($q$select count(*) from storage.objects where bucket_id = 'race-interviews' and name = %L$q$, p_name)
  end);
$$;

-- A storage upload as the Storage API writes it, under p_who's role.
create function interview_fixture.upload_sql(p_name text) returns text
  language sql as $$
  select format($q$insert into storage.objects (bucket_id, name) values ('race-interviews', %L)$q$, p_name);
$$;

grant usage on schema interview_fixture to anon, authenticated;
grant execute on all functions in schema interview_fixture to anon, authenticated;

-- Base data ------------------------------------------------------------------------------------

-- No scoring or round-stats side effects from the rows below.
update public.scoring_settings set triggers_enabled = false;

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (851, 'Active')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select 851, 'Alpha', 1 where not exists (select 1 from public.driver_classes where name = 'Alpha');

insert into public.seasons (id, number, name) values ('bbbbbbbb-0000-0000-0000-000000000901', 9851, 'Iv Season');

insert into public.drivers (id, name, car_number, status_id, class_id, is_ai) values
  ('99999999-0000-0000-0000-000000000901', 'Ana Mine', 891,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false),
  ('99999999-0000-0000-0000-000000000902', 'Ben Other', 892,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false),
  ('99999999-0000-0000-0000-000000000903', 'Zed New', 893,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false);

-- The auth.users insert creates a 'driver' profile; the admin and the linked accounts are re-inserted,
-- because as postgres the profiles guard refuses a role or driver change.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000901', 'iv-admin@example.test', now(), '{"display_name":"Admin"}'),
  ('eeeeeeee-0000-0000-0000-000000000902', 'iv-a@example.test', now(), '{"display_name":"Owner A"}'),
  ('eeeeeeee-0000-0000-0000-000000000903', 'iv-b@example.test', now(), '{"display_name":"Owner B"}'),
  ('eeeeeeee-0000-0000-0000-000000000904', 'iv-u@example.test', now(), '{"display_name":"Unlinked U"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000000901', 'eeeeeeee-0000-0000-0000-000000000902',
                                         'eeeeeeee-0000-0000-0000-000000000903');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000901', 'admin', 'Admin', null),
  ('eeeeeeee-0000-0000-0000-000000000902', 'driver', 'Owner A', '99999999-0000-0000-0000-000000000901'),
  ('eeeeeeee-0000-0000-0000-000000000903', 'driver', 'Owner B', '99999999-0000-0000-0000-000000000902');

insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, round_number) values
  (9909001, now() - interval '1 day', 'Iv Park', 'bbbbbbbb-0000-0000-0000-000000000901', 1),
  (9909002, now() - interval '10 days', 'Iv Park', 'bbbbbbbb-0000-0000-0000-000000000901', 2);

insert into public.race_interviews (id, subsession_id, driver_id, audio_path, audio_type, duration_seconds, submitter_id) values
  ('a1a1a1a1-0000-0000-0000-000000000901', 9909001, '99999999-0000-0000-0000-000000000901',
   '99999999-0000-0000-0000-000000000901/9909001.webm', 'audio/webm', 42, 'eeeeeeee-0000-0000-0000-000000000902'),
  ('a1a1a1a1-0000-0000-0000-000000000902', 9909001, '99999999-0000-0000-0000-000000000902',
   '99999999-0000-0000-0000-000000000902/9909001.webm', 'audio/webm', 30, 'eeeeeeee-0000-0000-0000-000000000903');

insert into storage.objects (bucket_id, name) values
  ('race-interviews', '99999999-0000-0000-0000-000000000901/9909001.webm'),
  ('race-interviews', '99999999-0000-0000-0000-000000000902/9909001.webm');

savepoint fixture;

-- V01 Grants: anon executes none of the new functions; authenticated executes all three (NFR1.2, NFR1.4, NFR1.5)
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array['public.my_interview_audio_exists(uuid)', 'public.delete_my_interview_record(uuid)',
                              'private.is_my_interview_object(text)'] loop
    perform interview_fixture.expect('V01 anon cannot execute ' || v_fn, has_function_privilege('anon', v_fn, 'execute'), false);
    perform interview_fixture.expect('V01 authenticated can execute ' || v_fn,
      has_function_privilege('authenticated', v_fn, 'execute'), true);
  end loop;
  perform interview_fixture.expect('V01 anon call refused', interview_fixture.state_as('anon',
    $q$select public.my_interview_audio_exists('a1a1a1a1-0000-0000-0000-000000000901')$q$), '42501');
  raise notice 'ok V01 grants';
end $$;
rollback to savepoint fixture;

-- V02 Rows: the uploader reads their own, another account, an unlinked account and anon none, an admin all
-- (BR12.1, BR12.2; NFR1.1)
do $$
begin
  perform interview_fixture.expect('V02 Ana reads I1', interview_fixture.text_as('eeeeeeee-0000-0000-0000-000000000902',
    'select string_agg(id::text, '','') from public.race_interviews'), 'a1a1a1a1-0000-0000-0000-000000000901');
  perform interview_fixture.expect('V02 Ben reads I2', interview_fixture.text_as('eeeeeeee-0000-0000-0000-000000000903',
    'select string_agg(id::text, '','') from public.race_interviews'), 'a1a1a1a1-0000-0000-0000-000000000902');
  perform interview_fixture.expect('V02 unlinked reads none', interview_fixture.text_as('eeeeeeee-0000-0000-0000-000000000904',
    'select count(*) from public.race_interviews'), '0');
  perform interview_fixture.expect('V02 anon reads none', interview_fixture.text_as('anon',
    'select count(*) from public.race_interviews'), '0');
  perform interview_fixture.expect('V02 admin reads all', interview_fixture.text_as('eeeeeeee-0000-0000-0000-000000000901',
    'select count(*) from public.race_interviews'), '2');
  perform interview_fixture.expect('V02 Ana cannot delete her row directly', interview_fixture.text_as('eeeeeeee-0000-0000-0000-000000000902',
    $q$with d as (delete from public.race_interviews returning 1) select count(*) from d$q$), '0');
  raise notice 'ok V02 row reads';
end $$;
rollback to savepoint fixture;

-- V03 Objects: any signed-in account reads shown interviews' audio, anon none, an admin both (BR12.2 amended by
-- driver-profile-polish FR8.4; NFR1.3)
do $$
declare
  v_i1 text := '99999999-0000-0000-0000-000000000901/9909001.webm';
  v_i2 text := '99999999-0000-0000-0000-000000000902/9909001.webm';
begin
  perform interview_fixture.expect('V03 Ana reads I1', interview_fixture.objects_as('eeeeeeee-0000-0000-0000-000000000902', v_i1), '1');
  perform interview_fixture.expect('V03 Ana reads I2', interview_fixture.objects_as('eeeeeeee-0000-0000-0000-000000000902', v_i2), '1');
  perform interview_fixture.expect('V03 unlinked reads I1', interview_fixture.objects_as('eeeeeeee-0000-0000-0000-000000000904', v_i1), '1');
  perform interview_fixture.expect('V03 anon reads none', interview_fixture.objects_as('anon', v_i2), '0');
  perform interview_fixture.expect('V03 anon reads none', interview_fixture.objects_as('anon', v_i1), '0');
  perform interview_fixture.expect('V03 admin reads I2', interview_fixture.objects_as('eeeeeeee-0000-0000-0000-000000000901', v_i2), '1');
  raise notice 'ok V03 object reads';
end $$;
rollback to savepoint fixture;

-- V04 Ownership follows the account: relinked to Zed, a still reads and deletes I1 (BR12.2 amended; NFR1.3)
do $$
declare
  v_a text := 'eeeeeeee-0000-0000-0000-000000000902';
  v_i1 text := '99999999-0000-0000-0000-000000000901/9909001.webm';
begin
  delete from public.profiles where id = v_a::uuid;
  insert into public.profiles (id, role, display_name, driver_id)
  values (v_a::uuid, 'driver', 'Owner A', '99999999-0000-0000-0000-000000000903');
  perform interview_fixture.expect('V04 still reads the row', interview_fixture.text_as(v_a,
    'select string_agg(id::text, '','') from public.race_interviews'), 'a1a1a1a1-0000-0000-0000-000000000901');
  perform interview_fixture.expect('V04 still reads the object', interview_fixture.objects_as(v_a, v_i1), '1');
  perform interview_fixture.expect('V04 exists check', interview_fixture.text_as(v_a,
    $q$select public.my_interview_audio_exists('a1a1a1a1-0000-0000-0000-000000000901')::text$q$), 'true');
  perform interview_fixture.expect('V04 still deletes the object', interview_fixture.objects_as(v_a, v_i1, true), '1');
  perform interview_fixture.expect('V04 then the record', interview_fixture.code_as(v_a,
    $q$select public.delete_my_interview_record('a1a1a1a1-0000-0000-0000-000000000901')$q$), 'ok');
  raise notice 'ok V04 relinked account';
end $$;
rollback to savepoint fixture;

-- V05 The storage delete is the uploader's (and an admin's) only (BR12.2; NFR1.3)
do $$
declare
  v_i1 text := '99999999-0000-0000-0000-000000000901/9909001.webm';
begin
  perform interview_fixture.expect('V05 Ben deletes nothing', interview_fixture.objects_as('eeeeeeee-0000-0000-0000-000000000903', v_i1, true), '0');
  perform interview_fixture.expect('V05 unlinked deletes nothing', interview_fixture.objects_as('eeeeeeee-0000-0000-0000-000000000904', v_i1, true), '0');
  perform interview_fixture.expect('V05 still there', (select count(*)::int from storage.objects
    where bucket_id = 'race-interviews' and name = v_i1), 1);
  perform interview_fixture.expect('V05 Ana deletes it', interview_fixture.objects_as('eeeeeeee-0000-0000-0000-000000000902', v_i1, true), '1');
  perform interview_fixture.expect('V05 admin deletes I2', interview_fixture.objects_as('eeeeeeee-0000-0000-0000-000000000901',
    '99999999-0000-0000-0000-000000000902/9909001.webm', true), '1');
  raise notice 'ok V05 storage delete';
end $$;
rollback to savepoint fixture;

-- V06 my_interview_audio_exists: true, false and null, and another bucket's object does not count (BR12.4)
do $$
declare
  v_i1 text := '99999999-0000-0000-0000-000000000901/9909001.webm';
  v_sql text := $q$select public.my_interview_audio_exists('a1a1a1a1-0000-0000-0000-000000000901')::text$q$;
begin
  perform interview_fixture.expect('V06 present', interview_fixture.text_as('eeeeeeee-0000-0000-0000-000000000902', v_sql), 'true');
  perform interview_fixture.expect('V06 not Ben''s', interview_fixture.text_as('eeeeeeee-0000-0000-0000-000000000903', v_sql), null::text);
  perform interview_fixture.expect('V06 unknown id', interview_fixture.text_as('eeeeeeee-0000-0000-0000-000000000902',
    $q$select public.my_interview_audio_exists(gen_random_uuid())::text$q$), null::text);
  delete from storage.objects where bucket_id = 'race-interviews' and name = v_i1;
  insert into storage.objects (bucket_id, name) values ('imports', v_i1);
  perform interview_fixture.expect('V06 gone, same name in imports', interview_fixture.text_as('eeeeeeee-0000-0000-0000-000000000902', v_sql), 'false');
  raise notice 'ok V06 existence check';
end $$;
rollback to savepoint fixture;

-- V07 delete_my_interview_record: NOT_OWNER, FILE_EXISTS, then success once the file is gone (BR12.4; NFR1.5)
do $$
declare
  v_i1 text := '99999999-0000-0000-0000-000000000901/9909001.webm';
  v_sql text := $q$select public.delete_my_interview_record('a1a1a1a1-0000-0000-0000-000000000901')$q$;
begin
  perform interview_fixture.expect('V07 Ben', interview_fixture.code_as('eeeeeeee-0000-0000-0000-000000000903', v_sql), 'NOT_OWNER');
  perform interview_fixture.expect('V07 admin is not the submitter', interview_fixture.code_as('eeeeeeee-0000-0000-0000-000000000901', v_sql), 'NOT_OWNER');
  perform interview_fixture.expect('V07 unknown id', interview_fixture.code_as('eeeeeeee-0000-0000-0000-000000000902',
    'select public.delete_my_interview_record(gen_random_uuid())'), 'NOT_OWNER');
  perform interview_fixture.expect('V07 file still there', interview_fixture.code_as('eeeeeeee-0000-0000-0000-000000000902', v_sql), 'FILE_EXISTS');
  perform interview_fixture.expect('V07 row kept', (select count(*)::int from public.race_interviews
    where id = 'a1a1a1a1-0000-0000-0000-000000000901'), 1);
  delete from storage.objects where bucket_id = 'race-interviews' and name = v_i1;
  insert into storage.objects (bucket_id, name) values ('imports', v_i1);
  perform interview_fixture.expect('V07 file gone', interview_fixture.code_as('eeeeeeee-0000-0000-0000-000000000902', v_sql), 'ok');
  perform interview_fixture.expect('V07 row removed', (select count(*)::int from public.race_interviews
    where id = 'a1a1a1a1-0000-0000-0000-000000000901'), 0);
  perform interview_fixture.expect('V07 Ben''s row untouched', (select count(*)::int from public.race_interviews
    where id = 'a1a1a1a1-0000-0000-0000-000000000902'), 1);
  raise notice 'ok V07 record delete';
end $$;
rollback to savepoint fixture;

-- V08 The insert policy keeps its original check and adds the submitted-path test (BR12.8 amended)
do $$
declare
  v_check text;
begin
  select with_check into v_check from pg_policies
  where schemaname = 'storage' and tablename = 'objects' and policyname = 'driver upload own race-interviews' and cmd = 'INSERT';
  perform interview_fixture.expect('V08 race-interviews only', position('race-interviews' in v_check) > 0, true);
  perform interview_fixture.expect('V08 own folder', position('foldername' in v_check) > 0, true);
  perform interview_fixture.expect('V08 submitted path refused', position('is_race_interview_path_submitted' in v_check) > 0, true);
  raise notice 'ok V08 insert policy';
end $$;
rollback to savepoint fixture;

-- V09 A submitted path refuses a re-upload once its file is deleted; a new path still uploads (BR12.8 amended)
do $$
declare
  v_a text := 'eeeeeeee-0000-0000-0000-000000000902';
  v_i1 text := '99999999-0000-0000-0000-000000000901/9909001.webm';
begin
  perform interview_fixture.expect('V09 Ana deletes her file', interview_fixture.objects_as(v_a, v_i1, true), '1');
  perform interview_fixture.expect('V09 re-upload refused', interview_fixture.state_as(v_a, interview_fixture.upload_sql(v_i1)), '42501');
  perform interview_fixture.expect('V09 an unsubmitted path uploads', interview_fixture.state_as(v_a,
    interview_fixture.upload_sql('99999999-0000-0000-0000-000000000901/9909002.webm')), 'ok');
  perform interview_fixture.expect('V09 not into another driver''s folder', interview_fixture.state_as(v_a,
    interview_fixture.upload_sql('99999999-0000-0000-0000-000000000902/9909002.webm')), '42501');
  raise notice 'ok V09 re-upload lock';
end $$;
rollback to savepoint fixture;

-- V10 After a full delete the recording flow works inside the window: upload, then submit (BR12.8 amended)
do $$
declare
  v_a text := 'eeeeeeee-0000-0000-0000-000000000902';
  v_i1 text := '99999999-0000-0000-0000-000000000901/9909001.webm';
begin
  perform interview_fixture.expect('V10 file', interview_fixture.objects_as(v_a, v_i1, true), '1');
  perform interview_fixture.expect('V10 record', interview_fixture.code_as(v_a,
    $q$select public.delete_my_interview_record('a1a1a1a1-0000-0000-0000-000000000901')$q$), 'ok');
  perform interview_fixture.expect('V10 upload', interview_fixture.state_as(v_a, interview_fixture.upload_sql(v_i1)), 'ok');
  perform interview_fixture.expect('V10 submit', interview_fixture.code_as(v_a, format(
    $q$select public.submit_race_interview(%L, 9909001, %L, 'audio/webm;codecs=opus', 35)$q$,
    'a1a1a1a1-0000-0000-0000-000000000903', v_i1)), 'ok');
  perform interview_fixture.expect('V10 the new record is hers', (select concat(r.submitter_id::text, '/', r.duration_seconds::text)
    from public.race_interviews r where r.id = 'a1a1a1a1-0000-0000-0000-000000000903'), v_a || '/35');
  perform interview_fixture.expect('V10 and locks its path again', interview_fixture.text_as(v_a,
    format('select public.is_race_interview_path_submitted(%L)::text', v_i1)), 'true');
  raise notice 'ok V10 re-record inside the window';
end $$;
rollback to savepoint fixture;

-- V11 Outside the window the database refuses the new recording (BR12.8 amended: the confirm text says so)
do $$
declare
  v_a text := 'eeeeeeee-0000-0000-0000-000000000902';
  v_old text := '99999999-0000-0000-0000-000000000901/9909002.webm';
begin
  insert into public.race_interviews (id, subsession_id, driver_id, audio_path, audio_type, duration_seconds, submitter_id)
  values ('a1a1a1a1-0000-0000-0000-000000000904', 9909002, '99999999-0000-0000-0000-000000000901', v_old, 'audio/webm', 20, v_a::uuid);
  perform interview_fixture.expect('V11 record (no file)', interview_fixture.code_as(v_a,
    $q$select public.delete_my_interview_record('a1a1a1a1-0000-0000-0000-000000000904')$q$), 'ok');
  perform interview_fixture.expect('V11 upload', interview_fixture.state_as(v_a, interview_fixture.upload_sql(v_old)), 'ok');
  perform interview_fixture.expect('V11 submit refused', interview_fixture.code_as(v_a, format(
    $q$select public.submit_race_interview(gen_random_uuid(), 9909002, %L, 'audio/webm', 20)$q$, v_old)),
    'interview window closed');
  raise notice 'ok V11 window closed';
end $$;
rollback to savepoint fixture;

-- V12 Members' view: anon has no grant; with Ben's name hidden, an unlinked account no longer sees I2's row or
-- audio, while a linked account and an admin still do (driver-profile-polish FR8.2-FR8.4; NFR1)
do $$
declare
  v_i2 text := '99999999-0000-0000-0000-000000000902/9909001.webm';
  v_ids text := 'select string_agg(id::text, '','' order by id) from public.race_interviews_shown';
begin
  perform interview_fixture.expect('V12 anon cannot read the view', interview_fixture.state_as('anon',
    'select count(*) from public.race_interviews_shown'), '42501');
  perform interview_fixture.expect('V12 unlinked reads both before', interview_fixture.text_as('eeeeeeee-0000-0000-0000-000000000904',
    v_ids), 'a1a1a1a1-0000-0000-0000-000000000901,a1a1a1a1-0000-0000-0000-000000000902');
  insert into public.account_settings (profile_id, hide_name, hide_profile)
  values ('eeeeeeee-0000-0000-0000-000000000903', true, false)
  on conflict (profile_id) do update set hide_name = true;
  perform interview_fixture.expect('V12 unlinked reads I1 only', interview_fixture.text_as('eeeeeeee-0000-0000-0000-000000000904',
    v_ids), 'a1a1a1a1-0000-0000-0000-000000000901');
  perform interview_fixture.expect('V12 unlinked cannot read hidden audio',
    interview_fixture.objects_as('eeeeeeee-0000-0000-0000-000000000904', v_i2), '0');
  perform interview_fixture.expect('V12 Ana still reads I2', interview_fixture.objects_as('eeeeeeee-0000-0000-0000-000000000902', v_i2), '1');
  perform interview_fixture.expect('V12 admin reads both', interview_fixture.text_as('eeeeeeee-0000-0000-0000-000000000901',
    'select count(*) from public.race_interviews_shown'), '2');
  raise notice 'ok V12 members view';
end $$;
rollback to savepoint fixture;

rollback;
