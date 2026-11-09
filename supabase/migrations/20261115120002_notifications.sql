-- In-site notifications: the bell in the nav and its popup (notifications unit U3; FR2.1-FR2.12, NFR1-NFR4,
-- NFR6; rules BR2.1, BR4.1-BR4.7, BR5.1, BR5.2; ADR-001 to ADR-004, ADR-006, ADR-010).
--
-- What:
--   1. public.notifications: one row per account and notification, holding references only (a round, an
--      appeal or a poll), never text or names. Kinds: 1 results posted, 2 incident report posted, 3 appeals
--      open, 4 incident submissions open, 5 appeal closed, 6 schedule vote open. unique (user_id, dedupe_key)
--      gives each account each notification once (dedupe_key = kind:subsession_id for 1-4, 5:appeal_id,
--      6:poll_id), and every insert is on conflict do nothing.
--   2. Row Level Security: an account reads only its own rows. Nobody writes from the site: there are no
--      insert, update or delete grants, and rows are marked read only through open_my_notifications().
--   3. private.notify_round_participants(): kinds for every account whose driver raced in a round.
--   4. Five AFTER triggers fill the table:
--        curated_rounds        insert or update of season_id   kinds 1 and 4 when a round first gets a season
--        curated_race_results  insert, per statement           kinds 1 and 4 for results added to a linked
--                                                              round (the CSV import inserts the round linked
--                                                              and adds its results afterwards)
--        round_incident_status insert or update                kinds 2 and 3 on the first post (first_posted_at,
--                                                              the same test as the report-posted email)
--        incident_appeals      update of closed_at             kind 5 to the filer when Close Appeal runs
--        polls                 insert or update                kind 6 to every driver-linked account when a
--                                                              schedule-vote poll becomes posted
--   5. public.notification_unread_count() and public.open_my_notifications() for the site, SECURITY DEFINER
--      with an empty search_path, executable by authenticated only. open_my_notifications() is one statement:
--      it returns the caller's 50 newest rows, marks only those read, and returns the unread count left, so
--      a row committed meanwhile, or unread beyond the 50 shown, keeps the dot.
--
-- Why in the database: who receives what, and who may read or mark a row, are access and business rules
-- (team rule), and the events are written by the pipeline, the CSV import and admins through several paths.
-- Each trigger wraps its work in its own exception block and raises a warning, so a failed notification
-- never blocks the event that fired it (BR4.6). Only events after this migration notify: no backfill.
--
-- Expand only: one new table, new functions and new triggers beside the existing ones; nothing existing
-- changes, so the code on main keeps working. Undo with supabase/down/20261115120002_notifications.down.sql.

-- 1. The table (BR4.7; entities.md Notification) ------------------------------------------------------------

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind integer not null,
  subsession_id bigint references public.curated_rounds (subsession_id) on delete cascade,
  appeal_id uuid references public.incident_appeals (id) on delete cascade,
  poll_id uuid references public.polls (id) on delete cascade,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint notifications_kind_check check (kind between 1 and 6),
  constraint notifications_refs_check check (
    (kind between 1 and 4 and subsession_id is not null and appeal_id is null and poll_id is null)
    or (kind = 5 and subsession_id is not null and appeal_id is not null and poll_id is null)
    or (kind = 6 and subsession_id is null and appeal_id is null and poll_id is not null)
  ),
  constraint notifications_user_dedupe_key unique (user_id, dedupe_key)
);

comment on table public.notifications is
  'In-site notifications (U3): references only, never text or names. Filled by triggers; read by the owner; '
  'marked read only through open_my_notifications(). No retention limit for now.';
comment on column public.notifications.dedupe_key is
  'kind:subsession_id for kinds 1-4, 5:appeal_id, 6:poll_id; unique per user_id, so nobody gets one twice.';

-- The unread count, the popup list, and one index per cascading foreign key, so deleting a round, appeal
-- or poll does not scan the table.
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;
create index notifications_list_idx on public.notifications (user_id, created_at desc, kind, id);
create index notifications_subsession_id_idx on public.notifications (subsession_id) where subsession_id is not null;
create index notifications_appeal_id_idx on public.notifications (appeal_id) where appeal_id is not null;
create index notifications_poll_id_idx on public.notifications (poll_id) where poll_id is not null;

-- 2. Access (BR5.1) ------------------------------------------------------------------------------------------

