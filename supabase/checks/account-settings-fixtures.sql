-- Account settings fixtures for 20261028120000_account_settings.sql (U3 profile-settings): the owner-only
-- account_settings table (Row Level Security, column grants, cascade), the per-account email limit
-- claim_email_action() and its grants, and the avatar delete policy (A01-A12).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- driver-linking-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/account-settings-fixtures.sql
--
-- Same conventions as driver-linking-fixtures.sql (supabase/checks/README.md): every assertion calls
-- account_settings_fixture.expect(), which raises naming the case; one transaction, rolled back at the
-- end; each case runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`.
-- Callers are impersonated with request.jwt.claims and `set local role authenticated` (or anon).
--
-- Users: admin, a (owner, linked to driver Ada Settings), b (another account).

begin;

set local client_min_messages = notice;

create schema account_settings_fixture;

create function account_settings_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement)
  returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'account settings fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- The first word of an error message ('RATE_LIMITED: ...' -> 'RATE_LIMITED'), or 'ok' when p_sql
-- runs without error. Runs as the current role, so callers set the role first.
create function account_settings_fixture.error_code(p_sql text) returns text
  language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return split_part(sqlerrm, ':', 1);
end;
$$;

-- The SQLSTATE p_sql fails with, or 'ok'.
create function account_settings_fixture.error_state(p_sql text) returns text
  language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- Acts as p_user for the rest of the transaction (or until the claims are cleared).
create function account_settings_fixture.claims(p_user uuid) returns void
  language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

grant usage on schema account_settings_fixture to authenticated, anon;
grant execute on all functions in schema account_settings_fixture to authenticated, anon;

-- Base data ------------------------------------------------------------------------------------

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (811, 'Active')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select 811, 'Alpha', 1 where not exists (select 1 from public.driver_classes where name = 'Alpha');

insert into public.drivers (id, name, car_number, status_id, class_id, is_ai) values
  ('99999999-0000-0000-0000-000000000501', 'Ada Settings', 51,
   (select id from public.driver_statuses where name = 'Active'),
   (select id from public.driver_classes where name = 'Alpha'), false);

-- The auth.users insert creates a 'driver' profile; the admin and the linked owner are re-inserted,
-- because as postgres the profiles guard refuses a role or driver change.
insert into auth.users (id, email, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000501', 'settings-admin@example.test', '{"display_name":"Settings Admin"}'),
  ('eeeeeeee-0000-0000-0000-000000000502', 'settings-a@example.test', '{"display_name":"Owner A"}'),
  ('eeeeeeee-0000-0000-0000-000000000503', 'settings-b@example.test', '{"display_name":"Other B"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000000501', 'eeeeeeee-0000-0000-0000-000000000502');
insert into public.profiles (id, role, display_name) values
  ('eeeeeeee-0000-0000-0000-000000000501', 'admin', 'Settings Admin');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000502', 'driver', 'Owner A', '99999999-0000-0000-0000-000000000501');

savepoint fixture;

-- A01 Owner inserts, updates (the site's upsert) and reads their own row; defaults are off (BR5.5, BR6.1)
do $$
declare
  v_defaults text;
  v_after text;
begin
  perform account_settings_fixture.claims('eeeeeeee-0000-0000-0000-000000000502');
  set local role authenticated;
  insert into public.account_settings (profile_id) values ('eeeeeeee-0000-0000-0000-000000000502');
  -- Cast to text: concat_ws prints a bare boolean as t/f.
  select concat_ws(',', hide_profile::text, hide_name::text, notify_appeal_reviewed::text,
                   notify_report_posted::text, notify_event_reminders::text)
    into v_defaults
  from public.account_settings where profile_id = 'eeeeeeee-0000-0000-0000-000000000502';
  insert into public.account_settings (profile_id, hide_profile, hide_name, notify_appeal_reviewed,
                                       notify_report_posted, notify_event_reminders)
  values ('eeeeeeee-0000-0000-0000-000000000502', true, false, true, false, true)
  -- The same SET list PostgREST's merge-duplicates upsert sends, profile_id included.
  on conflict (profile_id) do update set
    profile_id = excluded.profile_id, hide_profile = excluded.hide_profile, hide_name = excluded.hide_name,
    notify_appeal_reviewed = excluded.notify_appeal_reviewed, notify_report_posted = excluded.notify_report_posted,
    notify_event_reminders = excluded.notify_event_reminders;
  select concat_ws(',', hide_profile::text, hide_name::text, notify_appeal_reviewed::text,
                   notify_report_posted::text, notify_event_reminders::text)
    into v_after
  from public.account_settings where profile_id = 'eeeeeeee-0000-0000-0000-000000000502';
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform account_settings_fixture.expect('A01 defaults off', v_defaults, 'false,false,false,false,false');
  perform account_settings_fixture.expect('A01 upsert saved', v_after, 'true,false,true,false,true');
  raise notice 'ok A01 owner read and write';
end $$;
rollback to savepoint fixture;

-- A02 Another account's row is invisible and an update changes nothing (BR5.6) ---------------------
do $$
declare
  v_seen bigint;
  v_rows integer;
begin
  insert into public.account_settings (profile_id, hide_name) values ('eeeeeeee-0000-0000-0000-000000000502', true);
  perform account_settings_fixture.claims('eeeeeeee-0000-0000-0000-000000000503');
  set local role authenticated;
  select count(*) into v_seen from public.account_settings where profile_id = 'eeeeeeee-0000-0000-0000-000000000502';
  update public.account_settings set hide_name = false where profile_id = 'eeeeeeee-0000-0000-0000-000000000502';
  get diagnostics v_rows = row_count;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform account_settings_fixture.expect('A02 row invisible', v_seen, 0::bigint);
  perform account_settings_fixture.expect('A02 update affects nothing', v_rows, 0);
  perform account_settings_fixture.expect('A02 value unchanged',
    (select hide_name from public.account_settings where profile_id = 'eeeeeeee-0000-0000-0000-000000000502'), true);
  raise notice 'ok A02 other account cannot read or change';
end $$;
rollback to savepoint fixture;

-- A03 Inserting a row for another account fails (BR5.6) --------------------------------------------
do $$
declare
  v text;
begin
  perform account_settings_fixture.claims('eeeeeeee-0000-0000-0000-000000000503');
  set local role authenticated;
  v := account_settings_fixture.error_state(
    $q$insert into public.account_settings (profile_id, hide_profile) values ('eeeeeeee-0000-0000-0000-000000000502', true)$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform account_settings_fixture.expect('A03 insert for another account', v, '42501');
  raise notice 'ok A03 no rows for other accounts';
end $$;
rollback to savepoint fixture;

-- A04 Anon has no access to the table (NFR1.1) ------------------------------------------------------
do $$
declare
  v_select text;
  v_insert text;
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  v_select := account_settings_fixture.error_state($q$select count(*) from public.account_settings$q$);
  v_insert := account_settings_fixture.error_state(
    $q$insert into public.account_settings (profile_id) values ('eeeeeeee-0000-0000-0000-000000000502')$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform account_settings_fixture.expect('A04 anon select', v_select, '42501');
  perform account_settings_fixture.expect('A04 anon insert', v_insert, '42501');
  raise notice 'ok A04 anon has no access';
end $$;
rollback to savepoint fixture;

-- A05 An admin can read another account's row (BR5.6) -----------------------------------------------
do $$
declare
  v boolean;
begin
  insert into public.account_settings (profile_id, notify_report_posted) values ('eeeeeeee-0000-0000-0000-000000000502', true);
  perform account_settings_fixture.claims('eeeeeeee-0000-0000-0000-000000000501');
  set local role authenticated;
  select notify_report_posted into v from public.account_settings where profile_id = 'eeeeeeee-0000-0000-0000-000000000502';
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform account_settings_fixture.expect('A05 admin reads', v, true);
  raise notice 'ok A05 admin can read';
end $$;
rollback to savepoint fixture;

-- A06 Deleting the profile deletes its settings row (cascade) -----------------------------------------
do $$
begin
  insert into public.account_settings (profile_id, hide_profile) values ('eeeeeeee-0000-0000-0000-000000000503', true);
  delete from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000503';
  perform account_settings_fixture.expect('A06 row gone with its profile',
    (select count(*) from public.account_settings where profile_id = 'eeeeeeee-0000-0000-0000-000000000503'), 0::bigint);
  raise notice 'ok A06 cascade';
end $$;
rollback to savepoint fixture;

-- A07 claim_email_action: the first call goes through (creating the row), a second within 60 s is refused
--     (NFR1.4, NFR1.5). now() is fixed within one transaction, so both calls fall in the same minute.
do $$
declare
  v_first text;
  v_second text;
  v_row text;
begin
  perform account_settings_fixture.claims('eeeeeeee-0000-0000-0000-000000000503');
  set local role authenticated;
  v_first := account_settings_fixture.error_code($q$select public.claim_email_action()$q$);
  v_second := account_settings_fixture.error_code($q$select public.claim_email_action()$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  select concat_ws(',', hide_profile::text, (last_email_action_at is not null)::text) into v_row
  from public.account_settings where profile_id = 'eeeeeeee-0000-0000-0000-000000000503';
  perform account_settings_fixture.expect('A07 first call', v_first, 'ok');
  perform account_settings_fixture.expect('A07 second call', v_second, 'RATE_LIMITED');
  perform account_settings_fixture.expect('A07 row created with defaults and the stamp', v_row, 'false,true');
  raise notice 'ok A07 email limit';
end $$;
rollback to savepoint fixture;

-- A08 claim_email_action after the window passes, and without a sign-in -------------------------------
do $$
declare
  v_after_window text;
  v_signed_out text;
begin
  insert into public.account_settings (profile_id, last_email_action_at)
  values ('eeeeeeee-0000-0000-0000-000000000503', now() - interval '61 seconds');
  perform account_settings_fixture.claims('eeeeeeee-0000-0000-0000-000000000503');
  set local role authenticated;
  v_after_window := account_settings_fixture.error_code($q$select public.claim_email_action()$q$);
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  v_signed_out := account_settings_fixture.error_code($q$select public.claim_email_action()$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform account_settings_fixture.expect('A08 after the window', v_after_window, 'ok');
  perform account_settings_fixture.expect('A08 no user', v_signed_out, 'NOT_AUTHENTICATED');
  raise notice 'ok A08 window and sign-in';
end $$;
rollback to savepoint fixture;

-- A09 The owner cannot move the email limit or write the stamp directly (column grants) ------------------
do $$
declare
  v_update text;
  v_insert text;
begin
  insert into public.account_settings (profile_id, last_email_action_at)
  values ('eeeeeeee-0000-0000-0000-000000000502', now());
  perform account_settings_fixture.claims('eeeeeeee-0000-0000-0000-000000000502');
  set local role authenticated;
  v_update := account_settings_fixture.error_state(
    $q$update public.account_settings set last_email_action_at = null where profile_id = 'eeeeeeee-0000-0000-0000-000000000502'$q$);
  reset role;
  perform account_settings_fixture.claims('eeeeeeee-0000-0000-0000-000000000503');
  set local role authenticated;
  v_insert := account_settings_fixture.error_state(
    $q$insert into public.account_settings (profile_id, last_email_action_at) values ('eeeeeeee-0000-0000-0000-000000000503', null)$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform account_settings_fixture.expect('A09 update the stamp', v_update, '42501');
  perform account_settings_fixture.expect('A09 insert the stamp', v_insert, '42501');
  raise notice 'ok A09 stamp written only by claim_email_action';
end $$;
rollback to savepoint fixture;

-- A10 Grants: claim_email_action for signed-in callers only (NFR1.4) ------------------------------------
do $$
begin
  perform account_settings_fixture.expect('A10 anon cannot execute',
    has_function_privilege('anon', 'public.claim_email_action()', 'execute'), false);
  perform account_settings_fixture.expect('A10 authenticated can execute',
    has_function_privilege('authenticated', 'public.claim_email_action()', 'execute'), true);
  perform account_settings_fixture.expect('A10 anon has no table privilege',
    has_table_privilege('anon', 'public.account_settings', 'select'), false);
  perform account_settings_fixture.expect('A10 no delete for authenticated',
    has_table_privilege('authenticated', 'public.account_settings', 'delete'), false);
  raise notice 'ok A10 grants';
end $$;
rollback to savepoint fixture;

-- A11 The avatar delete policy covers only the driver's own folder (NFR4.1) -----------------------------
do $$
declare
  v_qual text;
begin
  select qual into v_qual from pg_policies
  where schemaname = 'storage' and tablename = 'objects' and policyname = 'driver delete own avatar' and cmd = 'DELETE';
  perform account_settings_fixture.expect('A11 policy exists', v_qual is not null, true);
  perform account_settings_fixture.expect('A11 photos bucket only', position('photos' in v_qual) > 0, true);
  perform account_settings_fixture.expect('A11 avatar folder only', position('driver-avatars' in v_qual) > 0, true);
  raise notice 'ok A11 avatar delete policy';
end $$;
rollback to savepoint fixture;

-- A12 The owner cannot repoint their row at another account through profile_id (update with check) -------
do $$
declare
  v_state text;
begin
  insert into public.account_settings (profile_id) values ('eeeeeeee-0000-0000-0000-000000000502');
  perform account_settings_fixture.claims('eeeeeeee-0000-0000-0000-000000000502');
  set local role authenticated;
  v_state := account_settings_fixture.error_state(
    $q$update public.account_settings set profile_id = 'eeeeeeee-0000-0000-0000-000000000503' where profile_id = 'eeeeeeee-0000-0000-0000-000000000502'$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform account_settings_fixture.expect('A12 repoint profile_id', v_state, '42501');
  raise notice 'ok A12 profile_id pinned to the owner';
end $$;
rollback to savepoint fixture;

rollback;
