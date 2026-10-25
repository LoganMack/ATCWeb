-- Rulebook fixtures for 20261104120000_rulebook_versions.sql (native rulebook): public reads, no direct
-- writes, the admin-only save_rulebook_version() with its grants and error codes, the stale-editor refusal,
-- the keep-10 trim and the seeded Rulebook 18.3 (R01-R08).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- interviews-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/rulebook-fixtures.sql
--
-- Same conventions as interviews-fixtures.sql (supabase/checks/README.md): every assertion calls
-- rulebook_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each case
-- runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`. Callers are impersonated
-- with request.jwt.claims and the role setting.
--
-- Accounts: admin (admin); u (a plain signed-in account). The only row at the start is the seeded 18.3.

begin;

set local client_min_messages = notice;

create schema rulebook_fixture;

create function rulebook_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'rulebook fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Acts as p_who ('anon' or an account id) until rulebook_fixture.as_owner().
create function rulebook_fixture.act_as(p_who text) returns void
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

create function rulebook_fixture.as_owner() returns void
  language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- The first value p_sql returns as p_who, as text.
create function rulebook_fixture.text_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v text;
begin
  perform rulebook_fixture.act_as(p_who);
  execute p_sql into v;
  perform rulebook_fixture.as_owner();
  return v;
end;
$$;

-- The SQLSTATE p_sql fails with as p_who, or 'ok'. On an error the block's own rollback puts the role back.
create function rulebook_fixture.state_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform rulebook_fixture.act_as(p_who);
  execute p_sql;
  perform rulebook_fixture.as_owner();
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- The code before the first ':' of the error p_sql raises as p_who ('NOT_ADMIN: ...' -> 'NOT_ADMIN'), or 'ok'.
create function rulebook_fixture.code_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform rulebook_fixture.act_as(p_who);
  execute p_sql;
  perform rulebook_fixture.as_owner();
  return 'ok';
exception when others then
  return split_part(sqlerrm, ':', 1);
end;
$$;

-- The whole error message p_sql raises as p_who, or 'ok'.
create function rulebook_fixture.message_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform rulebook_fixture.act_as(p_who);
  execute p_sql;
  perform rulebook_fixture.as_owner();
  return 'ok';
exception when others then
  return sqlerrm;
end;
$$;

-- A save call with the current newest id as the expected one, as an editor opened just now would send.
create function rulebook_fixture.save_sql(p_label text, p_body text) returns text
  language sql as $$
  select format('select public.save_rulebook_version(%L, %L, (select max(id) from public.rulebook_versions))',
                p_label, p_body);
$$;

grant usage on schema rulebook_fixture to anon, authenticated;
grant execute on all functions in schema rulebook_fixture to anon, authenticated;

-- Base data ------------------------------------------------------------------------------------

-- The auth.users insert creates a 'driver' profile; the admin is re-inserted, because as postgres the
-- profiles guard refuses a role change.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000a01', 'rb-admin@example.test', now(), '{"display_name":"Rb Admin"}'),
  ('eeeeeeee-0000-0000-0000-000000000a02', 'rb-u@example.test', now(), '{"display_name":"Rb User"}');
delete from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000a01';
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000a01', 'admin', 'Rb Admin', null);

do $$
begin
  perform rulebook_fixture.expect('base: only the seeded version', (select count(*) from public.rulebook_versions), 1::bigint);
end $$;

savepoint fixture;

-- R01 Anyone reads the current version: anon and a plain signed-in account (FR1.4)
do $$
begin
  perform rulebook_fixture.expect('R01 anon reads the latest label', rulebook_fixture.text_as('anon',
    'select version_label from public.rulebook_versions order by id desc limit 1'), '18.3');
  perform rulebook_fixture.expect('R01 signed-in reads the latest label', rulebook_fixture.text_as(
    'eeeeeeee-0000-0000-0000-000000000a02', 'select version_label from public.rulebook_versions order by id desc limit 1'),
    '18.3');
  perform rulebook_fixture.expect('R01 anon reads the body', rulebook_fixture.text_as('anon',
    'select (char_length(body_md) > 1000)::text from public.rulebook_versions'), 'true');
  raise notice 'ok R01 public read';
end $$;
rollback to savepoint fixture;

-- R02 Nobody writes the table directly, not even an admin (FR1.4)
do $$
declare
  v_who text;
begin
  foreach v_who in array array['anon', 'eeeeeeee-0000-0000-0000-000000000a02', 'eeeeeeee-0000-0000-0000-000000000a01'] loop
    perform rulebook_fixture.expect('R02 insert refused for ' || v_who, rulebook_fixture.state_as(v_who,
      $q$insert into public.rulebook_versions (version_label, body_md) values ('x', 'y')$q$), '42501');
    perform rulebook_fixture.expect('R02 update refused for ' || v_who, rulebook_fixture.state_as(v_who,
      $q$update public.rulebook_versions set body_md = 'gone'$q$), '42501');
    perform rulebook_fixture.expect('R02 delete refused for ' || v_who, rulebook_fixture.state_as(v_who,
      'delete from public.rulebook_versions'), '42501');
  end loop;
  perform rulebook_fixture.expect('R02 nothing changed', (select count(*) from public.rulebook_versions), 1::bigint);
  raise notice 'ok R02 no direct writes';
end $$;
rollback to savepoint fixture;

-- R03 Only admins save: grants, definer settings, anon refused, a non-admin refused with NOT_ADMIN (FR1.4)
do $$
declare
  v_fn constant text := 'public.save_rulebook_version(text, text, bigint)';
begin
  perform rulebook_fixture.expect('R03 anon cannot execute', has_function_privilege('anon', v_fn, 'execute'), false);
  perform rulebook_fixture.expect('R03 authenticated can execute', has_function_privilege('authenticated', v_fn, 'execute'), true);
  perform rulebook_fixture.expect('R03 security definer',
    (select prosecdef from pg_proc where oid = v_fn::regprocedure), true);
  perform rulebook_fixture.expect('R03 empty search_path',
    (select proconfig from pg_proc where oid = v_fn::regprocedure), array['search_path=""']);
  perform rulebook_fixture.expect('R03 anon call refused', rulebook_fixture.state_as('anon',
    rulebook_fixture.save_sql('18.4', 'Body')), '42501');
  perform rulebook_fixture.expect('R03 non-admin refused', rulebook_fixture.code_as('eeeeeeee-0000-0000-0000-000000000a02',
    rulebook_fixture.save_sql('18.4', 'Body')), 'NOT_ADMIN');
  perform rulebook_fixture.expect('R03 nothing saved', (select count(*) from public.rulebook_versions), 1::bigint);
  raise notice 'ok R03 admin-only save';
end $$;
rollback to savepoint fixture;

-- R04 An admin save creates the new latest version with its label (trimmed), body, saver and time (FR1.2)
do $$
declare
  v_seed bigint := (select max(id) from public.rulebook_versions);
  v_new text;
  v_row public.rulebook_versions;
begin
  v_new := rulebook_fixture.text_as('eeeeeeee-0000-0000-0000-000000000a01', rulebook_fixture.save_sql(' 18.4 ', '## New'));
  select * into v_row from public.rulebook_versions order by id desc limit 1;
  perform rulebook_fixture.expect('R04 returns the new id', v_new, v_row.id::text);
  perform rulebook_fixture.expect('R04 newer than the seed', v_row.id > v_seed, true);
  perform rulebook_fixture.expect('R04 label trimmed', v_row.version_label, '18.4');
  perform rulebook_fixture.expect('R04 body', v_row.body_md, '## New');
  perform rulebook_fixture.expect('R04 saved by the admin', v_row.saved_by, 'eeeeeeee-0000-0000-0000-000000000a01'::uuid);
  perform rulebook_fixture.expect('R04 saved now', v_row.saved_at, now());
  perform rulebook_fixture.expect('R04 seed kept', (select count(*) from public.rulebook_versions), 2::bigint);
  raise notice 'ok R04 admin save';
end $$;
rollback to savepoint fixture;

-- R05 An empty or too long label, and an empty body, are refused with INVALID and save nothing (FR4.3)
do $$
declare
  v_admin constant text := 'eeeeeeee-0000-0000-0000-000000000a01';
begin
  perform rulebook_fixture.expect('R05 blank label', rulebook_fixture.code_as(v_admin, rulebook_fixture.save_sql('   ', 'Body')), 'INVALID');
  perform rulebook_fixture.expect('R05 null label', rulebook_fixture.code_as(v_admin,
    'select public.save_rulebook_version(null, ''Body'', (select max(id) from public.rulebook_versions))'), 'INVALID');
  perform rulebook_fixture.expect('R05 41-character label', rulebook_fixture.code_as(v_admin,
    rulebook_fixture.save_sql(repeat('x', 41), 'Body')), 'INVALID');
  perform rulebook_fixture.expect('R05 blank body', rulebook_fixture.code_as(v_admin, rulebook_fixture.save_sql('18.4', E' \n\t ')), 'INVALID');
  perform rulebook_fixture.expect('R05 names the label field', split_part(rulebook_fixture.message_as(v_admin,
    rulebook_fixture.save_sql('', 'Body')), ':', 2), ' version_label');
  perform rulebook_fixture.expect('R05 names the body field', split_part(rulebook_fixture.message_as(v_admin,
    rulebook_fixture.save_sql('18.4', '')), ':', 2), ' body_md');
  perform rulebook_fixture.expect('R05 nothing saved', (select count(*) from public.rulebook_versions), 1::bigint);
  raise notice 'ok R05 validation';
end $$;
rollback to savepoint fixture;

-- R06 A save from a stale editor (another save came first, or the editor saw no version) is refused (FR4.5)
do $$
declare
  v_admin constant text := 'eeeeeeee-0000-0000-0000-000000000a01';
  v_opened bigint := (select max(id) from public.rulebook_versions);
begin
  perform rulebook_fixture.text_as(v_admin, rulebook_fixture.save_sql('18.4', 'First'));
  perform rulebook_fixture.expect('R06 stale id refused', rulebook_fixture.code_as(v_admin,
    format('select public.save_rulebook_version(%L, %L, %s)', '18.5', 'Second', v_opened)), 'STALE_VERSION');
  perform rulebook_fixture.expect('R06 null id refused while a version exists', rulebook_fixture.code_as(v_admin,
    'select public.save_rulebook_version(''18.5'', ''Second'', null)'), 'STALE_VERSION');
  perform rulebook_fixture.expect('R06 the first save stands', rulebook_fixture.text_as('anon',
    'select body_md from public.rulebook_versions order by id desc limit 1'), 'First');
  perform rulebook_fixture.expect('R06 two versions', (select count(*) from public.rulebook_versions), 2::bigint);
  raise notice 'ok R06 stale save refused';
end $$;
rollback to savepoint fixture;

-- R07 After 11 saves exactly 10 versions remain: the newest ones, so the seed and the first save are gone (FR1.3)
do $$
declare
  v_seed bigint := (select max(id) from public.rulebook_versions);
begin
  for i in 1..11 loop
    perform rulebook_fixture.text_as('eeeeeeee-0000-0000-0000-000000000a01', rulebook_fixture.save_sql('v' || i, 'Body ' || i));
  end loop;
  perform rulebook_fixture.expect('R07 ten rows', (select count(*) from public.rulebook_versions), 10::bigint);
  perform rulebook_fixture.expect('R07 seed gone', exists (select 1 from public.rulebook_versions where id = v_seed), false);
  perform rulebook_fixture.expect('R07 oldest kept is the second save',
    (select version_label from public.rulebook_versions order by id limit 1), 'v2');
  perform rulebook_fixture.expect('R07 newest is the eleventh save',
    (select version_label from public.rulebook_versions order by id desc limit 1), 'v11');
  raise notice 'ok R07 keep 10';
end $$;
rollback to savepoint fixture;

-- R08 The seed: label 18.3, no saver, section 6 kept, and the five tables' delimiter rows (FR1.5, FR5.2, FR5.4)
do $$
declare
  v_row public.rulebook_versions;
begin
  select * into v_row from public.rulebook_versions order by id desc limit 1;
  perform rulebook_fixture.expect('R08 label', v_row.version_label, '18.3');
  perform rulebook_fixture.expect('R08 no saver', v_row.saved_by, null::uuid);
  perform rulebook_fixture.expect('R08 section 6', position('## 6. Racing Guidelines' in v_row.body_md) > 0, true);
  perform rulebook_fixture.expect('R08 rule 6.15 heading', position(E'### Blue Flags\n\n15. ' in v_row.body_md) > 0, true);
  perform rulebook_fixture.expect('R08 five tables',
    (select count(*) from regexp_matches(v_row.body_md, '^\|( :?-+:? \|)+$', 'gn')), 5::bigint);
  perform rulebook_fixture.expect('R08 no legend line', position('NEW | MODIFIED | REMOVED' in v_row.body_md), 0);
  raise notice 'ok R08 seed';
end $$;
rollback to savepoint fixture;

rollback;
