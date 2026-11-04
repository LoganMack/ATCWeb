-- Round auto-link fixtures for 20261112120000_round_auto_link.sql, cases K01-K14: a round the results
-- pipeline inserts is linked to its one calendar event (season, event, layout, format, exhibition/test
-- flag) and scored; any doubt leaves it unlinked with a reason from public.round_event_matches().
--
-- Runs against an empty database rebuilt from supabase/migrations/ (CI job migrations-rebuild), after
-- incident-clips-fixtures.sql:
--   psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/round-auto-link-fixtures.sql
--
-- Same conventions as the other fixtures (supabase/checks/README.md): every assertion calls
-- autolink_fixture.expect(), which raises naming the case; one transaction, rolled back at the end; each
-- case runs after `savepoint fixture` and is undone with `rollback to savepoint fixture`.
--
-- Base data: seasons Za Season (no scoring ruleset, so a linked round is recorded in scoring_issues as
-- having no ruleset rather than no season) and Zb Season (no events); circuits Za Park and Zb Ring; events
-- E1 (Za Park, 2026-06-01, Za Season R1, layout Grand Prix, endurance) and E2 (Zb Ring, 2026-06-08, Za
-- Season R2, layout North, special). Round start times are UTC; 2026-06-02 00:30Z is 2026-06-01 evening in
-- the league's time zone (America/New_York).

begin;

set local client_min_messages = notice;

create schema autolink_fixture;

create function autolink_fixture.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void
  language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'round auto-link fixture failed: %: expected [%], got [%]', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- The code round_event_matches() gives one round.
create function autolink_fixture.code(p_subsession_id bigint) returns text
  language sql as $$
  select m.reason from public.round_event_matches(array[p_subsession_id]) m;
$$;

-- season_label|season set?|event set?|layout|format of one round, compactly.
create function autolink_fixture.round(p_subsession_id bigint) returns text
  language sql as $$
  select concat_ws('|', cr.season_label, (cr.season_id is not null)::text, coalesce(cr.event_id::text, '-'),
                   coalesce(cr.layout, '-'), coalesce(cr.format, '-'))
  from public.curated_rounds cr where cr.subsession_id = p_subsession_id;
$$;

insert into public.seasons (id, number, name) values
  ('aaaaaaaa-0000-0000-0000-00000000a001', 9951, 'Za Season'),
  ('aaaaaaaa-0000-0000-0000-00000000a002', 9952, 'Zb Season');

insert into public.circuits (id, name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'Za Park'),
  ('aaaaaaaa-0000-0000-0000-00000000c002', 'Zb Ring');

insert into public.events (id, circuit_id, layout, event_date, format, category, season_id, round_number) values
  ('aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-00000000c001', 'Grand Prix', '2026-06-01',
   'endurance', 'championship', 'aaaaaaaa-0000-0000-0000-00000000a001', 1),
  ('aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-00000000c002', 'North', '2026-06-08',
   'special', 'championship', 'aaaaaaaa-0000-0000-0000-00000000a001', 2);

savepoint fixture;

-- K01 A pipeline round with only season_label, inserted the evening of the event (next day in UTC), is
--     linked to E1: season, label, event, the event's layout and format, and the scoring trigger ran on it
--     with its season (the issue it records is the missing ruleset, not a missing season).
insert into public.curated_rounds (subsession_id, start_time, track_name, season_label)
values (9950001, '2026-06-02 00:30+00', 'Za Park', 'Za Season');
do $$
begin
  perform autolink_fixture.expect('K01 round',
    autolink_fixture.round(9950001),
    'Za Season|true|aaaaaaaa-0000-0000-0000-00000000e001|Grand Prix|endurance');
  perform autolink_fixture.expect('K01 code', autolink_fixture.code(9950001), 'linked');
  perform autolink_fixture.expect('K01 scored with its season',
    (select si.message from public.scoring_issues si where si.subsession_id = 9950001),
    'Season aaaaaaaa-0000-0000-0000-00000000a001 has no scoring ruleset');
  raise notice 'ok K01 single match is linked and scored';
end $$;
rollback to savepoint fixture;

