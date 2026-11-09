-- Poll fixtures for 20261115120001_polls.sql (polls unit U2; rules BR1.1-BR5.6): creating and saving a poll
-- with mixed answer types, the payload refusals, a name swap and reorder in one save, stale saves and ids or
-- image paths from elsewhere, Staff, drivers and anon refused, what each caller can read, Post and Unpost,
-- Delete, the vote lock stub, the bucket policies and the grants (Q01-Q10).
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- appeal-close-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/poll-fixtures.sql
--
-- Same conventions as appeal-close-fixtures.sql (supabase/checks/README.md): every assertion calls
-- poll_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each case runs
-- after `savepoint fixture` and is undone with `rollback to savepoint fixture`. Callers are impersonated with
-- request.jwt.claims and the role setting. Storage objects are written straight into storage.objects, as the
-- Storage API does under the caller's role.
--
-- Accounts: adm (admin), stf (staff), drv (driver). Polls are created by adm through create_poll unless a
-- case needs a state the functions would refuse, which is then written as the owner.

begin;

set local client_min_messages = notice;

create schema poll_fixture;

create function poll_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'poll fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- Acts as p_who ('anon' or an account id) until poll_fixture.as_owner().
create function poll_fixture.act_as(p_who text) returns void
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

create function poll_fixture.as_owner() returns void
  language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- The first value p_sql returns as p_who, as text (raises when p_sql fails).
create function poll_fixture.val_as(p_who text, p_sql text) returns text
  language plpgsql as $$
declare
  v text;
begin
  perform poll_fixture.act_as(p_who);
  execute p_sql into v;
  perform poll_fixture.as_owner();
  return v;
end;
$$;

-- 'ok', or the message of the error p_sql raises as p_who. On an error the block's rollback puts the role back.
create function poll_fixture.err_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform poll_fixture.act_as(p_who);
  execute p_sql;
  perform poll_fixture.as_owner();
  return 'ok';
exception when others then
  return sqlerrm;
end;
$$;

-- 'ok', or the SQLSTATE p_sql fails with as p_who.
create function poll_fixture.state_as(p_who text, p_sql text) returns text
  language plpgsql as $$
begin
  perform poll_fixture.act_as(p_who);
  execute p_sql;
  perform poll_fixture.as_owner();
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

create function poll_fixture.save_sql(p_poll uuid, p_expected timestamptz, p_payload jsonb) returns text
  language sql as $$
  select format('select public.save_poll(%L, %L, %L)::text', p_poll, p_expected, p_payload);
$$;

-- What save_poll answers p_who: the unused paths it returns, or the error message.
create function poll_fixture.save(p_who text, p_poll uuid, p_payload jsonb) returns text
  language plpgsql as $$
declare
  v_expected timestamptz := (select updated_at from public.polls where id = p_poll);
begin
  return poll_fixture.val_as(p_who, poll_fixture.save_sql(p_poll, v_expected, p_payload));
exception when others then
  perform poll_fixture.as_owner();
  return sqlerrm;
end;
$$;

-- A new draft made by adm through create_poll.
create function poll_fixture.new_poll(p_title text) returns uuid
  language sql as $$
  select poll_fixture.val_as('eeeeeeee-0000-0000-0000-0000000002a1',
    format('select public.create_poll(%L)::text', p_title))::uuid;
$$;

-- A section payload: options given as names, no ids.
create function poll_fixture.section(p_name text, p_type text, p_options text[]) returns jsonb
  language sql as $$
  select jsonb_build_object('name', p_name, 'answer_type', p_type,
    'options', coalesce((select jsonb_agg(jsonb_build_object('name', n) order by i)
                         from unnest(p_options) with ordinality as o (n, i)), '[]'::jsonb));
$$;

-- The poll's sections as 'name:type:option|option' in position order.
create function poll_fixture.shape(p_poll uuid) returns text
  language sql as $$
  select string_agg(s.name || ':' || s.answer_type || ':' || (
    select string_agg(o.name, '|' order by o.position) from public.poll_options o where o.section_id = s.id
  ), ';' order by s.position)
  from public.poll_sections s where s.poll_id = p_poll;
$$;

