-- Incident management on the own profile (U5 incident-management, US7.1-US7.4; contracts C4, C7; rules
-- BR11.1-BR11.18 with their design amendments; NFR1.1-NFR1.8, NFR3.2, NFR3.4, NFR8.1, NFR8.2).
--
-- What: a driver's "Incident Management" tab lists the incident reports that name their driver while the
-- round is unposted (one final comment each), then the posted penalties where their driver is penalized or
-- involved, while the appeal window is open or once they have appealed. This migration adds:
--   * driver_incident_comments, one comment per driver per report, readable by its author and by admins
--     who are not involved in the report;
--   * my_incidents(), the caller's list; add_my_incident_comment(), the only way to write a comment;
--     can_appeal_penalty(), a pre-check the site runs before it uploads appeal files;
--   * a shared appeal-window helper and two caller predicates in the private schema;
--   * submit_incident_appeal, replaced in place: only the penalized or an involved driver's account may
--     appeal, once per penalty (it used to allow any signed-in account three times);
--   * an incident_appeals policy so a driver can read their own appeals' status.
--
-- Why in the database: who may comment or appeal is an access rule (team rule), so the definer functions
-- decide it and the page only shows the outcome. New refusals are raised as '<CODE>: <message>' (codes
-- NOT_INVOLVED, CLOSED, ALREADY_COMMENTED, ALREADY_APPEALED, INVALID), which src/lib/incidentErrors.ts reads.
--
-- Expand only: the appeal function keeps its signature, search_path, grants and every existing check, so
-- the round page on main keeps working while this applies. One appeal per penalty is checked inside the
-- function under its existing advisory lock, with no unique index, so legacy duplicate appeals (up to three
-- from the old limit) stay and never block this migration. The appeal status values are unchanged (C7), so
-- the U7 reviewed trigger is unaffected. Undo with supabase/down/20261101120000_incident_management.down.sql.

-- 1. Driver comments (BR11.6, BR11.7; NFR1.1, NFR3.4) --------------------------------------------------
create table public.driver_incident_comments (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.incident_reports (id) on delete cascade,
  driver_id uuid not null references public.drivers (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  -- One comment per driver per report; it also serves the author check.
  constraint driver_incident_comments_report_driver_key unique (report_id, driver_id)
);

comment on table public.driver_incident_comments is
  'A driver''s one final comment on a pending incident report (U5). Readable by its author and by admins '
  'not involved in the report; written only by add_my_incident_comment().';

-- The admin report view reads a round's comments by report id.
create index driver_incident_comments_report_idx on public.driver_incident_comments (report_id);
create index driver_incident_comments_author_idx on public.driver_incident_comments (author_id);
create index driver_incident_comments_driver_idx on public.driver_incident_comments (driver_id);

alter table public.driver_incident_comments enable row level security;

-- Involved admins are blinded, like the steward review policy.
create policy "author or uninvolved admin read" on public.driver_incident_comments
  for select to authenticated
  using (
    author_id = (select auth.uid())
    or ((select public.is_admin()) and not public.is_involved_in_incident_report(report_id))
  );

-- Comments are final for drivers; only admins can remove one.
create policy "admin delete" on public.driver_incident_comments
  for delete to authenticated
  using ((select public.is_admin()));

-- Supabase grants every new public table to anon and authenticated by default, so start from nothing.
-- No insert or update grant: writes go only through add_my_incident_comment().
revoke all on table public.driver_incident_comments from public, anon, authenticated;
grant select, delete on table public.driver_incident_comments to authenticated;

-- 2. Private helpers (BR11.3 amended, BR11.9; NFR1.5) --------------------------------------------------
--    Called only from the definer functions below, which run as their owner (postgres).

-- When a round's appeals close: posted_at plus the Incident Appeal Window (site setting, hours, parsed as
-- submit_incident_appeal always did, default 24). Null while the round is unposted.
create function private.appeal_window_closes_at(p_subsession bigint) returns timestamptz
  language sql stable security definer
  set search_path = ''
  as $$
  select s.posted_at + make_interval(hours => coalesce(
           (select case when ss.value ~ '^[0-9]{1,4}$' then ss.value::integer end
            from public.site_settings ss
            where ss.setting_key = 'incident_appeal_period_hours'),
           24))
  from public.round_incident_status s
  where s.subsession_id = p_subsession and s.posted and s.posted_at is not null;
$$;

