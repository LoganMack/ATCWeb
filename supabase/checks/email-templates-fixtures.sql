-- Email templates fixtures for 20261113120001_email_templates.sql (FR2.1-FR2.7, NFR2; rules BR2.1, BR2.2,
-- BR2.6): who reads and writes email_templates, the length and line-break checks, the kind check, the stamp
-- of who last saved, and the grants (E01-E07).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- incident-review-visibility-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/email-templates-fixtures.sql
--
-- Same conventions as incident-management-fixtures.sql (supabase/checks/README.md): one transaction, rolled
-- back at the end; each case runs after `savepoint fixture` and is undone with `rollback to savepoint
-- fixture`; callers are impersonated with request.jwt.claims and the role setting.
--
-- Accounts: admin (role admin), staff (role staff), driver (role driver).

begin;

set local client_min_messages = notice;

create schema template_fixture;

create function template_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'email templates fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

create function template_fixture.act_as(p_who text) returns void
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

create function template_fixture.as_owner() returns void
  language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- The first value p_sql returns as p_who, as text.
create function template_fixture.text_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v text;
begin
  perform template_fixture.act_as(p_who);
  execute p_sql into v;
  perform template_fixture.as_owner();
  return v;
end;
$$;

-- The SQLSTATE p_sql fails with as p_who, or 'ok'.
create function template_fixture.state_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform template_fixture.act_as(p_who);
  execute p_sql;
  perform template_fixture.as_owner();
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- The site's save: an upsert on kind setting all three fields (BR2.6).
create function template_fixture.upsert_sql(p_kind text, p_subject text, p_lead text, p_link text) returns text
  language sql as $$
  select format($q$insert into public.email_templates (kind, subject, lead, link_text) values (%L, %L, %L, %L)
                   on conflict (kind) do update
                   set subject = excluded.subject, lead = excluded.lead, link_text = excluded.link_text$q$,
                p_kind, p_subject, p_lead, p_link);
$$;

grant usage on schema template_fixture to anon, authenticated;
grant execute on all functions in schema template_fixture to anon, authenticated;

-- Base data ------------------------------------------------------------------------------------

-- The auth.users insert creates a 'driver' profile; the admin and staff accounts are re-inserted, because as
-- postgres the profiles guard refuses a role change.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000d01', 'et-admin@example.test', now(), '{"display_name":"Template Admin"}'),
  ('eeeeeeee-0000-0000-0000-000000000d02', 'et-staff@example.test', now(), '{"display_name":"Template Staff"}'),
  ('eeeeeeee-0000-0000-0000-000000000d03', 'et-driver@example.test', now(), '{"display_name":"Template Driver"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000000d01', 'eeeeeeee-0000-0000-0000-000000000d02');
insert into public.profiles (id, role, display_name) values
  ('eeeeeeee-0000-0000-0000-000000000d01', 'admin', 'Template Admin'),
  ('eeeeeeee-0000-0000-0000-000000000d02', 'staff', 'Template Staff');

insert into public.email_templates (kind, subject) values ('report_posted', 'Posted: {round}');

savepoint fixture;

-- E01 Row level security on; only authenticated and the service role hold grants; anon holds none --------
do $$
begin
  perform template_fixture.expect('E01 row level security',
    (select c.relrowsecurity from pg_class c where c.oid = 'public.email_templates'::regclass), true);
  perform template_fixture.expect('E01 anon privileges',
    has_table_privilege('anon', 'public.email_templates', 'select, insert, update, delete'), false);
  perform template_fixture.expect('E01 authenticated privileges',
    has_table_privilege('authenticated', 'public.email_templates', 'select')
    and has_table_privilege('authenticated', 'public.email_templates', 'insert')
    and has_table_privilege('authenticated', 'public.email_templates', 'update')
    and has_table_privilege('authenticated', 'public.email_templates', 'delete'), true);
  perform template_fixture.expect('E01 service role reads',
    has_table_privilege('service_role', 'public.email_templates', 'select'), true);
  raise notice 'ok E01 grants';
end $$;
rollback to savepoint fixture;

-- E02 An admin and a staff account read, save (insert and update) and reset (delete); the save is stamped ---
do $$
declare
  v_admin text := 'eeeeeeee-0000-0000-0000-000000000d01';
  v_staff text := 'eeeeeeee-0000-0000-0000-000000000d02';
begin
  perform template_fixture.expect('E02 admin reads',
    template_fixture.text_as(v_admin, $q$select subject from public.email_templates where kind = 'report_posted'$q$),
    'Posted: {round}');
  perform template_fixture.expect('E02 admin inserts',
    template_fixture.state_as(v_admin, template_fixture.upsert_sql('appeal_reviewed', 'Reviewed', null, 'Open it')), 'ok');
  perform template_fixture.expect('E02 stamped by the admin',
    (select updated_by::text from public.email_templates where kind = 'appeal_reviewed'), v_admin);
  perform template_fixture.expect('E02 staff updates',
    template_fixture.state_as(v_staff, template_fixture.upsert_sql('appeal_reviewed', 'Reviewed again', E'Line one\nLine two', null)), 'ok');
  perform template_fixture.expect('E02 last write wins',
    (select subject || '|' || lead || '|' || coalesce(link_text, 'null') from public.email_templates where kind = 'appeal_reviewed'),
    E'Reviewed again|Line one\nLine two|null');
  perform template_fixture.expect('E02 stamped by the staff account',
    (select updated_by::text from public.email_templates where kind = 'appeal_reviewed'), v_staff);
  perform template_fixture.expect('E02 staff resets',
    template_fixture.state_as(v_staff, $q$delete from public.email_templates where kind = 'appeal_reviewed'$q$), 'ok');
  perform template_fixture.expect('E02 row gone',
    (select count(*) from public.email_templates where kind = 'appeal_reviewed'), 0::bigint);
  raise notice 'ok E02 panel access';