alter table public.notifications enable row level security;

create policy notifications_select_own on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Supabase grants every new public table to anon and authenticated by default, so start from nothing.
revoke all on table public.notifications from public, anon, authenticated;
grant select on table public.notifications to authenticated;

-- 3. Recipients (entities.md "Who is a recipient") -------------------------------------------------------------

-- Every account whose driver has a result row in the round, once each, through the same join the
-- report-posted email uses. Unlike the emails there is no opt-in.
create function private.notify_round_participants(p_subsession_id bigint, p_kinds integer[]) returns void
  language sql security definer
  set search_path = ''
  as $$
  insert into public.notifications (user_id, kind, subsession_id, dedupe_key)
  select rp.profile_id, k.kind, p_subsession_id, k.kind || ':' || p_subsession_id
  from (
    select distinct p.id as profile_id
    from public.curated_race_results r
    join public.drivers d on d.iracing_cust_id = r.cust_id
    join public.profiles p on p.driver_id = d.id
    where r.subsession_id = p_subsession_id
  ) rp
  cross join unnest(p_kinds) as k (kind)
  on conflict (user_id, dedupe_key) do nothing;
$$;

comment on function private.notify_round_participants(bigint, integer[]) is
  'Inserts the given kinds for every account whose driver raced in the round (U3); repeats are skipped.';

revoke all on function private.notify_round_participants(bigint, integer[])
  from public, anon, authenticated, service_role;

-- 4. Triggers (BR4.1-BR4.6) ----------------------------------------------------------------------------------

-- BR4.1: kinds 1 and 4 when a round first gets a season, on insert (a round born linked) or update.
create function private.notify_round_linked() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  if new.season_id is null or (tg_op = 'UPDATE' and old.season_id is not null) then
    return null;
  end if;
  begin
    perform private.notify_round_participants(new.subsession_id, array[1, 4]);
  exception when others then
    raise warning 'notifications for linked round % were not created: %', new.subsession_id, sqlerrm;
  end;
  return null;
end;
$$;

-- BR4.2: results added to a round that already has a season notify those drivers' accounts. Per statement,
-- so a bulk insert is one pass; the CSV import's row-by-row inserts repeat, and the dedupe key absorbs that.
create function private.notify_results_added() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  begin
    insert into public.notifications (user_id, kind, subsession_id, dedupe_key)
    select rp.profile_id, k.kind, rp.subsession_id, k.kind || ':' || rp.subsession_id
    from (
      select distinct n.subsession_id, p.id as profile_id
      from new_rows n
      join public.curated_rounds cr on cr.subsession_id = n.subsession_id and cr.season_id is not null
      join public.drivers d on d.iracing_cust_id = n.cust_id
      join public.profiles p on p.driver_id = d.id
    ) rp
    cross join unnest(array[1, 4]) as k (kind)
    on conflict (user_id, dedupe_key) do nothing;
  exception when others then
    raise warning 'notifications for added results were not created: %', sqlerrm;
  end;
  return null;
end;
$$;

-- BR4.3: kinds 2 and 3 the first time a round's report is posted, so a re-post sends nothing.
create function private.notify_report_posted() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  if not ((tg_op = 'INSERT' and new.first_posted_at is not null)
          or (tg_op = 'UPDATE' and old.first_posted_at is null and new.first_posted_at is not null)) then
    return null;
  end if;
  begin
    perform private.notify_round_participants(new.subsession_id, array[2, 3]);
  exception when others then
    raise warning 'notifications for posted report % were not created: %', new.subsession_id, sqlerrm;
  end;
  return null;
end;
$$;

-- BR4.4: kind 5 to the filer when Close Appeal sets closed_at. A dismissal never sets it, so sends nothing.
create function private.notify_appeal_closed() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  if old.closed_at is not null or new.closed_at is null or new.submitter_id is null then
    return null;
  end if;
  begin
    insert into public.notifications (user_id, kind, subsession_id, appeal_id, dedupe_key)
    select p.id, 5, new.subsession_id, new.id, '5:' || new.id
    from public.profiles p
    where p.id = new.submitter_id
    on conflict (user_id, dedupe_key) do nothing;
  exception when others then
    raise warning 'notification for closed appeal % was not created: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