-- The caller's linked driver, or null.
create function private.caller_driver_id() returns uuid
  language sql stable security definer
  set search_path = ''
  as $$
  select p.driver_id from public.profiles p where p.id = (select auth.uid());
$$;

-- Whether p_driver_id is the penalized driver or listed under "Involved" for the penalty.
create function private.is_penalty_party(p_penalty_id uuid, p_driver_id uuid) returns boolean
  language sql stable security definer
  set search_path = ''
  as $$
  select p_driver_id is not null
     and (exists (select 1 from public.penalties p where p.id = p_penalty_id and p.driver_id = p_driver_id)
          or exists (select 1 from public.penalty_involved_drivers i
                     where i.penalty_id = p_penalty_id and i.driver_id = p_driver_id));
$$;

revoke all on function private.appeal_window_closes_at(bigint) from public, anon, authenticated, service_role;
revoke all on function private.caller_driver_id() from public, anon, authenticated, service_role;
revoke all on function private.is_penalty_party(uuid, uuid) from public, anon, authenticated, service_role;

-- 3. The caller's list (BR11.1-BR11.4, BR11.11, BR11.18; NFR1.3, NFR3.2, NFR3.4) -------------------------
--    Rows for auth.uid()'s linked driver only; nothing for an unlinked account. Never returns the reporter.
--    Pending: a not-dismissed report naming my driver in an unposted round (no status row, or posted =
--    false). Posted: a penalty in a posted round where my driver is penalized or involved, while the window
--    is open or once I have appealed it (my latest appeal, any status). Newest first, at most 200 rows.
create function public.my_incidents()
  returns table (
    kind text,
    id uuid,
    subsession_id bigint,
    round_label text,
    occurred_at timestamptz,
    session text,
    lap integer,
    turn text,
    description text,
    penalized_car text,
    involved_cars text[],
    i_am_penalized boolean,
    my_comment_exists boolean,
    appeal_window_closes_at timestamptz,
    my_appeal_status text,
    points_before integer,
    points_after integer,
    time_or_points_changed boolean
  )
  language sql stable security definer
  set search_path = ''
  as $$
  with me as (
    select p.id as profile_id, p.driver_id
    from public.profiles p
    where p.id = (select auth.uid()) and p.driver_id is not null
  ),
  pending as (
    select
      'pending_report'::text as kind,
      r.id,
      r.subsession_id,
      r.session,
      r.lap,
      r.turn,
      r.description,
      null::text as penalized_car,
      array(
        select d.car_number::text
        from public.incident_report_drivers x
        join public.drivers d on d.id = x.driver_id
        where x.report_id = r.id and x.driver_id <> me.driver_id and d.car_number is not null
        order by d.car_number
      ) as involved_cars,
      false as i_am_penalized,
      exists (
        select 1 from public.driver_incident_comments c where c.report_id = r.id and c.driver_id = me.driver_id
      ) as my_comment_exists,
      null::timestamptz as appeal_window_closes_at,
      'none'::text as my_appeal_status,
      null::integer as points_before,
      null::integer as points_after,
      false as time_or_points_changed
    from me
    join public.incident_report_drivers ird on ird.driver_id = me.driver_id
    join public.incident_reports r on r.id = ird.report_id
    where r.status <> 'dismissed'
      and not exists (
        select 1 from public.round_incident_status s where s.subsession_id = r.subsession_id and s.posted
      )
  ),
  -- Two index lookups (penalties_driver_idx, penalty_involved_drivers_driver_id_idx) instead of an OR.
  my_penalty_ids as (
    select p.id from public.penalties p join me on p.driver_id = me.driver_id
    union
    select i.penalty_id from public.penalty_involved_drivers i join me on i.driver_id = me.driver_id
  ),
  posted as (
    select
      'posted_penalty'::text as kind,
      p.id,
      p.subsession_id,
      p.session_type as session,
      p.lap,
      null::text as turn,
      null::text as description,
      pd.car_number::text as penalized_car,
      array(
        select d.car_number::text
        from public.penalty_involved_drivers x
        join public.drivers d on d.id = x.driver_id
        where x.penalty_id = p.id and d.car_number is not null
        order by d.car_number
      ) as involved_cars,
      coalesce(p.driver_id = me.driver_id, false) as i_am_penalized,
      false as my_comment_exists,
      w.closes_at as appeal_window_closes_at,
      coalesce(a.status, 'none') as my_appeal_status,
      p.penalty_points as points_before,
      -- Same formula as effectivePenaltyPoints in src/lib/penalties/effective.ts; a test compares them.
      case when p.is_appealed then p.appeal_penalty_points else p.penalty_points end as points_after,
      (p.is_appealed
        and (coalesce(p.appeal_time_penalty_seconds, 0) <> coalesce(p.time_penalty_seconds, 0)
             or p.appeal_points_penalty <> p.points_penalty)) as time_or_points_changed
    from my_penalty_ids m
    join public.penalties p on p.id = m.id
    cross join me
    left join public.drivers pd on pd.id = p.driver_id
    cross join lateral (select private.appeal_window_closes_at(p.subsession_id) as closes_at) w
    left join lateral (
      select ia.status
      from public.incident_appeals ia
      where ia.penalty_id = p.id and ia.submitter_id = me.profile_id
      order by ia.created_at desc
      limit 1
    ) a on true
    where w.closes_at is not null
      and (now() < w.closes_at or a.status is not null)
  ),
  listed as (
    select * from pending
    union all
    select * from posted
  )
  select
    l.kind,
    l.id,
    l.subsession_id,
    concat_ws(' · ',
      coalesce(se.name, cr.season_label),
      case when cr.round_number is not null then 'Round ' || cr.round_number end,
      cr.track_name) as round_label,
    cr.start_time as occurred_at,
    l.session,
    l.lap,
    l.turn,
    l.description,
    l.penalized_car,
    l.involved_cars,
    l.i_am_penalized,
    l.my_comment_exists,
    l.appeal_window_closes_at,
    l.my_appeal_status,
    l.points_before,
    l.points_after,
    l.time_or_points_changed
  from listed l
  left join public.curated_rounds cr on cr.subsession_id = l.subsession_id
  left join public.seasons se on se.id = cr.season_id
  order by cr.start_time desc nulls last, l.lap desc nulls last, l.id
  limit 200;