grant usage on schema poll_fixture to anon, authenticated;
grant execute on all functions in schema poll_fixture to anon, authenticated;

-- Base data ------------------------------------------------------------------------------------------------

-- The auth.users insert creates a 'driver' profile; the admin and staff accounts are re-inserted, because as
-- postgres the profiles guard refuses a role change.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-0000000002a1', 'poll-adm@example.test', now(), '{"display_name":"Poll Admin"}'),
  ('eeeeeeee-0000-0000-0000-0000000002a2', 'poll-stf@example.test', now(), '{"display_name":"Poll Staff"}'),
  ('eeeeeeee-0000-0000-0000-0000000002a3', 'poll-drv@example.test', now(), '{"display_name":"Poll Driver"}');
delete from public.profiles where id in ('eeeeeeee-0000-0000-0000-0000000002a1', 'eeeeeeee-0000-0000-0000-0000000002a2',
                                         'eeeeeeee-0000-0000-0000-0000000002a3');
insert into public.profiles (id, role, display_name, driver_id) values
  ('eeeeeeee-0000-0000-0000-0000000002a1', 'admin', 'Poll Admin', null),
  ('eeeeeeee-0000-0000-0000-0000000002a2', 'staff', 'Poll Staff', null),
  ('eeeeeeee-0000-0000-0000-0000000002a3', 'driver', 'Poll Driver', null);

savepoint fixture;

-- Q01 A full admin creates a draft and saves it with mixed answer types (BR1.1-BR1.4, BR2.1) ------------------
do $$
declare
  v_adm text := 'eeeeeeee-0000-0000-0000-0000000002a1';
  v_poll uuid := poll_fixture.new_poll('  Next season  ');
  v_payload jsonb;
begin
  perform poll_fixture.expect('Q01 draft',
    (select title || '/' || status || '/' || (posted_at is null)::text || '/' || (first_posted_at is null)::text
            || '/' || created_by::text from public.polls where id = v_poll),
    'Next season/draft/true/true/eeeeeeee-0000-0000-0000-0000000002a1');
  v_payload := jsonb_build_object(
    'title', ' Next season ', 'description', '   ', 'closes_at', (now() + interval '7 days')::text,
    'is_schedule_vote', true,
    'sections', jsonb_build_array(
      poll_fixture.section(' Track ', 'single', array['Spa', 'Monza']),
      poll_fixture.section('Cars', 'multiple', array['GT3', 'GT4', 'TCR']),
      poll_fixture.section('Rate the season', 'stars', array['Overall'])));
  v_payload := jsonb_set(v_payload, '{sections,0,options,0,image_path}', to_jsonb(v_poll::text || '/spa-1700000000000.png'));
  perform poll_fixture.expect('Q01 save', poll_fixture.save(v_adm, v_poll, v_payload), '{}');
  perform poll_fixture.expect('Q01 poll row',
    (select title || '/' || coalesce(description, 'null') || '/' || is_schedule_vote::text || '/' || (closes_at > now())::text
     from public.polls where id = v_poll),
    'Next season/null/true/true');
  perform poll_fixture.expect('Q01 shape', poll_fixture.shape(v_poll),
    'Track:single:Spa|Monza;Cars:multiple:GT3|GT4|TCR;Rate the season:stars:Overall');
  perform poll_fixture.expect('Q01 positions',
    (select string_agg(s.position::text, ',' order by s.position) from public.poll_sections s where s.poll_id = v_poll),
    '0,1,2');
  perform poll_fixture.expect('Q01 image path',
    (select o.image_path from public.poll_options o join public.poll_sections s on s.id = o.section_id
     where s.poll_id = v_poll and o.name = 'Spa'),
    v_poll::text || '/spa-1700000000000.png');
  raise notice 'ok Q01 create and save';
end $$;
rollback to savepoint fixture;

-- Q02 The payload refusals (BR1.1-BR1.3, BR2.4) --------------------------------------------------------------
do $$
declare
  v_adm text := 'eeeeeeee-0000-0000-0000-0000000002a1';
  v_poll uuid := poll_fixture.new_poll('Refusals');
  v_ok jsonb := jsonb_build_array(poll_fixture.section('Q', 'single', array['A', 'B']));
  v_many jsonb := '[]';
