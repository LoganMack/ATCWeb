-- Incident clips, shared report numbering and re-posting with a date choice (incident-clips-and-ordering;
-- rules BR1.2-BR1.5, BR2.1-BR2.7, BR3.1, BR3.2, BR4.2, BR4.3, BR4.5, BR5.1).
--
-- What:
--   1. incident_reports.video_url, penalties.video_url and penalties.turn, each optional and checked.
--   2. private.incident_report_order(): the one rule that orders and numbers a round's incident reports
--      (session in event order, lap, natural turn order, submission time, id; dismissed reports unnumbered).
--   3. public.incident_submissions() now numbers and orders by that rule and leaves dismissed reports out.
--   4. public.incident_report_order(): the same order for admins and staff (dismissed reports included).
--   5. public.set_round_incident_posted(): post or unpost a round, choosing on a re-post whether the post
--      date (which the appeal window runs from) is reset or kept. Unposting now keeps the date.
--   6. public.set_incident_report_video() and public.set_incident_video(): set or clear a clip on a report,
--      or on every row of a posted incident at once.
--   7. public.penalties_shown gains turn and video_url, so they are public exactly when the round is.
--
-- Why in the database: the admin Reported Incidents screen and the public Incident Submissions page must
-- show the same number for the same report, and the public page must sort by turn without ever seeing it,
-- so the order is worked out here once. Who may post a round or change a clip is an authorization rule,
-- so it lives in SECURITY DEFINER functions that check public.is_admin() (admin or staff).
--
-- Re-posting never queues a second "Incident Report Posted" email: that email is queued only when
-- first_posted_at goes from empty to set (private.enqueue_report_posted), and nothing here writes it.
-- Every reader of posted_at also checks posted, so a date kept on an unposted round opens no appeal window.
--
-- Errors the site maps to messages are raised as '<CODE>: <message>' with errcode P0001:
-- INVALID_URL, REPORT_NOT_FOUND, INCIDENT_NOT_FOUND and INCIDENT_NUMBER_REQUIRED.
--
-- Expand only: new nullable columns and new functions; incident_submissions keeps its signature and columns
-- and penalties_shown keeps its columns with two appended, so the code on main keeps working. Undo with
-- supabase/down/20261111120000_incident_clips_and_ordering.down.sql.

-- 1. Columns ------------------------------------------------------------------------------------------------

alter table public.incident_reports
  add column video_url text,
  add constraint incident_reports_video_url_check
    check (video_url is null or (length(video_url) between 1 and 500 and video_url ~* '^https?://'));

alter table public.penalties
  add column turn text,
  add column video_url text,
  add constraint penalties_turn_check
    check (turn is null or (length(turn) between 1 and 80 and turn = btrim(turn))),
  add constraint penalties_video_url_check
    check (video_url is null or (length(video_url) between 1 and 500 and video_url ~* '^https?://'));

comment on column public.incident_reports.video_url is
  'Optional clip of the incident (http or https link), set by admins and staff.';
comment on column public.penalties.turn is
  'Optional turn where the incident happened; used to ring the corner on the layout map.';
comment on column public.penalties.video_url is
  'Optional clip of the incident (http or https link), shared by every row of the incident.';

-- 2. The shared order ----------------------------------------------------------------------------------------
-- Turns compare without case or surrounding spaces, and a leading "T", "Turn" or "Turns" before a digit is
-- ignored, so "T4", "turn 4" and "4" sort together. Turns that start with a number come first, by that number
-- and then by the rest of the text (3, 10, 10b); other turns follow alphabetically. Text compares in the C
-- collation so the order is the same on every database.

create function private.incident_report_order(p_subsession_id bigint)
  returns table (report_id uuid, "position" integer, number integer)
  language sql stable security definer
  set search_path = ''
  as $$
  with keyed as (
    select
      r.id,
      r.status,
      r.created_at,
      r.lap,
      case
        when r.session = 'practice:0' then 0::numeric
        when r.session = 'qualifying:0' then 1::numeric
        when r.session ~ '^race:[0-9]+$' then 1 + substring(r.session from 6)::numeric
      end as session_rank,
      regexp_replace(lower(btrim(coalesce(r.turn, ''))), '^(turns?|t)\s*(?=[0-9])', '') as turn_key
    from public.incident_reports r
    where r.subsession_id = p_subsession_id
  ),
  split as (
    select
      k.*,
      substring(k.turn_key from '^[0-9]+')::numeric as turn_number,
      btrim(regexp_replace(k.turn_key, '^[0-9]+', '')) as turn_rest
    from keyed k
  ),
  ranked as (
    select
      s.id,
      s.status,
      row_number() over (
        order by
          s.session_rank nulls last,
          s.lap,
          s.turn_number is null,
          s.turn_number,
          (case when s.turn_number is null then s.turn_key else s.turn_rest end) collate "C",
          s.created_at,
          s.id
      ) as pos
    from split s
  )
  select
    x.id as report_id,
    x.pos::integer as "position",
    case
      when x.status is distinct from 'dismissed'
        then (row_number() over (partition by x.status is distinct from 'dismissed' order by x.pos))::integer
    end as number
  from ranked x
  order by x.pos;
