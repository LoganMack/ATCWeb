-- Appeal comments, Close Appeal and the appealed warning flag (appeals unit U1; FR3.1-FR3.7; rules
-- BR2.1-BR2.4, BR3.1-BR3.7, BR4.1; ADR-007, ADR-008, ADR-009).
--
-- What:
--   1. incident_appeals gains the close record: closed_at, closed_by (set null when that profile is
--      deleted), close_comment and the four decided_* values, all null or all set together.
--   2. penalties gains appeal_is_warning: null means the appeal left the warning flag unchanged.
--   3. incident_appeal_comments: one internal comment per steward per appeal, kept with a null author when
--      that profile is deleted. No client grants; reads and writes go through the definer functions below.
--   4. private.is_involved_in_appeal(): the one involvement test for comments, Close Appeal, Dismiss and
--      Reopen. The caller's driver is a party to the appeal's penalty, or the caller is involved in the
--      logged incident report that became it (same round and a shared car; same session and lap, else same
--      session, else same lap, as the admin page matches them).
--   5. private.incident_appeals_lock() on BEFORE UPDATE: a reviewed appeal is final; only an update that sets
--      every close field while moving open to reviewed can close one (which close_incident_appeal makes);
--      close fields never change otherwise, except closed_by going to null alone; an involved steward
--      cannot change the status.
--   6. public.close_incident_appeal(): locks the appeal, checks the caller, then marks it reviewed with its
--      own decision and writes the decision to the penalty as its appealed values, in one transaction. The
--      existing triggers then rescore the round and queue the appeal-reviewed email.
--   7. public.save_incident_appeal_comment() and public.incident_appeal_comments_for_round().
--   8. The effective warning (coalesce(appeal_is_warning, is_warning) once appealed): the scoring trigger's
--      change comparison includes appeal_is_warning, and penalties_shown exposes it.
--
-- Why in the database: who may close an appeal or read steward comments is an access rule, and closing must
-- be atomic and final whichever path the write takes (team rule; ADR-007, ADR-008). The functions return a
-- status code (ok, not_allowed, already_closed, not_open, invalid) that src/lib/incidentAppeals.ts maps;
-- the trigger raises '<CODE>: <message>' with errcode P0001 (ALREADY_CLOSED, NOT_OPEN, USE_CLOSE_APPEAL,
-- INVOLVED_STEWARD).
--
-- Expand only: new nullable columns, a new table and new functions; the status values stay open, reviewed
-- and dismissed, and penalties_shown keeps its columns with one appended, so the code on main keeps working.
-- The one exception is main's "Mark reviewed" button: a bare status change to reviewed is now refused, so
-- until this unit's code deploys that button fails with a logged error and changes nothing (accepted, BR3.5).
-- Undo with supabase/down/20261115120000_appeal_close_and_comments.down.sql.

-- 1. The close record on incident_appeals (BR3.3, BR5.1) ------------------------------------------------------

alter table public.incident_appeals
  add column closed_at timestamptz,
  add column closed_by uuid references public.profiles (id) on delete set null,
  add column close_comment text,
  add column decided_time_penalty_seconds numeric,
  add column decided_points_penalty integer,
  add column decided_penalty_points integer,
  add column decided_is_warning boolean,
  add constraint incident_appeals_close_fields_check check (
    (closed_at is null and close_comment is null and decided_time_penalty_seconds is null
     and decided_points_penalty is null and decided_penalty_points is null and decided_is_warning is null)
    or (closed_at is not null and close_comment is not null and decided_time_penalty_seconds is not null
        and decided_points_penalty is not null and decided_penalty_points is not null
        and decided_is_warning is not null and status = 'reviewed')
  ),
  add constraint incident_appeals_close_values_check check (
    (close_comment is null or (char_length(close_comment) between 1 and 4000 and close_comment = btrim(close_comment)))
    and (decided_time_penalty_seconds is null or decided_time_penalty_seconds >= 0)
    and (decided_points_penalty is null or decided_points_penalty >= 0)
    and (decided_penalty_points is null or decided_penalty_points >= 0)
  );