begin
  for i in 1 .. 21 loop
    v_many := v_many || jsonb_build_array(poll_fixture.section('Q' || i, 'stars', array['A']));
  end loop;
  perform poll_fixture.expect('Q02 blank title',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', '  ', 'sections', v_ok)), 'invalid:title:length');
  perform poll_fixture.expect('Q02 long description',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'T', 'description', repeat('d', 2001), 'sections', v_ok)),
    'invalid:description:length');
  perform poll_fixture.expect('Q02 no sections',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'T', 'sections', '[]'::jsonb)), 'invalid:sections:count');
  perform poll_fixture.expect('Q02 21 sections',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'T', 'sections', v_many)), 'invalid:sections:count');
  perform poll_fixture.expect('Q02 bad answer type',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'T',
      'sections', jsonb_build_array(poll_fixture.section('Q', 'ranked', array['A', 'B'])))),
    'invalid:section.1.answer_type:value');
  perform poll_fixture.expect('Q02 one option for Pick one',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'T',
      'sections', jsonb_build_array(poll_fixture.section('Q', 'single', array['A'])))),
    'invalid:section.1.options:count');
  perform poll_fixture.expect('Q02 no option for Star rating',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'T',
      'sections', jsonb_build_array(poll_fixture.section('Q', 'stars', array[]::text[])))),
    'invalid:section.1.options:count');
  perform poll_fixture.expect('Q02 31 options',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'T',
      'sections', jsonb_build_array(poll_fixture.section('Q', 'multiple',
        (select array_agg('O' || g) from generate_series(1, 31) g))))),
    'invalid:section.1.options:count');
  perform poll_fixture.expect('Q02 long option name',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'T',
      'sections', jsonb_build_array(poll_fixture.section('Q', 'single', array['A', repeat('n', 121)])))),
    'invalid:section.1.option.2.name:length');
  perform poll_fixture.expect('Q02 duplicate names ignoring case and spaces',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'T',
      'sections', jsonb_build_array(poll_fixture.section('Q', 'single', array['Red', ' red '])))),
    'invalid:section.1.option.2.name:duplicate');
  perform poll_fixture.expect('Q02 the same name in two sections is fine',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'T', 'sections', jsonb_build_array(
      poll_fixture.section('Q1', 'single', array['Red', 'Blue']),
      poll_fixture.section('Q2', 'single', array['Red', 'Blue'])))),
    '{}');
  perform poll_fixture.expect('Q02 closing date in the past',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'T', 'closes_at', (now() - interval '1 hour')::text,
      'sections', v_ok)),
    'invalid:closes_at:past');
  -- An unchanged closing date that has since passed is kept (BR2.4).
  update public.polls set closes_at = now() - interval '1 hour' where id = v_poll;
  perform poll_fixture.expect('Q02 unchanged passed closing date',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'T',
      'closes_at', (select closes_at from public.polls where id = v_poll)::text, 'sections', v_ok)),
    '{}');
  raise notice 'ok Q02 refusals';
end $$;
rollback to savepoint fixture;

-- Q03 A name swap and a reorder in one save keep the ids and pass the deferred constraints (BR1.4) ----------
do $$
declare
  v_adm text := 'eeeeeeee-0000-0000-0000-0000000002a1';
  v_poll uuid := poll_fixture.new_poll('Swap');
  v_s1 uuid;
  v_s2 uuid;
  v_a uuid;
  v_b uuid;
  v_c uuid;
