-- Incident review visibility fixtures for 20261113120000_incident_review_involved_visibility.sql (FR1.1, NFR2;
-- rules BR1.1 and BR1.6): who reads the steward reviews (and their faults) of an open, logged, dismissed and
-- reopened report, and who may change a report's status (W01-W07).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- round-auto-link-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/incident-review-visibility-fixtures.sql
--
-- Same conventions as incident-management-fixtures.sql (supabase/checks/README.md): every assertion calls
-- review_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each case
-- runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`. Callers are impersonated
-- with request.jwt.claims and the role setting.
--
-- Accounts: steward_in (admin, linked to Dee Steward, so involved in report R1); steward_rev (admin, no
-- driver, has reviewed R1); steward_new (admin, no driver, has not reviewed R1); ana (driver account).
-- Report R1 (open): Ana and Dee. One review of R1 by steward_rev, blaming Ana.

begin;

set local client_min_messages = notice;

create schema review_fixture;

create function review_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'incident review visibility fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Acts as p_who ('anon' or an account id) until review_fixture.as_owner().
create function review_fixture.act_as(p_who text) returns void
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

create function review_fixture.as_owner() returns void
  language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- The first value p_sql returns as p_who, as text.
create function review_fixture.text_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v text;
begin
  perform review_fixture.act_as(p_who);
  execute p_sql into v;
  perform review_fixture.as_owner();
  return v;
end;
$$;

-- The code before the first ':' of the error p_sql raises as p_who, or 'ok'. On an error the block's own
-- rollback puts the role back.
create function review_fixture.code_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform review_fixture.act_as(p_who);
  execute p_sql;
  perform review_fixture.as_owner();
  return 'ok';
exception when others then
  return split_part(sqlerrm, ':', 1);
end;
$$;

-- How many reviews and faults of R1 p_who reads, as 'reviews/faults'.
create function review_fixture.visible(p_who text) returns text
  language sql as $$
  select review_fixture.text_as(p_who,
    $q$select (select count(*) from public.incident_report_reviews
               where report_id = 'aaaaaaaa-0000-0000-0000-000000000c01')::text
              || '/' ||
              (select count(*) from public.incident_report_review_drivers
               where review_id = 'bbbbbbbb-0000-0000-0000-000000000c01')::text$q$);
$$;

-- A status change of R1 as p_who.
create function review_fixture.set_status_sql(p_status text) returns text
  language sql as $$
  select format($q$update public.incident_reports set status = %L, dismissal_reason = %L
                   where id = 'aaaaaaaa-0000-0000-0000-000000000c01'$q$,
                p_status, case when p_status = 'dismissed' then 'Not an incident' end);
$$;

grant usage on schema review_fixture to anon, authenticated;
grant execute on all functions in schema review_fixture to anon, authenticated;

-- Base data ------------------------------------------------------------------------------------

-- No scoring or round-stats side effects from the rows below.
update public.scoring_settings set triggers_enabled = false;

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (971, 'Active')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select 971, 'Alpha', 1 where not exists (select 1 from public.driver_classes where name = 'Alpha');

insert into public.seasons (id, number, name) values ('bbbbbbbb-0000-0000-0000-000000000c71', 9971, 'Zv Season');

insert into public.drivers (id, name, car_number, status_id, class_id, is_ai) values
  ('99999999-0000-0000-0000-000000000c01', 'Ana Visible', 971,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false),
  ('99999999-0000-0000-0000-000000000c04', 'Dee Steward', 974,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false);

-- The auth.users insert creates a 'driver' profile; the admins and the linked account are re-inserted,
-- because as postgres the profiles guard refuses a role or driver change.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000c01', 'rv-in@example.test', now(), '{"display_name":"Steward In"}'),
  ('eeeeeeee-0000-0000-0000-000000000c02', 'rv-rev@example.test', now(), '{"display_name":"Steward Rev"}'),
  ('eeeeeeee-0000-0000-0000-000000000c03', 'rv-new@example.test', now(), '{"display_name":"Steward New"}'),
  ('eeeeeeee-0000-0000-0000-000000000c04', 'rv-ana@example.test', now(), '{"display_name":"Ana Account"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000000c01', 'eeeeeeee-0000-0000-0000-000000000c02',
                                         'eeeeeeee-0000-0000-0000-000000000c03', 'eeeeeeee-0000-0000-0000-000000000c04');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000c01', 'admin', 'Steward In', '99999999-0000-0000-0000-000000000c04'),
  ('eeeeeeee-0000-0000-0000-000000000c02', 'admin', 'Steward Rev', null),
  ('eeeeeeee-0000-0000-0000-000000000c03', 'admin', 'Steward New', null),
  ('eeeeeeee-0000-0000-0000-000000000c04', 'driver', 'Ana Account', '99999999-0000-0000-0000-000000000c01');

insert into public.curated_rounds (subsession_id, start_time, track_name, season_id, round_number) values
  (9971001, '2026-06-05 18:00+00', 'Zv Park', 'bbbbbbbb-0000-0000-0000-000000000c71', 1);

insert into public.incident_reports (id, subsession_id, session, lap, turn, description, status) values
  ('aaaaaaaa-0000-0000-0000-000000000c01', 9971001, 'race:1', 4, '3', 'Contact at T3', 'open');
insert into public.incident_report_drivers (report_id, driver_id) values
  ('aaaaaaaa-0000-0000-0000-000000000c01', '99999999-0000-0000-0000-000000000c01'),
  ('aaaaaaaa-0000-0000-0000-000000000c01', '99999999-0000-0000-0000-000000000c04');

insert into public.incident_report_reviews (id, report_id, reviewer_id, reviewer_name, explanation) values
  ('bbbbbbbb-0000-0000-0000-000000000c01', 'aaaaaaaa-0000-0000-0000-000000000c01',
   'eeeeeeee-0000-0000-0000-000000000c02', 'Steward Rev', 'Ana dived in.');
insert into public.incident_report_review_drivers (review_id, driver_id, penalty) values
  ('bbbbbbbb-0000-0000-0000-000000000c01', '99999999-0000-0000-0000-000000000c01', '2');

savepoint fixture;

-- W01 Open report: the involved steward reads no review and no fault; the reviewer reads their own; an
--     uninvolved steward who has not reviewed stays blind; drivers and anon read nothing (BR1.1) ------------
do $$
begin
  perform review_fixture.expect('W01 involved steward', review_fixture.visible('eeeeeeee-0000-0000-0000-000000000c01'), '0/0');
  perform review_fixture.expect('W01 reviewer', review_fixture.visible('eeeeeeee-0000-0000-0000-000000000c02'), '1/1');
  perform review_fixture.expect('W01 uninvolved, not reviewed', review_fixture.visible('eeeeeeee-0000-0000-0000-000000000c03'), '0/0');
  perform review_fixture.expect('W01 driver account', review_fixture.visible('eeeeeeee-0000-0000-0000-000000000c04'), '0/0');
  perform review_fixture.expect('W01 anon', review_fixture.visible('anon'), '0/0');
  raise notice 'ok W01 open report';
end $$;
rollback to savepoint fixture;

-- W02 Logged (reviews closed): everyone with panel access reads the review and its fault ------------------
do $$
begin
  execute review_fixture.set_status_sql('logged');
  perform review_fixture.expect('W02 reviews closed stamped',
    (select reviews_closed_at is not null from public.incident_reports where id = 'aaaaaaaa-0000-0000-0000-000000000c01'), true);
  perform review_fixture.expect('W02 involved steward', review_fixture.visible('eeeeeeee-0000-0000-0000-000000000c01'), '1/1');
  perform review_fixture.expect('W02 uninvolved, not reviewed', review_fixture.visible('eeeeeeee-0000-0000-0000-000000000c03'), '1/1');
  perform review_fixture.expect('W02 driver account', review_fixture.visible('eeeeeeee-0000-0000-0000-000000000c04'), '0/0');
  -- Reopened after logging: reviews_closed_at stays, so the reviews stay visible.
  update public.incident_reports set status = 'open' where id = 'aaaaaaaa-0000-0000-0000-000000000c01';
  perform review_fixture.expect('W02 involved steward after reopening a logged report',
    review_fixture.visible('eeeeeeee-0000-0000-0000-000000000c01'), '1/1');
  raise notice 'ok W02 logged report';
end $$;
rollback to savepoint fixture;

-- W03 Dismissed: the involved steward reads them; an uninvolved steward who has not reviewed stays blind,
--     as before; reopening the report hides them from the involved steward again ----------------------------
do $$
begin
  execute review_fixture.set_status_sql('dismissed');
  perform review_fixture.expect('W03 involved steward', review_fixture.visible('eeeeeeee-0000-0000-0000-000000000c01'), '1/1');
  perform review_fixture.expect('W03 uninvolved, not reviewed', review_fixture.visible('eeeeeeee-0000-0000-0000-000000000c03'), '0/0');
  perform review_fixture.expect('W03 reviewer', review_fixture.visible('eeeeeeee-0000-0000-0000-000000000c02'), '1/1');
  execute review_fixture.set_status_sql('open');
  perform review_fixture.expect('W03 involved steward after reopening',
    review_fixture.visible('eeeeeeee-0000-0000-0000-000000000c01'), '0/0');
  raise notice 'ok W03 dismissed and reopened';
end $$;
rollback to savepoint fixture;

-- W04 The involved steward cannot log, dismiss or reopen the report (BR1.6) -------------------------------
do $$
declare
  v_in text := 'eeeeeeee-0000-0000-0000-000000000c01';
begin
  perform review_fixture.expect('W04 log', review_fixture.code_as(v_in, review_fixture.set_status_sql('logged')), 'INVOLVED_STEWARD');
  perform review_fixture.expect('W04 dismiss', review_fixture.code_as(v_in, review_fixture.set_status_sql('dismissed')), 'INVOLVED_STEWARD');
  execute review_fixture.set_status_sql('dismissed');
  perform review_fixture.expect('W04 reopen', review_fixture.code_as(v_in, review_fixture.set_status_sql('open')), 'INVOLVED_STEWARD');
  perform review_fixture.expect('W04 status unchanged',
    (select status from public.incident_reports where id = 'aaaaaaaa-0000-0000-0000-000000000c01'), 'dismissed');
  raise notice 'ok W04 involved steward refused';
end $$;
rollback to savepoint fixture;

-- W05 An uninvolved steward changes the status as before; the involved steward may still edit other fields --
do $$
begin
  perform review_fixture.expect('W05 uninvolved dismiss',
    review_fixture.code_as('eeeeeeee-0000-0000-0000-000000000c03', review_fixture.set_status_sql('dismissed')), 'ok');
  perform review_fixture.expect('W05 dismissed',
    (select status from public.incident_reports where id = 'aaaaaaaa-0000-0000-0000-000000000c01'), 'dismissed');
  perform review_fixture.expect('W05 uninvolved reopen',
    review_fixture.code_as('eeeeeeee-0000-0000-0000-000000000c02', review_fixture.set_status_sql('open')), 'ok');
  perform review_fixture.expect('W05 involved steward edits the turn',
    review_fixture.code_as('eeeeeeee-0000-0000-0000-000000000c01',
      $q$update public.incident_reports set turn = '4' where id = 'aaaaaaaa-0000-0000-0000-000000000c01'$q$), 'ok');
  perform review_fixture.expect('W05 turn saved',
    (select turn from public.incident_reports where id = 'aaaaaaaa-0000-0000-0000-000000000c01'), '4');
  raise notice 'ok W05 uninvolved steward and other fields';
end $$;
rollback to savepoint fixture;

-- W06 Writing the same status again is not a change, so the trigger stays out of it ----------------------
do $$
begin
  perform review_fixture.expect('W06 same status',
    review_fixture.code_as('eeeeeeee-0000-0000-0000-000000000c01', review_fixture.set_status_sql('open')), 'ok');
  raise notice 'ok W06 same status';
end $$;
rollback to savepoint fixture;

-- W07 The trigger function: definer, empty search_path, closed to every API role ---------------------------
do $$
begin
  perform review_fixture.expect('W07 definer',
    (select p.prosecdef from pg_proc p where p.oid = 'private.refuse_involved_status_change()'::regprocedure), true);
  perform review_fixture.expect('W07 search_path',
    (select p.proconfig from pg_proc p where p.oid = 'private.refuse_involved_status_change()'::regprocedure),
    array['search_path=""']);
  perform review_fixture.expect('W07 authenticated cannot call it',
    has_function_privilege('authenticated', 'private.refuse_involved_status_change()', 'execute'), false);
  raise notice 'ok W07 trigger function';
end $$;
rollback to savepoint fixture;

rollback;