$$;

comment on function private.incident_report_order(bigint) is
  'The one ordering and numbering rule for a round''s incident reports: position over every report, number '
  'over the reports that are not dismissed. Read through incident_submissions (public) and '
  'incident_report_order (admins and staff).';

revoke all on function private.incident_report_order(bigint) from public, anon, authenticated, service_role;

-- 3. Public submissions list, numbered by the shared order ---------------------------------------------------

create or replace function public.incident_submissions(p_subsession_id bigint)
  returns table (id uuid, submission_number integer, session text, lap integer, involved_cars text[])
  language sql stable security definer
  set search_path = ''
  as $$
  select
    r.id,
    o.number as submission_number,
    r.session,
    r.lap,
    array(
      select d.car_number::text
      from public.incident_report_drivers x
      join public.drivers d on d.id = x.driver_id
      where x.report_id = r.id and d.car_number is not null
      order by d.car_number
    ) as involved_cars
  from private.incident_report_order(p_subsession_id) o
  join public.incident_reports r on r.id = o.report_id
  where o.number is not null
    and not exists (
      select 1 from public.round_incident_status s where s.subsession_id = r.subsession_id and s.posted
    )
  order by o.number;
$$;

comment on function public.incident_submissions(bigint) is
  'An unposted round''s incident reports for the public Incident Submissions page: id, number, session, lap '
  'and involved car numbers only, numbered and ordered by private.incident_report_order. Dismissed reports '
  'are left out. Empty once the round is posted.';

revoke all on function public.incident_submissions(bigint) from public;
grant execute on function public.incident_submissions(bigint) to anon, authenticated, service_role;

-- 4. Admin order -----------------------------------------------------------------------------------------------

create function public.incident_report_order(p_subsession_id bigint)
  returns table (report_id uuid, "position" integer, number integer)
  language plpgsql stable security definer
  set search_path = ''
  as $$
#variable_conflict use_column
begin
  if not public.is_admin() then
    raise exception 'Only an admin or staff member can read the report order' using errcode = 'insufficient_privilege';
  end if;
  return query
    select o.report_id, o."position", o.number from private.incident_report_order(p_subsession_id) o;
end;
$$;

comment on function public.incident_report_order(bigint) is
  'Admins and staff: every incident report of a round with its position and number (null when dismissed).';

revoke all on function public.incident_report_order(bigint) from public, anon;
grant execute on function public.incident_report_order(bigint) to authenticated;

-- 5. Posting with a date choice --------------------------------------------------------------------------------
-- Post with reset, or a first post: the post date is now. Post with keep: the last post date, else the first,
-- else now. Unpost: posted goes off and the date stays. Posting a round that is already posted changes nothing,
-- so a stale page can't move an open appeal window. Returns whether a new date was set and whether this was
-- the round's first post, for the activity log.

create function public.set_round_incident_posted(p_subsession_id bigint, p_posted boolean,
  p_reset_date boolean default true) returns jsonb
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  v_was_posted boolean := false;
  v_posted_at timestamptz;
  v_first_posted_at timestamptz;
  v_new_posted_at timestamptz;
  v_reset boolean := false;
  v_first_post boolean := false;
begin
  if not public.is_admin() then
    raise exception 'Only an admin or staff member can post a round' using errcode = 'insufficient_privilege';
  end if;
  if p_subsession_id is null or p_posted is null then
    raise exception 'INVALID: Pick a round and whether it is posted' using errcode = 'P0001';
  end if;

  select s.posted, s.posted_at, s.first_posted_at
    into v_was_posted, v_posted_at, v_first_posted_at
  from round_incident_status s where s.subsession_id = p_subsession_id for update;
  v_was_posted := coalesce(v_was_posted, false);

  if not p_posted then
    v_new_posted_at := v_posted_at;
  elsif v_was_posted then
    v_new_posted_at := coalesce(v_posted_at, now());
  else
    v_first_post := v_first_posted_at is null and v_posted_at is null;
    if coalesce(p_reset_date, true) or coalesce(v_posted_at, v_first_posted_at) is null then
      v_new_posted_at := now();
      v_reset := true;
    else
      v_new_posted_at := coalesce(v_posted_at, v_first_posted_at);
    end if;
  end if;

  insert into round_incident_status as s (subsession_id, posted, posted_at)
  values (p_subsession_id, p_posted, v_new_posted_at)
  on conflict (subsession_id) do update
    set posted = excluded.posted, posted_at = excluded.posted_at;

  return jsonb_build_object('posted', p_posted, 'reset', v_reset, 'first_post', v_first_post,
    'posted_at', v_new_posted_at);
