-- In-site notifications fixtures for 20261115120002_notifications.sql (notifications unit U3): the five
-- triggers (a round linked on insert and on update, results added to a linked round, the first report post,
-- Close Appeal, a schedule-vote poll), a failing trigger body never blocking its event, own-rows-only reads
-- with no site writes, open_my_notifications() (50 newest, marks only those, unread_left), the grants, and
-- unread_left counted after the marking (N01-N11).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- poll-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/notification-inbox-fixtures.sql
--
-- Same conventions as account-settings-fixtures.sql (supabase/checks/README.md): every assertion calls
-- inbox_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each case
-- runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`. Callers are
-- impersonated with request.jwt.claims and the role setting. now() is fixed for the whole transaction, so
-- "older" rows are written with explicit times.
--
-- Accounts: admin (no driver); a (linked to Ann Inbox); b (linked to Bob Inbox); u (no driver). Driver Una
-- Unlinked has results but no account. Round 9909001 has results for Ann, Bob and Una and starts with no
-- season; round 9909002 has none yet.

begin;

set local client_min_messages = notice;

create schema inbox_fixture;

create function inbox_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'notification inbox fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Acts as p_who ('anon' or an account id) until inbox_fixture.as_owner().
create function inbox_fixture.act_as(p_who text) returns void
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

create function inbox_fixture.as_owner() returns void
  language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- The SQLSTATE p_sql fails with as p_who, or 'ok'. On an error the block's own rollback puts the role back.
create function inbox_fixture.state_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform inbox_fixture.act_as(p_who);
  execute p_sql;
  perform inbox_fixture.as_owner();
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- One text value read by p_sql as p_who.
create function inbox_fixture.read_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v text;
begin
  perform inbox_fixture.act_as(p_who);
  execute p_sql into v;
  perform inbox_fixture.as_owner();
  return v;
end;
$$;

-- open_my_notifications() as p_who.
create function inbox_fixture.open_as(p_who text) returns jsonb
  language plpgsql as $$
declare
  v jsonb;
begin
  perform inbox_fixture.act_as(p_who);
  v := public.open_my_notifications();
  perform inbox_fixture.as_owner();
  return v;
end;
$$;

-- The kinds one account holds for one dedupe subject, as '1,4' (read as the owner).
create function inbox_fixture.kinds(p_user uuid, p_subject text) returns text
  language sql as $$
  select coalesce(string_agg(n.kind::text, ',' order by n.kind), '')
  from public.notifications n
  where n.user_id = p_user and split_part(n.dedupe_key, ':', 2) = p_subject;
$$;

create function inbox_fixture.total() returns integer
  language sql as $$ select count(*)::integer from public.notifications; $$;

grant usage on schema inbox_fixture to anon, authenticated;
grant execute on all functions in schema inbox_fixture to anon, authenticated;

-- Base data ------------------------------------------------------------------------------------

-- No scoring or round-stats side effects from the rows below.
update public.scoring_settings set triggers_enabled = false;

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (931, 'Active')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select 931, 'Alpha', 1 where not exists (select 1 from public.driver_classes where name = 'Alpha');

insert into public.seasons (id, number, name) values
  ('bbbbbbbb-0000-0000-0000-000000000901', 9931, 'Zi Season'),
  ('bbbbbbbb-0000-0000-0000-000000000902', 9932, 'Zi Other');

insert into public.drivers (id, name, car_number, status_id, class_id, iracing_cust_id, is_ai) values
  ('99999999-0000-0000-0000-000000000901', 'Ann Inbox', 91,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'),
   990900001, false),
  ('99999999-0000-0000-0000-000000000902', 'Bob Inbox', 92,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'),
   990900002, false),
  ('99999999-0000-0000-0000-000000000903', 'Una Unlinked', 93,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'),
   990900003, false);

-- The auth.users insert creates a 'driver' profile; the admin and the linked accounts are re-inserted,
-- because as postgres the profiles guard refuses a role or driver change.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000901', 'inbox-admin@example.test', now(), '{"display_name":"Inbox Admin"}'),
  ('eeeeeeee-0000-0000-0000-000000000902', 'inbox-a@example.test', now(), '{"display_name":"Owner A"}'),
  ('eeeeeeee-0000-0000-0000-000000000903', 'inbox-b@example.test', now(), '{"display_name":"Owner B"}'),
  ('eeeeeeee-0000-0000-0000-000000000904', 'inbox-u@example.test', now(), '{"display_name":"Unlinked U"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000000901', 'eeeeeeee-0000-0000-0000-000000000902',
                                         'eeeeeeee-0000-0000-0000-000000000903');
insert into public.profiles (id, role, display_name) values
  ('eeeeeeee-0000-0000-0000-000000000901', 'admin', 'Inbox Admin');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000902', 'driver', 'Owner A', '99999999-0000-0000-0000-000000000901'),
  ('eeeeeeee-0000-0000-0000-000000000903', 'driver', 'Owner B', '99999999-0000-0000-0000-000000000902');

insert into public.curated_rounds (subsession_id, start_time, track_name, season_label, round_number) values
  (9909001, '2026-06-01 18:00+00', 'Zi Park', 'Zi Season', 5),
  (9909002, '2026-06-08 18:00+00', 'Zi Ring', 'Zi Season', null);

-- Ann raced twice in 9909001, so each kind must still reach her once.
insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, finish_position) values
  (9909001, 1, 990900001, 'Ann Inbox', 1),
  (9909001, 2, 990900001, 'Ann Inbox', 2),
  (9909001, 1, 990900002, 'Bob Inbox', 2),
  (9909001, 1, 990900003, 'Una Unlinked', 3);

insert into public.penalties (id, subsession_id, race_number, driver_id, description) values
  ('cccccccc-0000-0000-0000-000000000911', 9909001, 1, '99999999-0000-0000-0000-000000000901', 'Contact in turn 1');

insert into public.incident_appeals (id, subsession_id, penalty_id, message, submitter_id, status) values
  ('aaaaaaaa-0000-0000-0000-000000000901', 9909001, 'cccccccc-0000-0000-0000-000000000911', 'Please review',
   'eeeeeeee-0000-0000-0000-000000000902', 'open'),
  ('aaaaaaaa-0000-0000-0000-000000000902', 9909001, 'cccccccc-0000-0000-0000-000000000911', 'Second look',
   'eeeeeeee-0000-0000-0000-000000000903', 'dismissed');

savepoint fixture;

-- N01 A round born linked (the CSV import's shape: the round inserted with its season, results added after)
--     notifies its participants with kinds 1 and 4, once each; an unlinked round notifies nobody (BR4.1,
--     BR4.2, BR4.7) ----------------------------------------------------------------------------------------
do $$
begin
  perform inbox_fixture.expect('N01 base data notifies nobody', inbox_fixture.total(), 0);
  insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, season_label, round_number)
  values (9909003, '2026-06-15 18:00+00', 'Zi Bay', 'bbbbbbbb-0000-0000-0000-000000000901', 'Zi Season', 6);
  perform inbox_fixture.expect('N01 nobody raced yet', inbox_fixture.total(), 0);
  -- Row by row, as the import inserts them.
  insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, finish_position)
  values (9909003, 1, 990900001, 'Ann Inbox', 1);
  insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, finish_position)
  values (9909003, 2, 990900001, 'Ann Inbox', 1);
  insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, finish_position)
  values (9909003, 1, 990900003, 'Una Unlinked', 2);
  perform inbox_fixture.expect('N01 a gets 1 and 4',
    inbox_fixture.kinds('eeeeeeee-0000-0000-0000-000000000902', '9909003'), '1,4');
  perform inbox_fixture.expect('N01 only a', inbox_fixture.total(), 2);
  perform inbox_fixture.expect('N01 dedupe key',
    (select string_agg(dedupe_key, ',' order by kind) from public.notifications), '1:9909003,4:9909003');
  perform inbox_fixture.expect('N01 unread on arrival',
    (select count(*)::integer from public.notifications where read_at is null), 2);

  insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, finish_position)
  values (9909002, 1, 990900002, 'Bob Inbox', 1);
  perform inbox_fixture.expect('N01 unlinked round notifies nobody', inbox_fixture.total(), 2);
  raise notice 'ok N01 born-linked round';
end $$;
rollback to savepoint fixture;

-- N02 Linking a round on UPDATE gives kinds 1 and 4 to the participants' accounts only; moving it to another
--     season, unlinking and linking again insert nothing more (BR4.1, BR4.7) --------------------------------
do $$
begin
  update public.curated_rounds set season_id = 'bbbbbbbb-0000-0000-0000-000000000901' where subsession_id = 9909001;
  perform inbox_fixture.expect('N02 a', inbox_fixture.kinds('eeeeeeee-0000-0000-0000-000000000902', '9909001'), '1,4');
  perform inbox_fixture.expect('N02 b', inbox_fixture.kinds('eeeeeeee-0000-0000-0000-000000000903', '9909001'), '1,4');
  perform inbox_fixture.expect('N02 admin and u get nothing',
    (select count(*)::integer from public.notifications
     where user_id in ('eeeeeeee-0000-0000-0000-000000000901', 'eeeeeeee-0000-0000-0000-000000000904')), 0);
  perform inbox_fixture.expect('N02 four rows', inbox_fixture.total(), 4);

  update public.curated_rounds set season_id = 'bbbbbbbb-0000-0000-0000-000000000902' where subsession_id = 9909001;
  update public.curated_rounds set season_id = null where subsession_id = 9909001;
  update public.curated_rounds set season_id = 'bbbbbbbb-0000-0000-0000-000000000901' where subsession_id = 9909001;
  perform inbox_fixture.expect('N02 no repeats', inbox_fixture.total(), 4);
  -- A write that leaves season_id alone does not count as linking.
  update public.curated_rounds set track_name = 'Zi Park GP' where subsession_id = 9909001;
  perform inbox_fixture.expect('N02 other columns', inbox_fixture.total(), 4);
  raise notice 'ok N02 round linked on update';
end $$;
rollback to savepoint fixture;

-- N03 Results added to a linked round notify only those drivers' accounts, in one pass per statement; a
--     driver with no account gets nothing (BR4.2) ----------------------------------------------------------
do $$
begin
  update public.curated_rounds set season_id = 'bbbbbbbb-0000-0000-0000-000000000901' where subsession_id = 9909002;
  perform inbox_fixture.expect('N03 no participants yet', inbox_fixture.total(), 0);
  insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, finish_position) values
    (9909002, 1, 990900002, 'Bob Inbox', 1),
    (9909002, 2, 990900002, 'Bob Inbox', 1),
    (9909002, 1, 990900003, 'Una Unlinked', 2);
  perform inbox_fixture.expect('N03 b', inbox_fixture.kinds('eeeeeeee-0000-0000-0000-000000000903', '9909002'), '1,4');
  perform inbox_fixture.expect('N03 a raced elsewhere',
    inbox_fixture.kinds('eeeeeeee-0000-0000-0000-000000000902', '9909002'), '');
  perform inbox_fixture.expect('N03 only b', inbox_fixture.total(), 2);

  insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, finish_position)
  values (9909002, 1, 990900001, 'Ann Inbox', 3);
  perform inbox_fixture.expect('N03 a added later',
    inbox_fixture.kinds('eeeeeeee-0000-0000-0000-000000000902', '9909002'), '1,4');
  perform inbox_fixture.expect('N03 b not repeated', inbox_fixture.total(), 4);
  raise notice 'ok N03 results added to a linked round';
end $$;
rollback to savepoint fixture;

-- N04 The first report post (the site's upsert as an insert) gives kinds 2 and 3 to the participants;
--     unposting and posting again insert nothing (BR4.3) ------------------------------------------------------
do $$
begin
  insert into public.round_incident_status (subsession_id, posted, posted_at) values (9909001, true, now())
  on conflict (subsession_id) do update set posted = excluded.posted, posted_at = excluded.posted_at;
  perform inbox_fixture.expect('N04 a', inbox_fixture.kinds('eeeeeeee-0000-0000-0000-000000000902', '9909001'), '2,3');
  perform inbox_fixture.expect('N04 b', inbox_fixture.kinds('eeeeeeee-0000-0000-0000-000000000903', '9909001'), '2,3');
  perform inbox_fixture.expect('N04 four rows', inbox_fixture.total(), 4);

  update public.round_incident_status set posted = false, posted_at = null where subsession_id = 9909001;
  update public.round_incident_status set posted = true, posted_at = now() where subsession_id = 9909001;
  perform inbox_fixture.expect('N04 re-post sends nothing', inbox_fixture.total(), 4);

  -- The update path: a status row that starts unposted.
  insert into public.round_incident_status (subsession_id, posted) values (9909002, false);
  insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, finish_position)
  values (9909002, 1, 990900002, 'Bob Inbox', 1);
  perform inbox_fixture.expect('N04 unposted sends nothing', inbox_fixture.total(), 4);
  update public.round_incident_status set posted = true, posted_at = now() where subsession_id = 9909002;
  perform inbox_fixture.expect('N04 first post as an update',
    inbox_fixture.kinds('eeeeeeee-0000-0000-0000-000000000903', '9909002'), '2,3');
  raise notice 'ok N04 first report post';
end $$;
rollback to savepoint fixture;

-- N05 Close Appeal gives kind 5 to the filer only, with the round and the appeal; a dismissed appeal cannot
--     be closed and sends nothing (BR4.4) --------------------------------------------------------------------
do $$
declare
  v_code text;
begin
  perform inbox_fixture.act_as('eeeeeeee-0000-0000-0000-000000000901');
  v_code := public.close_incident_appeal('aaaaaaaa-0000-0000-0000-000000000901', 0, 0, 0, false, 'Upheld');
  perform inbox_fixture.as_owner();
  perform inbox_fixture.expect('N05 closed', v_code, 'ok');
  perform inbox_fixture.expect('N05 one row', inbox_fixture.total(), 1);
  perform inbox_fixture.expect('N05 row',
    (select concat_ws('|', user_id, kind, subsession_id, appeal_id, dedupe_key) from public.notifications),
    'eeeeeeee-0000-0000-0000-000000000902|5|9909001|aaaaaaaa-0000-0000-0000-000000000901|5:aaaaaaaa-0000-0000-0000-000000000901');

  perform inbox_fixture.act_as('eeeeeeee-0000-0000-0000-000000000901');
  v_code := public.close_incident_appeal('aaaaaaaa-0000-0000-0000-000000000902', 0, 0, 0, false, 'Upheld');
  perform inbox_fixture.as_owner();
  perform inbox_fixture.expect('N05 dismissed not closed', v_code, 'not_open');
  perform inbox_fixture.expect('N05 nothing for b', inbox_fixture.total(), 1);
  raise notice 'ok N05 appeal closed';
end $$;
rollback to savepoint fixture;

-- N06 Posting a schedule-vote poll gives kind 6 to every driver-linked account, once per poll; a draft, a
--     normal poll and a re-post send nothing (BR4.5, polls BR6.1) ----------------------------------------------
do $$
declare
  v_vote uuid;
  v_linked integer := (select count(*)::integer from public.profiles where driver_id is not null);
begin
  insert into public.polls (title, is_schedule_vote, status, posted_at, first_posted_at)
  values ('Normal poll', false, 'posted', now(), now());
  perform inbox_fixture.expect('N06 normal poll', inbox_fixture.total(), 0);

  insert into public.polls (title, is_schedule_vote) values ('Next season schedule', true) returning id into v_vote;
  perform inbox_fixture.expect('N06 draft', inbox_fixture.total(), 0);
  update public.polls set status = 'posted', posted_at = now(), first_posted_at = now() where id = v_vote;
  perform inbox_fixture.expect('N06 every linked account', inbox_fixture.total(), v_linked);
  perform inbox_fixture.expect('N06 a', inbox_fixture.kinds('eeeeeeee-0000-0000-0000-000000000902', v_vote::text), '6');
  perform inbox_fixture.expect('N06 u gets nothing',
    (select count(*)::integer from public.notifications where user_id = 'eeeeeeee-0000-0000-0000-000000000904'), 0);

  update public.polls set status = 'draft', posted_at = null where id = v_vote;
  update public.polls set status = 'posted', posted_at = now() where id = v_vote;
  perform inbox_fixture.expect('N06 re-post', inbox_fixture.total(), v_linked);

  -- A posted normal poll turned into a schedule vote counts as the change into posted with the flag.
  update public.polls set is_schedule_vote = true where title = 'Normal poll';
  perform inbox_fixture.expect('N06 flag turned on', inbox_fixture.total(), 2 * v_linked);
  raise notice 'ok N06 schedule vote';
end $$;
rollback to savepoint fixture;

-- N07 A failing trigger body raises a warning and the event still commits (BR4.6). Every insert into the
--     table is made to fail with a NOT VALID check, which applies to new rows only. ----------------------------
do $$
begin
  alter table public.notifications add constraint inbox_fixture_block check (kind < 0) not valid;

  update public.curated_rounds set season_id = 'bbbbbbbb-0000-0000-0000-000000000901' where subsession_id = 9909001;
  perform inbox_fixture.expect('N07 round linked',
    (select season_id::text from public.curated_rounds where subsession_id = 9909001), 'bbbbbbbb-0000-0000-0000-000000000901');
  insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, finish_position)
  values (9909001, 3, 990900002, 'Bob Inbox', 1);
  insert into public.round_incident_status (subsession_id, posted, posted_at) values (9909001, true, now());
  perform inbox_fixture.expect('N07 report posted',
    (select posted::text from public.round_incident_status where subsession_id = 9909001), 'true');
  insert into public.polls (title, is_schedule_vote, status, posted_at, first_posted_at)
  values ('Blocked schedule vote', true, 'posted', now(), now());

  perform inbox_fixture.act_as('eeeeeeee-0000-0000-0000-000000000901');
  perform inbox_fixture.expect('N07 appeal closed',
    public.close_incident_appeal('aaaaaaaa-0000-0000-0000-000000000901', 0, 0, 0, false, 'Upheld'), 'ok');
  perform inbox_fixture.as_owner();

  perform inbox_fixture.expect('N07 nothing inserted', inbox_fixture.total(), 0);
  raise notice 'ok N07 failures never block the event';
end $$;
rollback to savepoint fixture;

-- N08 An account reads only its own rows; anon reads nothing; direct insert, update and delete are refused
--     to every caller (BR5.1) -------------------------------------------------------------------------------
do $$
declare
  v_who text;
begin
  update public.curated_rounds set season_id = 'bbbbbbbb-0000-0000-0000-000000000901' where subsession_id = 9909001;
  perform inbox_fixture.expect('N08 a reads own',
    inbox_fixture.read_as('eeeeeeee-0000-0000-0000-000000000902',
      $q$select string_agg(distinct user_id::text, ',') || ':' || count(*) from public.notifications$q$),
    'eeeeeeee-0000-0000-0000-000000000902:2');
  perform inbox_fixture.expect('N08 u reads none',
    inbox_fixture.read_as('eeeeeeee-0000-0000-0000-000000000904', 'select count(*)::text from public.notifications'), '0');
  perform inbox_fixture.expect('N08 admin reads none',
    inbox_fixture.read_as('eeeeeeee-0000-0000-0000-000000000901', 'select count(*)::text from public.notifications'), '0');
  perform inbox_fixture.expect('N08 anon refused',
    inbox_fixture.state_as('anon', 'select count(*) from public.notifications'), '42501');

  foreach v_who in array array['anon', 'eeeeeeee-0000-0000-0000-000000000902', 'eeeeeeee-0000-0000-0000-000000000901'] loop
    perform inbox_fixture.expect('N08 insert as ' || v_who,
      inbox_fixture.state_as(v_who, $q$insert into public.notifications (user_id, kind, poll_id, dedupe_key)
        values ('eeeeeeee-0000-0000-0000-000000000902', 6, gen_random_uuid(), 'x')$q$), '42501');
    perform inbox_fixture.expect('N08 update as ' || v_who,
      inbox_fixture.state_as(v_who, 'update public.notifications set read_at = now()'), '42501');
    perform inbox_fixture.expect('N08 delete as ' || v_who,
      inbox_fixture.state_as(v_who, 'delete from public.notifications'), '42501');
  end loop;
  perform inbox_fixture.expect('N08 rows untouched',
    (select count(*)::integer from public.notifications where read_at is null), 4);
  raise notice 'ok N08 own rows only, no site writes';
end $$;
rollback to savepoint fixture;

-- N09 open_my_notifications() returns the 50 newest with was_unread as they stood, in created_at, kind, id
--     order with the labels read now; it marks only those, leaves older unread rows and other accounts'
--     rows, and returns the unread count left (BR2.1, BR2.2, BR3.1) --------------------------------------------
do $$
declare
  v jsonb;
  v_first jsonb;
begin
  -- 55 rows for a, i minutes old, with the 3-minute one already read; and one row for b.
  insert into public.notifications (user_id, kind, subsession_id, dedupe_key, created_at, read_at)
  select 'eeeeeeee-0000-0000-0000-000000000902', 1, 9909001, 'fx:' || i, now() - make_interval(mins => i),
         case when i = 3 then now() - interval '1 minute' end
  from generate_series(1, 55) i;
  insert into public.notifications (user_id, kind, subsession_id, dedupe_key, created_at)
  values ('eeeeeeee-0000-0000-0000-000000000903', 1, 9909001, '1:9909001', now());
  -- Two created together list kind 1 before kind 4.
  insert into public.notifications (user_id, kind, subsession_id, dedupe_key, created_at) values
    ('eeeeeeee-0000-0000-0000-000000000902', 4, 9909002, '4:9909002', now()),
    ('eeeeeeee-0000-0000-0000-000000000902', 1, 9909002, '1:9909002', now());
  update public.curated_rounds set season_id = 'bbbbbbbb-0000-0000-0000-000000000901' where subsession_id = 9909002;
  -- The update above notified nobody (9909002 has no results), so a holds 57 rows, 56 unread.

  v := inbox_fixture.open_as('eeeeeeee-0000-0000-0000-000000000902');
  v_first := v -> 'items' -> 0;
  perform inbox_fixture.expect('N09 fifty items', jsonb_array_length(v -> 'items'), 50);
  perform inbox_fixture.expect('N09 kind order', concat_ws(',', v_first ->> 'kind', v -> 'items' -> 1 ->> 'kind'), '1,4');
  perform inbox_fixture.expect('N09 labels read now',
    concat_ws('|', v_first ->> 'season_label', coalesce(v_first ->> 'round_number', 'null'), v_first ->> 'track_name',
              v_first ->> 'subsession_id', v_first ->> 'was_unread'),
    'Zi Season|null|Zi Ring|9909002|true');
  perform inbox_fixture.expect('N09 the read row stays read in the list',
    (select (i ->> 'was_unread') from jsonb_array_elements(v -> 'items') i
     where (i ->> 'created_at')::timestamptz = now() - interval '3 minutes'), 'false');
  perform inbox_fixture.expect('N09 newest first',
    (v -> 'items' -> 49 ->> 'created_at')::timestamptz, now() - interval '48 minutes');
  -- 56 unread before, 49 of them shown and marked.
  perform inbox_fixture.expect('N09 unread_left', (v ->> 'unread_left')::integer, 7);
  perform inbox_fixture.expect('N09 older rows stay unread',
    (select count(*)::integer from public.notifications
     where user_id = 'eeeeeeee-0000-0000-0000-000000000902' and read_at is null), 7);
  perform inbox_fixture.expect('N09 b untouched',
    (select (read_at is null)::text from public.notifications where user_id = 'eeeeeeee-0000-0000-0000-000000000903'), 'true');
  perform inbox_fixture.expect('N09 the count agrees',
    inbox_fixture.read_as('eeeeeeee-0000-0000-0000-000000000902', 'select public.notification_unread_count()::text'), '7');

  -- Opening again shows the same 50, now all read, and still leaves the older 7 unread.
  v := inbox_fixture.open_as('eeeeeeee-0000-0000-0000-000000000902');
  perform inbox_fixture.expect('N09 second open all read',
    (select count(*)::integer from jsonb_array_elements(v -> 'items') i where (i ->> 'was_unread')::boolean), 0);
  perform inbox_fixture.expect('N09 second unread_left', (v ->> 'unread_left')::integer, 7);

  -- An account with nothing gets an empty list.
  v := inbox_fixture.open_as('eeeeeeee-0000-0000-0000-000000000904');
  perform inbox_fixture.expect('N09 empty', v::text, '{"items": [], "unread_left": 0}');
  raise notice 'ok N09 open marks only what it shows';
end $$;
rollback to savepoint fixture;

-- N10 Settings and grants: the two site functions are definers with an empty search_path, executable by
--     authenticated and not anon; the helper and trigger functions by no API role; the closed appeal's
--     penalty id comes back for kind 5 (BR5.1) ------------------------------------------------------------------
do $$
declare
  v_fn record;
  v_found integer := 0;
  v_private text;
  v jsonb;
begin
  for v_fn in
    select p.oid, p.proname, p.prosecdef, p.proconfig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('notification_unread_count', 'open_my_notifications')
  loop
    v_found := v_found + 1;
    perform inbox_fixture.expect('N10 ' || v_fn.proname || ' anon', has_function_privilege('anon', v_fn.oid, 'execute'), false);
    perform inbox_fixture.expect('N10 ' || v_fn.proname || ' authenticated',
      has_function_privilege('authenticated', v_fn.oid, 'execute'), true);
    perform inbox_fixture.expect('N10 ' || v_fn.proname || ' definer', v_fn.prosecdef, true);
    perform inbox_fixture.expect('N10 ' || v_fn.proname || ' search_path', 'search_path=""' = any (v_fn.proconfig), true);
  end loop;
  perform inbox_fixture.expect('N10 both functions exist', v_found, 2);
  perform inbox_fixture.expect('N10 anon cannot open',
    inbox_fixture.state_as('anon', 'select public.open_my_notifications()'), '42501');
  perform inbox_fixture.expect('N10 anon cannot count',
    inbox_fixture.state_as('anon', 'select public.notification_unread_count()'), '42501');

  foreach v_private in array array['private.notify_round_participants(bigint, integer[])', 'private.notify_round_linked()',
                                   'private.notify_results_added()', 'private.notify_report_posted()',
                                   'private.notify_appeal_closed()', 'private.notify_schedule_vote()'] loop
    perform inbox_fixture.expect('N10 ' || v_private || ' authenticated',
      has_function_privilege('authenticated', v_private, 'execute'), false);
    perform inbox_fixture.expect('N10 ' || v_private || ' service_role',
      has_function_privilege('service_role', v_private, 'execute'), false);
  end loop;
  perform inbox_fixture.expect('N10 row level security',
    (select c.relrowsecurity from pg_class c where c.oid = 'public.notifications'::regclass), true);
  perform inbox_fixture.expect('N10 anon has no table privilege',
    has_table_privilege('anon', 'public.notifications', 'select, insert, update, delete'), false);

  perform inbox_fixture.act_as('eeeeeeee-0000-0000-0000-000000000901');
  perform public.close_incident_appeal('aaaaaaaa-0000-0000-0000-000000000901', 0, 0, 0, false, 'Upheld');
  perform inbox_fixture.as_owner();
  v := inbox_fixture.open_as('eeeeeeee-0000-0000-0000-000000000902');
  perform inbox_fixture.expect('N10 kind 5 carries the penalty',
    concat_ws('|', v -> 'items' -> 0 ->> 'kind', v -> 'items' -> 0 ->> 'penalty_id', v -> 'items' -> 0 ->> 'round_number'),
    '5|cccccccc-0000-0000-0000-000000000911|5');
  raise notice 'ok N10 settings and grants';
end $$;
rollback to savepoint fixture;

-- N11 unread_left is counted after the marking, so it always equals the unread rows left: three opens in a
--     row, with another tab marking and a new event arriving in between, each report the true count. A real
--     overlap needs two sessions, which this file cannot run, so it also checks the count is its own
--     statement (plpgsql) and not a figure from the listing's snapshot (review R-02) -----------------------------
do $$
declare
  v jsonb;
begin
  -- 52 unread rows for a: an open shows and marks 50, leaving the 2 oldest.
  insert into public.notifications (user_id, kind, subsession_id, dedupe_key, created_at)
  select 'eeeeeeee-0000-0000-0000-000000000902', 1, 9909001, 'fx:' || i, now() - make_interval(mins => i)
  from generate_series(1, 52) i;

  v := inbox_fixture.open_as('eeeeeeee-0000-0000-0000-000000000902');
  perform inbox_fixture.expect('N11 first open unread_left', (v ->> 'unread_left')::integer, 2);

  -- Another tab's open has marked everything, and an older-dated event has arrived since.
  update public.notifications set read_at = now()
   where user_id = 'eeeeeeee-0000-0000-0000-000000000902' and read_at is null;
  insert into public.notifications (user_id, kind, subsession_id, dedupe_key, created_at)
  values ('eeeeeeee-0000-0000-0000-000000000902', 2, 9909001, '2:9909001', now() - interval '2 hours');

  v := inbox_fixture.open_as('eeeeeeee-0000-0000-0000-000000000902');
  perform inbox_fixture.expect('N11 second open unread_left', (v ->> 'unread_left')::integer, 1);
  perform inbox_fixture.expect('N11 agrees with the count',
    inbox_fixture.read_as('eeeeeeee-0000-0000-0000-000000000902', 'select public.notification_unread_count()::text'),
    '1');

  v := inbox_fixture.open_as('eeeeeeee-0000-0000-0000-000000000902');
  perform inbox_fixture.expect('N11 third open unread_left', (v ->> 'unread_left')::integer, 1);
  perform inbox_fixture.expect('N11 counted by its own statement',
    (select l.lanname::text from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = 'public.open_my_notifications()'::regprocedure), 'plpgsql');
  raise notice 'ok N11 unread_left counted after marking';
end $$;
rollback to savepoint fixture;

rollback;