$$;

comment on function public.my_incidents() is
  'The caller''s Incident Management list (U5): pending reports naming their driver, then posted penalties '
  'they are penalized or involved in, inside the appeal window or appealed. Newest first, at most 200 rows.';

-- 4. Add a comment (BR11.6; NFR1.2) --------------------------------------------------------------------
create function public.add_my_incident_comment(p_report_id uuid, p_body text) returns uuid
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_uid uuid := (select auth.uid());
  v_driver uuid := private.caller_driver_id();
  v_body text := btrim(coalesce(p_body, ''));
  v_status text;
  v_subsession bigint;
  v_id uuid;
begin
  -- An unknown report reads as "not involved", so the function never confirms a report id exists.
  select r.status, r.subsession_id into v_status, v_subsession
  from public.incident_reports r
  join public.incident_report_drivers d on d.report_id = r.id
  where r.id = p_report_id and v_driver is not null and d.driver_id = v_driver;
  if v_uid is null or v_status is null then
    raise exception 'NOT_INVOLVED: you are not involved in this incident';
  end if;
  if v_status = 'dismissed'
     or exists (select 1 from public.round_incident_status s where s.subsession_id = v_subsession and s.posted) then
    raise exception 'CLOSED: this incident is no longer open for comments';
  end if;
  if char_length(v_body) < 1 or char_length(v_body) > 2000 then
    raise exception 'INVALID: invalid comment';
  end if;

  begin
    insert into public.driver_incident_comments (report_id, driver_id, author_id, body)
    values (p_report_id, v_driver, v_uid, v_body)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'ALREADY_COMMENTED: you have already commented';
  end;
  return v_id;
end;
$$;

comment on function public.add_my_incident_comment(uuid, text) is
  'Adds the caller''s one final comment on a pending report that names their driver (U5, BR11.6).';

-- 5. Appeal pre-check (BR11.9; NFR1.5) -----------------------------------------------------------------
--    The same checks as submit_incident_appeal, in the same order, writing nothing; the site calls it
--    before uploading files so a refused appeal leaves no uploads behind.
create function public.can_appeal_penalty(p_penalty_id uuid) returns text
  language plpgsql stable security definer
  set search_path = ''
  as $$
declare
  v_uid uuid := (select auth.uid());
  v_subsession bigint;
  v_closes timestamptz;
begin
  select p.subsession_id into v_subsession from public.penalties p where p.id = p_penalty_id;
  if v_uid is null or v_subsession is null then return 'UNKNOWN'; end if;
  v_closes := private.appeal_window_closes_at(v_subsession);
  if v_closes is null or now() > v_closes then return 'CLOSED'; end if;
  if not private.is_penalty_party(p_penalty_id, private.caller_driver_id()) then return 'NOT_INVOLVED'; end if;
  if exists (
    select 1 from public.incident_appeals a where a.penalty_id = p_penalty_id and a.submitter_id = v_uid
  ) then
    return 'ALREADY_APPEALED';
  end if;
  return 'ok';