begin
  perform poll_fixture.expect('Q03 first save',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'Swap', 'sections', jsonb_build_array(
      poll_fixture.section('First', 'single', array['A', 'B']),
      poll_fixture.section('Second', 'stars', array['C'])))),
    '{}');
  select id into v_s1 from public.poll_sections where poll_id = v_poll and name = 'First';
  select id into v_s2 from public.poll_sections where poll_id = v_poll and name = 'Second';
  select id into v_a from public.poll_options where section_id = v_s1 and name = 'A';
  select id into v_b from public.poll_options where section_id = v_s1 and name = 'B';
  select id into v_c from public.poll_options where section_id = v_s2 and name = 'C';

  -- Sections reordered, A and B renamed to each other's names and reordered.
  perform poll_fixture.expect('Q03 swap save',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'Swap', 'sections', jsonb_build_array(
      jsonb_build_object('id', v_s2, 'name', 'Second', 'answer_type', 'stars',
        'options', jsonb_build_array(jsonb_build_object('id', v_c, 'name', 'C'))),
      jsonb_build_object('id', v_s1, 'name', 'First', 'answer_type', 'single',
        'options', jsonb_build_array(jsonb_build_object('id', v_a, 'name', 'B'), jsonb_build_object('id', v_b, 'name', 'A')))))),
    '{}');
  execute 'set constraints all immediate';
  execute 'set constraints all deferred';
  perform poll_fixture.expect('Q03 shape', poll_fixture.shape(v_poll), 'Second:stars:C;First:single:B|A');
  perform poll_fixture.expect('Q03 ids kept',
    (select string_agg(o.id::text, ',' order by o.position) from public.poll_options o where o.section_id = v_s1),
    v_a::text || ',' || v_b::text);
  perform poll_fixture.expect('Q03 one section per poll position',
    (select count(*)::int from public.poll_sections where poll_id = v_poll), 2);
  raise notice 'ok Q03 swap and reorder';
end $$;
rollback to savepoint fixture;

-- Q04 Removing rows returns the images no longer used; stale saves, foreign ids and bad paths are refused
--     (BR4.2, BR4.3, BR5.5, BR5.6) -------------------------------------------------------------------------
do $$
declare
  v_adm text := 'eeeeeeee-0000-0000-0000-0000000002a1';
  v_poll uuid := poll_fixture.new_poll('Images');
  v_other uuid := poll_fixture.new_poll('Other');
  v_payload jsonb;
  v_other_section uuid;
  v_other_option uuid;
  v_s uuid;
  v_keep uuid;
  v_stale timestamptz;
begin
  v_payload := jsonb_build_object('title', 'Images', 'sections', jsonb_build_array(
    jsonb_build_object('name', 'Q', 'answer_type', 'single', 'options', jsonb_build_array(
      jsonb_build_object('name', 'Keep', 'image_path', v_poll::text || '/keep-1.png'),
      jsonb_build_object('name', 'Drop', 'image_path', v_poll::text || '/drop-1.webp'),
      jsonb_build_object('name', 'Swap', 'image_path', v_poll::text || '/swap-1.jpg')))));
  perform poll_fixture.expect('Q04 first save', poll_fixture.save(v_adm, v_poll, v_payload), '{}');
  perform poll_fixture.expect('Q04 other poll', poll_fixture.save(v_adm, v_other, jsonb_build_object('title', 'Other',
    'sections', jsonb_build_array(poll_fixture.section('Q', 'single', array['X', 'Y'])))), '{}');
  select id into v_s from public.poll_sections where poll_id = v_poll;
  select id into v_keep from public.poll_options where section_id = v_s and name = 'Keep';
  select s.id, o.id into v_other_section, v_other_option
  from public.poll_sections s join public.poll_options o on o.section_id = s.id
  where s.poll_id = v_other limit 1;

  perform poll_fixture.expect('Q04 unused images returned',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'Images', 'sections', jsonb_build_array(
      jsonb_build_object('id', v_s, 'name', 'Q', 'answer_type', 'single', 'options', jsonb_build_array(
        jsonb_build_object('id', v_keep, 'name', 'Keep', 'image_path', v_poll::text || '/keep-1.png'),
        jsonb_build_object('name', 'Swap', 'image_path', v_poll::text || '/swap-2.jpg')))))),
    '{' || v_poll::text || '/drop-1.webp,' || v_poll::text || '/swap-1.jpg}');

  v_stale := (select updated_at from public.polls where id = v_poll) - interval '1 second';
  perform poll_fixture.expect('Q04 stale save',
    poll_fixture.err_as(v_adm, poll_fixture.save_sql(v_poll, v_stale, v_payload)), 'stale');
  perform poll_fixture.expect('Q04 foreign section id',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'Images', 'sections', jsonb_build_array(
      jsonb_build_object('id', v_other_section, 'name', 'Q', 'answer_type', 'single',
        'options', jsonb_build_array(jsonb_build_object('name', 'A'), jsonb_build_object('name', 'B')))))),
    'invalid:section.1.id:foreign');
  perform poll_fixture.expect('Q04 foreign option id',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'Images', 'sections', jsonb_build_array(
      jsonb_build_object('name', 'Q', 'answer_type', 'single',
        'options', jsonb_build_array(jsonb_build_object('id', v_other_option, 'name', 'A'), jsonb_build_object('name', 'B')))))),
    'invalid:section.1.option.1.id:foreign');
  perform poll_fixture.expect('Q04 image in another poll folder',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'Images', 'sections', jsonb_build_array(
      jsonb_build_object('name', 'Q', 'answer_type', 'single', 'options', jsonb_build_array(
        jsonb_build_object('name', 'A', 'image_path', v_other::text || '/a-1.png'), jsonb_build_object('name', 'B')))))),
    'invalid:section.1.option.1.image:path');
  perform poll_fixture.expect('Q04 image path with ..',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'Images', 'sections', jsonb_build_array(
      jsonb_build_object('name', 'Q', 'answer_type', 'single', 'options', jsonb_build_array(
        jsonb_build_object('name', 'A', 'image_path', v_poll::text || '/../x/a-1.png'), jsonb_build_object('name', 'B')))))),
    'invalid:section.1.option.1.image:path');
  perform poll_fixture.expect('Q04 image url instead of a path',
    poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'Images', 'sections', jsonb_build_array(
      jsonb_build_object('name', 'Q', 'answer_type', 'single', 'options', jsonb_build_array(
        jsonb_build_object('name', 'A', 'image_path', 'https://x.test/' || v_poll::text || '/a-1.png'),
        jsonb_build_object('name', 'B')))))),
    'invalid:section.1.option.1.image:path');
  perform poll_fixture.expect('Q04 unknown poll',
    poll_fixture.err_as(v_adm, poll_fixture.save_sql(gen_random_uuid(), now(), v_payload)), 'not_found');
  raise notice 'ok Q04 images, stale and foreign ids';