end $$;
rollback to savepoint fixture;

-- E03 A driver account and anon read nothing and cannot write (BR2.1) -------------------------------------
do $$
declare
  v_driver text := 'eeeeeeee-0000-0000-0000-000000000d03';
begin
  perform template_fixture.expect('E03 driver reads nothing',
    template_fixture.text_as(v_driver, 'select count(*)::text from public.email_templates'), '0');
  perform template_fixture.expect('E03 driver insert refused',
    template_fixture.state_as(v_driver, template_fixture.upsert_sql('event_reminder', 'Hi', null, null)), '42501');
  perform template_fixture.expect('E03 driver update changes nothing',
    template_fixture.state_as(v_driver, $q$update public.email_templates set subject = 'x' where kind = 'report_posted'$q$), 'ok');
  perform template_fixture.expect('E03 driver delete changes nothing',
    template_fixture.state_as(v_driver, $q$delete from public.email_templates where kind = 'report_posted'$q$), 'ok');
  perform template_fixture.expect('E03 row unchanged',
    (select subject from public.email_templates where kind = 'report_posted'), 'Posted: {round}');
  perform template_fixture.expect('E03 anon read refused',
    template_fixture.state_as('anon', 'select count(*) from public.email_templates'), '42501');
  perform template_fixture.expect('E03 anon insert refused',
    template_fixture.state_as('anon', template_fixture.upsert_sql('event_reminder', 'Hi', null, null)), '42501');
  raise notice 'ok E03 no access for drivers and anon';
end $$;
rollback to savepoint fixture;

-- E04 Length, blank and line-break checks (BR2.2) ----------------------------------------------------------
do $$
declare
  v_admin text := 'eeeeeeee-0000-0000-0000-000000000d01';
begin
  perform template_fixture.expect('E04 subject with a newline',
    template_fixture.state_as(v_admin, template_fixture.upsert_sql('event_reminder', E'Two\nlines', null, null)), '23514');
  perform template_fixture.expect('E04 subject with a carriage return',
    template_fixture.state_as(v_admin, template_fixture.upsert_sql('event_reminder', E'Two\rlines', null, null)), '23514');
  perform template_fixture.expect('E04 subject of 150 characters',
    template_fixture.state_as(v_admin, template_fixture.upsert_sql('event_reminder', repeat('s', 150), null, null)), 'ok');
  perform template_fixture.expect('E04 subject of 151 characters',
    template_fixture.state_as(v_admin, template_fixture.upsert_sql('event_reminder', repeat('s', 151), null, null)), '23514');
  perform template_fixture.expect('E04 blank subject',
    template_fixture.state_as(v_admin, template_fixture.upsert_sql('event_reminder', '   ', null, null)), '23514');
  perform template_fixture.expect('E04 lead of 1000 characters',
    template_fixture.state_as(v_admin, template_fixture.upsert_sql('event_reminder', null, repeat('l', 1000), null)), 'ok');
  perform template_fixture.expect('E04 lead of 1001 characters',
    template_fixture.state_as(v_admin, template_fixture.upsert_sql('event_reminder', null, repeat('l', 1001), null)), '23514');
  perform template_fixture.expect('E04 lead of only line breaks',
    template_fixture.state_as(v_admin, template_fixture.upsert_sql('event_reminder', null, E'\n \n', null)), '23514');
  perform template_fixture.expect('E04 link text of 61 characters',
    template_fixture.state_as(v_admin, template_fixture.upsert_sql('event_reminder', null, null, repeat('k', 61))), '23514');
  perform template_fixture.expect('E04 link text with a newline',
    template_fixture.state_as(v_admin, template_fixture.upsert_sql('event_reminder', null, null, E'Open\nit')), '23514');
  raise notice 'ok E04 field checks';
end $$;
rollback to savepoint fixture;

-- E05 Only the three kinds exist ---------------------------------------------------------------------------
do $$
begin
  perform template_fixture.expect('E05 unknown kind',
    template_fixture.state_as('eeeeeeee-0000-0000-0000-000000000d01', template_fixture.upsert_sql('newsletter', 'Hi', null, null)), '23514');
  raise notice 'ok E05 kind check';
end $$;
rollback to savepoint fixture;

-- E06 Deleting the account that last saved a template keeps the template and clears updated_by ------------
do $$
declare
  v_admin text := 'eeeeeeee-0000-0000-0000-000000000d01';
begin
  perform template_fixture.expect('E06 save',
    template_fixture.state_as(v_admin, template_fixture.upsert_sql('event_reminder', 'Soon', null, null)), 'ok');
  delete from public.profiles where id = v_admin::uuid;
  perform template_fixture.expect('E06 updated_by cleared',
    (select coalesce(updated_by::text, 'null') from public.email_templates where kind = 'event_reminder'), 'null');
  raise notice 'ok E06 profile delete';
end $$;
rollback to savepoint fixture;

-- E07 The stamp function: definer, empty search_path, closed to every API role ----------------------------
do $$
begin
  perform template_fixture.expect('E07 search_path',
    (select p.proconfig from pg_proc p where p.oid = 'private.stamp_email_template()'::regprocedure),
    array['search_path=""']);
  perform template_fixture.expect('E07 authenticated cannot call it',
    has_function_privilege('authenticated', 'private.stamp_email_template()', 'execute'), false);
  raise notice 'ok E07 stamp function';
end $$;
rollback to savepoint fixture;

rollback;
