-- Staff and Broadcaster fixtures for 20261109120000_staff_role_and_broadcaster.sql,
-- 20261109120001_staff_restricted_areas.sql, 20261109120002_incident_report_edit.sql and
-- 20261109120003_website_signup_fields.sql (broadcaster-staff-roles; rules BR1-BR5), cases T01-T24:
--   (a) T01      no write policy on a restricted area, the profiles insert or the three buckets accepts
--                panel access without a full Admin;
--   (b) T02-T07  Staff: restricted writes refused, shared writes kept, Users read-only;
--   (c) T08-T15  the Broadcaster: claim, one slot, never with a driver, admin assign, masking, deletion;
--   (d) T16-T20  Edit Submission: who, open reports only, the log row, no-op, bad values;
--   (e) T21-T24  New Driver Sign-Up: required iRating, taken and requested numbers, the old call, approval.
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- rulebook-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/staff-broadcaster-fixtures.sql
--
-- Same conventions as driver-linking-fixtures.sql (supabase/checks/README.md): every assertion calls
-- staff_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each case
-- runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`. Callers are
-- impersonated with request.jwt.claims and `set local role authenticated`. Storage objects are written
-- straight into storage.objects, as the Storage API does under the caller's role.
--
-- Base data: drivers Amy Brown #12, Bea Browning #7 (iRacing 555), Cara Linked #20 (linked to account c),
-- Old Timer #30 (Inactive) and Hal Hidden #40 (linked to account h, name hidden). Accounts: admin, staff,
-- a and b (plain, unlinked), c and h (linked). Round 9910001 at Zs Park with reports R1 (open), R2 (logged)
-- and R3 (dismissed).

begin;

set local client_min_messages = notice;

create schema staff_fixture;

create function staff_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'staff and broadcaster fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- The first word of an error message ('BROADCASTER_TAKEN: ...' -> 'BROADCASTER_TAKEN'), or 'ok'.
create function staff_fixture.error_code(p_sql text) returns text
  language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return split_part(sqlerrm, ':', 1);
end;
$$;

-- The field an 'INVALID: <field>: ...' error names, or 'ok'.
create function staff_fixture.error_field(p_sql text) returns text
  language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return split_part(sqlerrm, ':', 1) || ' ' || btrim(split_part(sqlerrm, ':', 2));
end;
$$;

-- The SQLSTATE p_sql fails with, or 'ok'.
create function staff_fixture.error_state(p_sql text) returns text
  language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- The number of rows p_sql changed (an update or delete RLS filters out changes none).
create function staff_fixture.affected(p_sql text) returns bigint
  language plpgsql as $$
declare
  v bigint;
begin
  execute p_sql;
  get diagnostics v = row_count;
  return v;
end;
$$;

-- Acts as p_user for the rest of the transaction.
create function staff_fixture.claims(p_user uuid) returns void
  language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

grant usage on schema staff_fixture to authenticated;
grant execute on all functions in schema staff_fixture to authenticated;

-- Base data ------------------------------------------------------------------------------------

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (811, 'Active'), (812, 'New'), (813, 'Inactive')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select 811, 'Alpha', 1 where not exists (select 1 from public.driver_classes where name = 'Alpha');

insert into public.drivers (id, name, car_number, status_id, class_id, iracing_cust_id, is_ai, nationality_1) values
  ('99999999-0000-0000-0000-000000000b01', 'Amy Brown', 12,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), null, false, null),
  ('99999999-0000-0000-0000-000000000b02', 'Bea Browning', 7,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), 555, false, 'gb'),
  ('99999999-0000-0000-0000-000000000b03', 'Cara Linked', 20,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), null, false, null),
  ('99999999-0000-0000-0000-000000000b04', 'Old Timer', 30,
   (select id from public.driver_statuses where name = 'Inactive'), (select id from public.driver_classes where name = 'Alpha'), null, false, null),
  ('99999999-0000-0000-0000-000000000b05', 'Hal Hidden', 40,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), null, false, null);

-- Accounts (the auth.users insert creates a 'driver' profile; the admin, staff and linked accounts are
-- re-inserted, because as postgres the profiles guard refuses a role or driver change).
insert into auth.users (id, email, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000b01', 'staff-admin@example.test', '{"display_name":"Site Admin"}'),
  ('eeeeeeee-0000-0000-0000-000000000b02', 'staff-staff@example.test', '{"display_name":"Sam Staff"}'),
  ('eeeeeeee-0000-0000-0000-000000000b03', 'staff-a@example.test', '{"display_name":"Viewer A"}'),
  ('eeeeeeee-0000-0000-0000-000000000b04', 'staff-b@example.test', '{"display_name":"Viewer B"}'),
  ('eeeeeeee-0000-0000-0000-000000000b05', 'staff-c@example.test', '{"display_name":"Driver C"}'),
  ('eeeeeeee-0000-0000-0000-000000000b06', 'staff-h@example.test', '{"display_name":"Driver H"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000000b01', 'eeeeeeee-0000-0000-0000-000000000b02',
  'eeeeeeee-0000-0000-0000-000000000b05', 'eeeeeeee-0000-0000-0000-000000000b06');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000b01', 'admin', 'Site Admin', null),
  ('eeeeeeee-0000-0000-0000-000000000b02', 'staff', 'Sam Staff', null),
  ('eeeeeeee-0000-0000-0000-000000000b05', 'driver', 'Driver C', '99999999-0000-0000-0000-000000000b03'),
  ('eeeeeeee-0000-0000-0000-000000000b06', 'driver', 'Driver H', '99999999-0000-0000-0000-000000000b05');
insert into public.account_settings (profile_id, hide_name) values ('eeeeeeee-0000-0000-0000-000000000b06', true);

insert into public.circuits (id, name) values ('cccccccc-0000-0000-0000-000000000b01', 'Zs Circuit');
insert into public.seasons (id, number, name) values ('bbbbbbbb-0000-0000-0000-000000000b01', 9861, 'Zs Season');
insert into public.site_settings (setting_key, value) values ('incident_report_period_hours', '24'), ('probation_days', '45')
on conflict (setting_key) do update set value = excluded.value;

insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, round_number) values
  (9910001, now() - interval '2 days', 'Zs Park', 'bbbbbbbb-0000-0000-0000-000000000b01', 1);
insert into public.incident_reports (id, subsession_id, session, lap, turn, description, status, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000000b01', 9910001, 'race:1', 4, 'T1', 'Contact', 'open', now() - interval '3 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000b02', 9910001, 'race:2', 7, 'T5', null, 'logged', now() - interval '2 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000b03', 9910001, 'race:1', 9, 'T9', null, 'dismissed', now() - interval '1 hour');
update public.incident_reports set dismissal_reason = 'No incident' where id = 'aaaaaaaa-0000-0000-0000-000000000b03';
insert into public.incident_report_drivers (report_id, driver_id) values
  ('aaaaaaaa-0000-0000-0000-000000000b01', '99999999-0000-0000-0000-000000000b01'),
  ('aaaaaaaa-0000-0000-0000-000000000b01', '99999999-0000-0000-0000-000000000b02'),
  ('aaaaaaaa-0000-0000-0000-000000000b02', '99999999-0000-0000-0000-000000000b01'),
  ('aaaaaaaa-0000-0000-0000-000000000b03', '99999999-0000-0000-0000-000000000b02');

savepoint fixture;

-- (a) T01 No write policy on a restricted area accepts panel access without a full Admin (ADR-1) ---------
do $$
declare
  v_open text;
begin
  select string_agg(format('%s.%s "%s"', schemaname, tablename, policyname), ', ' order by tablename, policyname)
    into v_open
  from pg_policies
  where cmd <> 'SELECT'
    and (
      (schemaname = 'public' and tablename in ('page_banners', 'car_logos', 'penalty_offenses', 'champion_photos',
        'hall_of_fame_photos', 'seasons', 'scoring_rulesets', 'media_videos', 'media_graphics', 'media_meetups',
        'media_meetup_drivers', 'circuits', 'circuit_layouts', 'layout_corners', 'layout_incident_pins',
        'track_guides', 'site_settings'))
      or (schemaname = 'public' and tablename = 'profiles' and cmd = 'INSERT')
      or (schemaname = 'storage' and tablename = 'objects'
          and coalesce(qual, '') || coalesce(with_check, '') ~ '''(banners|logos|photos)''')
    )
    and coalesce(qual, '') || coalesce(with_check, '') ~ '\mis_admin\('
    and coalesce(qual, '') || coalesce(with_check, '') !~ '\mis_full_admin\(';
  perform staff_fixture.expect('T01 policies open to panel access', v_open, null::text);
  perform staff_fixture.expect('T01 the restricted tables are covered',
    (select count(distinct tablename) from pg_policies
     where schemaname = 'public' and cmd <> 'SELECT'
       and coalesce(qual, '') || coalesce(with_check, '') ~ '\mis_full_admin\('
       and tablename in ('page_banners', 'car_logos', 'penalty_offenses', 'champion_photos', 'hall_of_fame_photos',
         'seasons', 'scoring_rulesets', 'media_videos', 'media_graphics', 'media_meetups', 'media_meetup_drivers',
         'circuits', 'circuit_layouts', 'layout_corners', 'layout_incident_pins', 'track_guides', 'site_settings')),
    17::bigint);
  raise notice 'ok T01 restricted policies';
end $$;
rollback to savepoint fixture;

-- (b) T02 Staff can't write the restricted areas' tables (BR2.4) ---------------------------------------
do $$
declare
  v_insert text;
  v_season bigint;
  v_circuit bigint;
  v_admin_season bigint;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b02');
  set local role authenticated;
  v_insert := staff_fixture.error_state($q$insert into public.circuits (name) values ('Zs New Circuit')$q$);
  v_season := staff_fixture.affected($q$update public.seasons set name = 'Staff Season'
    where id = 'bbbbbbbb-0000-0000-0000-000000000b01'$q$);
  v_circuit := staff_fixture.affected($q$delete from public.circuits where id = 'cccccccc-0000-0000-0000-000000000b01'$q$);
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b01');
  v_admin_season := staff_fixture.affected($q$update public.seasons set name = 'Admin Season'
    where id = 'bbbbbbbb-0000-0000-0000-000000000b01'$q$);
  reset role;
  perform staff_fixture.expect('T02 staff inserts a circuit', v_insert, '42501');
  perform staff_fixture.expect('T02 staff updates a season', v_season, 0::bigint);
  perform staff_fixture.expect('T02 staff deletes a circuit', v_circuit, 0::bigint);
  perform staff_fixture.expect('T02 an admin still updates a season', v_admin_season, 1::bigint);
  raise notice 'ok T02 restricted tables';
end $$;
rollback to savepoint fixture;

-- T03 Site settings: Staff may change only the four driver-status keys (BR2.5) --------------------------
do $$
declare
  v_period bigint;
  v_probation bigint;
  v_insert text;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b02');
  set local role authenticated;
  v_period := staff_fixture.affected($q$update public.site_settings set value = '48'
    where setting_key = 'incident_report_period_hours'$q$);
  v_probation := staff_fixture.affected($q$update public.site_settings set value = '30'
    where setting_key = 'probation_days'$q$);
  v_insert := staff_fixture.error_state($q$insert into public.site_settings (setting_key, value)
    values ('incident_appeal_period_hours', '12')$q$);
  reset role;
  perform staff_fixture.expect('T03 incident period refused', v_period, 0::bigint);
  perform staff_fixture.expect('T03 probation days allowed', v_probation, 1::bigint);
  perform staff_fixture.expect('T03 appeal period insert refused', v_insert, '42501');
  raise notice 'ok T03 site settings';
end $$;
rollback to savepoint fixture;

-- T04 Storage: restricted names are full Admin, the rest stay open to panel access (BR2.6) --------------
do $$
declare
  v_banner text;
  v_circuit_logo text;
  v_team_logo text;
  v_media_photo text;
  v_news_photo text;
  v_admin_banner text;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b02');
  set local role authenticated;
  v_banner := staff_fixture.error_state($q$insert into storage.objects (bucket_id, name) values ('banners', 'standings-1.png')$q$);
  v_circuit_logo := staff_fixture.error_state($q$insert into storage.objects (bucket_id, name) values ('logos', 'circuit-x-1.png')$q$);
  v_team_logo := staff_fixture.error_state($q$insert into storage.objects (bucket_id, name)
    values ('logos', '0b0b0b0b-0000-0000-0000-000000000000-1.png')$q$);
  v_media_photo := staff_fixture.error_state($q$insert into storage.objects (bucket_id, name) values ('photos', 'media-graphic-1.png')$q$);
  v_news_photo := staff_fixture.error_state($q$insert into storage.objects (bucket_id, name) values ('photos', 'news-zs-1.png')$q$);
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b01');
  v_admin_banner := staff_fixture.error_state($q$insert into storage.objects (bucket_id, name) values ('banners', 'standings-2.png')$q$);
  reset role;
  perform staff_fixture.expect('T04 staff banner', v_banner, '42501');
  perform staff_fixture.expect('T04 staff circuit logo', v_circuit_logo, '42501');
  perform staff_fixture.expect('T04 staff team logo', v_team_logo, 'ok');
  perform staff_fixture.expect('T04 staff media photo', v_media_photo, '42501');
  perform staff_fixture.expect('T04 staff news cover', v_news_photo, 'ok');
  perform staff_fixture.expect('T04 admin banner', v_admin_banner, 'ok');
  raise notice 'ok T04 storage';
end $$;
rollback to savepoint fixture;

-- T05 Staff keep the shared areas: a team, a news post (BR2.2) ------------------------------------------
do $$
declare
  v_team text;
  v_news text;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b02');
  set local role authenticated;
  v_team := staff_fixture.error_state($q$insert into public.teams (name) values ('Zs Team')$q$);
  v_news := staff_fixture.error_state($q$insert into public.news_posts (slug, title, body, author_name)
    values ('zs-staff-post', 'Staff post', 'Body', 'Sam Staff')$q$);
  reset role;
  perform staff_fixture.expect('T05 team', v_team, 'ok');
  perform staff_fixture.expect('T05 news post', v_news, 'ok');
  raise notice 'ok T05 shared areas';
end $$;
rollback to savepoint fixture;

-- T06 Admin > Users is read-only for Staff: roles, links, the marker and deletion (BR2.1, BR2.3) --------
do $$
declare
  v_promote bigint;
  v_self text;
  v_link bigint;
  v_marker bigint;
  v_rename bigint;
  v_assign text;
  v_delete text;
  v_rows bigint;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b02');
  set local role authenticated;
  -- Another account's row isn't updatable by Staff at all (the update policy filters it out); their own row
  -- is, but the guard refuses a role change on it.
  v_promote := staff_fixture.affected($q$update public.profiles set role = 'staff' where id = 'eeeeeeee-0000-0000-0000-000000000b03'$q$);
  v_self := staff_fixture.error_state($q$update public.profiles set role = 'admin' where id = 'eeeeeeee-0000-0000-0000-000000000b02'$q$);
  v_link := staff_fixture.affected($q$update public.profiles set driver_id = '99999999-0000-0000-0000-000000000b01'
    where id = 'eeeeeeee-0000-0000-0000-000000000b03'$q$);
  v_marker := staff_fixture.affected($q$update public.profiles set is_broadcaster = true where id = 'eeeeeeee-0000-0000-0000-000000000b03'$q$);
  v_rename := staff_fixture.affected($q$update public.profiles set display_name = 'Renamed' where id = 'eeeeeeee-0000-0000-0000-000000000b03'$q$);
  v_assign := staff_fixture.error_state($q$select public.admin_set_broadcaster('eeeeeeee-0000-0000-0000-000000000b03')$q$);
  v_delete := staff_fixture.error_state($q$select public.admin_delete_user('eeeeeeee-0000-0000-0000-000000000b03')$q$);
  select count(*) into v_rows from public.profiles;
  reset role;
  perform staff_fixture.expect('T06 raise another account', v_promote, 0::bigint);
  perform staff_fixture.expect('T06 raise themselves', v_self, '42501');
  perform staff_fixture.expect('T06 link a driver', v_link, 0::bigint);
  perform staff_fixture.expect('T06 set the marker', v_marker, 0::bigint);
  perform staff_fixture.expect('T06 rename another account', v_rename, 0::bigint);
  perform staff_fixture.expect('T06 assign the Broadcaster', v_assign, '42501');
  perform staff_fixture.expect('T06 delete an account', v_delete, '42501');
  perform staff_fixture.expect('T06 staff still list every account', v_rows >= 6, true);
  perform staff_fixture.expect('T06 roles unchanged',
    (select string_agg(role, ',' order by id) from public.profiles
     where id in ('eeeeeeee-0000-0000-0000-000000000b02', 'eeeeeeee-0000-0000-0000-000000000b03')), 'staff,driver');
  raise notice 'ok T06 users read-only';
end $$;
rollback to savepoint fixture;

-- T07 Staff approve a website sign-up through the approval opening (BR2.1, W6) -------------------------
do $$
declare
  v_id uuid;
  v_result jsonb;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b03');
  set local role authenticated;
  v_id := public.submit_driver_signup('Nico Newman', 55, 2100, 123456, 'us', 'ca');
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b02');
  v_result := public.approve_signup_request(v_id, 'Nico Newman', null, (select id from public.driver_classes where name = 'Alpha'), null);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T07 requester linked',
    (select driver_id from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000b03'),
    (v_result ->> 'driver_id')::uuid);
  perform staff_fixture.expect('T07 approval opening off again',
    coalesce(current_setting('atc.approval_link', true), ''), 'off');
  raise notice 'ok T07 staff approve';
end $$;
rollback to savepoint fixture;

-- (c) T08 A plain driver claims the Broadcaster; a second claim and a linked account are refused (BR1.1-BR1.3)
do $$
declare
  v_result jsonb;
  v_state jsonb;
  v_second text;
  v_linked text;
  v_again text;
  v_taken boolean;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b03');
  set local role authenticated;
  v_result := public.claim_broadcaster();
  v_state := public.my_link_state();
  v_again := staff_fixture.error_code($q$select public.claim_broadcaster()$q$);
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b04');
  v_second := staff_fixture.error_code($q$select public.claim_broadcaster()$q$);
  v_taken := public.broadcaster_slot_taken();
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b05');
  v_linked := staff_fixture.error_code($q$select public.claim_broadcaster()$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T08 claim result', v_result ->> 'is_broadcaster', 'true');
  perform staff_fixture.expect('T08 marker set',
    (select is_broadcaster from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000b03'), true);
  perform staff_fixture.expect('T08 link state', v_state ->> 'broadcaster', 'true');
  perform staff_fixture.expect('T08 link state slot', v_state ->> 'broadcaster_slot_taken', 'true');
  perform staff_fixture.expect('T08 claim twice', v_again, 'ALREADY_LINKED');
  perform staff_fixture.expect('T08 second account', v_second, 'BROADCASTER_TAKEN');
  perform staff_fixture.expect('T08 slot taken', v_taken, true);
  perform staff_fixture.expect('T08 linked account', v_linked, 'ALREADY_LINKED');
  perform staff_fixture.expect('T08 one activity row',
    (select count(*) from public.activity_log where actor_id = 'eeeeeeee-0000-0000-0000-000000000b03'
       and entity_label = 'Viewer A became the Broadcaster'), 1::bigint);
  perform staff_fixture.expect('T08 claim opening off again',
    coalesce(current_setting('atc.broadcaster_claim', true), ''), 'off');
  raise notice 'ok T08 claim';
end $$;
rollback to savepoint fixture;

-- T09 The marker can't be changed directly, and the uniqueness and exclusivity rules hold (BR1.1-BR1.3) --
do $$
declare
  v_own text;
  v_off text;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b04');
  set local role authenticated;
  v_own := staff_fixture.error_state($q$update public.profiles set is_broadcaster = true where id = 'eeeeeeee-0000-0000-0000-000000000b04'$q$);
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b03');
  perform public.claim_broadcaster();
  v_off := staff_fixture.error_state($q$update public.profiles set is_broadcaster = false where id = 'eeeeeeee-0000-0000-0000-000000000b03'$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T09 direct set', v_own, '42501');
  perform staff_fixture.expect('T09 direct clear', v_off, '42501');
  -- As postgres, on a fresh account row (an update would stop at the guard first).
  insert into auth.users (id, email) values ('eeeeeeee-0000-0000-0000-000000000b07', 'staff-x@example.test');
  delete from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000b07';
  perform staff_fixture.expect('T09 a second marker', staff_fixture.error_state($q$insert into public.profiles (id, role, is_broadcaster)
    values ('eeeeeeee-0000-0000-0000-000000000b07', 'driver', true)$q$), '23505');
  perform staff_fixture.expect('T09 marker with a driver', staff_fixture.error_state($q$insert into public.profiles (id, role, driver_id, is_broadcaster)
    values ('eeeeeeee-0000-0000-0000-000000000b07', 'driver', '99999999-0000-0000-0000-000000000b01', true)$q$), '23514');
  raise notice 'ok T09 direct writes';
end $$;
rollback to savepoint fixture;

-- T10 The Broadcaster can't link a driver or ask for one; claiming cancels a pending request (BR1.2, BR1.3)
do $$
declare
  v_id uuid;
  v_link text;
  v_request text;
  v_signup text;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b03');
  set local role authenticated;
  v_id := public.submit_driver_signup('Nico Newman', 55, 2100, 123456, null, null);
  perform public.claim_broadcaster();
  v_link := staff_fixture.error_code($q$select public.link_my_driver('99999999-0000-0000-0000-000000000b01')$q$);
  v_request := staff_fixture.error_code($q$select public.submit_driver_request('Nico Newman', 56, 123457)$q$);
  v_signup := staff_fixture.error_code($q$select public.submit_driver_signup('Nico Newman', 56, 2100, 123457, null, null)$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T10 request cancelled', (select status from public.signup_requests where id = v_id), 'cancelled');
  perform staff_fixture.expect('T10 link', v_link, 'ALREADY_LINKED');
  perform staff_fixture.expect('T10 old request call', v_request, 'ALREADY_LINKED');
  perform staff_fixture.expect('T10 new sign-up call', v_signup, 'ALREADY_LINKED');
  raise notice 'ok T10 no driver for the Broadcaster';
end $$;
rollback to savepoint fixture;

-- T11 A full Admin moves and removes the marker in one step; a driver-linked target is refused (BR1.4) ---
do $$
declare
  v_id uuid;
  v_linked text;
  v_holder_after_move uuid;
  v_holders_after_remove bigint;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b03');
  set local role authenticated;
  perform public.claim_broadcaster();
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b04');
  v_id := public.submit_driver_signup('Bob Pending', 56, 1500, 223344, null, null);
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b01');
  perform public.admin_set_broadcaster('eeeeeeee-0000-0000-0000-000000000b04');
  select id into v_holder_after_move from public.profiles where is_broadcaster;
  v_linked := staff_fixture.error_code($q$select public.admin_set_broadcaster('eeeeeeee-0000-0000-0000-000000000b05')$q$);
  perform public.admin_set_broadcaster(null);
  select count(*) into v_holders_after_remove from public.profiles where is_broadcaster;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T11 moved', v_holder_after_move, 'eeeeeeee-0000-0000-0000-000000000b04'::uuid);
  perform staff_fixture.expect('T11 target request cancelled', (select status from public.signup_requests where id = v_id), 'cancelled');
  perform staff_fixture.expect('T11 driver-linked target', v_linked, 'ACCOUNT_LINKED');
  perform staff_fixture.expect('T11 removed', v_holders_after_remove, 0::bigint);
  raise notice 'ok T11 admin assigns';
end $$;
rollback to savepoint fixture;

-- T12 A requester who became the Broadcaster can't be approved (BR5.7) ----------------------------------
do $$
declare
  v_id uuid;
  v text;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b03');
  set local role authenticated;
  v_id := public.submit_driver_signup('Nico Newman', 55, 2100, 123456, null, null);
  perform public.claim_broadcaster();
  reset role;
  -- Normally the claim cancels the request; put it back to reach the approval check.
  update public.signup_requests set status = 'pending', decided_at = null where id = v_id;
  set local role authenticated;
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b01');
  v := staff_fixture.error_code(format(
    $q$select public.approve_signup_request(%L, 'Nico Newman', null, (select id from public.driver_classes where name = 'Alpha'), null)$q$, v_id));
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T12 code', v, 'REQUESTER_IS_BROADCASTER');
  perform staff_fixture.expect('T12 still pending', (select status from public.signup_requests where id = v_id), 'pending');
  raise notice 'ok T12 broadcaster requester';
end $$;
rollback to savepoint fixture;

-- T13 The Broadcaster and Staff see hidden names; a plain account doesn't (BR1.6) -----------------------
do $$
declare
  v_plain boolean;
  v_broadcaster boolean;
  v_staff boolean;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b04');
  set local role authenticated;
  select is_hidden into v_plain from public.drivers_shown where id = '99999999-0000-0000-0000-000000000b05';
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b03');
  perform public.claim_broadcaster();
  select is_hidden into v_broadcaster from public.drivers_shown where id = '99999999-0000-0000-0000-000000000b05';
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b02');
  select is_hidden into v_staff from public.drivers_shown where id = '99999999-0000-0000-0000-000000000b05';
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T13 plain account', v_plain, true);
  perform staff_fixture.expect('T13 Broadcaster', v_broadcaster, false);
  perform staff_fixture.expect('T13 Staff', v_staff, false);
  raise notice 'ok T13 masking';
end $$;
rollback to savepoint fixture;

-- T14 Deleting the Broadcaster's account frees the slot (BR1.5) ----------------------------------------
do $$
declare
  v text;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b03');
  set local role authenticated;
  perform public.claim_broadcaster();
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b01');
  perform public.admin_delete_user('eeeeeeee-0000-0000-0000-000000000b03');
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b04');
  v := staff_fixture.error_code($q$select public.claim_broadcaster()$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T14 claim after deletion', v, 'ok');
  raise notice 'ok T14 deletion frees the slot';
end $$;
rollback to savepoint fixture;

-- T15 Grants: signed-in callers only, and the hand insert of profiles is full Admin (BR1.3, BR2.1) ------
do $$
declare
  v_fn text;
  v_staff_insert text;
begin
  foreach v_fn in array array[
    'public.claim_broadcaster()',
    'public.admin_set_broadcaster(uuid)',
    'public.broadcaster_slot_taken()',
    'public.edit_incident_report_submission(uuid, text, integer, text, uuid[])',
    'public.submit_driver_signup(text, integer, integer, bigint, text, text)',
    'public.taken_car_numbers()'
  ] loop
    perform staff_fixture.expect('T15 anon cannot execute ' || v_fn, has_function_privilege('anon', v_fn, 'execute'), false);
    perform staff_fixture.expect('T15 authenticated can execute ' || v_fn,
      has_function_privilege('authenticated', v_fn, 'execute'), true);
  end loop;
  perform staff_fixture.expect('T15 shared check not callable',
    has_function_privilege('authenticated', 'private.check_driver_request(uuid, text, integer, bigint)', 'execute'), false);
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b02');
  set local role authenticated;
  v_staff_insert := staff_fixture.error_state($q$insert into public.profiles (id, role) values (gen_random_uuid(), 'admin')$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T15 staff hand insert', v_staff_insert, '42501');
  raise notice 'ok T15 grants';
end $$;
rollback to savepoint fixture;

-- (d) T16 Staff edit an open report: the fields, the cars and one log row (BR4.1, BR4.3, BR4.5) ----------
do $$
declare
  v_result jsonb;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b02');
  set local role authenticated;
  v_result := public.edit_incident_report_submission('aaaaaaaa-0000-0000-0000-000000000b01', 'race:2', 5, '  T2 ',
    array['99999999-0000-0000-0000-000000000b01', '99999999-0000-0000-0000-000000000b04']::uuid[]);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T16 changed', v_result ->> 'changed', 'true');
  perform staff_fixture.expect('T16 report',
    (select format('%s %s %s %s', session, lap, turn, coalesce(description, '-')) from public.incident_reports
     where id = 'aaaaaaaa-0000-0000-0000-000000000b01'), 'race:2 5 T2 Contact');
  perform staff_fixture.expect('T16 cars',
    (select string_agg(d.name, ', ' order by d.name) from public.incident_report_drivers r join public.drivers d on d.id = r.driver_id
     where r.report_id = 'aaaaaaaa-0000-0000-0000-000000000b01'), 'Amy Brown, Old Timer');
  perform staff_fixture.expect('T16 log row',
    (select format('%s|%s|%s|%s', actor_name, action, entity_type, entity_label) from public.activity_log
     where entity_id = 'aaaaaaaa-0000-0000-0000-000000000b01'),
    'Sam Staff|edit|incident_report|Edited incident report 1 - Zs Park');
  perform staff_fixture.expect('T16 log details',
    (select details from public.activity_log where entity_id = 'aaaaaaaa-0000-0000-0000-000000000b01'),
    E'Race: race:1 -> race:2\nLap: 4 -> 5\nTurns: T1 -> T2\nCars: Amy Brown, Bea Browning -> Amy Brown, Old Timer');
  raise notice 'ok T16 edit';
end $$;
rollback to savepoint fixture;

-- T17 Logged, dismissed and missing reports are refused (BR4.2) -----------------------------------------
do $$
declare
  v_logged text;
  v_dismissed text;
  v_missing text;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b01');
  set local role authenticated;
  v_logged := staff_fixture.error_code($q$select public.edit_incident_report_submission('aaaaaaaa-0000-0000-0000-000000000b02',
    'race:2', 8, 'T5', array['99999999-0000-0000-0000-000000000b01']::uuid[])$q$);
  v_dismissed := staff_fixture.error_code($q$select public.edit_incident_report_submission('aaaaaaaa-0000-0000-0000-000000000b03',
    'race:1', 9, 'T9', array['99999999-0000-0000-0000-000000000b01']::uuid[])$q$);
  v_missing := staff_fixture.error_code($q$select public.edit_incident_report_submission('aaaaaaaa-0000-0000-0000-0000000000ff',
    'race:1', 1, 'T1', array['99999999-0000-0000-0000-000000000b01']::uuid[])$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T17 logged', v_logged, 'REPORT_NOT_OPEN');
  perform staff_fixture.expect('T17 dismissed', v_dismissed, 'REPORT_NOT_OPEN');
  perform staff_fixture.expect('T17 missing', v_missing, 'REPORT_NOT_FOUND');
  perform staff_fixture.expect('T17 logged report unchanged',
    (select lap from public.incident_reports where id = 'aaaaaaaa-0000-0000-0000-000000000b02'), 7);
  raise notice 'ok T17 open reports only';
end $$;
rollback to savepoint fixture;

-- T18 Saving nothing new writes nothing, whatever order the cars come in (BR4.4) ------------------------
do $$
declare
  v_result jsonb;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b01');
  set local role authenticated;
  v_result := public.edit_incident_report_submission('aaaaaaaa-0000-0000-0000-000000000b01', 'race:1', 4, 'T1',
    array['99999999-0000-0000-0000-000000000b02', '99999999-0000-0000-0000-000000000b01',
          '99999999-0000-0000-0000-000000000b02']::uuid[]);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T18 not changed', v_result ->> 'changed', 'false');
  perform staff_fixture.expect('T18 no log row',
    (select count(*) from public.activity_log where entity_type = 'incident_report'), 0::bigint);
  raise notice 'ok T18 no-op';
end $$;
rollback to savepoint fixture;

-- T18b A car a steward review blames can't be removed from the report (BR4.3) -----------------------------
do $$
declare
  v_review uuid;
  v_drop text;
begin
  insert into public.incident_report_reviews (report_id, reviewer_id, reviewer_name, explanation)
  values ('aaaaaaaa-0000-0000-0000-000000000b01', 'eeeeeeee-0000-0000-0000-000000000b01', 'Site Admin', 'Bea at fault')
  returning id into v_review;
  insert into public.incident_report_review_drivers (review_id, driver_id, penalty)
  values (v_review, '99999999-0000-0000-0000-000000000b02', '2');
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b02');
  set local role authenticated;
  v_drop := staff_fixture.error_field($q$select public.edit_incident_report_submission('aaaaaaaa-0000-0000-0000-000000000b01',
    'race:1', 4, 'T1', array['99999999-0000-0000-0000-000000000b01']::uuid[])$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T18b blamed car kept', v_drop, 'INVALID driver_ids');
  perform staff_fixture.expect('T18b cars unchanged',
    (select count(*) from public.incident_report_drivers where report_id = 'aaaaaaaa-0000-0000-0000-000000000b01'), 2::bigint);
  raise notice 'ok T18b blamed car kept';
end $$;
rollback to savepoint fixture;

-- T19 Bad values are refused with their field (BR4.3) ----------------------------------------------------
do $$
declare
  v_session text;
  v_lap text;
  v_turn text;
  v_none text;
  v_unknown text;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b01');
  set local role authenticated;
  v_session := staff_fixture.error_field($q$select public.edit_incident_report_submission('aaaaaaaa-0000-0000-0000-000000000b01',
    'race:x', 4, 'T1', array['99999999-0000-0000-0000-000000000b01']::uuid[])$q$);
  v_lap := staff_fixture.error_field($q$select public.edit_incident_report_submission('aaaaaaaa-0000-0000-0000-000000000b01',
    'race:1', 1001, 'T1', array['99999999-0000-0000-0000-000000000b01']::uuid[])$q$);
  v_turn := staff_fixture.error_field($q$select public.edit_incident_report_submission('aaaaaaaa-0000-0000-0000-000000000b01',
    'race:1', 4, '   ', array['99999999-0000-0000-0000-000000000b01']::uuid[])$q$);
  v_none := staff_fixture.error_field($q$select public.edit_incident_report_submission('aaaaaaaa-0000-0000-0000-000000000b01',
    'race:1', 4, 'T1', array[]::uuid[])$q$);
  v_unknown := staff_fixture.error_field($q$select public.edit_incident_report_submission('aaaaaaaa-0000-0000-0000-000000000b01',
    'race:1', 4, 'T1', array['99999999-0000-0000-0000-0000000000ff']::uuid[])$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T19 session', v_session, 'INVALID session');
  perform staff_fixture.expect('T19 lap', v_lap, 'INVALID lap');
  perform staff_fixture.expect('T19 turn', v_turn, 'INVALID turn');
  perform staff_fixture.expect('T19 no cars', v_none, 'INVALID driver_ids');
  perform staff_fixture.expect('T19 unknown car', v_unknown, 'INVALID driver_ids');
  raise notice 'ok T19 bad values';
end $$;
rollback to savepoint fixture;

-- T20 A driver can't edit a submission (BR4.1) ------------------------------------------------------------
do $$
declare
  v text;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b05');
  set local role authenticated;
  v := staff_fixture.error_state($q$select public.edit_incident_report_submission('aaaaaaaa-0000-0000-0000-000000000b01',
    'race:1', 5, 'T1', array['99999999-0000-0000-0000-000000000b01']::uuid[])$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T20 driver', v, '42501');
  raise notice 'ok T20 panel access only';
end $$;
rollback to savepoint fixture;

-- (e) T21 The new sign-up call requires iRating and checks the nationalities (BR5.1) ---------------------
do $$
declare
  v_missing text;
  v_range text;
  v_second_only text;
  v_same text;
  v_bad_code text;
  v_ok uuid;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b03');
  set local role authenticated;
  v_missing := staff_fixture.error_field($q$select public.submit_driver_signup('Nico Newman', 55, null, 123456, null, null)$q$);
  v_range := staff_fixture.error_field($q$select public.submit_driver_signup('Nico Newman', 55, 20001, 123456, null, null)$q$);
  v_second_only := staff_fixture.error_field($q$select public.submit_driver_signup('Nico Newman', 55, 2100, 123456, null, 'ca')$q$);
  v_same := staff_fixture.error_field($q$select public.submit_driver_signup('Nico Newman', 55, 2100, 123456, 'us', 'US')$q$);
  v_bad_code := staff_fixture.error_field($q$select public.submit_driver_signup('Nico Newman', 55, 2100, 123456, 'usa', null)$q$);
  v_ok := public.submit_driver_signup(' Nico Newman ', 55, 2100, 123456, ' US ', 'ca');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T21 missing iRating', v_missing, 'INVALID irating');
  perform staff_fixture.expect('T21 iRating out of range', v_range, 'INVALID irating');
  perform staff_fixture.expect('T21 nationality 2 alone', v_second_only, 'INVALID nationality_2');
  perform staff_fixture.expect('T21 same nationality twice', v_same, 'INVALID nationality_2');
  perform staff_fixture.expect('T21 not a country code', v_bad_code, 'INVALID nationality_1');
  perform staff_fixture.expect('T21 row',
    (select format('%s %s %s %s %s', name, requested_numbers, irating, nationality_1, nationality_2)
     from public.signup_requests where id = v_ok), 'Nico Newman {55} 2100 us ca');
  raise notice 'ok T21 sign-up fields';
end $$;
rollback to savepoint fixture;

-- T22 Taken and requested numbers, and the taken-numbers list (BR5.2, BR5.3) ------------------------------
do $$
declare
  v_taken text;
  v_requested text;
  v_inactive text;
  v_list integer[];
  v_anon text;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b04');
  set local role authenticated;
  perform public.submit_driver_signup('Bob Pending', 56, 1500, 223344, null, null);
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b03');
  v_taken := staff_fixture.error_code($q$select public.submit_driver_signup('Nico Newman', 12, 2100, 123456, null, null)$q$);
  v_requested := staff_fixture.error_code($q$select public.submit_driver_signup('Nico Newman', 56, 2100, 123456, null, null)$q$);
  v_list := public.taken_car_numbers();
  v_inactive := staff_fixture.error_code($q$select public.submit_driver_signup('Nico Newman', 30, 2100, 123456, null, null)$q$);
  reset role;
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  set local role authenticated;
  v_anon := staff_fixture.error_code($q$select public.taken_car_numbers()$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T22 held by a driver', v_taken, 'CAR_NUMBER_TAKEN');
  perform staff_fixture.expect('T22 asked for by a pending request', v_requested, 'CAR_NUMBER_REQUESTED');
  perform staff_fixture.expect('T22 held only by an Inactive driver', v_inactive, 'ok');
  perform staff_fixture.expect('T22 list has 7, 12, 20, 40 and 56', v_list @> array[7, 12, 20, 40, 56], true);
  perform staff_fixture.expect('T22 list leaves out 30', 30 = any (v_list), false);
  perform staff_fixture.expect('T22 signed out', v_anon, 'NOT_AUTHENTICATED');
  raise notice 'ok T22 numbers';
end $$;
rollback to savepoint fixture;

-- T23 The old three-field call still works, with named arguments, and stores no iRating (BR5.5) ----------
do $$
declare
  v_id uuid;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b03');
  set local role authenticated;
  v_id := public.submit_driver_request(p_name => 'Nico Newman', p_car_number => 55, p_iracing_cust_id => 123456);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T23 row',
    (select format('%s %s %s %s', source, status, requested_numbers, coalesce(irating::text, '-'))
     from public.signup_requests where id = v_id), 'website pending {55} -');
  raise notice 'ok T23 old call';
end $$;
rollback to savepoint fixture;

-- T24 Approval copies iRating and nationalities: set on a new driver, only filling a returning one (BR5.6)
do $$
declare
  v_new uuid;
  v_returning uuid;
  v_result jsonb;
begin
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b03');
  set local role authenticated;
  v_new := public.submit_driver_signup('Nico Newman', 55, 2100, 123456, 'us', 'ca');
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b04');
  v_returning := public.submit_driver_signup('Bea Browning', 57, 3300, 555000, 'gb', 'ie');
  reset role;
  -- The request names Bea's own iRacing id, as a returning driver's would.
  update public.signup_requests set iracing_cust_id = 555 where id = v_returning;
  set local role authenticated;
  perform staff_fixture.claims('eeeeeeee-0000-0000-0000-000000000b01');
  v_result := public.approve_signup_request(v_new, 'Nico Newman', null, (select id from public.driver_classes where name = 'Alpha'), null);
  perform public.approve_signup_request(v_returning, 'Bea Browning', null, (select id from public.driver_classes where name = 'Alpha'),
    '99999999-0000-0000-0000-000000000b02');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform staff_fixture.expect('T24 new driver',
    (select format('%s %s %s', starting_irating, nationality_1, nationality_2) from public.drivers
     where id = (v_result ->> 'driver_id')::uuid), '2100 us ca');
  perform staff_fixture.expect('T24 returning driver keeps her nationality, gains iRating and a second one',
    (select format('%s %s %s', starting_irating, nationality_1, nationality_2) from public.drivers
     where id = '99999999-0000-0000-0000-000000000b02'), '3300 gb ie');
  raise notice 'ok T24 approval copies';
end $$;
rollback to savepoint fixture;

rollback;