end $$;
rollback to savepoint fixture;

-- Q05 Staff, drivers and anon are refused on every function (BR5.1) ------------------------------------------
do $$
declare
  v_poll uuid := poll_fixture.new_poll('Locked');
  v_payload jsonb := jsonb_build_object('title', 'X', 'sections', jsonb_build_array(
    poll_fixture.section('Q', 'single', array['A', 'B'])));
  v_who text;
begin
  foreach v_who in array array['eeeeeeee-0000-0000-0000-0000000002a2', 'eeeeeeee-0000-0000-0000-0000000002a3'] loop
    perform poll_fixture.expect('Q05 create ' || v_who,
      poll_fixture.err_as(v_who, $q$select public.create_poll('X')$q$), 'not_allowed');
    perform poll_fixture.expect('Q05 save ' || v_who,
      poll_fixture.err_as(v_who, poll_fixture.save_sql(v_poll, (select updated_at from public.polls where id = v_poll), v_payload)),
      'not_allowed');
    perform poll_fixture.expect('Q05 post ' || v_who,
      poll_fixture.err_as(v_who, format('select public.set_poll_posted(%L, true)', v_poll)), 'not_allowed');
    perform poll_fixture.expect('Q05 delete ' || v_who,
      poll_fixture.err_as(v_who, format('select public.delete_poll(%L)', v_poll)), 'not_allowed');
  end loop;
  perform poll_fixture.expect('Q05 anon create',
    poll_fixture.state_as('anon', $q$select public.create_poll('X')$q$), '42501');
  perform poll_fixture.expect('Q05 anon save',
    poll_fixture.state_as('anon', poll_fixture.save_sql(v_poll, now(), v_payload)), '42501');
  perform poll_fixture.expect('Q05 anon post',
    poll_fixture.state_as('anon', format('select public.set_poll_posted(%L, true)', v_poll)), '42501');
  perform poll_fixture.expect('Q05 anon delete',
    poll_fixture.state_as('anon', format('select public.delete_poll(%L)', v_poll)), '42501');
  perform poll_fixture.expect('Q05 no direct writes',
    poll_fixture.state_as('eeeeeeee-0000-0000-0000-0000000002a1',
      $q$insert into public.polls (title) values ('Direct')$q$), '42501');
  perform poll_fixture.expect('Q05 poll unchanged',
    (select title || '/' || status from public.polls where id = v_poll), 'Locked/draft');
  raise notice 'ok Q05 refused callers';
