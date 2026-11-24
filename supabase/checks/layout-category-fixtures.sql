-- Layout category and logo colour fixtures for 20261123120000_layout_category_and_logo_colour.sql
-- (BR1.1-BR1.4): the five category keys and an unknown one, admin-only writes, category through the public
-- view with the lap record holder still masked, and the widened logo colour CHECK (G01-G04).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild):
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/layout-category-fixtures.sql
--
-- Same conventions as scoring-fixtures.sql (supabase/checks/README.md): every assertion calls
-- layout_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each case
-- runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`.
--
-- Base data: circuit Fixture Ring with layout Grand Prix, whose lap record belongs to driver "Layout Holder";
-- that driver's linked account hides the name. An admin and a signed-in account with no driver.

begin;

set local client_min_messages = notice;

create schema layout_fixture;

create function layout_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'layout category fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Switches to p_who ('anon' or an account id) for the rest of the transaction-local scope.
create function layout_fixture.become(p_who text) returns void
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

create function layout_fixture.reset() returns void
  language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- How many rows p_sql changes as p_who, or the SQLSTATE it fails with.
create function layout_fixture.rows_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v integer;
begin
  perform layout_fixture.become(p_who);
  begin
    execute p_sql;
    get diagnostics v = row_count;
  exception when others then
    perform layout_fixture.reset();
    return sqlstate;
  end;
  perform layout_fixture.reset();
  return v::text;
end;
$$;

-- The first text value p_sql returns as p_who.
create function layout_fixture.read_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v text;
begin
  perform layout_fixture.become(p_who);
  execute p_sql into v;
  perform layout_fixture.reset();
  return v;
end;
$$;

-- Base data ------------------------------------------------------------------------------------

insert into public.driver_statuses (id, name) values (1, 'Active') on conflict do nothing;
insert into public.driver_classes (id, name, sort_order) values (1, 'Alpha', 1) on conflict do nothing;

insert into public.drivers (id, name, status_id, class_id, iracing_cust_id, is_ai) values
  ('77777777-0000-0000-0000-000000000501', 'Layout Holder', 1, 1, 950501, false);

insert into public.circuits (id, name) values ('99999999-0000-0000-0000-000000000501', 'Fixture Ring');
insert into public.circuit_layouts (id, circuit_id, name, lap_record_holder, lap_record_seconds) values
  ('99999999-0000-0000-0000-000000000511', '99999999-0000-0000-0000-000000000501', 'Grand Prix',
   'Layout Holder', 90.5);

-- An admin, a signed-in account with no driver (the auth.users insert creates a 'driver' profile), and the
-- holder's own account, which hides the name.
insert into auth.users (id, email) values
  ('eeeeeeee-0000-0000-0000-000000000501', 'layout-admin@example.invalid'),
  ('eeeeeeee-0000-0000-0000-000000000502', 'layout-member@example.invalid'),
  ('eeeeeeee-0000-0000-0000-000000000503', 'layout-holder@example.invalid');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000000501', 'eeeeeeee-0000-0000-0000-000000000503');
insert into public.profiles (id, role) values ('eeeeeeee-0000-0000-0000-000000000501', 'admin');
insert into public.profiles (id, role) values ('eeeeeeee-0000-0000-0000-000000000502', 'driver')
  on conflict (id) do nothing;
insert into public.profiles (id, role, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000503', 'driver', '77777777-0000-0000-0000-000000000501');
insert into public.account_settings (profile_id, hide_name, hide_profile) values
  ('eeeeeeee-0000-0000-0000-000000000503', true, false);

savepoint fixture;

-- G01 An admin sets each of the five keys; an unknown key is refused (BR1.1) ---------------------------
do $$
declare
  v_key text;
begin
  perform layout_fixture.expect('G01 a new column starts empty',
    (select l.category from public.circuit_layouts l where l.id = '99999999-0000-0000-0000-000000000511'), null::text);
  foreach v_key in array array['oval', 'roval', 'road_long', 'road_short', 'street'] loop
    perform layout_fixture.expect('G01 admin sets ' || v_key,
      layout_fixture.rows_as('eeeeeeee-0000-0000-0000-000000000501', format(
        $q$update public.circuit_layouts set category = %L where id = '99999999-0000-0000-0000-000000000511'$q$, v_key)),
      '1');
    perform layout_fixture.expect('G01 stored ' || v_key,
      (select l.category from public.circuit_layouts l where l.id = '99999999-0000-0000-0000-000000000511'), v_key);
  end loop;
  perform layout_fixture.expect('G01 gravel refused',
    layout_fixture.rows_as('eeeeeeee-0000-0000-0000-000000000501',
      $q$update public.circuit_layouts set category = 'gravel' where id = '99999999-0000-0000-0000-000000000511'$q$),
    '23514');
  perform layout_fixture.expect('G01 wrong case refused',
    layout_fixture.rows_as('eeeeeeee-0000-0000-0000-000000000501',
      $q$update public.circuit_layouts set category = 'Oval' where id = '99999999-0000-0000-0000-000000000511'$q$),
    '23514');
  perform layout_fixture.expect('G01 admin clears it',
    layout_fixture.rows_as('eeeeeeee-0000-0000-0000-000000000501',
      $q$update public.circuit_layouts set category = null where id = '99999999-0000-0000-0000-000000000511'$q$),
    '1');
  raise notice 'ok G01 category keys';
end $$;
rollback to savepoint fixture;

-- G02 Anon and a signed-in non-admin change nothing (BR1.2) ---------------------------------------------
do $$
begin
  perform layout_fixture.expect('G02 anon updates no row',
    layout_fixture.rows_as('anon',
      $q$update public.circuit_layouts set category = 'oval' where id = '99999999-0000-0000-0000-000000000511'$q$),
    '0');
  perform layout_fixture.expect('G02 a signed-in non-admin updates no row',
    layout_fixture.rows_as('eeeeeeee-0000-0000-0000-000000000502',
      $q$update public.circuit_layouts set category = 'oval' where id = '99999999-0000-0000-0000-000000000511'$q$),
    '0');
  perform layout_fixture.expect('G02 a signed-in non-admin sets no logo colour',
    layout_fixture.rows_as('eeeeeeee-0000-0000-0000-000000000502',
      $q$update public.circuits set logo_background = '#a1b2c3' where id = '99999999-0000-0000-0000-000000000501'$q$),
    '0');
  perform layout_fixture.expect('G02 the view is not writable',
    layout_fixture.rows_as('anon',
      $q$update public.circuit_layouts_shown set category = 'oval' where id = '99999999-0000-0000-0000-000000000511'$q$),
    '42501');
  perform layout_fixture.expect('G02 still empty',
    (select l.category from public.circuit_layouts l where l.id = '99999999-0000-0000-0000-000000000511'), null::text);
  perform layout_fixture.expect('G02 logo still empty',
    (select c.logo_background from public.circuits c where c.id = '99999999-0000-0000-0000-000000000501'), null::text);
  raise notice 'ok G02 admin-only writes';
end $$;
rollback to savepoint fixture;

-- G03 Category through the public view, masking unchanged (BR1.3) ---------------------------------------
update public.circuit_layouts set category = 'road_long' where id = '99999999-0000-0000-0000-000000000511';
do $$
begin
  perform layout_fixture.expect('G03 the last view column is category',
    (select a.attname::text from pg_attribute a
     where a.attrelid = 'public.circuit_layouts_shown'::regclass and a.attnum > 0 and not a.attisdropped
     order by a.attnum desc limit 1),
    'category');
  perform layout_fixture.expect('G03 anon reads the category and a masked holder',
    layout_fixture.read_as('anon', $q$select v.category || '/' || v.lap_record_holder from public.circuit_layouts_shown v
      where v.id = '99999999-0000-0000-0000-000000000511'$q$),
    'road_long/Hidden Driver');
  perform layout_fixture.expect('G03 a signed-in non-admin reads the same',
    layout_fixture.read_as('eeeeeeee-0000-0000-0000-000000000502', $q$select v.category || '/' || v.lap_record_holder
      from public.circuit_layouts_shown v where v.id = '99999999-0000-0000-0000-000000000511'$q$),
    'road_long/Hidden Driver');
  perform layout_fixture.expect('G03 an admin sees the name',
    layout_fixture.read_as('eeeeeeee-0000-0000-0000-000000000501', $q$select v.category || '/' || v.lap_record_holder
      from public.circuit_layouts_shown v where v.id = '99999999-0000-0000-0000-000000000511'$q$),
    'road_long/Layout Holder');
  perform layout_fixture.expect('G03 the base table stays closed to anon',
    layout_fixture.read_as('anon', $q$select count(*)::text from public.circuit_layouts l
      where l.id = '99999999-0000-0000-0000-000000000511'$q$),
    '0');
  perform layout_fixture.expect('G03 view options unchanged',
    (select string_agg(o, ',' order by o) from pg_class c, unnest(c.reloptions) o
     where c.oid = 'public.circuit_layouts_shown'::regclass),
    'security_barrier=true,security_invoker=false');
  -- Grantee 0 is PUBLIC.
  perform layout_fixture.expect('G03 select-only grants',
    (select string_agg(coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type, ' '
                       order by coalesce(r.rolname, 'PUBLIC'), a.privilege_type)
     from pg_class c
     cross join lateral aclexplode(c.relacl) a
     left join pg_roles r on r.oid = a.grantee
     where c.oid = 'public.circuit_layouts_shown'::regclass
       and (a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))),
    'anon:SELECT authenticated:SELECT service_role:SELECT');
  raise notice 'ok G03 public view';
end $$;
rollback to savepoint fixture;

-- G04 The logo colour CHECK (BR1.4) ---------------------------------------------------------------------
do $$
declare
  v_value text;
begin
  foreach v_value in array array['#a1b2c3', 'light', 'dark'] loop
    perform layout_fixture.expect('G04 accepts ' || v_value,
      layout_fixture.rows_as('eeeeeeee-0000-0000-0000-000000000501', format(
        $q$update public.circuits set logo_background = %L where id = '99999999-0000-0000-0000-000000000501'$q$, v_value)),
      '1');
  end loop;
  foreach v_value in array array['#A1B2C3', '#abc', 'red', '#a1b2c3 ', 'url(x)'] loop
    perform layout_fixture.expect('G04 refuses ' || v_value,
      layout_fixture.rows_as('eeeeeeee-0000-0000-0000-000000000501', format(
        $q$update public.circuits set logo_background = %L where id = '99999999-0000-0000-0000-000000000501'$q$, v_value)),
      '23514');
  end loop;
  perform layout_fixture.expect('G04 the last accepted value stays',
    (select c.logo_background from public.circuits c where c.id = '99999999-0000-0000-0000-000000000501'), 'dark');
  raise notice 'ok G04 logo colour';
end $$;
rollback to savepoint fixture;

rollback;
