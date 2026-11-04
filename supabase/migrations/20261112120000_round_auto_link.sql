-- Link each round the results pipeline inserts to its calendar event, so it is listed and scored without
-- anyone opening Admin > Events.
--
-- What:
--   1. public.round_event_matches(subsession_ids): for each round, the one calendar event it belongs to, or a
--      code saying why there is none. A round matches an event when the event is in the round's season (its
--      season_id, else the one season whose name is the round's season_label), on the round's league-local
--      date (America/New_York, as Admin > Events compares them) and at a circuit whose name is the round's
--      track_name (case and outer spaces ignored). Holiday and iRacing events never match. Codes:
--        linked          the round already has an event (event_id is that event)
--        match           exactly one free event matches and no other unlinked round matches it (event_id set)
--        no_round        no such round
--        no_season       no season_id, and season_label names no season (or several)
--        no_event        no event in that season on that date at that circuit
--        event_taken     every matching event already has a round (or is pinned to another round)
--        several_events  more than one free event matches
--        several_rounds  another unlinked round matches the same event, e.g. two splits on one night
--        season_locked   the match is in a season whose standings are locked
--   2. A trigger on curated_rounds inserts: every new round with a positive subsession_id (a real iRacing
--      round; the CSV importer's negative ids pick their own event) and no event, whose code is 'match', gets
--      what Admin > Events' Link button gives it: season_id and season_label from the event's season, the
--      event_id, the event's layout and format where the round has none, and the exhibition or test flag for
--      those event categories. Setting season_id fires the existing scoring trigger, which scores the round.
--      Anything else is left unlinked, and Admin > Events lists it under Orphaned Rounds with the code's reason.
--
-- Why: the pipeline inserts rounds with only season_label set. Such a round is hidden from Results and is not
-- scored until someone links it by hand, which five ATC18 rounds needed (Oulton, CTMP, Road America, Portland,
-- Sonoma; see supabase/data-fixes/). Matching lives in the database because the pipeline writes straight to
-- the table with the service role and never calls the site.
--
-- Never guesses: two candidate events, or two new rounds for one event, leave every one of them unlinked.
-- A locked season is skipped because scoring into it raises SC001, which would fail the pipeline's insert;
-- any other error linking one round is caught and leaves that round unlinked, so the insert always succeeds.
--
-- Expand only: one new function, one new private function and one new trigger; nothing on main changes
-- behaviour except that new rounds arrive linked. Undo with
-- supabase/down/20261112120000_round_auto_link.down.sql.

-- 1. Matching ----------------------------------------------------------------------------------------------

create function public.round_event_matches(p_subsession_ids bigint[])
  returns table (subsession_id bigint, event_id uuid, reason text)
  language sql stable
  set search_path = ''
  as $$
  with unlinked as (
    select cr.subsession_id as sid,
           cr.track_name,
           (cr.start_time at time zone 'America/New_York')::date as local_date,
           coalesce(
             cr.season_id,
             (select (array_agg(s.id))[1]
                from public.seasons s
               where lower(btrim(s.name)) = lower(btrim(cr.season_label))
              having count(*) = 1)
           ) as season_id
    from public.curated_rounds cr
    where cr.event_id is null
  ),
  candidates as (
    select u.sid,
           e.id as eid,
           (exists (select 1 from public.curated_rounds x where x.event_id = e.id)
            or (e.subsession_id is not null and e.subsession_id <> u.sid)) as taken
    from unlinked u
    join public.events e
      on e.season_id = u.season_id
     and e.event_date = u.local_date
     and e.category not in ('holiday', 'iracing')
    join public.circuits c
      on c.id = e.circuit_id
     and lower(btrim(c.name)) = lower(btrim(u.track_name))
  ),
  free as (
    select c.sid, c.eid from candidates c where not c.taken
  ),
  per_round as (
    select u.sid,
           u.season_id,
           (select count(*) from candidates c where c.sid = u.sid) as n_all,
           (select count(*) from free f where f.sid = u.sid) as n_free,
           (select (array_agg(f.eid))[1] from free f where f.sid = u.sid) as only_eid
    from unlinked u
  ),
  decided as (
    select ids.id as sid,
           cr.event_id as linked_eid,
           p.only_eid,
           case
             when cr.subsession_id is null then 'no_round'
             when cr.event_id is not null then 'linked'
             when p.season_id is null then 'no_season'
             when p.n_all = 0 then 'no_event'
             when p.n_free = 0 then 'event_taken'
             when p.n_free > 1 then 'several_events'
             when (select count(*) from free f where f.eid = p.only_eid) > 1 then 'several_rounds'
             when (select s.standings_locked_at from public.seasons s where s.id = p.season_id) is not null
               then 'season_locked'
             else 'match'
           end as code
    from unnest(p_subsession_ids) as ids(id)
    left join public.curated_rounds cr on cr.subsession_id = ids.id
    left join per_round p on p.sid = ids.id
  )
  select d.sid,
         case d.code when 'linked' then d.linked_eid when 'match' then d.only_eid end,
         d.code
  from decided d;
$$;

comment on function public.round_event_matches(bigint[]) is
  'For each round: its calendar event (linked, or the one unambiguous match) or why there is none. Used by the curated_rounds auto-link trigger and Admin > Events.';

-- Reads only public tables anyone can already read; returns ids and codes, no names.
revoke all on function public.round_event_matches(bigint[]) from public, anon, authenticated, service_role;
grant execute on function public.round_event_matches(bigint[]) to anon, authenticated, service_role;

-- 2. Auto-link on insert -----------------------------------------------------------------------------------

create function private.curated_rounds_auto_link() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  m record;
begin
  for m in
    select x.subsession_id, e.id as event_id, e.season_id, s.name as season_name, e.layout, e.format, e.category
    from public.round_event_matches(
           array(select n.subsession_id from new_rows n where n.subsession_id > 0 and n.event_id is null)
         ) x
    join public.events e on e.id = x.event_id
    join public.seasons s on s.id = e.season_id
    where x.reason = 'match'
  loop
    begin
      -- The flag first, so the rescore the update below triggers already sees it (same flags as the picker).
      if m.category = 'exhibition' then
        insert into public.round_overrides as o (subsession_id, is_exhibition) values (m.subsession_id, true)
        on conflict (subsession_id) do update set is_exhibition = true;
      elsif m.category = 'test' then
        insert into public.round_overrides as o (subsession_id, is_test) values (m.subsession_id, true)
        on conflict (subsession_id) do update set is_test = true;
      end if;

      update public.curated_rounds cr
         set season_id = m.season_id,
             season_label = m.season_name,
             event_id = m.event_id,
             layout = coalesce(cr.layout, m.layout),
             format = coalesce(cr.format, case when m.format in ('sprint', 'endurance') then m.format end)
       where cr.subsession_id = m.subsession_id
         and cr.event_id is null;
    exception when others then
      -- Leave this round unlinked (Admin > Events lists it); never fail the pipeline's insert.
      raise warning 'round % not auto-linked to event %: %', m.subsession_id, m.event_id, sqlerrm;
    end;
  end loop;
  return null;
end;
$$;

comment on function private.curated_rounds_auto_link() is
  'After a curated_rounds insert: links each new real round with one unambiguous calendar event (public.round_event_matches) and lets the scoring trigger score it.';

revoke all on function private.curated_rounds_auto_link() from public, anon, authenticated, service_role;

-- Named to sort before scoring_on_curated_rounds_insert, so the round is linked before that trigger runs.
create trigger curated_rounds_auto_link after insert on public.curated_rounds
  referencing new table as new_rows for each statement execute function private.curated_rounds_auto_link();