end $$;
rollback to savepoint fixture;

-- Q06 Everyone reads posted polls only; full admins read drafts; nobody reads created_by (BR5.2) -------------
do $$
declare
  v_posted uuid := poll_fixture.new_poll('Posted');
  v_draft uuid := poll_fixture.new_poll('Draft');
  v_ids text;
  v_who text;
begin
  perform poll_fixture.save('eeeeeeee-0000-0000-0000-0000000002a1', v_posted, jsonb_build_object('title', 'Posted',
    'sections', jsonb_build_array(poll_fixture.section('Q', 'single', array['A', 'B']))));
  perform poll_fixture.save('eeeeeeee-0000-0000-0000-0000000002a1', v_draft, jsonb_build_object('title', 'Draft',
    'sections', jsonb_build_array(poll_fixture.section('Q', 'single', array['A', 'B']))));
  perform poll_fixture.expect('Q06 post',
    poll_fixture.err_as('eeeeeeee-0000-0000-0000-0000000002a1', format('select public.set_poll_posted(%L, true)', v_posted)),
    'ok');
  v_ids := format('(%L, %L)', v_posted, v_draft);

  foreach v_who in array array['anon', 'eeeeeeee-0000-0000-0000-0000000002a2', 'eeeeeeee-0000-0000-0000-0000000002a3'] loop
    perform poll_fixture.expect('Q06 polls ' || v_who,
      poll_fixture.val_as(v_who, 'select string_agg(title, '','' order by title) from public.polls where id in ' || v_ids),
      'Posted');
    perform poll_fixture.expect('Q06 sections ' || v_who,
      poll_fixture.val_as(v_who, 'select count(*)::text from public.poll_sections where poll_id in ' || v_ids), '1');
    perform poll_fixture.expect('Q06 options ' || v_who,
      poll_fixture.val_as(v_who, 'select count(*)::text from public.poll_options o join public.poll_sections s on s.id = o.section_id where s.poll_id in ' || v_ids),
      '2');
    perform poll_fixture.expect('Q06 created_by hidden ' || v_who,
      poll_fixture.state_as(v_who, 'select created_by from public.polls'), '42501');
  end loop;
  perform poll_fixture.expect('Q06 full admin reads drafts',
    poll_fixture.val_as('eeeeeeee-0000-0000-0000-0000000002a1',
      'select string_agg(title, '','' order by title) from public.polls where id in ' || v_ids),
    'Draft,Posted');
  perform poll_fixture.expect('Q06 full admin options',
    poll_fixture.val_as('eeeeeeee-0000-0000-0000-0000000002a1',
      'select count(*)::text from public.poll_options o join public.poll_sections s on s.id = o.section_id where s.poll_id in ' || v_ids),
    '4');
  perform poll_fixture.expect('Q06 created_by hidden from the admin too',
    poll_fixture.state_as('eeeeeeee-0000-0000-0000-0000000002a1', 'select created_by from public.polls'), '42501');
  raise notice 'ok Q06 reads';
end $$;
rollback to savepoint fixture;

-- Q07 Post stamps first_posted_at once, Unpost clears posted_at only, a passed closing date refuses Post
--     (BR2.2, BR2.3) ---------------------------------------------------------------------------------------
do $$
declare
  v_adm text := 'eeeeeeee-0000-0000-0000-0000000002a1';
  v_poll uuid := poll_fixture.new_poll('Lifecycle');
  v_empty uuid := poll_fixture.new_poll('Empty');
  v_first timestamptz := now() - interval '3 days';