end;
$$;

comment on function public.can_appeal_penalty(uuid) is
  'Whether the caller may appeal this penalty now: ok, NOT_INVOLVED, ALREADY_APPEALED, CLOSED or UNKNOWN (U5).';

revoke all on function public.my_incidents() from public, anon;
revoke all on function public.add_my_incident_comment(uuid, text) from public, anon;
revoke all on function public.can_appeal_penalty(uuid) from public, anon;
grant execute on function public.my_incidents() to authenticated;
grant execute on function public.add_my_incident_comment(uuid, text) to authenticated;
grant execute on function public.can_appeal_penalty(uuid) to authenticated;

-- 6. The appeal function, replaced in place (BR11.9, BR11.15, BR11.17; NFR1.4) ---------------------------
--    Same signature, search_path and grants. The window comes from the shared helper (closed when
--    now() > closes_at, as before). Then, in order: the caller must be the penalized or an involved driver;
--    the existing per-submitter lock; one appeal per penalty (replacing three); the 10-per-round limit.
create or replace function public.submit_incident_appeal(p_id uuid, p_penalty_id uuid, p_message text, p_files jsonb)
  returns uuid
  language plpgsql security definer
  set search_path to 'public'
  as $_$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_subsession bigint;
  v_closes timestamptz;
  v_file jsonb;
begin
  if v_uid is null then raise exception 'sign in to submit an appeal'; end if;
  if p_id is null then raise exception 'invalid id'; end if;
  if coalesce(btrim(p_message), '') = '' or length(p_message) > 4000 then raise exception 'invalid message'; end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) > 3 then
    raise exception 'invalid files';
  end if;

  select subsession_id into v_subsession from penalties where id = p_penalty_id;
  if v_subsession is null then raise exception 'unknown incident'; end if;

  -- Appeal window: from posting until the appeal period runs out (private.appeal_window_closes_at).
  v_closes := private.appeal_window_closes_at(v_subsession);
  if v_closes is null or now() > v_closes then
    raise exception 'CLOSED: the appeal window for this round is closed';
  end if;

  -- Files must be the caller's own uploads for this appeal.
  for v_file in select * from jsonb_array_elements(p_files) loop
    if jsonb_typeof(v_file) <> 'object'
       or coalesce(v_file ->> 'path', '') !~ ('^' || v_uid::text || '/' || p_id::text || '/[0-9]+-[^/]+$')
       or not exists (
         select 1 from storage.objects o
         where o.bucket_id = 'incident-appeals' and o.name = v_file ->> 'path'
       ) then
      raise exception 'invalid files';
    end if;
  end loop;

  -- Only the penalized driver's or an involved driver's account may appeal (Q3 A).
  if not private.is_penalty_party(p_penalty_id, private.caller_driver_id()) then
    raise exception 'NOT_INVOLVED: you are not involved in this incident';
  end if;

  -- Per-submitter limits, under the lock so two requests cannot both pass: one appeal per penalty (Q2 A),
  -- ten per round.
  perform pg_advisory_xact_lock(hashtextextended('incident_appeal:' || v_uid::text, 0));
  if exists (select 1 from incident_appeals where penalty_id = p_penalty_id and submitter_id = v_uid) then
    raise exception 'ALREADY_APPEALED: you have already appealed this incident';
  end if;
  if (select count(*) from incident_appeals where subsession_id = v_subsession and submitter_id = v_uid) >= 10 then
    raise exception 'too many appeals for this round';
  end if;

  -- A login linked to a roster driver (Admin > Users > Driver) is named after that driver.
  select coalesce(d.name, p.display_name, u.email) into v_name
  from auth.users u left join profiles p on p.id = u.id left join drivers d on d.id = p.driver_id
  where u.id = v_uid;

  insert into incident_appeals (id, subsession_id, penalty_id, message, files, submitter_id, submitter_name)
  values (p_id, v_subsession, p_penalty_id, btrim(p_message), p_files, v_uid, v_name);

  return p_id;
end;
$_$;

-- 7. Drivers read their own appeals' status (BR11.16; NFR1.6). The admin policies are unchanged. ---------
create policy "submitter read own" on public.incident_appeals
  for select to authenticated
  using (submitter_id = (select auth.uid()));
