-- Driver privacy fixtures for 20261029120000_driver_privacy_views.sql and 20261103120000_driver_privacy_contract.sql
-- (U4 driver-privacy, expand and contract steps): the catalog properties of the private hidden set, the
-- three helpers and the eleven masked views; what each of four callers (anon, a signed-in account with no
-- driver, a linked driver, an admin) reads from every view; the base policies' row filters re-applied by
-- the views; the prose masking cases; the query plans; the catalog-driven leak check with its negative
-- control and the function allow-list; and the base tables narrowed to admins (P01-P21).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- account-settings-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/driver-privacy-fixtures.sql
--
-- Same conventions as account-settings-fixtures.sql (supabase/checks/README.md): every assertion calls
-- privacy_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each case
-- runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`. Callers are impersonated
-- with request.jwt.claims and the role setting (privacy_fixture.read_as). Failure messages name the case,
-- the relation and the column, never the marker value (NFR9.2).
--
-- The base tables are admin-only to read since the contract step, so the leak check fails on any relation
-- anon or an unlinked account can read that shows a marker.
--
-- Base data: drivers Zq Marker Driver #91 (hidden: its account hides the name), Pat Private #92 (its account
-- hides only the profile) and Vic Visible #93. Accounts: admin, h (linked to Zq Marker Driver), p (linked to
-- Pat Private), l (linked to Vic Visible) and u (no driver). Round 9906001 is posted, 9906002 is not.

begin;

set local client_min_messages = notice;

create schema privacy_fixture;

create function privacy_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'driver privacy fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Like expect, for values that may hold a marker: the message names the case only.
create function privacy_fixture.expect_quiet(p_label text, p_ok boolean) returns void
  language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'driver privacy fixture failed: %', p_label;
  end if;
end;
$$;

-- Runs p_sql (one text value) as p_who: 'anon', or an account id for a signed-in caller. The role and the
-- claims are put back afterwards, also when p_sql fails (the error is raised again).
create function privacy_fixture.read_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v text;
begin
  if p_who = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_who, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
  execute p_sql into v;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return v;
end;
$$;

-- The SQLSTATE p_sql fails with as p_who, or 'ok'. On an error the block's own rollback puts the role and
-- the claims back.
create function privacy_fixture.state_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  if p_who = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_who, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
  execute p_sql;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- How many plan nodes of p_sql, explained as p_who, scan p_table.
create function privacy_fixture.scans_as(p_who text, p_sql text, p_table text) returns integer
  language plpgsql as $$
declare
  v_line text;
  v_count integer := 0;
begin
  if p_who = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_who, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
  for v_line in execute 'explain (costs off) ' || p_sql loop
    if v_line ~ (' on ' || p_table || '( |$)') then
      v_count := v_count + 1;
    end if;
  end loop;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return v_count;
end;
$$;

-- The first marker found in every row of relation p_rel as p_who, or '' when there is none, or 'error'.
create function privacy_fixture.marker_in(p_who text, p_rel text) returns text
  language plpgsql as $$
declare
  v text;
begin
  v := privacy_fixture.read_as(p_who, format(
    $q$select coalesce(string_agg(t::text, ' '), '') from %s t$q$, p_rel));
  return case
    when position('Zq Marker' in v) > 0 or position('zq marker' in lower(v)) > 0 then 'name'
    when position('990000001' in v) > 0 then 'customer id'
    when position('zq-marker-photo' in v) > 0 then 'photo url'
    when position('Zq marker bio' in v) > 0 then 'bio'
    else ''
  end;
exception when others then
  return 'error';
end;
$$;

grant usage on schema privacy_fixture to anon, authenticated, service_role;
grant execute on all functions in schema privacy_fixture to anon, authenticated, service_role;

-- Base data ------------------------------------------------------------------------------------

-- No scoring or round-stats side effects from the rows below.
update public.scoring_settings set triggers_enabled = false;

insert into public.driver_statuses (id, name)
select v.id, v.name from (values (821, 'Active')) v (id, name)
where not exists (select 1 from public.driver_statuses s where s.name = v.name);
insert into public.driver_classes (id, name, sort_order)
select 821, 'Alpha', 1 where not exists (select 1 from public.driver_classes where name = 'Alpha');

insert into public.seasons (id, number, name) values ('bbbbbbbb-0000-0000-0000-000000000601', 9821, 'Zq Season');

insert into public.drivers (id, name, car_number, status_id, class_id, iracing_cust_id, photo_url, bio, is_ai) values
  ('99999999-0000-0000-0000-000000000601', 'Zq Marker Driver', 91,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'),
   990000001, 'https://example.test/zq-marker-photo.png', 'Zq marker bio', false),
  ('99999999-0000-0000-0000-000000000602', 'Pat Private', 92,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'),
   990000002, 'https://example.test/pat-photo.png', 'Pat private bio', false),
  ('99999999-0000-0000-0000-000000000603', 'Vic Visible', 93,
   (select id from public.driver_statuses where name = 'Active'), (select id from public.driver_classes where name = 'Alpha'),
   990000003, 'https://example.test/vic-photo.png', 'Vic bio', false);

-- The auth.users insert creates a 'driver' profile; the admin and the linked accounts are re-inserted,
-- because as postgres the profiles guard refuses a role or driver change.
insert into auth.users (id, email, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000601', 'privacy-admin@example.test', '{"display_name":"Privacy Admin"}'),
  ('eeeeeeee-0000-0000-0000-000000000602', 'privacy-h@example.test', '{"display_name":"Owner H"}'),
  ('eeeeeeee-0000-0000-0000-000000000603', 'privacy-p@example.test', '{"display_name":"Owner P"}'),
  ('eeeeeeee-0000-0000-0000-000000000604', 'privacy-l@example.test', '{"display_name":"Owner L"}'),
  ('eeeeeeee-0000-0000-0000-000000000605', 'privacy-u@example.test', '{"display_name":"Unlinked U"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-000000000601', 'eeeeeeee-0000-0000-0000-000000000602',
                                         'eeeeeeee-0000-0000-0000-000000000603', 'eeeeeeee-0000-0000-0000-000000000604');
insert into public.profiles (id, role, display_name) values
  ('eeeeeeee-0000-0000-0000-000000000601', 'admin', 'Privacy Admin');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-000000000602', 'driver', 'Owner H', '99999999-0000-0000-0000-000000000601'),
  ('eeeeeeee-0000-0000-0000-000000000603', 'driver', 'Owner P', '99999999-0000-0000-0000-000000000602'),
  ('eeeeeeee-0000-0000-0000-000000000604', 'driver', 'Owner L', '99999999-0000-0000-0000-000000000603');

insert into public.account_settings (profile_id, hide_name, hide_profile) values
  ('eeeeeeee-0000-0000-0000-000000000602', true, false),
  ('eeeeeeee-0000-0000-0000-000000000603', false, true);

insert into public.curated_rounds (subsession_id, start_time, track_name, season_id) values
  (9906001, '2026-05-01 18:00+00', 'Zq Park', 'bbbbbbbb-0000-0000-0000-000000000601'),
  (9906002, '2026-05-08 18:00+00', 'Zq Park', 'bbbbbbbb-0000-0000-0000-000000000601');
insert into public.round_incident_status (subsession_id, posted) values (9906001, true), (9906002, false);

insert into public.curated_race_results (subsession_id, race_number, cust_id, display_name, finish_position) values
  (9906001, 1, 990000001, 'Zq Marker Driver', 1),
  (9906001, 1, 990000003, 'Vic Visible', 2),
  (9906001, 1, 990000099, 'Una Rostered', 3);
insert into public.curated_qualifying (subsession_id, cust_id, display_name, qual_position) values
  (9906001, 990000001, 'Zq Marker Driver', 1),
  (9906001, 990000003, 'Vic Visible', 2);
insert into public.curated_practice_results (subsession_id, cust_id, display_name, laps) values
  (9906001, 990000001, 'Zq Marker Driver', 10),
  (9906001, 990000003, 'Vic Visible', 12);

insert into public.kudos (id, subsession_id, session, lap, turn, description, author_id, author_name) values
  ('cccccccc-0000-0000-0000-000000000601', 9906001, 'race', 3, 'Turn 1', 'Clean pass',
   'eeeeeeee-0000-0000-0000-000000000602', 'Zq Marker Driver'),
  ('cccccccc-0000-0000-0000-000000000602', 9906001, 'race', 4, 'Turn 2', 'Nice save',
   'eeeeeeee-0000-0000-0000-000000000604', 'Vic Visible');

insert into public.news_posts (id, slug, title, body, author_name, status) values
  ('cccccccc-0000-0000-0000-000000000611', 'zq-post', 'Round report', 'Shout-out to @[Zq Marker Driver](99999999-0000-0000-0000-000000000601) and '
   || '@[Vic Visible](99999999-0000-0000-0000-000000000603). Winner: Zq Marker Driver. Again Zq  Marker'
   || E'\n' || 'Driver, ZQ MARKER DRIVER and Zq on his own.', '  zq marker driver ', 'published'),
  ('cccccccc-0000-0000-0000-000000000612', 'zq-draft', 'Draft', 'Draft text', 'Vic Visible', 'draft');

insert into public.circuits (id, name) values ('cccccccc-0000-0000-0000-000000000621', 'Zq Circuit');
insert into public.circuit_layouts (id, circuit_id, name, lap_record_holder) values
  ('cccccccc-0000-0000-0000-000000000622', 'cccccccc-0000-0000-0000-000000000621', 'Full', 'ZQ Marker Driver'),
  ('cccccccc-0000-0000-0000-000000000623', 'cccccccc-0000-0000-0000-000000000621', 'Short', 'Vic Visible'),
  ('cccccccc-0000-0000-0000-000000000624', 'cccccccc-0000-0000-0000-000000000621', 'Wet', ' zq  MARKER driver ');

insert into public.penalties (id, subsession_id, race_number, driver_id, description, appeal_result) values
  ('cccccccc-0000-0000-0000-000000000631', 9906001, 1, '99999999-0000-0000-0000-000000000601',
   'Zq Marker Driver. tapped Vic Visible', 'Denied for zq marker driver'),
  ('cccccccc-0000-0000-0000-000000000632', 9906002, 1, '99999999-0000-0000-0000-000000000603',
   'Unposted call', null);
insert into public.round_penalties (id, subsession_id, driver_id, kind, note) values
  ('cccccccc-0000-0000-0000-000000000641', 9906001, '99999999-0000-0000-0000-000000000601', 'other',
   'Zq Marker Driver serves a pit lane start'),
  ('cccccccc-0000-0000-0000-000000000642', 9906002, '99999999-0000-0000-0000-000000000603', 'other', 'Unposted note');

insert into public.champion_photos (id, season_id, class_id, driver_id, image_url, sort_order) values
  ('cccccccc-0000-0000-0000-000000000651', 'bbbbbbbb-0000-0000-0000-000000000601',
   (select id from public.driver_classes where name = 'Alpha'), '99999999-0000-0000-0000-000000000601',
   'https://example.test/zq-marker-photo-champion.png', 0),
  ('cccccccc-0000-0000-0000-000000000652', 'bbbbbbbb-0000-0000-0000-000000000601',
   (select id from public.driver_classes where name = 'Alpha'), '99999999-0000-0000-0000-000000000603',
   'https://example.test/vic-champion.png', 1);
insert into public.hall_of_fame_photos (id, driver_id, image_url, sort_order) values
  ('cccccccc-0000-0000-0000-000000000661', '99999999-0000-0000-0000-000000000601', 'https://example.test/zq-marker-photo-hof.png', 0),
  ('cccccccc-0000-0000-0000-000000000662', '99999999-0000-0000-0000-000000000603', 'https://example.test/vic-hof.png', 0);

savepoint fixture;

-- P01 The helpers: invoker, immutable, empty search_path; the hidden set is closed to every caller (NFR1.1)
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array['private.mask_names(text,text[])', 'private.mask_mentions(text,uuid[])',
                              'private.hidden_cust_id(uuid)'] loop
    perform privacy_fixture.expect('P01 not security definer: ' || v_fn,
      (select prosecdef from pg_proc where oid = v_fn::regprocedure), false);
    perform privacy_fixture.expect('P01 immutable: ' || v_fn,
      (select provolatile::text from pg_proc where oid = v_fn::regprocedure), 'i');
    perform privacy_fixture.expect('P01 search_path set: ' || v_fn,
      (select coalesce('search_path=""' = any (proconfig), false) from pg_proc where oid = v_fn::regprocedure), true);
    perform privacy_fixture.expect('P01 no execute for public: ' || v_fn,
      (select not exists (select 1 from aclexplode((select proacl from pg_proc where oid = v_fn::regprocedure)) a
                          where a.grantee = 0)), true);
  end loop;
  perform privacy_fixture.expect('P01 anon cannot read the hidden set',
    has_table_privilege('anon', 'private.hidden_drivers', 'select'), false);
  perform privacy_fixture.expect('P01 authenticated cannot read the hidden set',
    has_table_privilege('authenticated', 'private.hidden_drivers', 'select'), false);
  perform privacy_fixture.expect('P01 anon reading the hidden set directly',
    privacy_fixture.state_as('anon', 'select count(*)::text from private.hidden_drivers'), '42501');
  raise notice 'ok P01 helpers and hidden set';
end $$;
rollback to savepoint fixture;

-- P02 Every view: owner rights, security barrier, select only for anon and authenticated (NFR1.2) ----------
do $$
declare
  v_view text;
  v_priv text;
  v_role text;
begin
  foreach v_view in array array['drivers_shown', 'curated_race_results_shown', 'curated_qualifying_shown',
    'curated_practice_results_shown', 'kudos_shown', 'news_posts_shown', 'circuit_layouts_shown',
    'penalties_shown', 'round_penalties_shown', 'champion_photos_shown', 'hall_of_fame_photos_shown'] loop
    perform privacy_fixture.expect('P02 is a view: ' || v_view,
      (select relkind::text from pg_class where oid = ('public.' || v_view)::regclass), 'v');
    perform privacy_fixture.expect('P02 security_barrier: ' || v_view,
      (select coalesce('security_barrier=true' = any (reloptions), false) from pg_class where oid = ('public.' || v_view)::regclass), true);
    perform privacy_fixture.expect('P02 runs as owner: ' || v_view,
      (select coalesce('security_invoker=true' = any (reloptions), false) from pg_class where oid = ('public.' || v_view)::regclass), false);
    foreach v_role in array array['anon', 'authenticated'] loop
      perform privacy_fixture.expect('P02 select for ' || v_role || ': ' || v_view,
        has_table_privilege(v_role, 'public.' || v_view, 'select'), true);
      foreach v_priv in array array['insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
        perform privacy_fixture.expect('P02 no ' || v_priv || ' for ' || v_role || ': ' || v_view,
          has_table_privilege(v_role, 'public.' || v_view, v_priv), false);
      end loop;
    end loop;
  end loop;
  raise notice 'ok P02 view properties and grants';
end $$;
rollback to savepoint fixture;

-- P03 Insert, update and delete through every view fail, as anon and as a linked driver (NFR1.2). A view
--     with a join fails in the rewriter, a single-table one on the missing privilege; either way, no write.
do $$
declare
  v_view text;
  v_col text;
  v_who text;
begin
  foreach v_view in array array['drivers_shown', 'curated_race_results_shown', 'curated_qualifying_shown',
    'curated_practice_results_shown', 'kudos_shown', 'news_posts_shown', 'circuit_layouts_shown',
    'penalties_shown', 'round_penalties_shown', 'champion_photos_shown', 'hall_of_fame_photos_shown'] loop
    select a.attname into v_col from pg_attribute a
    where a.attrelid = ('public.' || v_view)::regclass and a.attnum = 1;
    foreach v_who in array array['anon', 'eeeeeeee-0000-0000-0000-000000000604'] loop
      perform privacy_fixture.expect('P03 insert through ' || v_view,
        privacy_fixture.state_as(v_who, format('insert into public.%I default values', v_view)) <> 'ok', true);
      perform privacy_fixture.expect('P03 update through ' || v_view,
        privacy_fixture.state_as(v_who, format('update public.%I set %I = %I where false', v_view, v_col, v_col)) <> 'ok', true);
      perform privacy_fixture.expect('P03 delete through ' || v_view,
        privacy_fixture.state_as(v_who, format('delete from public.%I where false', v_view)) <> 'ok', true);
    end loop;
  end loop;
  raise notice 'ok P03 views are read-only';
end $$;
rollback to savepoint fixture;

-- P04 drivers_shown per caller (BR9.1-BR9.3, BR9.11, BR9.12) ---------------------------------------------
do $$
declare
  c_row constant text := $q$select concat_ws('|', name, coalesce(photo_url, '-'), coalesce(bio, '-'),
      (iracing_cust_id < 0)::text, is_hidden::text, profile_private::text)
    from public.drivers_shown where id = '%s'$q$;
  v_who text;
begin
  foreach v_who in array array['anon', 'eeeeeeee-0000-0000-0000-000000000605'] loop
    perform privacy_fixture.expect('P04 hidden driver for ' || v_who,
      privacy_fixture.read_as(v_who, format(c_row, '99999999-0000-0000-0000-000000000601')),
      'Hidden Driver|-|-|true|true|true');
    perform privacy_fixture.expect('P04 private-only driver for ' || v_who,
      privacy_fixture.read_as(v_who, format(c_row, '99999999-0000-0000-0000-000000000602')),
      'Pat Private|https://example.test/pat-photo.png|-|false|false|true');
    perform privacy_fixture.expect('P04 visible driver for ' || v_who,
      privacy_fixture.read_as(v_who, format(c_row, '99999999-0000-0000-0000-000000000603')),
      'Vic Visible|https://example.test/vic-photo.png|Vic bio|false|false|false');
  end loop;
  foreach v_who in array array['eeeeeeee-0000-0000-0000-000000000601', 'eeeeeeee-0000-0000-0000-000000000604',
                               'eeeeeeee-0000-0000-0000-000000000602'] loop
    perform privacy_fixture.expect('P04 privileged caller sees the hidden driver: ' || v_who,
      privacy_fixture.read_as(v_who, format(c_row, '99999999-0000-0000-0000-000000000601')),
      'Zq Marker Driver|https://example.test/zq-marker-photo.png|Zq marker bio|false|false|false');
    perform privacy_fixture.expect('P04 privileged caller sees the private bio: ' || v_who,
      privacy_fixture.read_as(v_who, format(c_row, '99999999-0000-0000-0000-000000000602')),
      'Pat Private|https://example.test/pat-photo.png|Pat private bio|false|false|false');
  end loop;
  perform privacy_fixture.expect('P04 real customer id for an admin',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000601',
      $q$select iracing_cust_id::text from public.drivers_shown where id = '99999999-0000-0000-0000-000000000601'$q$),
    '990000001');
  perform privacy_fixture.expect('P04 every driver row is returned to anon',
    privacy_fixture.read_as('anon', $q$select count(*)::text from public.drivers_shown
      where id::text like '99999999-0000-0000-0000-00000000060%'$q$), '3');
  raise notice 'ok P04 drivers_shown';
end $$;
rollback to savepoint fixture;

-- P05 The results views: masked by roster match, a stand-in cust_id matching drivers_shown (BR9.4, F2 A) -
do $$
declare
  v_view text;
  v_shown_cust text;
begin
  v_shown_cust := privacy_fixture.read_as('anon',
    $q$select iracing_cust_id::text from public.drivers_shown where id = '99999999-0000-0000-0000-000000000601'$q$);
  foreach v_view in array array['curated_race_results_shown', 'curated_qualifying_shown', 'curated_practice_results_shown'] loop
    perform privacy_fixture.expect('P05 hidden row for anon: ' || v_view,
      privacy_fixture.read_as('anon', format(
        $q$select concat_ws('|', display_name, (cust_id::text = %L)::text, roster_driver_id::text)
           from public.%I where subsession_id = 9906001 and roster_driver_id = '99999999-0000-0000-0000-000000000601'$q$,
        v_shown_cust, v_view)),
      'Hidden Driver|true|99999999-0000-0000-0000-000000000601');
    perform privacy_fixture.expect('P05 visible row for anon: ' || v_view,
      privacy_fixture.read_as('anon', format(
        $q$select concat_ws('|', display_name, cust_id::text, roster_driver_id::text)
           from public.%I where subsession_id = 9906001 and roster_driver_id = '99999999-0000-0000-0000-000000000603'$q$, v_view)),
      'Vic Visible|990000003|99999999-0000-0000-0000-000000000603');
    perform privacy_fixture.expect('P05 hidden row for a linked driver: ' || v_view,
      privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000604', format(
        $q$select concat_ws('|', display_name, cust_id::text)
           from public.%I where subsession_id = 9906001 and roster_driver_id = '99999999-0000-0000-0000-000000000601'$q$, v_view)),
      'Zq Marker Driver|990000001');
  end loop;
  perform privacy_fixture.expect('P05 unrostered entrant keeps its name and has no roster driver',
    privacy_fixture.read_as('anon', $q$select concat_ws('|', display_name, cust_id::text, coalesce(roster_driver_id::text, 'none'))
      from public.curated_race_results_shown where subsession_id = 9906001 and finish_position = 3$q$),
    'Una Rostered|990000099|none');
  perform privacy_fixture.expect('P05 every result row is returned',
    privacy_fixture.read_as('anon', 'select count(*)::text from public.curated_race_results_shown where subsession_id = 9906001'), '3');
  raise notice 'ok P05 results views';
end $$;
rollback to savepoint fixture;

-- P06 Kudos author and lap record holder (BR9.5, BR9.6) --------------------------------------------------
do $$
begin
  perform privacy_fixture.expect('P06 kudos author for anon',
    privacy_fixture.read_as('anon', $q$select string_agg(author_name, ',' order by lap) from public.kudos_shown
      where subsession_id = 9906001$q$), 'Hidden Driver,Vic Visible');
  perform privacy_fixture.expect('P06 kudos author for an unlinked account',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000605', $q$select string_agg(author_name, ',' order by lap)
      from public.kudos_shown where subsession_id = 9906001$q$), 'Hidden Driver,Vic Visible');
  perform privacy_fixture.expect('P06 kudos author for a linked driver',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000604', $q$select string_agg(author_name, ',' order by lap)
      from public.kudos_shown where subsession_id = 9906001$q$), 'Zq Marker Driver,Vic Visible');
  perform privacy_fixture.expect('P06 lap record holder for anon (case-insensitive)',
    privacy_fixture.read_as('anon', $q$select string_agg(lap_record_holder, ',' order by name) from public.circuit_layouts_shown
      where circuit_id = 'cccccccc-0000-0000-0000-000000000621' and name <> 'Wet'$q$), 'Hidden Driver,Vic Visible');
  perform privacy_fixture.expect('P06 lap record holder with extra spaces for anon',
    privacy_fixture.read_as('anon', $q$select lap_record_holder from public.circuit_layouts_shown
      where id = 'cccccccc-0000-0000-0000-000000000624'$q$), 'Hidden Driver');
  perform privacy_fixture.expect('P06 lap record holder for an admin',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000601', $q$select string_agg(lap_record_holder, ',' order by name)
      from public.circuit_layouts_shown where circuit_id = 'cccccccc-0000-0000-0000-000000000621' and name <> 'Wet'$q$), 'ZQ Marker Driver,Vic Visible');
  raise notice 'ok P06 copied names';
end $$;
rollback to savepoint fixture;

-- P07 News: published rows only, author and body masked, mentions of the hidden driver made plain (BR9.6,
--     BR9.7, BR9.9; base policy "read news") ---------------------------------------------------------------
do $$
declare
  v_body text;
begin
  v_body := privacy_fixture.read_as('anon', $q$select body from public.news_posts_shown where slug = 'zq-post'$q$);
  perform privacy_fixture.expect('P07 body for anon', v_body,
    'Shout-out to Hidden Driver and @[Vic Visible](99999999-0000-0000-0000-000000000603). Winner: Hidden Driver. '
    || 'Again Hidden Driver, Hidden Driver and Zq on his own.');
  perform privacy_fixture.expect('P07 author for anon',
    privacy_fixture.read_as('anon', $q$select author_name from public.news_posts_shown where slug = 'zq-post'$q$), 'Hidden Driver');
  perform privacy_fixture.expect('P07 draft hidden from anon',
    privacy_fixture.read_as('anon', $q$select count(*)::text from public.news_posts_shown where slug = 'zq-draft'$q$), '0');
  perform privacy_fixture.expect('P07 draft hidden from a linked driver',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000604',
      $q$select count(*)::text from public.news_posts_shown where slug = 'zq-draft'$q$), '0');
  perform privacy_fixture.expect('P07 draft shown to an admin',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000601',
      $q$select count(*)::text from public.news_posts_shown where slug = 'zq-draft'$q$), '1');
  -- The raw body is read here as the owner: since the contract step a linked driver cannot read news_posts.
  perform privacy_fixture.expect('P07 body unchanged for a linked driver',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000604',
      $q$select body from public.news_posts_shown where slug = 'zq-post'$q$),
    (select n.body from public.news_posts n where n.slug = 'zq-post'));
  raise notice 'ok P07 news';
end $$;
rollback to savepoint fixture;

-- P08 Penalties and round penalties: posted rounds only for non-admins, prose masked (BR9.7, BR9.16) -------
do $$
begin
  perform privacy_fixture.expect('P08 penalties for anon',
    privacy_fixture.read_as('anon', $q$select string_agg(concat_ws('|', description, appeal_result), ',' order by subsession_id)
      from public.penalties_shown where subsession_id in (9906001, 9906002)$q$),
    'Hidden Driver. tapped Vic Visible|Denied for Hidden Driver');
  perform privacy_fixture.expect('P08 penalties for an unlinked account',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000605', $q$select count(*)::text from public.penalties_shown
      where subsession_id in (9906001, 9906002)$q$), '1');
  perform privacy_fixture.expect('P08 penalties for an admin',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000601', $q$select string_agg(description, ',' order by subsession_id)
      from public.penalties_shown where subsession_id in (9906001, 9906002)$q$),
    'Zq Marker Driver. tapped Vic Visible,Unposted call');
  perform privacy_fixture.expect('P08 round penalties for anon',
    privacy_fixture.read_as('anon', $q$select string_agg(note, ',' order by subsession_id)
      from public.round_penalties_shown where subsession_id in (9906001, 9906002)$q$),
    'Hidden Driver serves a pit lane start');
  perform privacy_fixture.expect('P08 round penalties for an admin',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000601', $q$select count(*)::text
      from public.round_penalties_shown where subsession_id in (9906001, 9906002)$q$), '2');
  raise notice 'ok P08 penalties';
end $$;
rollback to savepoint fixture;

-- P09 Champion and Hall of Fame photos of a hidden driver are left out (BR9.10) ---------------------------
do $$
begin
  perform privacy_fixture.expect('P09 champion photos for anon',
    privacy_fixture.read_as('anon', $q$select string_agg(driver_id::text, ',' order by sort_order) from public.champion_photos_shown
      where season_id = 'bbbbbbbb-0000-0000-0000-000000000601'$q$), '99999999-0000-0000-0000-000000000603');
  perform privacy_fixture.expect('P09 hall of fame photos for anon',
    privacy_fixture.read_as('anon', $q$select string_agg(driver_id::text, ',' order by driver_id) from public.hall_of_fame_photos_shown
      where driver_id::text like '99999999-0000-0000-0000-00000000060%'$q$), '99999999-0000-0000-0000-000000000603');
  perform privacy_fixture.expect('P09 champion photos for a linked driver',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000604', $q$select count(*)::text from public.champion_photos_shown
      where season_id = 'bbbbbbbb-0000-0000-0000-000000000601'$q$), '2');
  perform privacy_fixture.expect('P09 hall of fame photos for an admin',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000601', $q$select count(*)::text from public.hall_of_fame_photos_shown
      where driver_id::text like '99999999-0000-0000-0000-00000000060%'$q$), '2');
  raise notice 'ok P09 driver images';
end $$;
rollback to savepoint fixture;

-- P10 Turning the toggle off, removing the settings row, or unlinking ends the masking at once (ADR-004,
--     BR9.2: privacy follows the account; a driver with no linked account is never hidden) -----------------
do $$
begin
  update public.account_settings set hide_name = false where profile_id = 'eeeeeeee-0000-0000-0000-000000000602';
  perform privacy_fixture.expect('P10 toggle off',
    privacy_fixture.read_as('anon', $q$select concat_ws('|', name, is_hidden::text) from public.drivers_shown
      where id = '99999999-0000-0000-0000-000000000601'$q$), 'Zq Marker Driver|false');
  delete from public.account_settings where profile_id = 'eeeeeeee-0000-0000-0000-000000000603';
  perform privacy_fixture.expect('P10 no settings row means visible',
    privacy_fixture.read_as('anon', $q$select concat_ws('|', coalesce(bio, '-'), profile_private::text) from public.drivers_shown
      where id = '99999999-0000-0000-0000-000000000602'$q$), 'Pat private bio|false');
  raise notice 'ok P10 toggles apply at once';
end $$;
rollback to savepoint fixture;

do $$
begin
  -- The profiles guard refuses a driver change as postgres, so the account row is replaced.
  delete from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000602';
  insert into public.profiles (id, role, display_name) values ('eeeeeeee-0000-0000-0000-000000000602', 'driver', 'Owner H');
  perform privacy_fixture.expect('P10 unlinked driver is visible',
    privacy_fixture.read_as('anon', $q$select concat_ws('|', name, is_hidden::text) from public.drivers_shown
      where id = '99999999-0000-0000-0000-000000000601'$q$), 'Zq Marker Driver|false');
  raise notice 'ok P10 unlinking';
end $$;
rollback to savepoint fixture;

-- P11 mask_names: punctuation, whitespace runs, case, first name alone, one-word names, longest first,
--     regex characters, and more than 100 names (BR9.7, BR9.8) ---------------------------------------------
do $$
declare
  v_many text[];
begin
  perform privacy_fixture.expect('P11 name ending in a full stop',
    private.mask_names('Dana Example Jr. won. Then Dana Example Jr.', array['Dana Example Jr.']),
    'Hidden Driver won. Then Hidden Driver');
  perform privacy_fixture.expect('P11 double space and a line break inside the name',
    private.mask_names(E'Dana  Example and Dana\nExample', array['Dana Example']), 'Hidden Driver and Hidden Driver');
  perform privacy_fixture.expect('P11 case differences',
    private.mask_names('DANA EXAMPLE and dana example', array['Dana Example']), 'Hidden Driver and Hidden Driver');
  perform privacy_fixture.expect('P11 first or last name alone is left',
    private.mask_names('Dana was quick; Example too', array['Dana Example']), 'Dana was quick; Example too');
  perform privacy_fixture.expect('P11 whole words only',
    private.mask_names('Dana Examples and XDana Example', array['Dana Example']), 'Dana Examples and XDana Example');
  perform privacy_fixture.expect('P11 one-word name is not masked in prose',
    private.mask_names('Cher won', array['Cher']), 'Cher won');
  perform privacy_fixture.expect('P11 longest name first',
    private.mask_names('Dana Example Jr and Dana Example', array['Dana Example', 'Dana Example Jr']),
    'Hidden Driver and Hidden Driver');
  perform privacy_fixture.expect('P11 regex characters in a name',
    private.mask_names('A.J. (Ace) O''Neil+ won; AxJx (Ace) O''Neil+ lost', array['A.J. (Ace) O''Neil+']),
    'Hidden Driver won; AxJx (Ace) O''Neil+ lost');
  perform privacy_fixture.expect('P11 another driver with the same full name is masked too (BR9.8)',
    private.mask_names('Sam Same and Sam Same', array['Sam Same']), 'Hidden Driver and Hidden Driver');
  perform privacy_fixture.expect('P11 no names', private.mask_names('Dana Example', '{}'::text[]), 'Dana Example');
  perform privacy_fixture.expect('P11 null text', private.mask_names(null, array['Dana Example']), null::text);
  select array_agg('Zq Name ' || g) into v_many from generate_series(1, 150) g;
  perform privacy_fixture.expect('P11 more than 100 names (two patterns)',
    private.mask_names('Zq Name 150, Zq Name 1 and Zq Name 15x', v_many), 'Hidden Driver, Hidden Driver and Zq Name 15x');
  raise notice 'ok P11 prose masking';
end $$;
rollback to savepoint fixture;

-- P12 mask_mentions and the stand-in customer id ---------------------------------------------------------
do $$
begin
  perform privacy_fixture.expect('P12 mention with an upper-case id',
    private.mask_mentions('Hi @[Dana](99999999-0000-0000-0000-0000000006AB)!', array['99999999-0000-0000-0000-0000000006ab'::uuid]),
    'Hi Hidden Driver!');
  perform privacy_fixture.expect('P12 other mentions stay',
    private.mask_mentions('@[Vic](99999999-0000-0000-0000-000000000603)', array['99999999-0000-0000-0000-000000000601'::uuid]),
    '@[Vic](99999999-0000-0000-0000-000000000603)');
  perform privacy_fixture.expect('P12 stand-in id is negative',
    private.hidden_cust_id('99999999-0000-0000-0000-000000000601') < 0, true);
  perform privacy_fixture.expect('P12 stand-in id is exact in JavaScript',
    private.hidden_cust_id('99999999-0000-0000-0000-000000000601') >= -9007199254740991, true);
  perform privacy_fixture.expect('P12 stand-in id is stable',
    private.hidden_cust_id('99999999-0000-0000-0000-000000000601'),
    private.hidden_cust_id('99999999-0000-0000-0000-000000000601'));
  perform privacy_fixture.expect('P12 stand-in ids differ between drivers',
    private.hidden_cust_id('99999999-0000-0000-0000-000000000601') <> private.hidden_cust_id('99999999-0000-0000-0000-000000000603'),
    true);
  raise notice 'ok P12 mentions and stand-in ids';
end $$;
rollback to savepoint fixture;

-- P13 The hidden set is read once per statement, not per row (BR9.19, NFR3.3) -----------------------------
do $$
begin
  perform privacy_fixture.expect('P13 drivers_shown reads account_settings once',
    privacy_fixture.scans_as('anon', 'select * from public.drivers_shown', 'account_settings'), 1);
  perform privacy_fixture.expect('P13 results view reads account_settings once',
    privacy_fixture.scans_as('anon', 'select * from public.curated_race_results_shown where subsession_id = 9906001',
      'account_settings'), 1);
  -- Two prose columns, two name lists, each an InitPlan evaluated once.
  perform privacy_fixture.expect('P13 penalties_shown reads account_settings once per name list',
    privacy_fixture.scans_as('anon', 'select * from public.penalties_shown where subsession_id = 9906001',
      'account_settings') <= 2, true);
  raise notice 'ok P13 plans';
end $$;
rollback to savepoint fixture;

-- P14 Every identifying column carries a marker only for privileged callers (NFR1.3, NFR1.5 masked values)
do $$
declare
  v_view text;
  v_who text;
  v_found text;
begin
  foreach v_view in array array['drivers_shown', 'curated_race_results_shown', 'curated_qualifying_shown',
    'curated_practice_results_shown', 'kudos_shown', 'news_posts_shown', 'circuit_layouts_shown',
    'penalties_shown', 'round_penalties_shown', 'champion_photos_shown', 'hall_of_fame_photos_shown'] loop
    foreach v_who in array array['anon', 'eeeeeeee-0000-0000-0000-000000000605'] loop
      v_found := privacy_fixture.marker_in(v_who, 'public.' || v_view);
      perform privacy_fixture.expect_quiet(format('P14 %s leaks a %s to %s', v_view, v_found, v_who), v_found = '');
    end loop;
  end loop;
  -- Privileged callers do see the markers (the check is not vacuous).
  perform privacy_fixture.expect('P14 admin sees the name marker in drivers_shown',
    privacy_fixture.marker_in('eeeeeeee-0000-0000-0000-000000000601', 'public.drivers_shown') <> '', true);
  perform privacy_fixture.expect('P14 linked driver sees the name marker in news_posts_shown',
    privacy_fixture.marker_in('eeeeeeee-0000-0000-0000-000000000604', 'public.news_posts_shown') <> '', true);
  raise notice 'ok P14 no markers in the views for unprivileged callers';
end $$;
rollback to savepoint fixture;

-- P15 Catalog-driven leak check over every relation anon or an unlinked account can select (BR9.20; NFR1.5).
--     No relation may show a marker; one that cannot be read is reported. A deliberately unmasked view must
--     be flagged.
do $$
declare
  v_rel record;
  v_found text;
  v_role text;
  v_who text;
  v_flagged text := '';
begin
  create view public.zq_leak_probe as select d.id, d.name from public.drivers d;
  grant select on public.zq_leak_probe to anon, authenticated;

  foreach v_role in array array['anon', 'authenticated'] loop
    v_who := case when v_role = 'anon' then 'anon' else 'eeeeeeee-0000-0000-0000-000000000605' end;
    for v_rel in
      select format('%I.%I', n.nspname, c.relname) as qualified, c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'private')
        and c.relkind in ('r', 'v', 'm', 'p')
        and has_table_privilege(v_role, c.oid, 'select')
      order by 1
    loop
      v_found := privacy_fixture.marker_in(v_who, v_rel.qualified);
      if v_found = '' then
        continue;
      elsif v_rel.relname = 'zq_leak_probe' then
        v_flagged := v_flagged || v_role || ' ';
      elsif v_found = 'error' then
        raise notice 'P15 report: % could not be read as %', v_rel.qualified, v_role;
      else
        perform privacy_fixture.expect_quiet(format('P15 %s leaks a %s to %s', v_rel.qualified, v_found, v_role), false);
      end if;
    end loop;
  end loop;
  perform privacy_fixture.expect('P15 negative control flagged for both roles', v_flagged, 'anon authenticated ');
  raise notice 'ok P15 leak check';
end $$;
rollback to savepoint fixture;

-- P16 A linked user's own profile can embed its driver's real name through drivers_shown (auth.ts getProfile)
do $$
begin
  perform privacy_fixture.expect('P16 own driver name through drivers_shown',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000602', $q$select d.name from public.profiles p
      join public.drivers_shown d on d.id = p.driver_id where p.id = 'eeeeeeee-0000-0000-0000-000000000602'$q$),
    'Zq Marker Driver');
  raise notice 'ok P16 own profile name';
end $$;
rollback to savepoint fixture;

-- P17 After the contract step the eleven base tables are readable only by admins (BR9.16; NFR1.4): anon, an
--     unlinked account and a linked driver (p, who wrote no kudos) get no rows; an admin gets every row.
do $$
declare
  v_table text;
  v_who text;
begin
  foreach v_table in array array['drivers', 'curated_race_results', 'curated_qualifying', 'curated_practice_results',
    'kudos', 'news_posts', 'circuit_layouts', 'penalties', 'round_penalties', 'champion_photos', 'hall_of_fame_photos'] loop
    foreach v_who in array array['anon', 'eeeeeeee-0000-0000-0000-000000000605', 'eeeeeeee-0000-0000-0000-000000000603'] loop
      perform privacy_fixture.expect(format('P17 %s rows for %s', v_table, v_who),
        privacy_fixture.read_as(v_who, format('select count(*)::text from public.%I', v_table)), '0');
    end loop;
    perform privacy_fixture.expect(format('P17 admin reads %s', v_table),
      privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000601',
        format('select count(*)::text from public.%I', v_table)) <> '0', true);
  end loop;
  perform privacy_fixture.expect('P17 admin reads every seeded driver',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000601', $q$select count(*)::text from public.drivers
      where id::text like '99999999-0000-0000-0000-00000000060%'$q$), '3');
  perform privacy_fixture.expect('P17 admin reads the unposted penalty too',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000601',
      $q$select count(*)::text from public.penalties where subsession_id in (9906001, 9906002)$q$), '2');
  raise notice 'ok P17 base tables admin-only';
end $$;
rollback to savepoint fixture;

-- P18 The service role (the Discord bot) still reads the base tables raw (NFR1.6) -------------------------
do $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  perform privacy_fixture.expect('P18 service role reads the base table',
    (select name from public.drivers where id = '99999999-0000-0000-0000-000000000601'), 'Zq Marker Driver');
  perform privacy_fixture.expect('P18 service role runs a bot RPC', public.car_number_holder(91, null), 'Zq Marker Driver');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  raise notice 'ok P18 service role';
end $$;
rollback to savepoint fixture;

-- P19 The penalty child tables keep their posted-round filter for non-admins through private.penalty_is_posted,
--     although their policies can no longer read public.penalties as the caller.
do $$
declare
  v_offense uuid;
begin
  insert into public.penalty_offenses (name) values ('Zq offense') returning id into v_offense;
  insert into public.penalty_involved_drivers (penalty_id, driver_id) values
    ('cccccccc-0000-0000-0000-000000000631', '99999999-0000-0000-0000-000000000603'),
    ('cccccccc-0000-0000-0000-000000000632', '99999999-0000-0000-0000-000000000601');
  insert into public.penalty_offense_links (penalty_id, offense_id) values
    ('cccccccc-0000-0000-0000-000000000631', v_offense),
    ('cccccccc-0000-0000-0000-000000000632', v_offense);
  perform privacy_fixture.expect('P19 anon reads the posted involved driver only',
    privacy_fixture.read_as('anon', $q$select string_agg(penalty_id::text, ',') from public.penalty_involved_drivers
      where penalty_id in ('cccccccc-0000-0000-0000-000000000631', 'cccccccc-0000-0000-0000-000000000632')$q$),
    'cccccccc-0000-0000-0000-000000000631');
  perform privacy_fixture.expect('P19 anon reads the posted offense link only',
    privacy_fixture.read_as('anon', $q$select string_agg(penalty_id::text, ',') from public.penalty_offense_links
      where penalty_id in ('cccccccc-0000-0000-0000-000000000631', 'cccccccc-0000-0000-0000-000000000632')$q$),
    'cccccccc-0000-0000-0000-000000000631');
  perform privacy_fixture.expect('P19 the penalties view still embeds them for anon',
    privacy_fixture.read_as('anon', $q$select count(*)::text from public.penalties_shown p
      join public.penalty_involved_drivers i on i.penalty_id = p.id
      where p.id = 'cccccccc-0000-0000-0000-000000000631'$q$), '1');
  perform privacy_fixture.expect('P19 admin reads both involved drivers',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000601', $q$select count(*)::text from public.penalty_involved_drivers
      where penalty_id in ('cccccccc-0000-0000-0000-000000000631', 'cccccccc-0000-0000-0000-000000000632')$q$), '2');
  perform privacy_fixture.expect('P19 helper is a definer with an empty search_path',
    (select prosecdef and proconfig @> array['search_path=""'] from pg_proc
     where oid = 'private.penalty_is_posted(uuid)'::regprocedure), true);
  raise notice 'ok P19 penalty child policies';
end $$;
rollback to savepoint fixture;

-- P20 A kudos author still deletes their own kudos with a returning clause (src/lib/kudos.ts deleteKudos);
--     another account deletes nothing.
do $$
begin
  perform privacy_fixture.expect('P20 another account deletes nothing',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000604', $q$with d as (delete from public.kudos
      where id = 'cccccccc-0000-0000-0000-000000000601' returning id) select count(*)::text from d$q$), '0');
  perform privacy_fixture.expect('P20 the author deletes their own kudos',
    privacy_fixture.read_as('eeeeeeee-0000-0000-0000-000000000602', $q$with d as (delete from public.kudos
      where id = 'cccccccc-0000-0000-0000-000000000601' returning id) select count(*)::text from d$q$), '1');
  raise notice 'ok P20 kudos author delete';
end $$;
rollback to savepoint fixture;

-- P21 Every public function anon or authenticated may execute that returns text, json, a row or a set is on
--     this reviewed allow-list (BR9.20; NFR1.5). A function missing from the list fails the case by name;
--     review what it returns to an unprivileged caller before adding it.
do $$
declare
  v_unlisted text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into v_unlisted
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_type t on t.oid = p.prorettype
  where n.nspname = 'public'
    and p.prokind = 'f'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
    and (p.proretset or t.typtype = 'c' or t.oid in ('text'::regtype, 'json'::regtype, 'jsonb'::regtype, 'record'::regtype))
    and p.proname not in (
      -- Refuse callers who are not admins (is_admin() check in the body):
      'admin_list_user_emails', 'approve_signup_request', 'get_page_view_stats', 'incident_report_review_counts',
      'notifications_admin_counts', 'rebuild_season_stats', 'recalculate_season_scores', 'rescore_season',
      'score_round_preview', 'sync_results_with_roster', 'edit_incident_report_submission',
      -- Return no names (counts, codes, status rows; incident_submissions gives car numbers only):
      'can_appeal_penalty', 'get_news_post_view_counts', 'round_stats_status', 'claim_broadcaster',
      'incident_submissions',
      -- Return only the caller's own data, or names of unlinked drivers, who can never be hidden:
      'link_my_driver', 'list_unlinked_drivers', 'my_incidents', 'my_link_state'
    );
  perform privacy_fixture.expect('P21 unlisted functions', coalesce(v_unlisted, ''), '');
  raise notice 'ok P21 function allow-list';
end $$;
rollback to savepoint fixture;

rollback;