begin
  perform poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'Lifecycle',
    'sections', jsonb_build_array(poll_fixture.section('Q', 'stars', array['A']))));
  perform poll_fixture.expect('Q07 post', poll_fixture.err_as(v_adm, format('select public.set_poll_posted(%L, true)', v_poll)), 'ok');
  perform poll_fixture.expect('Q07 posted row',
    (select status || '/' || (posted_at = now())::text || '/' || (first_posted_at = now())::text from public.polls where id = v_poll),
    'posted/true/true');
  perform poll_fixture.expect('Q07 post again changes nothing',
    poll_fixture.err_as(v_adm, format('select public.set_poll_posted(%L, true)', v_poll)), 'ok');
  perform poll_fixture.expect('Q07 unpost', poll_fixture.err_as(v_adm, format('select public.set_poll_posted(%L, false)', v_poll)), 'ok');
  perform poll_fixture.expect('Q07 unposted row',
    (select status || '/' || (posted_at is null)::text || '/' || (first_posted_at is not null)::text from public.polls where id = v_poll),
    'draft/true/true');
  -- Moved back so the second Post can show it keeps the first stamp.
  update public.polls set first_posted_at = v_first where id = v_poll;
  perform poll_fixture.expect('Q07 repost', poll_fixture.err_as(v_adm, format('select public.set_poll_posted(%L, true)', v_poll)), 'ok');
  perform poll_fixture.expect('Q07 first_posted_at kept',
    (select first_posted_at from public.polls where id = v_poll), v_first);
  perform poll_fixture.expect('Q07 unpost again', poll_fixture.err_as(v_adm, format('select public.set_poll_posted(%L, false)', v_poll)), 'ok');
  update public.polls set closes_at = now() - interval '1 minute' where id = v_poll;
  perform poll_fixture.expect('Q07 closing date passed',
    poll_fixture.err_as(v_adm, format('select public.set_poll_posted(%L, true)', v_poll)), 'closing_passed');
  perform poll_fixture.expect('Q07 still a draft', (select status from public.polls where id = v_poll), 'draft');
  perform poll_fixture.expect('Q07 a poll with no sections',
    poll_fixture.err_as(v_adm, format('select public.set_poll_posted(%L, true)', v_empty)), 'invalid:sections:count');
  perform poll_fixture.expect('Q07 unknown poll',
    poll_fixture.err_as(v_adm, format('select public.set_poll_posted(%L, true)', gen_random_uuid())), 'not_found');
  raise notice 'ok Q07 post and unpost';
end $$;
rollback to savepoint fixture;

-- Q08 Only a draft can be deleted, with its sections and options (BR2.5) ---------------------------------------
do $$
declare
  v_adm text := 'eeeeeeee-0000-0000-0000-0000000002a1';
  v_poll uuid := poll_fixture.new_poll('Delete me');
begin
  perform poll_fixture.save(v_adm, v_poll, jsonb_build_object('title', 'Delete me', 'sections', jsonb_build_array(
    poll_fixture.section('Q1', 'single', array['A', 'B']), poll_fixture.section('Q2', 'stars', array['C']))));
  perform poll_fixture.err_as(v_adm, format('select public.set_poll_posted(%L, true)', v_poll));
  perform poll_fixture.expect('Q08 posted refused',
    poll_fixture.err_as(v_adm, format('select public.delete_poll(%L)', v_poll)), 'posted_cannot_delete');
  perform poll_fixture.err_as(v_adm, format('select public.set_poll_posted(%L, false)', v_poll));
  perform poll_fixture.expect('Q08 draft deleted',
    poll_fixture.err_as(v_adm, format('select public.delete_poll(%L)', v_poll)), 'ok');
  perform poll_fixture.expect('Q08 rows gone',
    (select count(*)::int from public.polls where id = v_poll)
      + (select count(*)::int from public.poll_sections where poll_id = v_poll)
      + (select count(*)::int from public.poll_options o where not exists (
           select 1 from public.poll_sections s where s.id = o.section_id)),
    0);
  perform poll_fixture.expect('Q08 unknown poll',
    poll_fixture.err_as(v_adm, format('select public.delete_poll(%L)', v_poll)), 'not_found');
  raise notice 'ok Q08 delete';
end $$;
rollback to savepoint fixture;

-- Q09 The poll-images bucket: full admins write in a poll folder, Staff and drivers cannot (BR4.1, BR4.3) ----
do $$
declare
  v_folder text := 'aaaaaaaa-0000-0000-0000-0000000002a1';