-- K02 Track and label match without regard to case or outer spaces; the round keeps its own layout and
--     format; a 'special' event format is never copied.
insert into public.curated_rounds (subsession_id, start_time, track_name, season_label, layout, format)
values (9950002, '2026-06-01 23:00+00', '  ZA PARK ', 'za season', 'Club', 'sprint'),
       (9950003, '2026-06-08 23:00+00', 'Zb Ring', 'Za Season', null, null);
do $$
begin
  perform autolink_fixture.expect('K02 own layout and format',
    autolink_fixture.round(9950002), 'Za Season|true|aaaaaaaa-0000-0000-0000-00000000e001|Club|sprint');
  perform autolink_fixture.expect('K02 special format not copied',
    autolink_fixture.round(9950003), 'Za Season|true|aaaaaaaa-0000-0000-0000-00000000e002|North|-');
  raise notice 'ok K02 case-insensitive match, own values kept';
end $$;
rollback to savepoint fixture;

-- K03 A round that already has season_id (and no label) matches through that season.
insert into public.curated_rounds (subsession_id, start_time, track_name, season_id)
values (9950004, '2026-06-01 23:00+00', 'Za Park', 'aaaaaaaa-0000-0000-0000-00000000a001');
do $$
begin
  perform autolink_fixture.expect('K03 round',
    autolink_fixture.round(9950004), 'Za Season|true|aaaaaaaa-0000-0000-0000-00000000e001|Grand Prix|endurance');
  raise notice 'ok K03 season_id without a label';
end $$;
rollback to savepoint fixture;

-- K04 A label that names no season, and a label for a season with no such event, stay unlinked.
insert into public.curated_rounds (subsession_id, start_time, track_name, season_label)
values (9950005, '2026-06-01 23:00+00', 'Za Park', 'Nobody Season'),
       (9950006, '2026-06-01 23:00+00', 'Za Park', 'Zb Season');
do $$
begin
  perform autolink_fixture.expect('K04 unknown label', autolink_fixture.round(9950005), 'Nobody Season|false|-|-|-');
  perform autolink_fixture.expect('K04 unknown label code', autolink_fixture.code(9950005), 'no_season');
  perform autolink_fixture.expect('K04 other season', autolink_fixture.round(9950006), 'Zb Season|false|-|-|-');
  perform autolink_fixture.expect('K04 other season code', autolink_fixture.code(9950006), 'no_event');
  raise notice 'ok K04 no season, no event in that season';
end $$;
rollback to savepoint fixture;

-- K05 The date is the league-local one: 2026-06-01 03:00Z is still 31 May in New York, so no event; and a
--     different track on the right date does not match.
insert into public.curated_rounds (subsession_id, start_time, track_name, season_label)
values (9950007, '2026-06-01 03:00+00', 'Za Park', 'Za Season'),
       (9950008, '2026-06-01 23:00+00', 'Zb Ring', 'Za Season');
do $$
begin
  perform autolink_fixture.expect('K05 local date', autolink_fixture.code(9950007), 'no_event');
  perform autolink_fixture.expect('K05 other track', autolink_fixture.code(9950008), 'no_event');
  perform autolink_fixture.expect('K05 left unlinked',
    (select count(*) from public.curated_rounds where subsession_id in (9950007, 9950008) and event_id is null), 2::bigint);
  raise notice 'ok K05 league-local date and track must both match';
end $$;
rollback to savepoint fixture;

-- K06 Two events on the same circuit, date and season: no guess.
insert into public.events (id, circuit_id, event_date, format, category, season_id, round_number) values
  ('aaaaaaaa-0000-0000-0000-00000000e003', 'aaaaaaaa-0000-0000-0000-00000000c001', '2026-06-01', 'sprint',
   'championship', 'aaaaaaaa-0000-0000-0000-00000000a001', 3);
insert into public.curated_rounds (subsession_id, start_time, track_name, season_label)
values (9950009, '2026-06-01 23:00+00', 'Za Park', 'Za Season');
do $$
begin
  perform autolink_fixture.expect('K06 round', autolink_fixture.round(9950009), 'Za Season|false|-|-|-');
  perform autolink_fixture.expect('K06 code', autolink_fixture.code(9950009), 'several_events');
  raise notice 'ok K06 two candidate events';
end $$;
rollback to savepoint fixture;