end;
$$;

comment on function public.set_round_incident_posted(bigint, boolean, boolean) is
  'Admins and staff: post or unpost a round''s incident report. On a re-post p_reset_date chooses a new post '
  'date (true, the default) or the previous one (false); unposting keeps the date. Returns '
  '{posted, reset, first_post, posted_at}.';

revoke all on function public.set_round_incident_posted(bigint, boolean, boolean) from public, anon;
grant execute on function public.set_round_incident_posted(bigint, boolean, boolean) to authenticated;

-- 6. Clips -------------------------------------------------------------------------------------------------------
-- A clip is trimmed; an empty one clears it. Anything else must be an http or https link of up to 500
-- characters with no spaces; the column check refuses the same, so no other write path can store a bad link.

create function public.set_incident_report_video(p_report_id uuid, p_url text) returns jsonb
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  v_url text := nullif(btrim(coalesce(p_url, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Only an admin or staff member can change a clip' using errcode = 'insufficient_privilege';
  end if;
  if v_url is not null and (length(v_url) > 500 or v_url !~* '^https?://[^[:space:]]+$') then
    raise exception 'INVALID_URL: Video URL: enter a link starting with http:// or https:// (up to 500 characters).'
      using errcode = 'P0001';
  end if;

  update incident_reports set video_url = v_url where id = p_report_id;
  if not found then
    raise exception 'REPORT_NOT_FOUND: That incident report no longer exists' using errcode = 'P0001';
  end if;

  return jsonb_build_object('video_url', v_url);
end;
$$;

comment on function public.set_incident_report_video(uuid, text) is
  'Admins and staff: set (or clear, with an empty value) the clip of an incident report in any status.';

revoke all on function public.set_incident_report_video(uuid, text) from public, anon;
grant execute on function public.set_incident_report_video(uuid, text) to authenticated;

-- An incident is every penalties row with the same round, session type, race number and incident number, so
-- the clip changes on all of them in one statement. An incident without a number can't be told apart from
-- the round's other unnumbered rows, so it is refused rather than updating them all.
create function public.set_incident_video(p_subsession_id bigint, p_session_type text, p_race_number integer,
  p_incident_number text, p_url text) returns jsonb
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  v_url text := nullif(btrim(coalesce(p_url, '')), '');
  v_rows integer;
begin
  if not public.is_admin() then
    raise exception 'Only an admin or staff member can change a clip' using errcode = 'insufficient_privilege';
  end if;
  if nullif(btrim(coalesce(p_incident_number, '')), '') is null then
    raise exception 'INCIDENT_NUMBER_REQUIRED: Give the incident a number before adding a clip'
      using errcode = 'P0001';
  end if;
  if v_url is not null and (length(v_url) > 500 or v_url !~* '^https?://[^[:space:]]+$') then
    raise exception 'INVALID_URL: Video URL: enter a link starting with http:// or https:// (up to 500 characters).'
      using errcode = 'P0001';
  end if;

  update penalties
  set video_url = v_url
  where subsession_id = p_subsession_id
    and session_type = p_session_type
    and race_number = p_race_number
    and incident_number = p_incident_number;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'INCIDENT_NOT_FOUND: That incident no longer exists' using errcode = 'P0001';
  end if;

  return jsonb_build_object('video_url', v_url, 'rows', v_rows);
end;
$$;

comment on function public.set_incident_video(bigint, text, integer, text, text) is
  'Admins and staff: set (or clear, with an empty value) the clip on every row of one incident.';

revoke all on function public.set_incident_video(bigint, text, integer, text, text) from public, anon;
grant execute on function public.set_incident_video(bigint, text, integer, text, text) to authenticated;

-- 7. penalties_shown with turn and clip ---------------------------------------------------------------------------
-- Same view, same filter (admins, or the round is posted), two columns appended.

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
  p.video_url
from public.penalties p
where (select public.is_admin())
   or exists (
     select 1 from public.round_incident_status s where s.subsession_id = p.subsession_id and s.posted
   );

comment on view public.penalties_shown is
  'penalties for pages (U4): posted rounds (all for admins); hidden drivers'' full names masked in the text.';

revoke all on table public.penalties_shown from public, anon, authenticated, service_role;
grant select on table public.penalties_shown to anon, authenticated, service_role;