begin
  perform poll_fixture.expect('Q09 bucket',
    (select public::text || '/' || file_size_limit::text || '/' || array_to_string(allowed_mime_types, ',')
     from storage.buckets where id = 'poll-images'),
    'true/5242880/image/png,image/jpeg,image/webp');
  perform poll_fixture.expect('Q09 admin upload',
    poll_fixture.state_as('eeeeeeee-0000-0000-0000-0000000002a1',
      format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'poll-images', v_folder || '/a-1.png')),
    'ok');
  perform poll_fixture.expect('Q09 admin upload outside a poll folder',
    poll_fixture.state_as('eeeeeeee-0000-0000-0000-0000000002a1',
      format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'poll-images', 'a-1.png')),
    '42501');
  perform poll_fixture.expect('Q09 staff upload',
    poll_fixture.state_as('eeeeeeee-0000-0000-0000-0000000002a2',
      format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'poll-images', v_folder || '/b-1.png')),
    '42501');
  perform poll_fixture.expect('Q09 driver upload',
    poll_fixture.state_as('eeeeeeee-0000-0000-0000-0000000002a3',
      format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'poll-images', v_folder || '/c-1.png')),
    '42501');
  perform poll_fixture.expect('Q09 staff list',
    poll_fixture.val_as('eeeeeeee-0000-0000-0000-0000000002a2',
      $q$select count(*)::text from storage.objects where bucket_id = 'poll-images'$q$),
    '0');
  perform poll_fixture.expect('Q09 admin list',
    poll_fixture.val_as('eeeeeeee-0000-0000-0000-0000000002a1',
      $q$select count(*)::text from storage.objects where bucket_id = 'poll-images'$q$),
    '1');
  raise notice 'ok Q09 bucket';
end $$;
rollback to savepoint fixture;

-- Q10 The vote lock stub, function settings and grants (BR5.1, BR5.3) -----------------------------------------
do $$
begin
  perform poll_fixture.expect('Q10 poll_has_votes', private.poll_has_votes(gen_random_uuid()), false);
  perform poll_fixture.expect('Q10 definer functions pin an empty search_path',
    (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
     from pg_proc p
     where p.oid in ('public.create_poll(text)'::regprocedure,
                     'public.save_poll(uuid, timestamptz, jsonb)'::regprocedure,
                     'public.set_poll_posted(uuid, boolean)'::regprocedure,
                     'public.delete_poll(uuid)'::regprocedure)),
    true);
  perform poll_fixture.expect('Q10 signed-in accounts can call the functions',
    has_function_privilege('authenticated', 'public.create_poll(text)', 'execute')
      and has_function_privilege('authenticated', 'public.save_poll(uuid, timestamptz, jsonb)', 'execute')
      and has_function_privilege('authenticated', 'public.set_poll_posted(uuid, boolean)', 'execute')
      and has_function_privilege('authenticated', 'public.delete_poll(uuid)', 'execute'),
    true);
  perform poll_fixture.expect('Q10 anon cannot',
    has_function_privilege('anon', 'public.create_poll(text)', 'execute')
      or has_function_privilege('anon', 'public.save_poll(uuid, timestamptz, jsonb)', 'execute')
      or has_function_privilege('anon', 'public.set_poll_posted(uuid, boolean)', 'execute')
      or has_function_privilege('anon', 'public.delete_poll(uuid)', 'execute'),
    false);
  perform poll_fixture.expect('Q10 helpers closed to clients',
    has_function_privilege('authenticated', 'private.poll_has_votes(uuid)', 'execute')
      or has_function_privilege('authenticated', 'private.poll_check_payload(uuid, jsonb, timestamptz)', 'execute')
      or has_function_privilege('anon', 'private.poll_structure(uuid)', 'execute'),
    false);
  perform poll_fixture.expect('Q10 no write grants on the tables',
    has_table_privilege('authenticated', 'public.polls', 'insert')
      or has_table_privilege('authenticated', 'public.poll_sections', 'update')
      or has_table_privilege('authenticated', 'public.poll_options', 'delete')
      or has_table_privilege('anon', 'public.polls', 'update'),
    false);
  raise notice 'ok Q10 settings and grants';
end $$;
rollback to savepoint fixture;

rollback;
