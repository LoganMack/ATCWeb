-- Driver linking fixtures for 20261027120000_driver_linking.sql (U2 driver-linking): self-linking
-- through link_my_driver and the profiles guard, the unique driver link, website driver requests,
-- admin approval and rejection of website requests, the Discord bot's rejection feed, account
-- deletion and the grants on the self-service functions (L01-L22).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- round-stats-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/driver-linking-fixtures.sql
--
-- Same conventions as scoring-fixtures.sql (supabase/checks/README.md): every assertion calls
-- driver_link_fixture.expect(), which raises naming the case; one transaction, rolled back at the end;
-- each case runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`.
--
-- Callers are impersonated with request.jwt.claims and `set local role authenticated`. True
-- two-session races cannot run in one transaction, so the unique index is asserted directly (L06).
--
-- Base data: drivers Amy Brown #12, Bea Browning #7 (iRacing 555), AI Bot #99 (AI), Cara Linked #20
-- (linked to user c) and Old Timer #30 (Inactive). Users: admin, a, b and d (unlinked), c (linked).

begin;

set local client_min_messages = notice;

create schema driver_link_fixture;

create function driver_link_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'driver linking fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- The first word of an error message ('DRIVER_TAKEN: ...' -> 'DRIVER_TAKEN'), or 'ok' when p_sql
-- runs without error. Runs as the current role, so callers set the role first.
create function driver_link_fixture.error_code(p_sql text) returns text
  language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return split_part(sqlerrm, ':', 1);
end;
$$;

-- The SQLSTATE p_sql fails with, or 'ok'.
create function driver_link_fixture.error_state(p_sql text) returns text
  language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- Acts as p_user for the rest of the transaction (or until driver_link_fixture.as_postgres()).
create function driver_link_fixture.claims(p_user uuid) returns void
  language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

grant usage on schema driver_link_fixture to authenticated;
grant execute on all functions in schema driver_link_fixture to authenticated;

-- Base data ------------------------------------------------------------------------------------

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (801, 'Active'), (802, 'New'), (803, 'Inactive')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select 801, 'Alpha', 1 where not exists (select 1 from public.driver_classes where name = 'Alpha');

insert into public.drivers (id, name, car_number, status_id, class_id, iracing_cust_id, is_ai) values
  ('99999999-0000-0000-0000-000000000001', 'Amy Brown', 12,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), null, false),
  ('99999999-0000-0000-0000-000000000002', 'Bea Browning', 7,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), 555, false),
  ('99999999-0000-0000-0000-000000000003', 'AI Bot', 99,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), null, true),
  ('99999999-0000-0000-0000-000000000004', 'Cara Linked', 20,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), null, false),
  ('99999999-0000-0000-0000-000000000005', 'Old Timer', 30,
   (select id from public.driver_statuses where name = 'Inactive'), (select id from public.driver_classes where name = 'Alpha'), null, false);

-- Accounts (the auth.users insert creates a 'driver' profile; the admin and the linked account are
-- re-inserted, because as postgres the profiles guard refuses a role or driver change).
insert into auth.users (id, email, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000401', 'link-admin@example.test', '{"display_name":"Link Admin"}'),
  ('eeeeeeee-0000-0000-0000-000000000402', 'link-a@example.test', '{"display_name":"Driver A"}'),
  ('eeeeeeee-0000-0000-0000-000000000403', 'link-b@example.test', '{"display_name":"Driver B"}'),
  ('eeeeeeee-0000-0000-0000-000000000404', 'link-c@example.test', '{"display_name":"Driver C"}'),
  ('eeeeeeee-0000-0000-0000-000000000405', 'link-d@example.test', '{"display_name":"Driver D"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000000401', 'eeeeeeee-0000-0000-0000-000000000404');
insert into public.profiles (id, role, display_name) values
  ('eeeeeeee-0000-0000-0000-000000000401', 'admin', 'Link Admin');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000404', 'driver', 'Driver C', '99999999-0000-0000-0000-000000000004');

-- A Discord sign-up, as the bot writes it (source defaults to discord).
insert into public.signup_requests (id, discord_user_id, discord_username, name, iracing_cust_id, requested_numbers)
values ('dddddddd-0000-0000-0000-000000000401', '123456789', 'discord-person', 'Discord Person', 777, array[40]);

savepoint fixture;

-- L01 The linking list: unlinked, not AI, alphabetical (BR3.3) -----------------------------------
do $$
declare
  v text;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000402');
  set local role authenticated;
  select string_agg(name || ' #' || coalesce(car_number::text, '-'), ', ') into v from public.list_unlinked_drivers();
  reset role;
  perform driver_link_fixture.expect('L01 unlinked drivers', v, 'Amy Brown #12, Bea Browning #7, Old Timer #30');
  raise notice 'ok L01 linking list';
end $$;
rollback to savepoint fixture;

-- L02 Self-link happy path and its activity row (BR3.6, NFR9.2) -----------------------------------
do $$
declare
  v_result jsonb;
  v_state jsonb;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000402');
  set local role authenticated;
  v_result := public.link_my_driver('99999999-0000-0000-0000-000000000001');
  v_state := public.my_link_state();
  reset role;
  perform driver_link_fixture.expect('L02 returns the driver', v_result ->> 'driver_id', '99999999-0000-0000-0000-000000000001');
  perform driver_link_fixture.expect('L02 profile linked',
    (select driver_id from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000402'),
    '99999999-0000-0000-0000-000000000001'::uuid);
  perform driver_link_fixture.expect('L02 link state', v_state ->> 'linked', 'true');
  perform driver_link_fixture.expect('L02 one activity row',
    (select count(*) from public.activity_log
     where actor_id = 'eeeeeeee-0000-0000-0000-000000000402' and action = 'edit' and entity_type = 'driver'
       and entity_id = '99999999-0000-0000-0000-000000000001'
       and entity_label = 'Driver A linked their account to Amy Brown'), 1::bigint);
  perform driver_link_fixture.expect('L02 the guard setting is off again',
    coalesce(current_setting('atc.self_link', true), ''), 'off');
  raise notice 'ok L02 self-link';
end $$;
rollback to savepoint fixture;

-- L03 ALREADY_LINKED, and the guard after a link in the same transaction (NFR1.1, NFR1.3) --------
do $$
declare
  v_second text;
  v_direct text;
  v_unlink text;
  v_other text;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000402');
  set local role authenticated;
  perform public.link_my_driver('99999999-0000-0000-0000-000000000001');
  v_second := driver_link_fixture.error_code($q$select public.link_my_driver('99999999-0000-0000-0000-000000000002')$q$);
  v_direct := driver_link_fixture.error_state($q$update public.profiles set driver_id = '99999999-0000-0000-0000-000000000002'
    where id = 'eeeeeeee-0000-0000-0000-000000000402'$q$);
  v_unlink := driver_link_fixture.error_state($q$update public.profiles set driver_id = null
    where id = 'eeeeeeee-0000-0000-0000-000000000402'$q$);
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  v_other := driver_link_fixture.error_state($q$update public.profiles set driver_id = '99999999-0000-0000-0000-000000000002'
    where id = 'eeeeeeee-0000-0000-0000-000000000403'$q$);
  reset role;
  perform driver_link_fixture.expect('L03 second link', v_second, 'ALREADY_LINKED');
  perform driver_link_fixture.expect('L03 direct change after a link', v_direct, '42501');
  perform driver_link_fixture.expect('L03 direct unlink', v_unlink, '42501');
  perform driver_link_fixture.expect('L03 direct link from null', v_other, '42501');
  perform driver_link_fixture.expect('L03 link unchanged',
    (select driver_id from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000402'),
    '99999999-0000-0000-0000-000000000001'::uuid);
  raise notice 'ok L03 already linked and the guard';
end $$;
rollback to savepoint fixture;

-- L04 DRIVER_TAKEN and NOT_FOUND (BR3.6, BR3.7) ---------------------------------------------------
do $$
declare
  v_taken text;
  v_ai text;
  v_missing text;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  set local role authenticated;
  v_taken := driver_link_fixture.error_code($q$select public.link_my_driver('99999999-0000-0000-0000-000000000004')$q$);
  v_ai := driver_link_fixture.error_code($q$select public.link_my_driver('99999999-0000-0000-0000-000000000003')$q$);
  v_missing := driver_link_fixture.error_code($q$select public.link_my_driver('99999999-0000-0000-0000-0000000000ff')$q$);
  reset role;
  perform driver_link_fixture.expect('L04 driver linked elsewhere', v_taken, 'DRIVER_TAKEN');
  perform driver_link_fixture.expect('L04 AI driver', v_ai, 'NOT_FOUND');
  perform driver_link_fixture.expect('L04 no such driver', v_missing, 'NOT_FOUND');
  perform driver_link_fixture.expect('L04 still unlinked',
    (select driver_id from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000403'), null::uuid);
  raise notice 'ok L04 taken and not found';
end $$;
rollback to savepoint fixture;

-- L05 Signed-out callers get nothing (NFR1.4) -----------------------------------------------------
do $$
declare
  v_link text;
  v_list text;
begin
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  set local role authenticated;
  v_link := driver_link_fixture.error_code($q$select public.link_my_driver('99999999-0000-0000-0000-000000000001')$q$);
  v_list := driver_link_fixture.error_code($q$select * from public.list_unlinked_drivers()$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform driver_link_fixture.expect('L05 link without a user', v_link, 'NOT_AUTHENTICATED');
  perform driver_link_fixture.expect('L05 list without a user', v_list, 'NOT_AUTHENTICATED');
  raise notice 'ok L05 signed-out callers';
end $$;
rollback to savepoint fixture;

-- L06 The unique link refuses a second account on one driver, also for an admin (NFR1.2) ---------
do $$
declare
  v text;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000401');
  set local role authenticated;
  v := driver_link_fixture.error_state($q$update public.profiles set driver_id = '99999999-0000-0000-0000-000000000004'
    where id = 'eeeeeeee-0000-0000-0000-000000000403'$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform driver_link_fixture.expect('L06 admin set-driver onto a linked driver', v, '23505');
  raise notice 'ok L06 unique driver link';
end $$;
rollback to savepoint fixture;

-- L07 Website request: validation codes in order (BR3.10) -----------------------------------------
do $$
declare
  v_name text;
  v_number text;
  v_iracing text;
  v_taken text;
  v_iracing_taken text;
  v_linked text;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  set local role authenticated;
  v_name := driver_link_fixture.error_code($q$select public.submit_driver_request('   ', 55, 123456)$q$);
  v_number := driver_link_fixture.error_code($q$select public.submit_driver_request('Nico Newman', 1000, 123456)$q$);
  v_iracing := driver_link_fixture.error_code($q$select public.submit_driver_request('Nico Newman', 55, 0)$q$);
  v_taken := driver_link_fixture.error_code($q$select public.submit_driver_request('Nico Newman', 12, 123456)$q$);
  v_iracing_taken := driver_link_fixture.error_code($q$select public.submit_driver_request('Nico Newman', 55, 555)$q$);
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000404');
  v_linked := driver_link_fixture.error_code($q$select public.submit_driver_request('Nico Newman', 55, 123456)$q$);
  reset role;
  perform driver_link_fixture.expect('L07 empty name', v_name, 'INVALID');
  perform driver_link_fixture.expect('L07 number out of range', v_number, 'INVALID');
  perform driver_link_fixture.expect('L07 iRacing id not positive', v_iracing, 'INVALID');
  perform driver_link_fixture.expect('L07 number held by an active driver', v_taken, 'CAR_NUMBER_TAKEN');
  perform driver_link_fixture.expect('L07 iRacing id of a driver', v_iracing_taken, 'IRACING_ID_TAKEN');
  perform driver_link_fixture.expect('L07 linked account', v_linked, 'ALREADY_LINKED');
  perform driver_link_fixture.expect('L07 nothing inserted',
    (select count(*) from public.signup_requests where source = 'website'), 0::bigint);
  raise notice 'ok L07 request validation';
end $$;
rollback to savepoint fixture;

-- L08 Website request happy path, pending state and REQUEST_PENDING (BR3.10, BR3.11) --------------
do $$
declare
  v_id uuid;
  v_state jsonb;
  v_again text;
  v_inactive text;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  set local role authenticated;
  v_id := public.submit_driver_request('  Nico Newman ', 55, 123456);
  v_state := public.my_link_state();
  v_again := driver_link_fixture.error_code($q$select public.submit_driver_request('Nico Newman', 56, 123457)$q$);
  -- A number held only by an Inactive driver is free to ask for.
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000405');
  v_inactive := driver_link_fixture.error_code($q$select public.submit_driver_request('Dee Driver', 30, 222)$q$);
  reset role;
  perform driver_link_fixture.expect('L08 row shape',
    (select format('%s %s %s %s %s %s', source, status, name, requested_numbers, iracing_cust_id, discord_user_id is null)
     from public.signup_requests where id = v_id),
    'website pending Nico Newman {55} 123456 true');
  perform driver_link_fixture.expect('L08 pending state', v_state -> 'request' ->> 'status', 'pending');
  perform driver_link_fixture.expect('L08 state number', v_state -> 'request' ->> 'car_number', '55');
  perform driver_link_fixture.expect('L08 still unlinked', v_state ->> 'linked', 'false');
  perform driver_link_fixture.expect('L08 second request', v_again, 'REQUEST_PENDING');
  perform driver_link_fixture.expect('L08 inactive holder', v_inactive, 'ok');
  raise notice 'ok L08 website request';
end $$;
rollback to savepoint fixture;

-- L09 Three requests a day (abuse limit) ----------------------------------------------------------
insert into public.signup_requests (source, requester_profile_id, name, iracing_cust_id, requested_numbers, status, reason)
select 'website', 'eeeeeeee-0000-0000-0000-000000000403', 'Nico Newman', 123456, array[55], 'rejected', 'Fixture'
from generate_series(1, 3);
do $$
declare
  v text;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  set local role authenticated;
  v := driver_link_fixture.error_code($q$select public.submit_driver_request('Nico Newman', 55, 123456)$q$);
  reset role;
  perform driver_link_fixture.expect('L09 fourth request in 24 hours', v, 'REQUEST_LIMIT');
  raise notice 'ok L09 request limit';
end $$;
rollback to savepoint fixture;

-- L10 Linking an existing driver cancels the pending request (BR3.9) -------------------------------
do $$
declare
  v_id uuid;
  v_state jsonb;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  set local role authenticated;
  v_id := public.submit_driver_request('Nico Newman', 55, 123456);
  perform public.link_my_driver('99999999-0000-0000-0000-000000000002');
  v_state := public.my_link_state();
  reset role;
  perform driver_link_fixture.expect('L10 request cancelled',
    (select status || ' ' || (decided_at is not null) from public.signup_requests where id = v_id), 'cancelled true');
  perform driver_link_fixture.expect('L10 no request in the state', v_state -> 'request', 'null'::jsonb);
  raise notice 'ok L10 link cancels the request';
end $$;
rollback to savepoint fixture;

-- L11 Approving a website request creates the driver and links the requester (BR3.13) ------------
do $$
declare
  v_id uuid;
  v_result jsonb;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  set local role authenticated;
  v_id := public.submit_driver_request('Nico Newman', 55, 123456);
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000401');
  -- The admin corrects the iRacing id at approval.
  v_result := public.approve_signup_request(v_id, 'Nico Newman', 654321,
    (select id from public.driver_classes where name = 'Alpha'), null);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform driver_link_fixture.expect('L11 new driver',
    (select format('%s #%s %s', name, car_number, iracing_cust_id) from public.drivers where id = (v_result ->> 'driver_id')::uuid),
    'Nico Newman #55 654321');
  perform driver_link_fixture.expect('L11 requester linked',
    (select driver_id from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000403'),
    (v_result ->> 'driver_id')::uuid);
  perform driver_link_fixture.expect('L11 request approved',
    (select status || ' ' || iracing_cust_id from public.signup_requests where id = v_id), 'approved 654321');
  raise notice 'ok L11 approve links the requester';
end $$;
rollback to savepoint fixture;

-- L12 REQUESTER_ALREADY_LINKED leaves the request pending and nothing created (NFR4.1) ------------
do $$
declare
  v_id uuid;
  v text;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  set local role authenticated;
  v_id := public.submit_driver_request('Nico Newman', 55, 123456);
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000401');
  -- The requester is linked by an admin meanwhile (a pending request can outlive that).
  update public.profiles set driver_id = '99999999-0000-0000-0000-000000000002' where id = 'eeeeeeee-0000-0000-0000-000000000403';
  v := driver_link_fixture.error_code(format(
    $q$select public.approve_signup_request(%L, 'Nico Newman', null, (select id from public.driver_classes where name = 'Alpha'), null)$q$, v_id));
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform driver_link_fixture.expect('L12 code', v, 'REQUESTER_ALREADY_LINKED');
  perform driver_link_fixture.expect('L12 still pending', (select status from public.signup_requests where id = v_id), 'pending');
  perform driver_link_fixture.expect('L12 no driver created',
    (select count(*) from public.drivers where name = 'Nico Newman'), 0::bigint);
  raise notice 'ok L12 requester already linked';
end $$;
rollback to savepoint fixture;

-- L13 DRIVER_ALREADY_LINKED: a failed approval changes nothing (NFR1.5, NFR4.1) --------------------
do $$
declare
  v_id uuid;
  v text;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  set local role authenticated;
  v_id := public.submit_driver_request('Nico Newman', 55, 123456);
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000401');
  -- Approved as returning driver Cara Linked, whom account c already holds.
  v := driver_link_fixture.error_code(format(
    $q$select public.approve_signup_request(%L, 'Nico Newman', null, (select id from public.driver_classes where name = 'Alpha'),
      '99999999-0000-0000-0000-000000000004')$q$, v_id));
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform driver_link_fixture.expect('L13 code', v, 'DRIVER_ALREADY_LINKED');
  perform driver_link_fixture.expect('L13 still pending', (select status from public.signup_requests where id = v_id), 'pending');
  perform driver_link_fixture.expect('L13 driver unchanged',
    (select format('#%s %s', car_number, coalesce(iracing_cust_id::text, '-')) from public.drivers
     where id = '99999999-0000-0000-0000-000000000004'),
    '#20 -');
  perform driver_link_fixture.expect('L13 requester unlinked',
    (select driver_id from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000403'), null::uuid);
  raise notice 'ok L13 driver already linked';
end $$;
rollback to savepoint fixture;

-- L14 Rejecting a website request needs a reason; the requester sees it and may ask again (BR3.12, BR3.14)
do $$
declare
  v_id uuid;
  v_empty text;
  v_state jsonb;
  v_new_state jsonb;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  set local role authenticated;
  v_id := public.submit_driver_request('Nico Newman', 55, 123456);
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000401');
  v_empty := driver_link_fixture.error_state(format($q$select public.reject_signup_request(%L, '   ')$q$, v_id));
  perform public.reject_signup_request(v_id, 'Use your full name');
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  v_state := public.my_link_state();
  perform public.submit_driver_request('Nico Newman', 55, 123456);
  v_new_state := public.my_link_state();
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform driver_link_fixture.expect('L14 empty reason refused', v_empty, 'P0001');
  perform driver_link_fixture.expect('L14 rejected state', v_state -> 'request' ->> 'status', 'rejected');
  perform driver_link_fixture.expect('L14 reason shown', v_state -> 'request' ->> 'reason', 'Use your full name');
  perform driver_link_fixture.expect('L14 a new request supersedes it', v_new_state -> 'request' ->> 'status', 'pending');
  raise notice 'ok L14 reject a website request';
end $$;
rollback to savepoint fixture;

-- L15 A non-admin cannot approve or reject (BR3.14) -----------------------------------------------
do $$
declare
  v_approve text;
  v_reject text;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  set local role authenticated;
  v_approve := driver_link_fixture.error_state($q$select public.approve_signup_request('dddddddd-0000-0000-0000-000000000401',
    'Discord Person', null, 1, null)$q$);
  v_reject := driver_link_fixture.error_state($q$select public.reject_signup_request('dddddddd-0000-0000-0000-000000000401', 'No')$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform driver_link_fixture.expect('L15 approve', v_approve, '42501');
  perform driver_link_fixture.expect('L15 reject', v_reject, '42501');
  raise notice 'ok L15 admins only';
end $$;
rollback to savepoint fixture;

-- L16 Discord approval is unchanged and links nobody (NFR4.4) --------------------------------------
do $$
declare
  v_result jsonb;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000401');
  set local role authenticated;
  v_result := public.approve_signup_request('dddddddd-0000-0000-0000-000000000401', 'Discord Person', 777,
    (select id from public.driver_classes where name = 'Alpha'), null);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform driver_link_fixture.expect('L16 driver', v_result ->> 'driver_name', 'Discord Person');
  perform driver_link_fixture.expect('L16 number', v_result ->> 'car_number', '40');
  perform driver_link_fixture.expect('L16 no profile linked',
    (select count(*) from public.profiles where driver_id = (v_result ->> 'driver_id')::uuid), 0::bigint);
  raise notice 'ok L16 Discord approval';
end $$;
rollback to savepoint fixture;

-- L17 Shape checks: cancelled only for website rows; a pending website row needs its requester ----
do $$
begin
  perform driver_link_fixture.expect('L17 cancelled Discord row',
    driver_link_fixture.error_state($q$insert into public.signup_requests (discord_user_id, name, requested_numbers, status)
      values ('987654321', 'Someone', array[41], 'cancelled')$q$), '23514');
  perform driver_link_fixture.expect('L17 website row without a requester',
    driver_link_fixture.error_state($q$insert into public.signup_requests (source, name, iracing_cust_id, requested_numbers)
      values ('website', 'Someone', 1, array[41])$q$), '23514');
  perform driver_link_fixture.expect('L17 Discord row without a Discord id',
    driver_link_fixture.error_state($q$insert into public.signup_requests (name, requested_numbers)
      values ('Someone', array[41])$q$), '23514');
  raise notice 'ok L17 shape checks';
end $$;
rollback to savepoint fixture;

-- L18 The Discord bot's feed and acknowledgement see Discord rows only (BR3.15, NFR1.8) ------------
do $$
declare
  v_id uuid;
  v_feed text;
  v_acked integer;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  set local role authenticated;
  v_id := public.submit_driver_request('Nico Newman', 55, 123456);
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000401');
  perform public.reject_signup_request(v_id, 'Website reason');
  perform public.reject_signup_request('dddddddd-0000-0000-0000-000000000401', 'Discord reason');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  select string_agg(name, ', ') into v_feed from public.pending_signup_rejections();
  v_acked := public.ack_signup_rejections(array[v_id]);
  perform driver_link_fixture.expect('L18 feed', v_feed, 'Discord Person');
  perform driver_link_fixture.expect('L18 website id not acknowledged', v_acked, 0);
  perform driver_link_fixture.expect('L18 Discord id acknowledged',
    public.ack_signup_rejections(array['dddddddd-0000-0000-0000-000000000401'::uuid]), 1);
  raise notice 'ok L18 bot feed';
end $$;
rollback to savepoint fixture;

-- L19 Deleting an account with pending and rejected website requests (NFR1.7) ----------------------
do $$
declare
  v_rejected uuid;
  v_pending uuid;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  set local role authenticated;
  v_rejected := public.submit_driver_request('Nico Newman', 55, 123456);
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000401');
  perform public.reject_signup_request(v_rejected, 'Try again');
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  v_pending := public.submit_driver_request('Nico Newman', 56, 123456);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  delete from auth.users where id = 'eeeeeeee-0000-0000-0000-000000000403';
  perform driver_link_fixture.expect('L19 pending row cancelled',
    (select status || ' ' || coalesce(requester_profile_id::text, '-') from public.signup_requests where id = v_pending), 'cancelled -');
  perform driver_link_fixture.expect('L19 rejected row kept',
    (select status || ' ' || coalesce(requester_profile_id::text, '-') from public.signup_requests where id = v_rejected), 'rejected -');
  raise notice 'ok L19 account deletion';
end $$;
rollback to savepoint fixture;

-- L20 admin_delete_user with a pending website request (NFR1.7) ------------------------------------
do $$
declare
  v_pending uuid;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000405');
  set local role authenticated;
  v_pending := public.submit_driver_request('Dee Driver', 57, 333);
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000401');
  perform public.admin_delete_user('eeeeeeee-0000-0000-0000-000000000405');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform driver_link_fixture.expect('L20 account gone',
    (select count(*) from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000405'), 0::bigint);
  perform driver_link_fixture.expect('L20 request cancelled',
    (select status from public.signup_requests where id = v_pending), 'cancelled');
  raise notice 'ok L20 admin_delete_user';
end $$;
rollback to savepoint fixture;

-- L21 Grants: signed-in callers only (NFR1.4) ------------------------------------------------------
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.link_my_driver(uuid)',
    'public.list_unlinked_drivers()',
    'public.my_link_state()',
    'public.submit_driver_request(text, integer, bigint)'
  ] loop
    perform driver_link_fixture.expect('L21 anon cannot execute ' || v_fn,
      has_function_privilege('anon', v_fn, 'execute'), false);
    perform driver_link_fixture.expect('L21 authenticated can execute ' || v_fn,
      has_function_privilege('authenticated', v_fn, 'execute'), true);
  end loop;
  perform driver_link_fixture.expect('L21 trigger function not callable',
    has_function_privilege('authenticated', 'public.cancel_requester_pending_request()', 'execute'), false);
  raise notice 'ok L21 grants';
end $$;
rollback to savepoint fixture;

-- L22 Two links of one driver: the second account gets DRIVER_TAKEN (BR3.7) ------------------------
do $$
declare
  v text;
begin
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000402');
  set local role authenticated;
  perform public.link_my_driver('99999999-0000-0000-0000-000000000005');
  perform driver_link_fixture.claims('eeeeeeee-0000-0000-0000-000000000403');
  v := driver_link_fixture.error_code($q$select public.link_my_driver('99999999-0000-0000-0000-000000000005')$q$);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform driver_link_fixture.expect('L22 second account', v, 'DRIVER_TAKEN');
  raise notice 'ok L22 one account per driver';
end $$;
rollback to savepoint fixture;

rollback;