-- BR4.5: kind 6 to every driver-linked account when a schedule-vote poll becomes posted. Unposting and
-- posting again inserts nothing new (the dedupe key is per poll).
create function private.notify_schedule_vote() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  if not (new.status = 'posted' and new.is_schedule_vote
          and (tg_op = 'INSERT' or old.status is distinct from 'posted' or not old.is_schedule_vote)) then
    return null;
  end if;
  begin
    insert into public.notifications (user_id, kind, poll_id, dedupe_key)
    select p.id, 6, new.id, '6:' || new.id
    from public.profiles p
    where p.driver_id is not null
    on conflict (user_id, dedupe_key) do nothing;
  exception when others then
    raise warning 'notifications for schedule vote % were not created: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function private.notify_round_linked() from public, anon, authenticated, service_role;
revoke all on function private.notify_results_added() from public, anon, authenticated, service_role;
revoke all on function private.notify_report_posted() from public, anon, authenticated, service_role;
revoke all on function private.notify_appeal_closed() from public, anon, authenticated, service_role;
revoke all on function private.notify_schedule_vote() from public, anon, authenticated, service_role;

create trigger curated_rounds_notify_linked
  after insert or update of season_id on public.curated_rounds
  for each row execute function private.notify_round_linked();

create trigger curated_race_results_notify_results
  after insert on public.curated_race_results
  referencing new table as new_rows
  for each statement execute function private.notify_results_added();

create trigger round_incident_status_notify_posted
  after insert or update on public.round_incident_status
  for each row execute function private.notify_report_posted();

create trigger incident_appeals_notify_closed
  after update of closed_at on public.incident_appeals
  for each row execute function private.notify_appeal_closed();

create trigger polls_notify_schedule_vote
  after insert or update on public.polls
  for each row execute function private.notify_schedule_vote();

-- 5. Functions for the site (BR1.2, BR2.1, BR5.1) --------------------------------------------------------------

-- The bell's dot: a count over the partial unread index.
create function public.notification_unread_count() returns integer
  language sql stable security definer
  set search_path = ''
  as $$
  select count(*)::integer
  from public.notifications n
  where n.user_id = (select auth.uid()) and n.read_at is null;
$$;

comment on function public.notification_unread_count() is
  'The caller''s unread notifications (U3, BR1.2).';

-- Opening the popup (BR2.1). One statement, so every part sees one snapshot: shown is the caller's 50
-- newest rows with was_unread as they stood, marked updates only those of them that were unread, and
-- unread_left is the unread count before the call minus the rows marked. Labels are read now (ADR-002).
create function public.open_my_notifications() returns jsonb
  language sql security definer
  set search_path = ''
  as $$
  with shown as (
    select n.id, n.kind, n.created_at, n.read_at is null as was_unread, n.subsession_id, n.appeal_id, n.poll_id
    from public.notifications n
    where n.user_id = (select auth.uid())
    order by n.created_at desc, n.kind, n.id
    limit 50
  ),
  marked as (
    update public.notifications n
       set read_at = now()
     where n.user_id = (select auth.uid())
       and n.read_at is null
       and n.id in (select s.id from shown s)
    returning n.id
  ),
  unread_before as (
    select count(*)::integer as total
    from public.notifications n
    where n.user_id = (select auth.uid()) and n.read_at is null
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id,
               'kind', s.kind,
               'created_at', s.created_at,
               'was_unread', s.was_unread,
               'subsession_id', s.subsession_id,
               'season_label', coalesce(se.name, cr.season_label),
               'round_number', cr.round_number,
               'track_name', cr.track_name,
               'penalty_id', a.penalty_id,
               'poll_id', s.poll_id)
             order by s.created_at desc, s.kind, s.id)
      from shown s
      left join public.curated_rounds cr on cr.subsession_id = s.subsession_id
      left join public.seasons se on se.id = cr.season_id
      left join public.incident_appeals a on a.id = s.appeal_id
    ), '[]'::jsonb),
    'unread_left', (select u.total from unread_before u) - (select count(*)::integer from marked)
  );
$$;

comment on function public.open_my_notifications() is
  'Lists the caller''s 50 newest notifications and marks those read in one statement (U3, BR2.1). Returns '
  '{items, unread_left}; no driver names (BR5.2).';

revoke all on function public.notification_unread_count() from public, anon;
grant execute on function public.notification_unread_count() to authenticated;
revoke all on function public.open_my_notifications() from public, anon;
grant execute on function public.open_my_notifications() to authenticated;