comment on column public.incident_appeals.closed_at is
  'When Close Appeal closed this appeal; null for open, dismissed and legacy reviewed appeals.';
comment on column public.incident_appeals.closed_by is
  'The steward who closed it; becomes null when that profile is deleted ("a former steward").';
comment on column public.incident_appeals.close_comment is
  'The Close Appeal comment, also written to the penalty as its appeal result.';

create index incident_appeals_closed_by_idx on public.incident_appeals (closed_by);

-- 2. The appealed warning flag (BR4.1; ADR-009) ---------------------------------------------------------------

alter table public.penalties add column appeal_is_warning boolean;

comment on column public.penalties.appeal_is_warning is
  'The warning flag an appeal decided; null means unchanged. Effective once appealed: coalesce(appeal_is_warning, is_warning).';

-- 3. Steward comments (BR2.1-BR2.4; ADR-008) ------------------------------------------------------------------

create table public.incident_appeal_comments (
  id uuid primary key default gen_random_uuid(),
  appeal_id uuid not null references public.incident_appeals (id) on delete cascade,
  -- Set null when the steward's profile is deleted, so the record survives ("A former steward"). Nulls are
  -- distinct, so the one-per-steward key below still holds for every living author.
  author_id uuid references public.profiles (id) on delete set null,
  body text not null check (char_length(body) between 1 and 4000 and body = btrim(body)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One comment per steward per appeal; saving again replaces it.
  constraint incident_appeal_comments_appeal_author_key unique (appeal_id, author_id)
);

comment on table public.incident_appeal_comments is
  'Internal steward comments on appeals (U1). No client grants: read through incident_appeal_comments_for_round(), '
  'written through save_incident_appeal_comment().';

create index incident_appeal_comments_author_idx on public.incident_appeal_comments (author_id);

alter table public.incident_appeal_comments enable row level security;

-- Supabase grants every new public table to anon and authenticated by default, so start from nothing.
revoke all on table public.incident_appeal_comments from public, anon, authenticated;

-- 4. The one involvement test (BR2.1, BR3.2, BR3.7) -----------------------------------------------------------
-- Nothing links a penalty to the report it was logged from, so the report side matches the way the admin page
-- finds a report's decision (decisionPenaltyFor): a penalty in the round sharing one of the logged report's
-- cars, at the same session and lap, else the same session, else the same lap (a steward may have changed
-- either while logging it). Every penalty at the report's best tier counts.

create function private.is_involved_in_appeal(p_appeal_id uuid) returns boolean
  language sql stable security definer
  set search_path = ''
  as $$
  with target as (
    select p.id, p.subsession_id
    from public.incident_appeals a
    join public.penalties p on p.id = a.penalty_id
    where a.id = p_appeal_id
  ),
  -- Each logged report of the round with each penalty sharing one of its cars, and how well they match:
  -- 1 same session and lap, 2 same session, 3 same lap, null neither.
  matches as (
    select r.id as report_id, q.id as penalty_id,
      case
        when r.session = q.session_type || ':' || q.race_number and r.lap is not distinct from q.lap then 1
        when r.session = q.session_type || ':' || q.race_number then 2
        when r.lap is not distinct from q.lap then 3
      end as tier
    from target t
    join public.incident_reports r on r.subsession_id = t.subsession_id and r.status = 'logged'
    join public.penalties q on q.subsession_id = t.subsession_id
    where exists (
      select 1
      from public.incident_report_drivers x
      where x.report_id = r.id
        and (x.driver_id = q.driver_id
             or exists (select 1 from public.penalty_involved_drivers i
                        where i.penalty_id = q.id and i.driver_id = x.driver_id))
    )
  ),
  decided as (
    select m.report_id, m.penalty_id
    from matches m
    where m.tier = (select min(m2.tier) from matches m2 where m2.report_id = m.report_id)
  )
  select exists (select 1 from target t where private.is_penalty_party(t.id, private.caller_driver_id()))
      or exists (select 1 from target t join decided d on d.penalty_id = t.id
                 where private.is_involved_in_incident_report(d.report_id));
$$;

comment on function private.is_involved_in_appeal(uuid) is
  'Whether the signed-in caller is involved in this appeal''s incident: a party to its penalty, or involved in '
  'the logged report it came from. Shared by comments, Close Appeal, Dismiss and Reopen (BR2.1).';

revoke all on function private.is_involved_in_appeal(uuid) from public, anon, authenticated, service_role;

-- 5. The lock (BR3.5, BR3.7) -----------------------------------------------------------------------------------

create function private.incident_appeals_lock() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_close_changed boolean :=
    new.closed_at is distinct from old.closed_at
    or new.close_comment is distinct from old.close_comment
    or new.decided_time_penalty_seconds is distinct from old.decided_time_penalty_seconds
    or new.decided_points_penalty is distinct from old.decided_points_penalty
    or new.decided_penalty_points is distinct from old.decided_penalty_points
    or new.decided_is_warning is distinct from old.decided_is_warning;
begin
  -- Reviewed is final; closed_by may only go to null on its own (the steward's profile was deleted).
  if old.status = 'reviewed' then
    if new.status is distinct from old.status or v_close_changed
       or (new.closed_by is distinct from old.closed_by and new.closed_by is not null) then
      raise exception 'ALREADY_CLOSED: This appeal is already closed' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if new.status = 'reviewed' then
    if old.status <> 'open' then
      raise exception 'NOT_OPEN: Only an open appeal can be closed' using errcode = 'P0001';
    end if;
    -- Only an update that writes the whole decision closes an appeal, stamped with the closing steward.
    if new.closed_at is null or new.close_comment is null or new.decided_time_penalty_seconds is null
       or new.decided_points_penalty is null or new.decided_penalty_points is null
       or new.decided_is_warning is null
       or ((select auth.uid()) is not null and new.closed_by is distinct from (select auth.uid())) then
      raise exception 'USE_CLOSE_APPEAL: Use Close Appeal to close an appeal' using errcode = 'P0001';
    end if;
  elsif v_close_changed or new.closed_by is distinct from old.closed_by then
    raise exception 'USE_CLOSE_APPEAL: Use Close Appeal to close an appeal' using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status and (select auth.uid()) is not null
     and private.is_involved_in_appeal(new.id) then
    raise exception 'INVOLVED_STEWARD: You are involved in this incident, so another steward must decide the appeal.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function private.incident_appeals_lock() is
  'Before an update of incident_appeals: reviewed is final, only a full close decision moves open to reviewed, '
  'close fields change only then, and an involved steward cannot change the status (BR3.5, BR3.7).';

revoke all on function private.incident_appeals_lock() from public, anon, authenticated, service_role;

create trigger incident_appeals_lock
  before update on public.incident_appeals
  for each row execute function private.incident_appeals_lock();

-- 6. Close Appeal (BR3.1-BR3.4; ADR-007) -------------------------------------------------------------------
-- The lock on the appeal row makes a second, concurrent close wait and then read already_closed. An unknown
-- appeal reads as not_allowed, so the function never confirms an id exists to someone who may not see it.

create function public.close_incident_appeal(p_appeal_id uuid, p_time numeric, p_points integer,
  p_licence integer, p_is_warning boolean, p_comment text) returns text
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_uid uuid := (select auth.uid());
  v_comment text := btrim(coalesce(p_comment, ''));
  v_status text;
  v_penalty uuid;
begin
  if v_uid is null or not public.is_admin() then
    return 'not_allowed';
  end if;

  select a.status, a.penalty_id into v_status, v_penalty
  from public.incident_appeals a
  where a.id = p_appeal_id
  for update;
  if not found or private.is_involved_in_appeal(p_appeal_id) then
    return 'not_allowed';
  end if;
  -- A closed appeal is final; a dismissed one must be reopened before it can be closed.
  if v_status = 'reviewed' then
    return 'already_closed';
  elsif v_status <> 'open' then
    return 'not_open';
  end if;

  if p_time is null or p_time < 0 or p_time <> round(p_time, 3)
     or p_points is null or p_points < 0
     or p_licence is null or p_licence < 0
     or p_is_warning is null
     or char_length(v_comment) not between 1 and 4000 then
    return 'invalid';
  end if;

  update public.incident_appeals
  set status = 'reviewed',
      closed_at = now(),
      closed_by = v_uid,
      close_comment = v_comment,
      decided_time_penalty_seconds = p_time,
      decided_points_penalty = p_points,
      decided_penalty_points = p_licence,
      decided_is_warning = p_is_warning
  where id = p_appeal_id;

  -- The latest close's decision is the penalty's appealed values; the originals stay as the record (BR3.4).
  update public.penalties
  set is_appealed = true,
      appeal_time_penalty_seconds = p_time,
      appeal_points_penalty = p_points,
      appeal_penalty_points = p_licence,
      appeal_is_warning = p_is_warning,
      appeal_result = v_comment
  where id = v_penalty;

  return 'ok';
end;
$$;

comment on function public.close_incident_appeal(uuid, numeric, integer, integer, boolean, text) is
  'Admins and staff not involved in the incident: close an open appeal with a decision (time, points, licence '
  'points, warning, comment), written to the appeal and to its penalty in one transaction. Returns ok, '
  'not_allowed, already_closed (reviewed), not_open (dismissed) or invalid.';

revoke all on function public.close_incident_appeal(uuid, numeric, integer, integer, boolean, text) from public, anon;
grant execute on function public.close_incident_appeal(uuid, numeric, integer, integer, boolean, text) to authenticated;

-- 7. Steward comments: save and read (BR2.1-BR2.4) -------------------------------------------------------------

create function public.save_incident_appeal_comment(p_appeal_id uuid, p_body text) returns text
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_uid uuid := (select auth.uid());
  v_body text := btrim(coalesce(p_body, ''));
  v_status text;
begin
  if v_uid is null or not public.is_admin() then
    return 'not_allowed';
  end if;

  -- A share lock, so a comment can't land after a concurrent close has taken the row.
  select a.status into v_status
  from public.incident_appeals a
  where a.id = p_appeal_id
  for share;
  if not found or private.is_involved_in_appeal(p_appeal_id) then
    return 'not_allowed';
  end if;
  if v_status <> 'open' then
    return 'not_open';
  end if;
  if char_length(v_body) not between 1 and 4000 then
    return 'invalid';
  end if;

  insert into public.incident_appeal_comments as c (appeal_id, author_id, body)
  values (p_appeal_id, v_uid, v_body)
  on conflict (appeal_id, author_id) do update
    set body = excluded.body, updated_at = now();

  return 'ok';
end;
$$;

comment on function public.save_incident_appeal_comment(uuid, text) is
  'Admins and staff not involved in the incident: add or replace their own comment on an open appeal (1 to '
  '4,000 characters). Returns ok, not_allowed, not_open or invalid.';

revoke all on function public.save_incident_appeal_comment(uuid, text) from public, anon;
grant execute on function public.save_incident_appeal_comment(uuid, text) to authenticated;

-- Comments on a round's appeals for a panel steward, leaving out every appeal they are involved in. is_mine
-- lets the page label the button Edit Comment and prefill it, without handing out account ids.
create function public.incident_appeal_comments_for_round(p_subsession_id bigint)
  returns table (appeal_id uuid, author_name text, body text, updated_at timestamptz, is_mine boolean)
  language sql stable security definer
  set search_path = ''
  as $$
  select
    c.appeal_id,
    case when c.author_id is null then 'A former steward'
         else coalesce(nullif(btrim(pr.display_name), ''), 'Unknown steward') end as author_name,
    c.body,
    c.updated_at,
    coalesce(c.author_id = (select auth.uid()), false) as is_mine
  from public.incident_appeal_comments c
  join public.incident_appeals a on a.id = c.appeal_id
  left join public.profiles pr on pr.id = c.author_id
  where a.subsession_id = p_subsession_id
    and (select auth.uid()) is not null
    and (select public.is_admin())
    and not private.is_involved_in_appeal(a.id)
  order by c.appeal_id, c.updated_at, c.id;
$$;

comment on function public.incident_appeal_comments_for_round(bigint) is
  'Admins and staff: the steward comments on a round''s appeals, except on appeals the caller is involved in. '
  'Empty for everyone else (BR2.1, BR2.4).';

revoke all on function public.incident_appeal_comments_for_round(bigint) from public, anon;
grant execute on function public.incident_appeal_comments_for_round(bigint) to authenticated;

-- 8. The effective warning (BR4.1; ADR-009) --------------------------------------------------------------------
-- Warnings don't change scores, but the change comparison lists every effective penalty value, so a change of
-- the effective warning still rescores the round, as an is_warning change always did.

create or replace function private.scoring_on_penalties() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v bigint[];
begin
  if not private.scoring_triggers_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    v := array(select distinct n.subsession_id from new_rows n);
  elsif tg_op = 'DELETE' then
    v := array(select distinct o.subsession_id from old_rows o);
  else
    v := array(
      select distinct d.subsession_id from (
        (select n.subsession_id, n.race_number, n.session_type, n.driver_id, n.time_penalty_seconds, n.points_penalty,
                n.is_appealed, n.appeal_time_penalty_seconds, n.appeal_points_penalty, n.is_warning,
                n.appeal_is_warning from new_rows n
         except
         select o.subsession_id, o.race_number, o.session_type, o.driver_id, o.time_penalty_seconds, o.points_penalty,
                o.is_appealed, o.appeal_time_penalty_seconds, o.appeal_points_penalty, o.is_warning,
                o.appeal_is_warning from old_rows o)
        union all
        (select o.subsession_id, o.race_number, o.session_type, o.driver_id, o.time_penalty_seconds, o.points_penalty,
                o.is_appealed, o.appeal_time_penalty_seconds, o.appeal_points_penalty, o.is_warning,
                o.appeal_is_warning from old_rows o
         except
         select n.subsession_id, n.race_number, n.session_type, n.driver_id, n.time_penalty_seconds, n.points_penalty,
                n.is_appealed, n.appeal_time_penalty_seconds, n.appeal_points_penalty, n.is_warning,
                n.appeal_is_warning from new_rows n)
      ) d);
  end if;
  perform private.scoring_rescore(v);
  return null;
end;
$$;

-- Same view, same filter (admins, or the round is posted), appeal_is_warning appended.
create or replace view public.penalties_shown with (security_invoker = false, security_barrier = true) as
select
  p.id,
  p.subsession_id,
  p.race_number,
  p.driver_id,
  p.incident_number,
  p.lap,
  private.mask_names(
    p.description,
    (select coalesce(array_agg(h.full_name), '{}') from private.hidden_drivers h where h.name_hidden)
  ) as description,
  p.time_penalty_seconds,
  p.points_penalty,
  p.penalty_points,
  p.created_at,
  p.updated_at,
  p.is_warning,
  p.is_appealed,
  private.mask_names(
    p.appeal_result,
    (select coalesce(array_agg(h.full_name), '{}') from private.hidden_drivers h where h.name_hidden)
  ) as appeal_result,
  p.appeal_time_penalty_seconds,
  p.appeal_points_penalty,
  p.appeal_penalty_points,
  p.session_type,
  p.turn,
  p.video_url,
  p.appeal_is_warning
from public.penalties p
where (select public.is_admin())
   or exists (
     select 1 from public.round_incident_status s where s.subsession_id = p.subsession_id and s.posted
   );

comment on view public.penalties_shown is
  'penalties for pages (U4): posted rounds (all for admins); hidden drivers'' full names masked in the text.';

revoke all on table public.penalties_shown from public, anon, authenticated, service_role;
grant select on table public.penalties_shown to anon, authenticated, service_role;