-- K07 Two rounds for one event in a single insert (two splits): neither is linked. A later round for an
--     event another round already has is not linked either.
insert into public.curated_rounds (subsession_id, start_time, track_name, season_label)
values (9950010, '2026-06-01 23:00+00', 'Za Park', 'Za Season'),
       (9950011, '2026-06-01 23:15+00', 'Za Park', 'Za Season');
do $$
begin
  perform autolink_fixture.expect('K07 both unlinked',
    (select count(*) from public.curated_rounds where subsession_id in (9950010, 9950011) and event_id is null), 2::bigint);
  perform autolink_fixture.expect('K07 code', autolink_fixture.code(9950010), 'several_rounds');
end $$;
-- An admin links one of them; the other is then told the event is taken.
update public.curated_rounds set event_id = 'aaaaaaaa-0000-0000-0000-00000000e001' where subsession_id = 9950010;
insert into public.curated_rounds (subsession_id, start_time, track_name, season_label)
values (9950012, '2026-06-02 00:00+00', 'Za Park', 'Za Season');
do $$
begin
  perform autolink_fixture.expect('K07 sibling code', autolink_fixture.code(9950011), 'event_taken');
  perform autolink_fixture.expect('K07 later round', autolink_fixture.round(9950012), 'Za Season|false|-|-|-');
  perform autolink_fixture.expect('K07 later code', autolink_fixture.code(9950012), 'event_taken');
  raise notice 'ok K07 two rounds for one event, event already taken';
end $$;
rollback to savepoint fixture;

-- K08 An event pinned to another round (events.subsession_id) is taken; pinned to this round, it matches.
--     events.subsession_id references curated_rounds, so a pin needs its round to exist first. The pinned
--     rounds are CSV rounds (negative ids), which the trigger leaves alone.
insert into public.curated_rounds (subsession_id, start_time, track_name, season_label)
values (-9959999, '2026-05-01 23:00+00', 'Za Park', 'Za Season'),
       (-9950014, '2026-06-08 23:00+00', 'Zb Ring', 'Za Season');
update public.events set subsession_id = -9959999 where id = 'aaaaaaaa-0000-0000-0000-00000000e001';
update public.events set subsession_id = -9950014 where id = 'aaaaaaaa-0000-0000-0000-00000000e002';
insert into public.curated_rounds (subsession_id, start_time, track_name, season_label)
values (9950013, '2026-06-01 23:00+00', 'Za Park', 'Za Season');
do $$
begin
  perform autolink_fixture.expect('K08 pinned elsewhere', autolink_fixture.round(9950013), 'Za Season|false|-|-|-');
  perform autolink_fixture.expect('K08 pinned elsewhere code', autolink_fixture.code(9950013), 'event_taken');
  perform autolink_fixture.expect('K08 pinned here', autolink_fixture.code(-9950014), 'match');
  perform autolink_fixture.expect('K08 pinned here event',
    (select m.event_id from public.round_event_matches(array[-9950014::bigint]) m),
    'aaaaaaaa-0000-0000-0000-00000000e002'::uuid);
  raise notice 'ok K08 pinned events';
end $$;
rollback to savepoint fixture;

-- K09 A season with locked standings is skipped (scoring into it would raise SC001), and the insert
--     still succeeds.
update public.seasons set standings_locked_at = now() where id = 'aaaaaaaa-0000-0000-0000-00000000a001';
insert into public.curated_rounds (subsession_id, start_time, track_name, season_label)
values (9950015, '2026-06-01 23:00+00', 'Za Park', 'Za Season');
do $$
begin
  perform autolink_fixture.expect('K09 round', autolink_fixture.round(9950015), 'Za Season|false|-|-|-');
  perform autolink_fixture.expect('K09 code', autolink_fixture.code(9950015), 'season_locked');
  raise notice 'ok K09 locked season left alone';
end $$;
rollback to savepoint fixture;

-- K10 Exhibition and test events flag the round as the Link button does.
update public.events set category = 'exhibition' where id = 'aaaaaaaa-0000-0000-0000-00000000e001';
update public.events set category = 'test' where id = 'aaaaaaaa-0000-0000-0000-00000000e002';
insert into public.curated_rounds (subsession_id, start_time, track_name, season_label)
values (9950016, '2026-06-01 23:00+00', 'Za Park', 'Za Season'),
       (9950017, '2026-06-08 23:00+00', 'Zb Ring', 'Za Season');
