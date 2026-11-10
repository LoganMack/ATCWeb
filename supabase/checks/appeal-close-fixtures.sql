-- Appeal close and comments fixtures for 20261115120000_appeal_close_and_comments.sql (appeals unit U1; rules
-- BR2.1-BR2.4, BR3.1-BR3.7, BR4.1, BR5.1): Close Appeal and what it writes, the first close winning, the
-- involvement test on both its paths, the closed-appeal lock on every update path, Dismiss and Reopen, steward
-- comments and who reads them, the appealed warning flag rescoring the round, and closed_by after a profile
-- is deleted (F01-F10).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- race-winners-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/appeal-close-fixtures.sql
--
-- Same conventions as incident-review-visibility-fixtures.sql (supabase/checks/README.md): every assertion
-- calls appeal_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each
-- case runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`. Callers are
-- impersonated with request.jwt.claims and the role setting.
--
-- Accounts: out (admin, no driver); two (admin, no driver); party (admin, linked to Ben, who is involved in
-- P1); rep (admin, linked to Cyd, who is named in the logged report R1 but not on P1); ana (driver account,
-- the penalized driver, appeal emails on).
-- Round 9915001 has no season, so a rescore records a scoring issue: that is how F08 sees one.
-- Penalty P1 (race 1, lap 5): Ana penalized, Ben involved; 5 s, 2 points, 3 licence points, a warning.
-- Report R1 (logged, race 1, lap 5): Ana and Cyd.
-- Appeals on P1: A1 (open, by Ana), A2 (open, no account), A3 (dismissed, no account).

begin;

set local client_min_messages = notice;

create schema appeal_fixture;

create function appeal_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'appeal close fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Acts as p_who ('anon' or an account id) until appeal_fixture.as_owner().
create function appeal_fixture.act_as(p_who text) returns void
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

create function appeal_fixture.as_owner() returns void
  language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- The first value p_sql returns as p_who, as text.
create function appeal_fixture.text_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v text;
begin
  perform appeal_fixture.act_as(p_who);
  execute p_sql into v;
  perform appeal_fixture.as_owner();
  return v;
end;
$$;

-- The code before the first ':' of the error p_sql raises as p_who, or 'ok'. On an error the block's own
-- rollback puts the role back.
create function appeal_fixture.code_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform appeal_fixture.act_as(p_who);
  execute p_sql;
  perform appeal_fixture.as_owner();
  return 'ok';
exception when others then
  return split_part(sqlerrm, ':', 1);
end;
$$;

-- The SQLSTATE p_sql fails with as p_who, or 'ok'.
create function appeal_fixture.state_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform appeal_fixture.act_as(p_who);
  execute p_sql;
  perform appeal_fixture.as_owner();
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- The status code close_incident_appeal returns to p_who.
create function appeal_fixture.close(p_who text, p_appeal uuid, p_time numeric, p_points integer, p_licence integer,
                                     p_warning boolean, p_comment text) returns text
  language sql as $$
  select appeal_fixture.text_as(p_who, format('select public.close_incident_appeal(%L, %s, %s, %s, %L, %L)',
    p_appeal, coalesce(p_time::text, 'null'), coalesce(p_points::text, 'null'), coalesce(p_licence::text, 'null'),
    p_warning, p_comment));
$$;

-- The status code save_incident_appeal_comment returns to p_who.
create function appeal_fixture.comment(p_who text, p_appeal uuid, p_body text) returns text
  language sql as $$
  select appeal_fixture.text_as(p_who, format('select public.save_incident_appeal_comment(%L, %L)', p_appeal, p_body));
$$;

-- What incident_appeal_comments_for_round returns to p_who, as 'author|body|is_mine' rows.
create function appeal_fixture.comments(p_who text) returns text
  language sql as $$
  select appeal_fixture.text_as(p_who,
    $q$select coalesce(string_agg(c.author_name || '|' || c.body || '|' || c.is_mine::text, ',' order by c.author_name), '')
       from public.incident_appeal_comments_for_round(9915001) c$q$);
$$;

-- An update of one appeal's status as written by the admin UPDATE policy path.
create function appeal_fixture.status_sql(p_appeal uuid, p_status text) returns text
  language sql as $$
  select format('update public.incident_appeals set status = %L where id = %L', p_status, p_appeal);
$$;

grant usage on schema appeal_fixture to anon, authenticated;
grant execute on all functions in schema appeal_fixture to anon, authenticated;

-- Base data ------------------------------------------------------------------------------------

-- Rescoring is switched on only where a case needs it.
update public.scoring_settings set triggers_enabled = false;

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (991, 'Active')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select 991, 'Alpha', 1 where not exists (select 1 from public.driver_classes where name = 'Alpha');

insert into public.drivers (id, name, car_number, status_id, class_id, is_ai) values
  ('99999999-0000-0000-0000-000000000f01', 'Ana Appeal', 991,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false),
  ('99999999-0000-0000-0000-000000000f02', 'Ben Party', 992,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false),
  ('99999999-0000-0000-0000-000000000f03', 'Cyd Reported', 993,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'), false);

-- The auth.users insert creates a 'driver' profile; the admins and the linked accounts are re-inserted,
-- because as postgres the profiles guard refuses a role or driver change.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000f01', 'ac-out@example.test', now(), '{"display_name":"Steward Out"}'),
  ('eeeeeeee-0000-0000-0000-000000000f02', 'ac-two@example.test', now(), '{"display_name":"Steward Two"}'),
  ('eeeeeeee-0000-0000-0000-000000000f03', 'ac-party@example.test', now(), '{"display_name":"Steward Party"}'),
  ('eeeeeeee-0000-0000-0000-000000000f04', 'ac-rep@example.test', now(), '{"display_name":"Steward Rep"}'),
  ('eeeeeeee-0000-0000-0000-000000000f05', 'ac-ana@example.test', now(), '{"display_name":"Ana Account"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000000f01', 'eeeeeeee-0000-0000-0000-000000000f02',
                                         'eeeeeeee-0000-0000-0000-000000000f03', 'eeeeeeee-0000-0000-0000-000000000f04',
                                         'eeeeeeee-0000-0000-0000-000000000f05');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000f01', 'admin', 'Steward Out', null),
  ('eeeeeeee-0000-0000-0000-000000000f02', 'admin', 'Steward Two', null),
  ('eeeeeeee-0000-0000-0000-000000000f03', 'admin', 'Steward Party', '99999999-0000-0000-0000-000000000f02'),
  ('eeeeeeee-0000-0000-0000-000000000f04', 'admin', 'Steward Rep', '99999999-0000-0000-0000-000000000f03'),
  ('eeeeeeee-0000-0000-0000-000000000f05', 'driver', 'Ana Account', '99999999-0000-0000-0000-000000000f01');

insert into public.account_settings (profile_id, notify_appeal_reviewed) values
  ('eeeeeeee-0000-0000-0000-000000000f05', true);

insert into public.curated_rounds (subsession_id, start_time, track_name) values
  (9915001, '2026-07-05 18:00+00', 'Zw Park');
insert into public.round_incident_status (subsession_id, posted, posted_at) values
  (9915001, true, now() - interval '1 hour');

insert into public.penalties (id, subsession_id, race_number, driver_id, lap, description, penalty_points,
                              time_penalty_seconds, points_penalty, is_warning) values
  ('cccccccc-0000-0000-0000-000000000f01', 9915001, 1, '99999999-0000-0000-0000-000000000f01', 5, 'P1', 3, 5, 2, true);
insert into public.penalty_involved_drivers (penalty_id, driver_id) values
  ('cccccccc-0000-0000-0000-000000000f01', '99999999-0000-0000-0000-000000000f02');

insert into public.incident_reports (id, subsession_id, session, lap, turn, description, status) values
  ('aaaaaaaa-0000-0000-0000-000000000f01', 9915001, 'race:1', 5, '2', 'Contact at T2', 'logged');
insert into public.incident_report_drivers (report_id, driver_id) values
  ('aaaaaaaa-0000-0000-0000-000000000f01', '99999999-0000-0000-0000-000000000f01'),
  ('aaaaaaaa-0000-0000-0000-000000000f01', '99999999-0000-0000-0000-000000000f03');

insert into public.incident_appeals (id, subsession_id, penalty_id, message, submitter_id, status) values
  ('dddddddd-0000-0000-0000-000000000f01', 9915001, 'cccccccc-0000-0000-0000-000000000f01', 'Not my fault',
   'eeeeeeee-0000-0000-0000-000000000f05', 'open'),
  ('dddddddd-0000-0000-0000-000000000f02', 9915001, 'cccccccc-0000-0000-0000-000000000f01', 'Second view', null, 'open'),
  ('dddddddd-0000-0000-0000-000000000f03', 9915001, 'cccccccc-0000-0000-0000-000000000f01', 'Dismissed one', null, 'dismissed');

savepoint fixture;

-- F01 An uninvolved steward closes A1: the appeal keeps its decision, the penalty takes it as its appealed
--     values with the originals kept, the round is rescored and the reviewed email is queued (BR3.3) ---------
do $$
declare
  v_out text := 'eeeeeeee-0000-0000-0000-000000000f01';
begin
  update public.scoring_settings set triggers_enabled = true;
  delete from public.scoring_issues where subsession_id = 9915001;
  perform appeal_fixture.expect('F01 close',
    appeal_fixture.close(v_out, 'dddddddd-0000-0000-0000-000000000f01', 2.5, 1, 0, false, '  Reduced to a reprimand.  '), 'ok');
  perform appeal_fixture.expect('F01 appeal row',
    (select status || '/' || (closed_at is not null)::text || '/' || closed_by::text || '/' || close_comment || '/'
            || decided_time_penalty_seconds::text || '/' || decided_points_penalty::text || '/'
            || decided_penalty_points::text || '/' || decided_is_warning::text
     from public.incident_appeals where id = 'dddddddd-0000-0000-0000-000000000f01'),
    'reviewed/true/eeeeeeee-0000-0000-0000-000000000f01/Reduced to a reprimand./2.5/1/0/false');
  perform appeal_fixture.expect('F01 penalty appealed values',
    (select is_appealed::text || '/' || appeal_time_penalty_seconds::text || '/' || appeal_points_penalty::text || '/'
            || appeal_penalty_points::text || '/' || appeal_is_warning::text || '/' || appeal_result
     from public.penalties where id = 'cccccccc-0000-0000-0000-000000000f01'),
    'true/2.5/1/0/false/Reduced to a reprimand.');
  perform appeal_fixture.expect('F01 originals kept',
    (select time_penalty_seconds::text || '/' || points_penalty::text || '/' || penalty_points::text || '/' || is_warning::text
     from public.penalties where id = 'cccccccc-0000-0000-0000-000000000f01'),
    '5/2/3/true');
  perform appeal_fixture.expect('F01 round rescored',
    (select count(*)::int from public.scoring_issues where subsession_id = 9915001), 1);
  perform appeal_fixture.expect('F01 email queued',
    (select count(*)::int from public.email_outbox o
     where o.kind = 'appeal_reviewed' and o.subject_id = 'dddddddd-0000-0000-0000-000000000f01'), 1);
  raise notice 'ok F01 close';
end $$;
rollback to savepoint fixture;

-- F02 The first close wins: a second close of A1 is already_closed and changes nothing; closing A2 then puts
--     A2's decision on the penalty while A1 keeps its own (BR3.2, BR3.4) --------------------------------------
do $$
declare
  v_out text := 'eeeeeeee-0000-0000-0000-000000000f01';
begin
  perform appeal_fixture.expect('F02 first close',
    appeal_fixture.close(v_out, 'dddddddd-0000-0000-0000-000000000f01', 0, 0, 0, false, 'Dropped'), 'ok');
  perform appeal_fixture.expect('F02 second close',
    appeal_fixture.close('eeeeeeee-0000-0000-0000-000000000f02', 'dddddddd-0000-0000-0000-000000000f01', 9, 9, 9, true, 'Again'),
    'already_closed');
  perform appeal_fixture.expect('F02 dismissed appeal cannot be closed',
    appeal_fixture.close(v_out, 'dddddddd-0000-0000-0000-000000000f03', 1, 1, 1, false, 'No'), 'not_open');
  perform appeal_fixture.expect('F02 A1 unchanged',
    (select close_comment || '/' || closed_by::text from public.incident_appeals where id = 'dddddddd-0000-0000-0000-000000000f01'),
    'Dropped/eeeeeeee-0000-0000-0000-000000000f01');
  perform appeal_fixture.expect('F02 close A2',
    appeal_fixture.close('eeeeeeee-0000-0000-0000-000000000f02', 'dddddddd-0000-0000-0000-000000000f02', 10, 0, 1, true, 'Restored'),
    'ok');
  perform appeal_fixture.expect('F02 penalty carries the latest close',
    (select appeal_time_penalty_seconds::text || '/' || appeal_penalty_points::text || '/' || appeal_is_warning::text
            || '/' || appeal_result
     from public.penalties where id = 'cccccccc-0000-0000-0000-000000000f01'),
    '10/1/true/Restored');
  perform appeal_fixture.expect('F02 A1 keeps its own decision',
    (select decided_time_penalty_seconds::text || '/' || decided_is_warning::text from public.incident_appeals
     where id = 'dddddddd-0000-0000-0000-000000000f01'),
    '0/false');
  raise notice 'ok F02 first close wins';
end $$;
rollback to savepoint fixture;

-- F03 Close Appeal input checks: negative or more than 3 decimals, negative points, a blank or long comment,
--     a missing warning flag; nothing changes (BR3.1) --------------------------------------------------------
do $$
declare
  v_out text := 'eeeeeeee-0000-0000-0000-000000000f01';
  v_a1 uuid := 'dddddddd-0000-0000-0000-000000000f01';
begin
  perform appeal_fixture.expect('F03 negative time', appeal_fixture.close(v_out, v_a1, -1, 0, 0, false, 'x'), 'invalid');
  perform appeal_fixture.expect('F03 four decimals', appeal_fixture.close(v_out, v_a1, 1.2345, 0, 0, false, 'x'), 'invalid');
  perform appeal_fixture.expect('F03 three decimals', appeal_fixture.close(v_out, v_a1, 1.234, 0, 0, false, ' '), 'invalid');
  perform appeal_fixture.expect('F03 negative points', appeal_fixture.close(v_out, v_a1, 0, -1, 0, false, 'x'), 'invalid');
  perform appeal_fixture.expect('F03 negative licence', appeal_fixture.close(v_out, v_a1, 0, 0, -1, false, 'x'), 'invalid');
  perform appeal_fixture.expect('F03 no warning flag', appeal_fixture.close(v_out, v_a1, 0, 0, 0, null, 'x'), 'invalid');
  perform appeal_fixture.expect('F03 long comment',
    appeal_fixture.close(v_out, v_a1, 0, 0, 0, false, repeat('a', 4001)), 'invalid');
  perform appeal_fixture.expect('F03 still open',
    (select status from public.incident_appeals where id = v_a1), 'open');
  perform appeal_fixture.expect('F03 4000 characters and 3 decimals close',
    appeal_fixture.close(v_out, v_a1, 1.234, 0, 0, false, repeat('a', 4000)), 'ok');
  raise notice 'ok F03 input checks';
end $$;
rollback to savepoint fixture;

-- F04 Involvement: a steward linked to a party of the penalty, and one linked to a car in the logged report it
--     came from, are refused Close Appeal, comments, Dismiss and Reopen; drivers and anon too (BR2.1, BR3.2,
--     BR3.7) -----------------------------------------------------------------------------------------------
do $$
declare
  v_who text;
begin
  foreach v_who in array array['eeeeeeee-0000-0000-0000-000000000f03', 'eeeeeeee-0000-0000-0000-000000000f04'] loop
    perform appeal_fixture.expect('F04 close ' || v_who,
      appeal_fixture.close(v_who, 'dddddddd-0000-0000-0000-000000000f01', 0, 0, 0, false, 'Mine'), 'not_allowed');
    perform appeal_fixture.expect('F04 comment ' || v_who,
      appeal_fixture.comment(v_who, 'dddddddd-0000-0000-0000-000000000f01', 'Mine'), 'not_allowed');
    perform appeal_fixture.expect('F04 dismiss ' || v_who,
      appeal_fixture.code_as(v_who, appeal_fixture.status_sql('dddddddd-0000-0000-0000-000000000f01', 'dismissed')),
      'INVOLVED_STEWARD');
    perform appeal_fixture.expect('F04 reopen ' || v_who,
      appeal_fixture.code_as(v_who, appeal_fixture.status_sql('dddddddd-0000-0000-0000-000000000f03', 'open')),
      'INVOLVED_STEWARD');
  end loop;
  perform appeal_fixture.expect('F04 driver close',
    appeal_fixture.close('eeeeeeee-0000-0000-0000-000000000f05', 'dddddddd-0000-0000-0000-000000000f01', 0, 0, 0, false, 'Me'),
    'not_allowed');
  perform appeal_fixture.expect('F04 driver comment',
    appeal_fixture.comment('eeeeeeee-0000-0000-0000-000000000f05', 'dddddddd-0000-0000-0000-000000000f01', 'Me'), 'not_allowed');
  perform appeal_fixture.expect('F04 unknown appeal',
    appeal_fixture.close('eeeeeeee-0000-0000-0000-000000000f01', 'dddddddd-0000-0000-0000-0000000000ff', 0, 0, 0, false, 'x'),
    'not_allowed');
  perform appeal_fixture.expect('F04 anon cannot call close',
    has_function_privilege('anon', 'public.close_incident_appeal(uuid, numeric, integer, integer, boolean, text)', 'execute'),
    false);
  perform appeal_fixture.expect('F04 anon cannot call save',
    has_function_privilege('anon', 'public.save_incident_appeal_comment(uuid, text)', 'execute'), false);
  perform appeal_fixture.expect('F04 anon cannot list',
    has_function_privilege('anon', 'public.incident_appeal_comments_for_round(bigint)', 'execute'), false);
  perform appeal_fixture.expect('F04 nothing changed',
    (select string_agg(status, ',' order by id) from public.incident_appeals where subsession_id = 9915001),
    'open,open,dismissed');
  raise notice 'ok F04 involvement';
end $$;
rollback to savepoint fixture;

-- F04 (changed lap) A steward changed the lap while logging: report R2 (race 2, lap 7) became penalty P2
--     (race 2, lap 9). Rep, named in R2, is involved in P2's appeal through the same-session match, while Steward
--     Out is not (BR2.1, BR3.2) ---------------------------------------------------------------------------------
do $$
declare
  v_rep text := 'eeeeeeee-0000-0000-0000-000000000f04';
begin
  insert into public.penalties (id, subsession_id, race_number, driver_id, lap, description, penalty_points,
                                time_penalty_seconds, points_penalty, is_warning) values
    ('cccccccc-0000-0000-0000-000000000f02', 9915001, 2, '99999999-0000-0000-0000-000000000f01', 9, 'P2', 1, 5, 0, false);
  insert into public.incident_reports (id, subsession_id, session, lap, turn, description, status) values
    ('aaaaaaaa-0000-0000-0000-000000000f02', 9915001, 'race:2', 7, '4', 'Lap changed when logged', 'logged');
  insert into public.incident_report_drivers (report_id, driver_id) values
    ('aaaaaaaa-0000-0000-0000-000000000f02', '99999999-0000-0000-0000-000000000f01'),
    ('aaaaaaaa-0000-0000-0000-000000000f02', '99999999-0000-0000-0000-000000000f03');
  insert into public.incident_appeals (id, subsession_id, penalty_id, message, submitter_id, status) values
    ('dddddddd-0000-0000-0000-000000000f05', 9915001, 'cccccccc-0000-0000-0000-000000000f02', 'Lap changed', null, 'open');
  perform appeal_fixture.expect('F04 changed lap: rep close',
    appeal_fixture.close(v_rep, 'dddddddd-0000-0000-0000-000000000f05', 0, 0, 0, false, 'Mine'), 'not_allowed');
  perform appeal_fixture.expect('F04 changed lap: rep comment',
    appeal_fixture.comment(v_rep, 'dddddddd-0000-0000-0000-000000000f05', 'Mine'), 'not_allowed');
  perform appeal_fixture.expect('F04 changed lap: rep dismiss',
    appeal_fixture.code_as(v_rep, appeal_fixture.status_sql('dddddddd-0000-0000-0000-000000000f05', 'dismissed')),
    'INVOLVED_STEWARD');
  perform appeal_fixture.expect('F04 changed lap: out comments',
    appeal_fixture.comment('eeeeeeee-0000-0000-0000-000000000f01', 'dddddddd-0000-0000-0000-000000000f05', 'Fine'), 'ok');
  raise notice 'ok F04 changed lap';
end $$;
rollback to savepoint fixture;

-- F04 (changed session) A steward changed the session while logging: report R3 (race 3, lap 6) became penalty
--     P3 (race 2, lap 6), so Rep is involved in P3's appeal through the same-lap match. Penalty P4 (race 2, lap 5)
--     shares R1's lap and a car, but R1's own decision is P1 at the same session and lap, so Rep may decide P4's
--     appeal (BR2.1, BR3.2) ------------------------------------------------------------------------------------
do $$
declare
  v_rep text := 'eeeeeeee-0000-0000-0000-000000000f04';
begin
  insert into public.penalties (id, subsession_id, race_number, driver_id, lap, description, penalty_points,
                                time_penalty_seconds, points_penalty, is_warning) values
    ('cccccccc-0000-0000-0000-000000000f03', 9915001, 2, '99999999-0000-0000-0000-000000000f01', 6, 'P3', 1, 5, 0, false),
    ('cccccccc-0000-0000-0000-000000000f04', 9915001, 2, '99999999-0000-0000-0000-000000000f01', 5, 'P4', 1, 5, 0, false);
  insert into public.incident_reports (id, subsession_id, session, lap, turn, description, status) values
    ('aaaaaaaa-0000-0000-0000-000000000f03', 9915001, 'race:3', 6, '1', 'Session changed when logged', 'logged');
  insert into public.incident_report_drivers (report_id, driver_id) values
    ('aaaaaaaa-0000-0000-0000-000000000f03', '99999999-0000-0000-0000-000000000f01'),
    ('aaaaaaaa-0000-0000-0000-000000000f03', '99999999-0000-0000-0000-000000000f03');
  insert into public.incident_appeals (id, subsession_id, penalty_id, message, submitter_id, status) values
    ('dddddddd-0000-0000-0000-000000000f06', 9915001, 'cccccccc-0000-0000-0000-000000000f03', 'Session changed', null, 'open'),
    ('dddddddd-0000-0000-0000-000000000f07', 9915001, 'cccccccc-0000-0000-0000-000000000f04', 'Unrelated', null, 'open');
  perform appeal_fixture.expect('F04 changed session: rep close',
    appeal_fixture.close(v_rep, 'dddddddd-0000-0000-0000-000000000f06', 0, 0, 0, false, 'Mine'), 'not_allowed');
  perform appeal_fixture.expect('F04 changed session: rep comment',
    appeal_fixture.comment(v_rep, 'dddddddd-0000-0000-0000-000000000f06', 'Mine'), 'not_allowed');
  perform appeal_fixture.expect('F04 changed session: rep dismiss',
    appeal_fixture.code_as(v_rep, appeal_fixture.status_sql('dddddddd-0000-0000-0000-000000000f06', 'dismissed')),
    'INVOLVED_STEWARD');
  perform appeal_fixture.expect('F04 changed session: rep may comment on an unrelated appeal',
    appeal_fixture.comment(v_rep, 'dddddddd-0000-0000-0000-000000000f07', 'Not mine'), 'ok');
  raise notice 'ok F04 changed session';
end $$;
rollback to savepoint fixture;

-- F05 The lock on every update path: a bare status change to reviewed, a close stamped with another steward,
--     close fields on an open appeal, dismissed straight to reviewed, and any change to a reviewed appeal
--     (closed or legacy) are refused (BR3.5) --------------------------------------------------------------
do $$
declare
  v_out text := 'eeeeeeee-0000-0000-0000-000000000f01';
begin
  perform appeal_fixture.expect('F05 bare reviewed',
    appeal_fixture.code_as(v_out, appeal_fixture.status_sql('dddddddd-0000-0000-0000-000000000f01', 'reviewed')),
    'USE_CLOSE_APPEAL');
  perform appeal_fixture.expect('F05 stamped with another steward',
    appeal_fixture.code_as(v_out, $q$update public.incident_appeals set status = 'reviewed', closed_at = now(),
      closed_by = 'eeeeeeee-0000-0000-0000-000000000f02', close_comment = 'x', decided_time_penalty_seconds = 0,
      decided_points_penalty = 0, decided_penalty_points = 0, decided_is_warning = false
      where id = 'dddddddd-0000-0000-0000-000000000f01'$q$),
    'USE_CLOSE_APPEAL');
  perform appeal_fixture.expect('F05 close fields while open',
    appeal_fixture.code_as(v_out, $q$update public.incident_appeals set closed_by = 'eeeeeeee-0000-0000-0000-000000000f01'
      where id = 'dddddddd-0000-0000-0000-000000000f01'$q$),
    'USE_CLOSE_APPEAL');
  perform appeal_fixture.expect('F05 dismissed to reviewed',
    appeal_fixture.code_as(v_out, $q$update public.incident_appeals set status = 'reviewed', closed_at = now(),
      closed_by = 'eeeeeeee-0000-0000-0000-000000000f01', close_comment = 'x', decided_time_penalty_seconds = 0,
      decided_points_penalty = 0, decided_penalty_points = 0, decided_is_warning = false
      where id = 'dddddddd-0000-0000-0000-000000000f03'$q$),
    'NOT_OPEN');
  perform appeal_fixture.expect('F05 close',
    appeal_fixture.close(v_out, 'dddddddd-0000-0000-0000-000000000f01', 0, 0, 0, false, 'Done'), 'ok');
  perform appeal_fixture.expect('F05 reopen a closed appeal',
    appeal_fixture.code_as(v_out, appeal_fixture.status_sql('dddddddd-0000-0000-0000-000000000f01', 'open')),
    'ALREADY_CLOSED');
  perform appeal_fixture.expect('F05 edit a closed comment',
    appeal_fixture.code_as(v_out, $q$update public.incident_appeals set close_comment = 'Changed'
      where id = 'dddddddd-0000-0000-0000-000000000f01'$q$),
    'ALREADY_CLOSED');
  -- A legacy reviewed appeal (no close record) is final as well.
  insert into public.incident_appeals (id, subsession_id, penalty_id, message, status) values
    ('dddddddd-0000-0000-0000-000000000f04', 9915001, 'cccccccc-0000-0000-0000-000000000f01', 'Legacy', 'reviewed');
  perform appeal_fixture.expect('F05 legacy reviewed stays final',
    appeal_fixture.code_as(v_out, appeal_fixture.status_sql('dddddddd-0000-0000-0000-000000000f04', 'open')),
    'ALREADY_CLOSED');
  -- The database owner is held too.
  begin
    update public.incident_appeals set status = 'open' where id = 'dddddddd-0000-0000-0000-000000000f04';
    raise exception 'appeal close fixture failed: F05 owner reopened a reviewed appeal';
  exception when sqlstate 'P0001' then
    if sqlerrm not like 'ALREADY_CLOSED:%' then raise; end if;
  end;
  raise notice 'ok F05 lock';
end $$;
rollback to savepoint fixture;

-- F06 Dismiss and Reopen still work for an uninvolved steward, with no email (BR1.3, BR3.6) ----------------
do $$
declare
  v_out text := 'eeeeeeee-0000-0000-0000-000000000f01';
begin
  perform appeal_fixture.expect('F06 dismiss',
    appeal_fixture.code_as(v_out, appeal_fixture.status_sql('dddddddd-0000-0000-0000-000000000f02', 'dismissed')), 'ok');
  perform appeal_fixture.expect('F06 reopen',
    appeal_fixture.code_as(v_out, appeal_fixture.status_sql('dddddddd-0000-0000-0000-000000000f03', 'open')), 'ok');
  perform appeal_fixture.expect('F06 statuses',
    (select string_agg(status, ',' order by id) from public.incident_appeals where subsession_id = 9915001),
    'open,dismissed,open');
  perform appeal_fixture.expect('F06 no email',
    (select count(*)::int from public.email_outbox o where o.kind = 'appeal_reviewed'
       and o.subject_id like 'dddddddd-0000-0000-0000-000000000f0%'), 0);
  raise notice 'ok F06 dismiss and reopen';
end $$;
rollback to savepoint fixture;

-- F07 Comments: one per steward per appeal, saving again replaces it, 1 to 4,000 characters after trimming,
--     open appeals only, never readable straight from the table (BR2.2, BR2.3) -----------------------------
do $$
declare
  v_out text := 'eeeeeeee-0000-0000-0000-000000000f01';
  v_a1 uuid := 'dddddddd-0000-0000-0000-000000000f01';
begin
  perform appeal_fixture.expect('F07 add', appeal_fixture.comment(v_out, v_a1, '  First thought  '), 'ok');
  perform appeal_fixture.expect('F07 edit', appeal_fixture.comment(v_out, v_a1, 'Second thought'), 'ok');
  perform appeal_fixture.expect('F07 one row, replaced',
    (select count(*)::text || '/' || max(body) from public.incident_appeal_comments where appeal_id = v_a1),
    '1/Second thought');
  perform appeal_fixture.expect('F07 blank', appeal_fixture.comment(v_out, v_a1, '   '), 'invalid');
  perform appeal_fixture.expect('F07 too long', appeal_fixture.comment(v_out, v_a1, repeat('b', 4001)), 'invalid');
  perform appeal_fixture.expect('F07 4000 after trimming',
    appeal_fixture.comment(v_out, v_a1, ' ' || repeat('b', 4000) || ' '), 'ok');
  perform appeal_fixture.expect('F07 dismissed appeal',
    appeal_fixture.comment(v_out, 'dddddddd-0000-0000-0000-000000000f03', 'Late'), 'not_open');
  perform appeal_fixture.expect('F07 close', appeal_fixture.close(v_out, v_a1, 0, 0, 0, false, 'Done'), 'ok');
  perform appeal_fixture.expect('F07 closed appeal', appeal_fixture.comment(v_out, v_a1, 'After'), 'not_open');
  perform appeal_fixture.expect('F07 table closed to authenticated',
    appeal_fixture.state_as(v_out, 'select count(*) from public.incident_appeal_comments'), '42501');
  perform appeal_fixture.expect('F07 no update grant',
    has_table_privilege('authenticated', 'public.incident_appeal_comments', 'update'), false);
  raise notice 'ok F07 comments';
end $$;
rollback to savepoint fixture;

-- F08 Reading comments: uninvolved stewards read them with the author's name, is_mine marks their own;
--     involved stewards and drivers read none (BR2.1, BR2.4) ---------------------------------------------------
do $$
declare
  v_a1 uuid := 'dddddddd-0000-0000-0000-000000000f01';
begin
  perform appeal_fixture.expect('F08 out writes',
    appeal_fixture.comment('eeeeeeee-0000-0000-0000-000000000f01', v_a1, 'Uphold'), 'ok');
  perform appeal_fixture.expect('F08 two writes',
    appeal_fixture.comment('eeeeeeee-0000-0000-0000-000000000f02', v_a1, 'Reduce'), 'ok');
  perform appeal_fixture.expect('F08 out reads both',
    appeal_fixture.comments('eeeeeeee-0000-0000-0000-000000000f01'),
    'Steward Out|Uphold|true,Steward Two|Reduce|false');
  perform appeal_fixture.expect('F08 two reads both',
    appeal_fixture.comments('eeeeeeee-0000-0000-0000-000000000f02'),
    'Steward Out|Uphold|false,Steward Two|Reduce|true');
  perform appeal_fixture.expect('F08 party reads none', appeal_fixture.comments('eeeeeeee-0000-0000-0000-000000000f03'), '');
  perform appeal_fixture.expect('F08 report car reads none', appeal_fixture.comments('eeeeeeee-0000-0000-0000-000000000f04'), '');
  perform appeal_fixture.expect('F08 driver reads none', appeal_fixture.comments('eeeeeeee-0000-0000-0000-000000000f05'), '');
  -- Still readable once the appeal is closed (W6).
  perform appeal_fixture.expect('F08 close',
    appeal_fixture.close('eeeeeeee-0000-0000-0000-000000000f01', v_a1, 0, 0, 0, false, 'Done'), 'ok');
  perform appeal_fixture.expect('F08 readable after close',
    appeal_fixture.comments('eeeeeeee-0000-0000-0000-000000000f02'),
    'Steward Out|Uphold|false,Steward Two|Reduce|true');
  raise notice 'ok F08 reading comments';
end $$;
rollback to savepoint fixture;

-- F09 The appealed warning flag: a change of the effective warning alone rescores the round; a change to a
--     column scoring never reads does not; penalties_shown exposes the flag (BR4.1) ---------------------------
do $$
begin
  update public.scoring_settings set triggers_enabled = true;
  update public.penalties set is_appealed = true, appeal_time_penalty_seconds = 5, appeal_points_penalty = 2,
    appeal_penalty_points = 3 where id = 'cccccccc-0000-0000-0000-000000000f01';
  delete from public.scoring_issues where subsession_id = 9915001;
  update public.penalties set description = 'P1 renamed' where id = 'cccccccc-0000-0000-0000-000000000f01';
  perform appeal_fixture.expect('F09 description change does not rescore',
    (select count(*)::int from public.scoring_issues where subsession_id = 9915001), 0);
  update public.penalties set appeal_is_warning = false where id = 'cccccccc-0000-0000-0000-000000000f01';
  perform appeal_fixture.expect('F09 removing the warning rescores',
    (select count(*)::int from public.scoring_issues where subsession_id = 9915001), 1);
  perform appeal_fixture.expect('F09 penalties_shown',
    (select is_warning::text || '/' || appeal_is_warning::text from public.penalties_shown
     where id = 'cccccccc-0000-0000-0000-000000000f01'),
    'true/false');
  perform appeal_fixture.expect('F09 anon reads it on a posted round',
    appeal_fixture.text_as('anon', $q$select appeal_is_warning::text from public.penalties_shown
      where id = 'cccccccc-0000-0000-0000-000000000f01'$q$), 'false');
  raise notice 'ok F09 appealed warning';
end $$;
rollback to savepoint fixture;

-- F10 closed_by and a comment's author become null when that steward's profile is deleted, and the close
--     record and the comment stay; the new functions' settings and grants (BR2.3, BR5.1) --------------------
do $$
begin
  perform appeal_fixture.expect('F10 comment before close',
    appeal_fixture.comment('eeeeeeee-0000-0000-0000-000000000f02', 'dddddddd-0000-0000-0000-000000000f01', 'Keep it'), 'ok');
  perform appeal_fixture.expect('F10 close',
    appeal_fixture.close('eeeeeeee-0000-0000-0000-000000000f02', 'dddddddd-0000-0000-0000-000000000f01', 1, 0, 0, false, 'Kept'),
    'ok');
  delete from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000f02';
  perform appeal_fixture.expect('F10 closed_by cleared, record kept',
    (select status || '/' || coalesce(closed_by::text, 'null') || '/' || close_comment
     from public.incident_appeals where id = 'dddddddd-0000-0000-0000-000000000f01'),
    'reviewed/null/Kept');
  perform appeal_fixture.expect('F10 comment kept with no author',
    appeal_fixture.comments('eeeeeeee-0000-0000-0000-000000000f01'), 'A former steward|Keep it|false');
  perform appeal_fixture.expect('F10 definers with an empty search_path',
    (select bool_and(p.prosecdef and p.proconfig = array['search_path=""']) from pg_proc p
     where p.oid in ('public.close_incident_appeal(uuid, numeric, integer, integer, boolean, text)'::regprocedure,
                     'public.save_incident_appeal_comment(uuid, text)'::regprocedure,
                     'public.incident_appeal_comments_for_round(bigint)'::regprocedure,
                     'private.is_involved_in_appeal(uuid)'::regprocedure,
                     'private.incident_appeals_lock()'::regprocedure)),
    true);
  perform appeal_fixture.expect('F10 helpers closed to authenticated',
    has_function_privilege('authenticated', 'private.is_involved_in_appeal(uuid)', 'execute')
      or has_function_privilege('authenticated', 'private.incident_appeals_lock()', 'execute'),
    false);
  perform appeal_fixture.expect('F10 signed-in stewards can call the functions',
    has_function_privilege('authenticated', 'public.close_incident_appeal(uuid, numeric, integer, integer, boolean, text)', 'execute')
      and has_function_privilege('authenticated', 'public.save_incident_appeal_comment(uuid, text)', 'execute')
      and has_function_privilege('authenticated', 'public.incident_appeal_comments_for_round(bigint)', 'execute'),
    true);
  raise notice 'ok F10 deleted steward and grants';
end $$;
rollback to savepoint fixture;

rollback;
