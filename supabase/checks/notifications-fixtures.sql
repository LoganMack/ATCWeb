-- Email notifications fixtures for 20261031120000_email_notifications.sql (U7 email-notifications): the
-- grants and lockdown, the three enqueue triggers (with the real setRoundPosted upsert shape), the failure
-- capture, reminders (window, championship only, moved and already-sent events, daylight saving), claims
-- (disjoint batches, the daily cap, attempt levels, re-checks), marks, stored renderings, stale batches and
-- the 20-hour cutoff, expiry with cap_expired, retention, the run log and the admin counts (N01-N27).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- driver-privacy-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/notifications-fixtures.sql
--
-- Same conventions as account-settings-fixtures.sql (supabase/checks/README.md): every assertion calls
-- notifications_fixture.expect(), which raises naming the case; one transaction, rolled back at the end;
-- each case runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`. Callers are
-- impersonated with request.jwt.claims and the role setting. now() is fixed for the whole transaction, so
-- "older" rows are written with explicit times.
--
-- Accounts: admin; a (linked to Ana Notify, every toggle on, confirmed); b (linked to Ben Quiet, every toggle
-- off); c (linked to Cyd Pending, every toggle on, address not confirmed); d (no driver, every toggle on).
-- Round 9907001 (Zr Season round 3) has results for Ana, Ben, Cyd and an unlinked driver; 9907002 for Ana.

begin;

set local client_min_messages = notice;

create schema notifications_fixture;

create function notifications_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'notifications fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Acts as p_who ('anon' or an account id) until notifications_fixture.as_owner().
create function notifications_fixture.act_as(p_who text) returns void
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

create function notifications_fixture.as_owner() returns void
  language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- Runs p_sql as p_who; an error stops the fixture.
create function notifications_fixture.exec_as(p_who text, p_sql text) returns void
  language plpgsql as $$
begin
  perform notifications_fixture.act_as(p_who);
  execute p_sql;
  perform notifications_fixture.as_owner();
end;
$$;

-- The SQLSTATE p_sql fails with as p_who, or 'ok'. On an error the block's own rollback puts the role back.
create function notifications_fixture.state_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform notifications_fixture.act_as(p_who);
  execute p_sql;
  perform notifications_fixture.as_owner();
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- The request the site's setRoundPosted sends (src/lib/incidentReports.ts): a PostgREST upsert on
-- on_conflict=subsession_id with a body of subsession_id, posted and posted_at, as an admin.
create function notifications_fixture.post_round(p_admin uuid, p_subsession bigint, p_posted boolean) returns void
  language plpgsql as $$
begin
  perform notifications_fixture.exec_as(p_admin::text, format(
    $q$insert into public.round_incident_status (subsession_id, posted, posted_at) values (%s, %L, %s)
       on conflict (subsession_id) do update set subsession_id = excluded.subsession_id,
         posted = excluded.posted, posted_at = excluded.posted_at$q$,
    p_subsession, p_posted, case when p_posted then 'now()' else 'null' end));
end;
$$;

-- One queued outbox row, created p_age ago.
create function notifications_fixture.queue(p_kind text, p_profile uuid, p_subject text,
                                            p_attempts integer default 0, p_age interval default interval '0 minutes',
                                            p_payload jsonb default '{}'::jsonb)
  returns uuid
  language sql as $$
  insert into public.email_outbox (kind, profile_id, subject_id, dedupe_key, payload, attempts, created_at, send_by)
  values (p_kind, p_profile, p_subject, p_kind || ':' || p_subject || ':' || p_profile, p_payload, p_attempts,
          now() - p_age, now() + interval '24 hours')
  returning id;
$$;

create function notifications_fixture.claim(p_size integer, p_cap integer) returns jsonb
  language sql as $$
  select public.notifications_claim_batch(gen_random_uuid(), p_size, p_cap);
$$;

-- The ids in a claim or stale result, in the order returned.
create function notifications_fixture.ids(p_result jsonb) returns uuid[]
  language sql as $$
  select coalesce(array_agg((r.value ->> 'id')::uuid order by r.ordinality), '{}')
  from jsonb_array_elements(p_result -> 'rows') with ordinality r;
$$;

-- A calendar date and wall-clock time in the league's zone, p_offset from now.
create function notifications_fixture.et_date(p_offset interval) returns date
  language sql as $$ select ((now() + p_offset) at time zone 'America/New_York')::date; $$;
create function notifications_fixture.et_time(p_offset interval) returns time
  language sql as $$ select ((now() + p_offset) at time zone 'America/New_York')::time; $$;

grant usage on schema notifications_fixture to anon, authenticated;
grant execute on all functions in schema notifications_fixture to anon, authenticated;

-- Base data ------------------------------------------------------------------------------------

-- No scoring or round-stats side effects from the rows below.
update public.scoring_settings set triggers_enabled = false;

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (831, 'Active')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select 831, 'Alpha', 1 where not exists (select 1 from public.driver_classes where name = 'Alpha');

insert into public.seasons (id, number, name) values ('bbbbbbbb-0000-0000-0000-000000000701', 9831, 'Zr Season');
insert into public.circuits (id, name) values ('cccccccc-0000-0000-0000-000000000701', 'Zr Circuit');

insert into public.drivers (id, name, car_number, status_id, class_id, iracing_cust_id, is_ai) values
  ('99999999-0000-0000-0000-000000000701', 'Ana Notify', 71,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'),
   990700001, false),
  ('99999999-0000-0000-0000-000000000702', 'Ben Quiet', 72,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'),
   990700002, false),
  ('99999999-0000-0000-0000-000000000703', 'Cyd Pending', 73,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'),
   990700003, false),
  ('99999999-0000-0000-0000-000000000704', 'Una Linked', 74,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'),
   990700004, false);

-- The auth.users insert creates a 'driver' profile; the admin and the linked accounts are re-inserted,
-- because as postgres the profiles guard refuses a role or driver change.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000701', 'notify-admin@example.test', now(), '{"display_name":"Notify Admin"}'),
  ('eeeeeeee-0000-0000-0000-000000000702', 'notify-a@example.test', now(), '{"display_name":"Owner A"}'),
  ('eeeeeeee-0000-0000-0000-000000000703', 'notify-b@example.test', now(), '{"display_name":"Owner B"}'),
  ('eeeeeeee-0000-0000-0000-000000000704', 'notify-c@example.test', null, '{"display_name":"Owner C"}'),
  ('eeeeeeee-0000-0000-0000-000000000705', 'notify-d@example.test', now(), '{"display_name":"Unlinked D"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000000701', 'eeeeeeee-0000-0000-0000-000000000702',
                                         'eeeeeeee-0000-0000-0000-000000000703', 'eeeeeeee-0000-0000-0000-000000000704');
insert into public.profiles (id, role, display_name) values
  ('eeeeeeee-0000-0000-0000-000000000701', 'admin', 'Notify Admin');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000702', 'driver', 'Owner A', '99999999-0000-0000-0000-000000000701'),
  ('eeeeeeee-0000-0000-0000-000000000703', 'driver', 'Owner B', '99999999-0000-0000-0000-000000000702'),
  ('eeeeeeee-0000-0000-0000-000000000704', 'driver', 'Owner C', '99999999-0000-0000-0000-000000000703');

insert into public.account_settings (profile_id, notify_appeal_reviewed, notify_report_posted, notify_event_reminders) values
  ('eeeeeeee-0000-0000-0000-000000000702', true, true, true),
  ('eeeeeeee-0000-0000-0000-000000000703', false, false, false),
  ('eeeeeeee-0000-0000-0000-000000000704', true, true, true),
  ('eeeeeeee-0000-0000-0000-000000000705', true, true, true);

insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, round_number) values
  (9907001, '2026-05-01 18:00+00', 'Zr Park', 'bbbbbbbb-0000-0000-0000-000000000701', 3),
  (9907002, '2026-05-08 18:00+00', 'Zr Park', 'bbbbbbbb-0000-0000-0000-000000000701', 4);

-- Ana raced twice in 9907001, so the enqueue must still give her one email.
insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, finish_position) values
  (9907001, 1, 990700001, 'Ana Notify', 1),
  (9907001, 2, 990700001, 'Ana Notify', 2),
  (9907001, 1, 990700002, 'Ben Quiet', 2),
  (9907001, 1, 990700003, 'Cyd Pending', 3),
  (9907001, 1, 990700004, 'Una Linked', 4),
  (9907002, 1, 990700001, 'Ana Notify', 1);

insert into public.penalties (id, subsession_id, race_number, driver_id, description) values
  ('cccccccc-0000-0000-0000-000000000711', 9907001, 1, '99999999-0000-0000-0000-000000000701', 'Contact in turn 1');

insert into public.incident_appeals (id, subsession_id, penalty_id, message, submitter_id, status) values
  ('aaaaaaaa-0000-0000-0000-000000000701', 9907001, 'cccccccc-0000-0000-0000-000000000711', 'Please review',
   'eeeeeeee-0000-0000-0000-000000000702', 'open'),
  ('aaaaaaaa-0000-0000-0000-000000000702', 9907001, 'cccccccc-0000-0000-0000-000000000711', 'Please review',
   'eeeeeeee-0000-0000-0000-000000000703', 'open'),
  ('aaaaaaaa-0000-0000-0000-000000000703', 9907001, 'cccccccc-0000-0000-0000-000000000711', 'Second look',
   'eeeeeeee-0000-0000-0000-000000000702', 'dismissed'),
  ('aaaaaaaa-0000-0000-0000-000000000704', 9907001, 'cccccccc-0000-0000-0000-000000000711', 'Deleted account',
   null, 'open');

savepoint fixture;

-- N01 Grants: every Worker function is a definer with an empty search_path, executable by service_role
--     only; the admin counts are for signed-in callers; the tables are closed (BR10.18, NFR1.1, NFR1.2) -----
do $$
declare
  v_names text[] := array['notifications_enqueue_reminders', 'notifications_drop_expired',
                          'notifications_take_stale_batch', 'notifications_claim_batch',
                          'notifications_store_rendered', 'notifications_mark_batch', 'notifications_record_run'];
  v_fn record;
  v_found integer := 0;
  v_table text;
begin
  for v_fn in
    select p.oid, p.proname, p.prosecdef, p.proconfig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any (v_names)
  loop
    v_found := v_found + 1;
    perform notifications_fixture.expect('N01 ' || v_fn.proname || ' anon execute',
      has_function_privilege('anon', v_fn.oid, 'execute'), false);
    perform notifications_fixture.expect('N01 ' || v_fn.proname || ' authenticated execute',
      has_function_privilege('authenticated', v_fn.oid, 'execute'), false);
    perform notifications_fixture.expect('N01 ' || v_fn.proname || ' service_role execute',
      has_function_privilege('service_role', v_fn.oid, 'execute'), true);
    perform notifications_fixture.expect('N01 ' || v_fn.proname || ' security definer', v_fn.prosecdef, true);
    perform notifications_fixture.expect('N01 ' || v_fn.proname || ' empty search_path',
      'search_path=""' = any (v_fn.proconfig), true);
  end loop;
  perform notifications_fixture.expect('N01 every Worker function exists', v_found, array_length(v_names, 1));

  perform notifications_fixture.expect('N01 admin counts for authenticated',
    has_function_privilege('authenticated', 'public.notifications_admin_counts()', 'execute'), true);
  perform notifications_fixture.expect('N01 admin counts not for anon',
    has_function_privilege('anon', 'public.notifications_admin_counts()', 'execute'), false);
  perform notifications_fixture.expect('N01 trigger function closed',
    has_function_privilege('authenticated', 'private.enqueue_report_posted()', 'execute'), false);

  foreach v_table in array array['public.email_outbox', 'public.email_enqueue_failures', 'public.notification_runs'] loop
    perform notifications_fixture.expect('N01 ' || v_table || ' row level security',
      (select c.relrowsecurity from pg_class c where c.oid = v_table::regclass), true);
    perform notifications_fixture.expect('N01 ' || v_table || ' no policies',
      (select count(*)::int from pg_policy p where p.polrelid = v_table::regclass), 0);
    perform notifications_fixture.expect('N01 ' || v_table || ' anon privileges',
      has_table_privilege('anon', v_table, 'select, insert, update, delete'), false);
    perform notifications_fixture.expect('N01 ' || v_table || ' authenticated privileges',
      has_table_privilege('authenticated', v_table, 'select, insert, update, delete'), false);
  end loop;
  raise notice 'ok N01 grants';
end $$;
rollback to savepoint fixture;

-- N02 Anon, a linked driver and an admin are all refused on the outbox and the Worker functions (NFR1.1) --
do $$
declare
  v_who text;
begin
  foreach v_who in array array['anon', 'eeeeeeee-0000-0000-0000-000000000702', 'eeeeeeee-0000-0000-0000-000000000701'] loop
    perform notifications_fixture.expect('N02 select outbox as ' || v_who,
      notifications_fixture.state_as(v_who, 'select count(*) from public.email_outbox'), '42501');
    perform notifications_fixture.expect('N02 insert outbox as ' || v_who,
      notifications_fixture.state_as(v_who, $q$insert into public.email_outbox (kind, profile_id, subject_id, dedupe_key, payload, send_by)
        values ('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'x', 'x', '{}', now())$q$), '42501');
    perform notifications_fixture.expect('N02 read runs as ' || v_who,
      notifications_fixture.state_as(v_who, 'select count(*) from public.notification_runs'), '42501');
    perform notifications_fixture.expect('N02 claim as ' || v_who,
      notifications_fixture.state_as(v_who, $q$select public.notifications_claim_batch(gen_random_uuid(), 10, 100)$q$), '42501');
  end loop;
  raise notice 'ok N02 outbox closed to every caller';
end $$;
rollback to savepoint fixture;

-- N03 A first post through the site's upsert (an INSERT) queues one email per raced, opted-in, linked
--     account, with no address in the payload (BR10.3, NFR1.3) -------------------------------------------
do $$
declare
  v_profiles text;
  v_payload jsonb;
begin
  perform notifications_fixture.post_round('eeeeeeee-0000-0000-0000-000000000701', 9907001, true);
  select string_agg(o.profile_id::text, ',' order by o.profile_id) into v_profiles
  from public.email_outbox o where o.kind = 'report_posted' and o.subject_id = '9907001';
  select o.payload into v_payload from public.email_outbox o
  where o.kind = 'report_posted' and o.profile_id = 'eeeeeeee-0000-0000-0000-000000000702';
  perform notifications_fixture.expect('N03 recipients', v_profiles,
    'eeeeeeee-0000-0000-0000-000000000702,eeeeeeee-0000-0000-0000-000000000704');
  perform notifications_fixture.expect('N03 dedupe key',
    (select o.dedupe_key from public.email_outbox o where o.kind = 'report_posted' and o.profile_id = 'eeeeeeee-0000-0000-0000-000000000702'),
    'report_posted:9907001:eeeeeeee-0000-0000-0000-000000000702');
  perform notifications_fixture.expect('N03 payload label', concat_ws('|', v_payload ->> 'season_label', v_payload ->> 'round_number'),
    'Zr Season|3');
  perform notifications_fixture.expect('N03 no address in payload', position('@' in v_payload::text), 0);
  perform notifications_fixture.expect('N03 first_posted_at set',
    (select (first_posted_at is not null)::text from public.round_incident_status where subsession_id = 9907001), 'true');
  raise notice 'ok N03 first post as an insert';
end $$;
rollback to savepoint fixture;

-- N04 A first post that updates an existing unposted row (the upsert's update path) queues the same --------
do $$
begin
  insert into public.round_incident_status (subsession_id, posted) values (9907001, false);
  perform notifications_fixture.expect('N04 nothing queued while unposted',
    (select count(*)::int from public.email_outbox), 0);
  perform notifications_fixture.post_round('eeeeeeee-0000-0000-0000-000000000701', 9907001, true);
  perform notifications_fixture.expect('N04 queued on first post',
    (select count(*)::int from public.email_outbox where kind = 'report_posted' and subject_id = '9907001'), 2);
  raise notice 'ok N04 first post as an update';
end $$;
rollback to savepoint fixture;

-- N05 Unposting keeps first_posted_at, a re-post queues nothing, and nobody can clear it (BR10.3, C7) -------
do $$
declare
  v_first timestamptz;
begin
  perform notifications_fixture.post_round('eeeeeeee-0000-0000-0000-000000000701', 9907001, true);
  select first_posted_at into v_first from public.round_incident_status where subsession_id = 9907001;
  perform notifications_fixture.post_round('eeeeeeee-0000-0000-0000-000000000701', 9907001, false);
  perform notifications_fixture.expect('N05 kept on unpost',
    (select first_posted_at from public.round_incident_status where subsession_id = 9907001), v_first);
  delete from public.email_outbox;
  perform notifications_fixture.post_round('eeeeeeee-0000-0000-0000-000000000701', 9907001, true);
  perform notifications_fixture.exec_as('eeeeeeee-0000-0000-0000-000000000701',
    'update public.round_incident_status set first_posted_at = null where subsession_id = 9907001');
  perform notifications_fixture.expect('N05 re-post queues nothing', (select count(*)::int from public.email_outbox), 0);
  perform notifications_fixture.expect('N05 cannot be cleared',
    (select first_posted_at from public.round_incident_status where subsession_id = 9907001), v_first);
  raise notice 'ok N05 re-post';
end $$;
rollback to savepoint fixture;

-- N06 A round that already has first_posted_at (as the migration's backfill leaves it) never sends (BR10.4)
do $$
begin
  alter table public.round_incident_status disable trigger round_incident_status_enqueue_report_posted;
  insert into public.round_incident_status (subsession_id, posted, posted_at) values (9907002, true, now());
  alter table public.round_incident_status enable trigger round_incident_status_enqueue_report_posted;
  perform notifications_fixture.post_round('eeeeeeee-0000-0000-0000-000000000701', 9907002, true);
  perform notifications_fixture.expect('N06 backfilled round sends nothing', (select count(*)::int from public.email_outbox), 0);
  raise notice 'ok N06 backfilled round';
end $$;
rollback to savepoint fixture;

-- N07 An appeal reviewed once, reviewed again, and one reviewed from dismissed: one email each (BR10.1, BR10.2)
do $$
begin
  perform notifications_fixture.exec_as('eeeeeeee-0000-0000-0000-000000000701',
    $q$update public.incident_appeals set status = 'reviewed' where id = 'aaaaaaaa-0000-0000-0000-000000000701'$q$);
  perform notifications_fixture.exec_as('eeeeeeee-0000-0000-0000-000000000701',
    $q$update public.incident_appeals set status = 'open' where id = 'aaaaaaaa-0000-0000-0000-000000000701'$q$);
  perform notifications_fixture.exec_as('eeeeeeee-0000-0000-0000-000000000701',
    $q$update public.incident_appeals set status = 'reviewed' where id = 'aaaaaaaa-0000-0000-0000-000000000701'$q$);
  perform notifications_fixture.exec_as('eeeeeeee-0000-0000-0000-000000000701',
    $q$update public.incident_appeals set status = 'reviewed' where id = 'aaaaaaaa-0000-0000-0000-000000000703'$q$);
  perform notifications_fixture.expect('N07 one email per appeal',
    (select string_agg(o.dedupe_key, ',' order by o.dedupe_key) from public.email_outbox o),
    'appeal_reviewed:aaaaaaaa-0000-0000-0000-000000000701:eeeeeeee-0000-0000-0000-000000000702,'
    || 'appeal_reviewed:aaaaaaaa-0000-0000-0000-000000000703:eeeeeeee-0000-0000-0000-000000000702');
  raise notice 'ok N07 appeal reviewed';
end $$;
rollback to savepoint fixture;

-- N08 A submitter with the toggle off, and an appeal whose account is gone, queue nothing (BR10.1) ----------
do $$
begin
  perform notifications_fixture.exec_as('eeeeeeee-0000-0000-0000-000000000701',
    $q$update public.incident_appeals set status = 'reviewed'
       where id in ('aaaaaaaa-0000-0000-0000-000000000702', 'aaaaaaaa-0000-0000-0000-000000000704')$q$);
  perform notifications_fixture.expect('N08 nothing queued', (select count(*)::int from public.email_outbox), 0);
  perform notifications_fixture.expect('N08 reviews saved',
    (select count(*)::int from public.incident_appeals where status = 'reviewed'), 2);
  raise notice 'ok N08 toggle off';
end $$;
rollback to savepoint fixture;

-- N09 A failing enqueue never fails the admin's statement; the failure is recorded (BR10.5, NFR1.5) --------
do $$
begin
  alter table public.email_outbox add constraint notifications_fixture_fail check (kind = 'event_reminder') not valid;
  perform notifications_fixture.post_round('eeeeeeee-0000-0000-0000-000000000701', 9907001, true);
  perform notifications_fixture.exec_as('eeeeeeee-0000-0000-0000-000000000701',
    $q$update public.incident_appeals set status = 'reviewed' where id = 'aaaaaaaa-0000-0000-0000-000000000701'$q$);
  perform notifications_fixture.expect('N09 round posted',
    (select posted::text from public.round_incident_status where subsession_id = 9907001), 'true');
  perform notifications_fixture.expect('N09 appeal reviewed',
    (select status from public.incident_appeals where id = 'aaaaaaaa-0000-0000-0000-000000000701'), 'reviewed');
  perform notifications_fixture.expect('N09 failures recorded',
    (select string_agg(f.kind || ':' || f.subject_id, ',' order by f.kind) from public.email_enqueue_failures f),
    'appeal_reviewed:aaaaaaaa-0000-0000-0000-000000000701,report_posted:9907001');
  perform notifications_fixture.expect('N09 nothing queued', (select count(*)::int from public.email_outbox), 0);
  raise notice 'ok N09 failure capture';
end $$;
rollback to savepoint fixture;

-- N10 Reminders: only championship events whose first session is 11 h 45 min to 12 h away, one per linked
--     account with the toggle on; a second run adds nothing (BR10.6, NFR4.3) --------------------------------
do $$
declare
  v_result jsonb;
  v_again jsonb;
begin
  insert into public.events (id, circuit_id, event_date, category, practice_start_time, race1_start_time) values
    ('dddddddd-0000-0000-0000-000000000701', 'cccccccc-0000-0000-0000-000000000701',
     notifications_fixture.et_date('11 hours 50 minutes'), 'championship', notifications_fixture.et_time('11 hours 50 minutes'), null),
    ('dddddddd-0000-0000-0000-000000000702', 'cccccccc-0000-0000-0000-000000000701',
     notifications_fixture.et_date('11 hours 40 minutes'), 'championship', null, notifications_fixture.et_time('11 hours 40 minutes')),
    ('dddddddd-0000-0000-0000-000000000703', 'cccccccc-0000-0000-0000-000000000701',
     notifications_fixture.et_date('11 hours 59 minutes'), 'championship', null, notifications_fixture.et_time('11 hours 59 minutes')),
    ('dddddddd-0000-0000-0000-000000000704', 'cccccccc-0000-0000-0000-000000000701',
     notifications_fixture.et_date('12 hours 1 minute'), 'championship', null, notifications_fixture.et_time('12 hours 1 minute')),
    ('dddddddd-0000-0000-0000-000000000705', 'cccccccc-0000-0000-0000-000000000701',
     notifications_fixture.et_date('11 hours 50 minutes'), 'exhibition', null, notifications_fixture.et_time('11 hours 50 minutes')),
    ('dddddddd-0000-0000-0000-000000000706', 'cccccccc-0000-0000-0000-000000000701',
     notifications_fixture.et_date('11 hours 50 minutes'), 'championship', null, null);
  v_result := public.notifications_enqueue_reminders();
  v_again := public.notifications_enqueue_reminders();
  perform notifications_fixture.expect('N10 enqueued', (v_result ->> 'enqueued')::int, 4);
  perform notifications_fixture.expect('N10 events reminded',
    (select string_agg(distinct o.subject_id, ',' order by o.subject_id) from public.email_outbox o
     where o.kind = 'event_reminder'),
    'dddddddd-0000-0000-0000-000000000701,dddddddd-0000-0000-0000-000000000703');
  perform notifications_fixture.expect('N10 recipients',
    (select string_agg(distinct o.profile_id::text, ',' order by o.profile_id::text) from public.email_outbox o),
    'eeeeeeee-0000-0000-0000-000000000702,eeeeeeee-0000-0000-0000-000000000704');
  perform notifications_fixture.expect('N10 send-by is the start',
    (select count(*)::int from public.email_outbox o where o.send_by = (o.payload ->> 'starts_at')::timestamptz), 4);
  perform notifications_fixture.expect('N10 second run adds nothing', (v_again ->> 'enqueued')::int, 0);
  raise notice 'ok N10 reminder window';
end $$;
rollback to savepoint fixture;

-- N11 An event moved before its reminder went out queues a new reminder; the old one drops as event_moved at
--     claim, and an unconfirmed address drops as no_confirmed_address (BR10.7, BR10.10) ---------------------
do $$
declare
  v_claim jsonb;
begin
  insert into public.events (id, circuit_id, event_date, category, race1_start_time) values
    ('dddddddd-0000-0000-0000-000000000711', 'cccccccc-0000-0000-0000-000000000701',
     notifications_fixture.et_date('11 hours 50 minutes'), 'championship', notifications_fixture.et_time('11 hours 50 minutes'));
  perform public.notifications_enqueue_reminders();
  update public.events
  set event_date = notifications_fixture.et_date('11 hours 55 minutes'),
      race1_start_time = notifications_fixture.et_time('11 hours 55 minutes')
  where id = 'dddddddd-0000-0000-0000-000000000711';
  perform notifications_fixture.expect('N11 moved event queues again',
    (public.notifications_enqueue_reminders() ->> 'enqueued')::int, 2);
  v_claim := notifications_fixture.claim(50, 100);
  perform notifications_fixture.expect('N11 drop reasons',
    (select string_agg(d.value ->> 'reason', ',' order by d.value ->> 'reason') from jsonb_array_elements(v_claim -> 'dropped') d),
    'event_moved,no_confirmed_address,no_confirmed_address');
  perform notifications_fixture.expect('N11 the new reminder is claimed', jsonb_array_length(v_claim -> 'rows'), 1);
  perform notifications_fixture.expect('N11 claimed row carries the address',
    v_claim -> 'rows' -> 0 ->> 'to', 'notify-a@example.test');
  raise notice 'ok N11 moved event';
end $$;
rollback to savepoint fixture;

-- N12 Once a reminder was sent to an account, a later move sends that account no follow-up (BR10.7) --------
do $$
begin
  insert into public.events (id, circuit_id, event_date, category, race1_start_time) values
    ('dddddddd-0000-0000-0000-000000000712', 'cccccccc-0000-0000-0000-000000000701',
     notifications_fixture.et_date('11 hours 50 minutes'), 'championship', notifications_fixture.et_time('11 hours 50 minutes'));
  perform public.notifications_enqueue_reminders();
  update public.email_outbox set status = 'sent', sent_at = now(), finished_at = now()
  where profile_id = 'eeeeeeee-0000-0000-0000-000000000702';
  update public.events
  set event_date = notifications_fixture.et_date('11 hours 55 minutes'),
      race1_start_time = notifications_fixture.et_time('11 hours 55 minutes')
  where id = 'dddddddd-0000-0000-0000-000000000712';
  perform notifications_fixture.expect('N12 only the unsent account queues again',
    (public.notifications_enqueue_reminders() ->> 'enqueued')::int, 1);
  perform notifications_fixture.expect('N12 sent account has one reminder',
    (select count(*)::int from public.email_outbox where profile_id = 'eeeeeeee-0000-0000-0000-000000000702'), 1);
  raise notice 'ok N12 already sent';
end $$;
rollback to savepoint fixture;

-- N13 The first session is the earliest set time, converted with that date's Eastern offset (NFR4.8) -------
do $$
begin
  perform notifications_fixture.expect('N13 before the change (EDT)',
    private.notifications_event_starts_at('2026-10-31', null, null, '20:00', null, null), '2026-11-01 00:00:00+00'::timestamptz);
  perform notifications_fixture.expect('N13 after the change (EST)',
    private.notifications_event_starts_at('2026-11-01', null, null, '20:00', null, null), '2026-11-02 01:00:00+00'::timestamptz);
  perform notifications_fixture.expect('N13 earliest session wins',
    private.notifications_event_starts_at('2026-11-01', '19:15', null, '20:00', '18:30', null), '2026-11-01 23:30:00+00'::timestamptz);
  perform notifications_fixture.expect('N13 no session time',
    private.notifications_event_starts_at('2026-11-01', null, null, null, null, null), null::timestamptz);
  raise notice 'ok N13 daylight saving';
end $$;
rollback to savepoint fixture;

-- N14 A window that closed with no reminder row is reported; one with a row is not (BR10.6) ---------------
do $$
declare
  v_result jsonb;
begin
  insert into public.events (id, circuit_id, event_date, category, race1_start_time) values
    ('dddddddd-0000-0000-0000-000000000714', 'cccccccc-0000-0000-0000-000000000701',
     notifications_fixture.et_date('11 hours 40 minutes'), 'championship', notifications_fixture.et_time('11 hours 40 minutes')),
    ('dddddddd-0000-0000-0000-000000000715', 'cccccccc-0000-0000-0000-000000000701',
     notifications_fixture.et_date('11 hours 40 minutes'), 'championship', notifications_fixture.et_time('11 hours 40 minutes'));
  perform notifications_fixture.queue('event_reminder', 'eeeeeeee-0000-0000-0000-000000000702', 'dddddddd-0000-0000-0000-000000000715');
  v_result := public.notifications_enqueue_reminders();
  perform notifications_fixture.expect('N14 missed windows', v_result -> 'missed_windows',
    '["dddddddd-0000-0000-0000-000000000714"]'::jsonb);
  raise notice 'ok N14 missed windows';
end $$;
rollback to savepoint fixture;

-- N15 Two claims take disjoint rows, oldest first, returned by id with the address; the outbox itself never
--     holds one (BR10.8, BR10.9, NFR1.3, NFR4.4) --------------------------------------------------------
do $$
declare
  v_s1 uuid;
  v_s2 uuid;
  v_s3 uuid;
  v_first jsonb;
  v_second jsonb;
begin
  v_s1 := notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 's1', 0, '3 minutes');
  v_s2 := notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 's2', 0, '2 minutes');
  v_s3 := notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 's3', 0, '1 minute');
  v_first := notifications_fixture.claim(2, 100);
  v_second := notifications_fixture.claim(2, 100);
  perform notifications_fixture.expect('N15 first claim takes the two oldest, by id',
    notifications_fixture.ids(v_first), array(select unnest(array[v_s1, v_s2]) order by 1));
  perform notifications_fixture.expect('N15 second claim takes the rest', notifications_fixture.ids(v_second), array[v_s3]);
  perform notifications_fixture.expect('N15 address returned', v_first -> 'rows' -> 1 ->> 'to', 'notify-a@example.test');
  perform notifications_fixture.expect('N15 rows hold their batch',
    (select count(*)::int from public.email_outbox o
     where o.status = 'sending' and o.claim_token = (v_first ->> 'batch_id')::uuid), 2);
  perform notifications_fixture.expect('N15 no address stored',
    (select count(*)::int from public.email_outbox o where position('@' in o::text) > 0), 0);
  raise notice 'ok N15 disjoint claims';
end $$;
rollback to savepoint fixture;

-- N16 At claim, a toggle turned off, an unconfirmed address and a deleted event drop with their reasons;
--     an account with no driver still gets its appeal email (BR10.10) -----------------------------------
do $$
declare
  v_claim jsonb;
begin
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000703', 'off');
  perform notifications_fixture.queue('report_posted', 'eeeeeeee-0000-0000-0000-000000000704', 'unconfirmed');
  perform notifications_fixture.queue('event_reminder', 'eeeeeeee-0000-0000-0000-000000000702',
    'dddddddd-0000-0000-0000-000000000799', 0, '0 minutes', jsonb_build_object('starts_at', now() + interval '12 hours'));
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000705', 'unlinked');
  v_claim := notifications_fixture.claim(50, 100);
  perform notifications_fixture.expect('N16 dropped with reasons',
    (select string_agg(o.subject_id || '=' || o.dropped_reason, ',' order by o.subject_id)
     from public.email_outbox o where o.status = 'dropped'),
    'dddddddd-0000-0000-0000-000000000799=event_moved,off=toggle_off,unconfirmed=no_confirmed_address');
  perform notifications_fixture.expect('N16 the rest is claimed', v_claim -> 'rows' -> 0 ->> 'to', 'notify-d@example.test');
  raise notice 'ok N16 claim re-checks';
end $$;
rollback to savepoint fixture;

-- N17 The daily cap counts live claims and today's sends, so sequential claims under the lock never pass
--     it (BR10.8, security design amendment 1) -----------------------------------------------------------
do $$
declare
  v_first jsonb;
  v_second jsonb;
  v_after_send jsonb;
  v_raised jsonb;
begin
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'c1');
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'c2');
  v_first := notifications_fixture.claim(10, 1);
  v_second := notifications_fixture.claim(10, 1);
  perform notifications_fixture.expect('N17 first claim within the cap',
    concat_ws(',', jsonb_array_length(v_first -> 'rows'), v_first ->> 'cap_left'), '1,0');
  perform notifications_fixture.expect('N17 a live claim counts',
    concat_ws(',', jsonb_array_length(v_second -> 'rows'), v_second ->> 'cap_left'), '0,0');
  perform public.notifications_mark_batch((v_first ->> 'batch_id')::uuid, '{"outcome":"sent"}');
  v_after_send := notifications_fixture.claim(10, 1);
  v_raised := notifications_fixture.claim(10, 2);
  perform notifications_fixture.expect('N17 today''s send counts', jsonb_array_length(v_after_send -> 'rows'), 0);
  perform notifications_fixture.expect('N17 a higher cap claims the rest', jsonb_array_length(v_raised -> 'rows'), 1);
  raise notice 'ok N17 daily cap';
end $$;
rollback to savepoint fixture;

-- N18 A mixed queue claims the highest attempt level first, at max(1, size / 2^level) (BR10.12) ----------
do $$
declare
  v_claim jsonb;
  i integer;
begin
  for i in 1..4 loop
    perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'level0-' || i, 0);
  end loop;
  for i in 1..3 loop
    perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'level2-' || i, 2);
  end loop;
  v_claim := notifications_fixture.claim(8, 100);
  perform notifications_fixture.expect('N18 level and size',
    concat_ws(',', v_claim ->> 'level', jsonb_array_length(v_claim -> 'rows')), '2,2');
  perform notifications_fixture.expect('N18 never mixes levels',
    (select string_agg(distinct o.attempts::text, ',') from public.email_outbox o where o.status = 'sending'), '2');
  raise notice 'ok N18 attempt levels';
end $$;
rollback to savepoint fixture;

-- N19 A mark with another batch id changes nothing; the right one marks sent with provider ids (BR10.9) ----
do $$
declare
  v_claim jsonb;
  v_ids uuid[];
  v_wrong jsonb;
begin
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'm1');
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'm2');
  v_claim := notifications_fixture.claim(10, 100);
  v_ids := notifications_fixture.ids(v_claim);
  v_wrong := public.notifications_mark_batch(gen_random_uuid(), '{"outcome":"sent"}');
  perform notifications_fixture.expect('N19 wrong batch id', (v_wrong ->> 'updated')::int, 0);
  perform notifications_fixture.expect('N19 still sending',
    (select count(*)::int from public.email_outbox where status = 'sending'), 2);
  perform public.notifications_mark_batch((v_claim ->> 'batch_id')::uuid, jsonb_build_object('outcome', 'sent',
    'provider_ids', jsonb_build_array(jsonb_build_object('id', v_ids[1], 'provider_id', 'p-1'),
                                      jsonb_build_object('id', v_ids[2], 'provider_id', 'p-2'))));
  perform notifications_fixture.expect('N19 marked sent',
    (select string_agg(o.status || ':' || o.provider_id || ':' || (o.sent_at is not null)::text, ',' order by o.provider_id)
     from public.email_outbox o),
    'sent:p-1:true,sent:p-2:true');
  raise notice 'ok N19 marks';
end $$;
rollback to savepoint fixture;

-- N20 A permanent rejection requeues a batch with attempts + 1 and a clean claim; a batch of one drops as
--     rejected (BR10.12, security design amendment 5) -----------------------------------------------------
do $$
declare
  v_claim jsonb;
begin
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'r1');
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'r2');
  v_claim := notifications_fixture.claim(2, 100);
  perform public.notifications_store_rendered((v_claim ->> 'batch_id')::uuid,
    (select jsonb_agg(jsonb_build_object('id', r.value ->> 'id', 'rendered', '{"subject":"s","html":"h","text":"t"}'::jsonb))
     from jsonb_array_elements(v_claim -> 'rows') r));
  perform public.notifications_mark_batch((v_claim ->> 'batch_id')::uuid, '{"outcome":"permanent","error":"422 validation_error"}');
  perform notifications_fixture.expect('N20 requeued with a clean claim',
    (select string_agg(distinct concat_ws(',', o.status, o.attempts, (o.claim_token is null)::text, (o.rendered is null)::text,
                                          (o.first_claimed_at is null)::text, o.last_error), ';')
     from public.email_outbox o),
    'queued,1,true,true,true,422 validation_error');
  v_claim := notifications_fixture.claim(2, 100);
  perform notifications_fixture.expect('N20 level 1 halves the batch', jsonb_array_length(v_claim -> 'rows'), 1);
  perform public.notifications_mark_batch((v_claim ->> 'batch_id')::uuid, '{"outcome":"permanent","error":"422"}');
  perform notifications_fixture.expect('N20 a single row drops as rejected',
    (select count(*)::int from public.email_outbox where status = 'dropped' and dropped_reason = 'rejected'), 1);
  raise notice 'ok N20 permanent rejection';
end $$;
rollback to savepoint fixture;

-- N21 An idempotency conflict becomes unknown; a release requeues with no attempt; a transient failure keeps
--     the batch; an unknown outcome is refused (BR10.12, security design amendment 2) ------------------------
do $$
declare
  v_a jsonb;
  v_b jsonb;
  v_c jsonb;
begin
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'k1', 0, '3 minutes');
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'k2', 0, '2 minutes');
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'k3', 0, '1 minute');
  v_a := notifications_fixture.claim(1, 100);
  v_b := notifications_fixture.claim(1, 100);
  v_c := notifications_fixture.claim(1, 100);
  perform public.notifications_mark_batch((v_a ->> 'batch_id')::uuid, '{"outcome":"conflict"}');
  perform public.notifications_mark_batch((v_b ->> 'batch_id')::uuid, '{"outcome":"release","error":"daily_quota"}');
  perform public.notifications_mark_batch((v_c ->> 'batch_id')::uuid, '{"outcome":"transient","error":"503"}');
  perform notifications_fixture.expect('N21 outcomes',
    (select string_agg(concat_ws(':', o.subject_id, o.status, o.attempts, o.last_error, (o.claim_token is null)::text), ','
                       order by o.subject_id) from public.email_outbox o),
    'k1:unknown:0:idempotent_conflict:false,k2:queued:0:daily_quota:true,k3:sending:0:503:false');
  begin
    perform public.notifications_mark_batch((v_c ->> 'batch_id')::uuid, '{"outcome":"bogus"}');
    raise exception 'N21 unknown outcome was accepted';
  exception when invalid_parameter_value then
    null;
  end;
  raise notice 'ok N21 conflict, release, transient';
end $$;
rollback to savepoint fixture;

-- N22 Renderings are stored only for this batch's rows, once, and only when complete (BR10.9) ---------------
do $$
declare
  v_claim jsonb;
  v_ids uuid[];
begin
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'w1');
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'w2');
  v_claim := notifications_fixture.claim(10, 100);
  v_ids := notifications_fixture.ids(v_claim);
  perform notifications_fixture.expect('N22 wrong batch stores nothing',
    public.notifications_store_rendered(gen_random_uuid(), jsonb_build_array(
      jsonb_build_object('id', v_ids[1], 'rendered', '{"subject":"s","html":"h","text":"t"}'::jsonb))), 0);
  perform notifications_fixture.expect('N22 incomplete rendering refused',
    public.notifications_store_rendered((v_claim ->> 'batch_id')::uuid, jsonb_build_array(
      jsonb_build_object('id', v_ids[1], 'rendered', '{"subject":"s"}'::jsonb))), 0);
  perform notifications_fixture.expect('N22 both stored',
    public.notifications_store_rendered((v_claim ->> 'batch_id')::uuid, jsonb_build_array(
      jsonb_build_object('id', v_ids[1], 'rendered', '{"subject":"s","html":"h","text":"t"}'::jsonb),
      jsonb_build_object('id', v_ids[2], 'rendered', '{"subject":"s","html":"h","text":"t"}'::jsonb))), 2);
  perform notifications_fixture.expect('N22 never overwritten',
    public.notifications_store_rendered((v_claim ->> 'batch_id')::uuid, jsonb_build_array(
      jsonb_build_object('id', v_ids[1], 'rendered', '{"subject":"x","html":"x","text":"x"}'::jsonb))), 0);
  raise notice 'ok N22 stored renderings';
end $$;
rollback to savepoint fixture;

-- N23 A stale batch comes back once, unchanged and in id order; one never rendered is released; one first
--     claimed over 20 hours ago drops as stale_unknown; one whose address went away becomes unknown (BR10.9,
--     NFR4.4, security design amendment 4) --------------------------------------------------------------
do $$
declare
  v_claim jsonb;
  v_stale jsonb;
  v_again jsonb;
begin
  -- Rendered and stale: re-sent.
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 't1');
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000705', 't2');
  v_claim := notifications_fixture.claim(10, 100);
  perform public.notifications_store_rendered((v_claim ->> 'batch_id')::uuid,
    (select jsonb_agg(jsonb_build_object('id', r.value ->> 'id', 'rendered', '{"subject":"s","html":"h","text":"t"}'::jsonb))
     from jsonb_array_elements(v_claim -> 'rows') r));
  update public.email_outbox set claimed_at = now() - interval '11 minutes';
  v_stale := public.notifications_take_stale_batch();
  v_again := public.notifications_take_stale_batch();
  perform notifications_fixture.expect('N23 same batch', v_stale ->> 'batch_id', v_claim ->> 'batch_id');
  perform notifications_fixture.expect('N23 same rows, by id', notifications_fixture.ids(v_stale), notifications_fixture.ids(v_claim));
  perform notifications_fixture.expect('N23 stored rendering and address',
    concat_ws(',', v_stale -> 'rows' -> 0 -> 'rendered' ->> 'subject',
              ((v_stale -> 'rows' -> 0 ->> 'to') is not null)::text), 's,true');
  perform notifications_fixture.expect('N23 taken once', v_again ->> 'batch_id', null);

  -- Address gone: the whole batch becomes unknown.
  update public.email_outbox set claimed_at = now() - interval '11 minutes';
  update auth.users set email_confirmed_at = null where id = 'eeeeeeee-0000-0000-0000-000000000705';
  v_stale := public.notifications_take_stale_batch();
  perform notifications_fixture.expect('N23 address changed',
    concat_ws(',', v_stale ->> 'batch_id', v_stale ->> 'address_changed'), '2');
  perform notifications_fixture.expect('N23 unknown rows',
    (select string_agg(distinct o.status || ':' || o.last_error, ',') from public.email_outbox o), 'unknown:address_changed');
  update auth.users set email_confirmed_at = now() where id = 'eeeeeeee-0000-0000-0000-000000000705';
  delete from public.email_outbox;

  -- Never rendered: released to queued.
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 't3');
  perform notifications_fixture.claim(10, 100);
  update public.email_outbox set claimed_at = now() - interval '11 minutes';
  v_stale := public.notifications_take_stale_batch();
  perform notifications_fixture.expect('N23 unrendered released',
    (select concat_ws(',', v_stale ->> 'released', o.status, (o.claim_token is null)::text) from public.email_outbox o), '1,queued,true');

  -- Over the 20-hour cutoff.
  perform notifications_fixture.claim(10, 100);
  update public.email_outbox set claimed_at = now() - interval '21 hours', first_claimed_at = now() - interval '21 hours';
  v_stale := public.notifications_take_stale_batch();
  perform notifications_fixture.expect('N23 cutoff',
    concat_ws(',', jsonb_array_length(v_stale -> 'stale_unknown'), v_stale ->> 'batch_id',
              (select o.dropped_reason from public.email_outbox o)), '1,stale_unknown');
  raise notice 'ok N23 stale batches';
end $$;
rollback to savepoint fixture;

-- N24 Queued rows past send-by drop: expired, event_started for a reminder whose event began, cap_expired
--     when the cap was reached; rows in sending are left alone (BR10.11, NFR3.6) --------------------------
do $$
declare
  v_result jsonb;
begin
  insert into public.email_outbox (kind, profile_id, subject_id, dedupe_key, payload, send_by) values
    ('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'e1', 'e1', '{}', now() - interval '1 minute'),
    ('event_reminder', 'eeeeeeee-0000-0000-0000-000000000702', 'e2', 'e2',
     jsonb_build_object('starts_at', now() - interval '5 minutes'), now() - interval '5 minutes');
  insert into public.email_outbox (kind, profile_id, subject_id, dedupe_key, payload, send_by, status, claim_token, claimed_at)
  values ('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'e3', 'e3', '{}', now() - interval '1 minute',
          'sending', gen_random_uuid(), now());
  v_result := public.notifications_drop_expired(100);
  perform notifications_fixture.expect('N24 reasons',
    (select string_agg(d.value ->> 'reason', ',' order by d.value ->> 'reason') from jsonb_array_elements(v_result -> 'dropped') d),
    'event_started,expired');
  perform notifications_fixture.expect('N24 sending untouched',
    (select status from public.email_outbox where subject_id = 'e3'), 'sending');

  insert into public.email_outbox (kind, profile_id, subject_id, dedupe_key, payload, send_by, status, sent_at, finished_at)
  values ('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000705', 'e4', 'e4', '{}', now(), 'sent',
          now() - interval '1 hour', now() - interval '1 hour');
  insert into public.email_outbox (kind, profile_id, subject_id, dedupe_key, payload, send_by)
  values ('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'e5', 'e5', '{}', now() - interval '1 minute');
  v_result := public.notifications_drop_expired(1);
  perform notifications_fixture.expect('N24 cap_expired', v_result -> 'dropped' -> 0 ->> 'reason', 'cap_expired');
  raise notice 'ok N24 expiry';
end $$;
rollback to savepoint fixture;

-- N25 Retention: finished rows go after 30 days, appeal_reviewed rows after 365; queued rows, runs and
--     enqueue failures are kept or cleared by their own clocks (NFR3.5, security design amendment 9) ---------
do $$
declare
  v_result jsonb;
begin
  insert into public.email_outbox (kind, profile_id, subject_id, dedupe_key, payload, send_by, status, created_at, finished_at) values
    ('report_posted', 'eeeeeeee-0000-0000-0000-000000000702', 'old-report', 'old-report', '{}', now(), 'sent',
     now() - interval '31 days', now() - interval '31 days'),
    ('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'old-appeal', 'old-appeal', '{}', now(), 'sent',
     now() - interval '31 days', now() - interval '31 days'),
    ('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'ancient-appeal', 'ancient-appeal', '{}', now(), 'sent',
     now() - interval '366 days', now() - interval '366 days'),
    ('report_posted', 'eeeeeeee-0000-0000-0000-000000000702', 'old-unknown', 'old-unknown', '{}', now(), 'unknown',
     now() - interval '31 days', now() - interval '31 days'),
    ('report_posted', 'eeeeeeee-0000-0000-0000-000000000702', 'queued', 'queued', '{}', now() + interval '1 hour', 'queued',
     now() - interval '40 days', null);
  insert into public.notification_runs (ran_at, status) values (now() - interval '31 days', 'ok'), (now(), 'ok');
  insert into public.email_enqueue_failures (kind, subject_id, error, created_at)
  values ('report_posted', '1', 'x', now() - interval '31 days');
  v_result := public.notifications_drop_expired(100);
  perform notifications_fixture.expect('N25 deleted count', (v_result ->> 'retention_deleted')::int, 3);
  perform notifications_fixture.expect('N25 kept rows',
    (select string_agg(o.subject_id, ',' order by o.subject_id) from public.email_outbox o), 'old-appeal,queued');
  perform notifications_fixture.expect('N25 runs and failures',
    concat_ws(',', (select count(*) from public.notification_runs), (select count(*) from public.email_enqueue_failures)), '1,0');
  raise notice 'ok N25 retention';
end $$;
rollback to savepoint fixture;

-- N26 The run log: record_run stores the summary, and a quota marker pauses claims (amendments 2 and 7) -----
do $$
declare
  v_id uuid;
  v_claim jsonb;
begin
  v_id := public.notifications_record_run(jsonb_build_object('status', 'ok', 'run_id', 'r-1',
                                                             'quota_until', now() + interval '1 hour'));
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'q1');
  v_claim := notifications_fixture.claim(10, 100);
  perform notifications_fixture.expect('N26 run stored',
    (select concat_ws(',', r.status, r.summary ->> 'run_id', (r.quota_until is not null)::text) from public.notification_runs r where r.id = v_id),
    'ok,r-1,true');
  perform notifications_fixture.expect('N26 paused by the quota',
    concat_ws(',', v_claim ->> 'quota_paused', jsonb_array_length(v_claim -> 'rows')), 'true,0');
  raise notice 'ok N26 run log and quota';
end $$;
rollback to savepoint fixture;

-- N27 Admin counts: an admin gets them, with cap drops and unknown deliveries broken out and the last run's
--     status; a linked driver is refused (BR10.17, NFR1.4, NFR9.3) -----------------------------------------
do $$
declare
  v_counts jsonb;
  v_driver text;
begin
  perform notifications_fixture.queue('appeal_reviewed', 'eeeeeeee-0000-0000-0000-000000000702', 'waiting');
  insert into public.email_outbox (kind, profile_id, subject_id, dedupe_key, payload, send_by, status, dropped_reason, last_error, finished_at) values
    ('report_posted', 'eeeeeeee-0000-0000-0000-000000000702', 'capped', 'capped', '{}', now(), 'dropped', 'cap_expired', null, now()),
    ('report_posted', 'eeeeeeee-0000-0000-0000-000000000702', 'stale', 'stale', '{}', now(), 'dropped', 'stale_unknown', null, now()),
    ('report_posted', 'eeeeeeee-0000-0000-0000-000000000702', 'conflict', 'conflict', '{}', now(), 'unknown', null,
     'idempotent_conflict', now());
  insert into public.email_enqueue_failures (kind, subject_id, error) values ('report_posted', '9907001', 'x');
  perform public.notifications_record_run('{"status":"no_key"}');

  perform notifications_fixture.act_as('eeeeeeee-0000-0000-0000-000000000701');
  v_counts := public.notifications_admin_counts();
  perform notifications_fixture.as_owner();
  v_driver := notifications_fixture.state_as('eeeeeeee-0000-0000-0000-000000000702',
    'select public.notifications_admin_counts()');

  perform notifications_fixture.expect('N27 counts',
    concat_ws(',', v_counts ->> 'queued', v_counts ->> 'dropped_7d', v_counts ->> 'cap_dropped_7d',
              v_counts ->> 'unknown_7d', v_counts ->> 'enqueue_failures_7d', v_counts ->> 'last_run_status'),
    '1,1,1,2,1,no_key');
  perform notifications_fixture.expect('N27 linked driver refused', v_driver, '42501');
  raise notice 'ok N27 admin counts';
end $$;
rollback to savepoint fixture;

rollback;