do $$
begin
  perform autolink_fixture.expect('K10 exhibition flag',
    (select o.is_exhibition from public.round_overrides o where o.subsession_id = 9950016), true);
  perform autolink_fixture.expect('K10 test flag',
    (select o.is_test from public.round_overrides o where o.subsession_id = 9950017), true);
  perform autolink_fixture.expect('K10 linked',
    (select count(*) from public.curated_rounds where subsession_id in (9950016, 9950017) and event_id is not null), 2::bigint);
  raise notice 'ok K10 exhibition and test flags';
end $$;
rollback to savepoint fixture;

-- K11 CSV-imported rounds (negative ids) are never auto-linked, though the matcher reports the match.
insert into public.curated_rounds (subsession_id, start_time, track_name, season_label)
values (-9950018, '2026-06-01 23:00+00', 'Za Park', 'Za Season');
do $$
begin
  perform autolink_fixture.expect('K11 round', autolink_fixture.round(-9950018), 'Za Season|false|-|-|-');
  perform autolink_fixture.expect('K11 code', autolink_fixture.code(-9950018), 'match');
  perform autolink_fixture.expect('K11 event',
    (select m.event_id from public.round_event_matches(array[-9950018::bigint]) m),
    'aaaaaaaa-0000-0000-0000-00000000e001'::uuid);
  raise notice 'ok K11 manual imports untouched';
end $$;
rollback to savepoint fixture;

-- K12 A round inserted with its own event keeps it; an unknown id reports no_round; one row per id asked.
insert into public.curated_rounds (subsession_id, start_time, track_name, season_label, event_id)
values (9950019, '2026-06-01 23:00+00', 'Za Park', 'Za Season', 'aaaaaaaa-0000-0000-0000-00000000e002');
do $$
begin
  perform autolink_fixture.expect('K12 own event kept',
    autolink_fixture.round(9950019), 'Za Season|false|aaaaaaaa-0000-0000-0000-00000000e002|-|-');
  perform autolink_fixture.expect('K12 codes',
    (select string_agg(m.subsession_id || '=' || m.reason, ',' order by m.subsession_id)
       from public.round_event_matches(array[9950019, 9950099]::bigint[]) m),
    '9950019=linked,9950099=no_round');
  raise notice 'ok K12 already linked, unknown round';
end $$;
rollback to savepoint fixture;

-- K13 An upsert that updates an existing round does not link it (only inserts do); the admin picker does.
insert into public.curated_rounds (subsession_id, start_time, track_name, season_label)
values (9950020, '2026-06-01 03:00+00', 'Za Park', 'Za Season');
insert into public.curated_rounds (subsession_id, start_time, track_name, season_label)
values (9950020, '2026-06-01 23:00+00', 'Za Park', 'Za Season')
on conflict (subsession_id) do update set start_time = excluded.start_time;
do $$
begin
  perform autolink_fixture.expect('K13 round', autolink_fixture.round(9950020), 'Za Season|false|-|-|-');
  perform autolink_fixture.expect('K13 code now', autolink_fixture.code(9950020), 'match');
  raise notice 'ok K13 updates are not auto-linked';
end $$;
rollback to savepoint fixture;

-- K14 Grants: anon and signed-in callers may run the matcher (ids and codes only); nobody may call the
--     trigger function directly.
do $$
begin
  perform autolink_fixture.expect('K14 anon matcher',
    has_function_privilege('anon', 'public.round_event_matches(bigint[])', 'execute'), true);
  perform autolink_fixture.expect('K14 authenticated trigger fn',
    has_function_privilege('authenticated', 'private.curated_rounds_auto_link()', 'execute'), false);
  perform autolink_fixture.expect('K14 service_role trigger fn',
    has_function_privilege('service_role', 'private.curated_rounds_auto_link()', 'execute'), false);
  perform autolink_fixture.expect('K14 definer',
    (select p.prosecdef from pg_proc p where p.oid = 'private.curated_rounds_auto_link()'::regprocedure), true);
  raise notice 'ok K14 grants';
end $$;
rollback to savepoint fixture;

rollback;
