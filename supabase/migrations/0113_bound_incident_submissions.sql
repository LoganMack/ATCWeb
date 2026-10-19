-- 0113_bound_incident_submissions.sql
-- Enforce the incident reporting and appeal rules in the database (site audit
-- SEC-02, NFR2.6-NFR2.8). The public anon key lets anyone call the RPCs and
-- the Storage API directly, skipping the honeypot and window checks in the
-- pages, so until now reports and appeals could be sent at any time, in any
-- number, and appeals needed no account. Undo script:
-- supabase/down/0113_bound_incident_submissions.down.sql
--
--  1. submit_incident_report stays open to signed-out visitors (owner's
--     decision), but now refuses:
--       - a round whose incident report is already posted;
--       - a round whose reporting period has ended. The pages compute the
--         exact close from the event schedule; here we use a deliberately
--         generous bound (round start + 4 h + the "incident_report_period_
--         hours" setting) so the database never rejects a report the page
--         accepts, while still closing the window;
--       - more than 10 reports per signed-in reporter per round, and for
--         signed-out reports more than 40 per round or 20 per hour site-wide
--         (busiest round so far: 16 reports, 13 anonymous; busiest hour: 8).
--  2. submit_incident_appeal needs a signed-in user (EXECUTE revoked from
--     anon) and refuses:
--       - a penalty whose round isn't posted, or whose appeal window
--         (posted_at + "incident_appeal_period_hours") has closed -- the same
--         rule src/lib/incidentAppeals.ts applies;
--       - more than 3 appeals per user per penalty or 10 per user per round;
--       - attached files that aren't the caller's own uploads for this appeal.
--  3. incident-appeals uploads: signed-in users only, into their own
--     "<user id>/<appeal id>/<n>-<file>" folder, at most 15 files a day each.
--  4. The bucket's per-file limit drops from 10 MB to 5 MB (largest appeal
--     file so far: 0.3 MB).
--
-- Each limit check takes a transaction-scoped advisory lock first so
-- parallel calls can't all pass the same count.

-- 1. Incident reports --------------------------------------------------------
create or replace function public.submit_incident_report(
  p_subsession_id bigint, p_session text, p_lap integer, p_turn text,
  p_description text, p_driver_ids uuid[]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_uid uuid := auth.uid();
  v_name text;
  v_start timestamptz;
  v_period_hours integer;
begin
  if p_session is null or p_session !~ '^(race:[0-9]+|qualifying:0|practice:0)$' then
    raise exception 'invalid session';
  end if;
  if p_lap is null or p_lap < 0 or p_lap > 1000 then raise exception 'invalid lap'; end if;
  if coalesce(btrim(p_turn), '') = '' or length(p_turn) > 80 then raise exception 'invalid turn'; end if;
  if p_description is not null and length(p_description) > 2000 then raise exception 'description too long'; end if;
  if p_driver_ids is null or cardinality(p_driver_ids) = 0 or cardinality(p_driver_ids) > 100 then
    raise exception 'at least one car is required';
  end if;

  select start_time into v_start from curated_rounds where subsession_id = p_subsession_id;
  if not found then raise exception 'unknown round'; end if;

  -- Reporting window: closed once posted, or once the period has run out.
  if exists (select 1 from round_incident_status where subsession_id = p_subsession_id and posted) then
    raise exception 'incident reporting is closed for this round';
  end if;
  select case when value ~ '^[0-9]{1,4}$' then value::integer end into v_period_hours
  from site_settings where setting_key = 'incident_report_period_hours';
  if v_start is null or now() > v_start + interval '4 hours' + make_interval(hours => coalesce(v_period_hours, 24)) then
    raise exception 'incident reporting is closed for this round';
  end if;

  -- Per-submitter limits.
  if v_uid is not null then
    perform pg_advisory_xact_lock(hashtextextended('incident_report:' || v_uid::text, 0));
    if (select count(*) from incident_reports where subsession_id = p_subsession_id and reporter_id = v_uid) >= 10 then
      raise exception 'too many incident reports for this round';
    end if;
  else
    perform pg_advisory_xact_lock(hashtextextended('incident_report:anon', 0));
    if (select count(*) from incident_reports where subsession_id = p_subsession_id and reporter_id is null) >= 40 then
      raise exception 'too many incident reports for this round';
    end if;
    if (select count(*) from incident_reports where reporter_id is null and created_at > now() - interval '1 hour') >= 20 then
      raise exception 'too many incident reports, try again later';
    end if;
  end if;

  if v_uid is not null then
    select coalesce(d.name, p.display_name, u.email) into v_name
    from auth.users u left join profiles p on p.id = u.id left join drivers d on d.id = p.driver_id
    where u.id = v_uid;
  end if;

  insert into incident_reports (subsession_id, session, lap, turn, description, reporter_id, reporter_name)
  values (p_subsession_id, p_session, p_lap, btrim(p_turn), nullif(btrim(coalesce(p_description, '')), ''), v_uid, v_name)
  returning id into v_id;

  insert into incident_report_drivers (report_id, driver_id)
  select v_id, d.id from drivers d where d.id = any (p_driver_ids);
  if not found then raise exception 'no valid cars'; end if;

  return v_id;
end;
$$;

revoke all on function public.submit_incident_report(bigint, text, integer, text, text, uuid[]) from public;
grant execute on function public.submit_incident_report(bigint, text, integer, text, text, uuid[]) to anon, authenticated;

-- 2. Incident appeals --------------------------------------------------------
create or replace function public.submit_incident_appeal(
  p_id uuid,
  p_penalty_id uuid,
  p_message text,
  p_files jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_subsession bigint;
  v_posted_at timestamptz;
  v_period_hours integer;
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

  -- Appeal window: from posting until the appeal period runs out.
  select posted_at into v_posted_at
  from round_incident_status where subsession_id = v_subsession and posted;
  select case when value ~ '^[0-9]{1,4}$' then value::integer end into v_period_hours
  from site_settings where setting_key = 'incident_appeal_period_hours';
  if v_posted_at is null or now() > v_posted_at + make_interval(hours => coalesce(v_period_hours, 24)) then
    raise exception 'the appeal window for this round is closed';
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

  -- Per-submitter limits.
  perform pg_advisory_xact_lock(hashtextextended('incident_appeal:' || v_uid::text, 0));
  if (select count(*) from incident_appeals where penalty_id = p_penalty_id and submitter_id = v_uid) >= 3 then
    raise exception 'too many appeals for this incident';
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
$$;

revoke all on function public.submit_incident_appeal(uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.submit_incident_appeal(uuid, uuid, text, jsonb) to authenticated;

-- 3. incident-appeals uploads -------------------------------------------------
-- Runs as owner so it can count the caller's earlier uploads, which the
-- bucket's admin-only select policy would otherwise hide from them.
create or replace function public.can_upload_incident_appeal_file()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and (
      select count(*) from storage.objects o
      where o.bucket_id = 'incident-appeals'
        and o.name like auth.uid()::text || '/%'
        and o.created_at > now() - interval '1 day'
    ) < 15;
$$;

revoke all on function public.can_upload_incident_appeal_file() from public, anon;
grant execute on function public.can_upload_incident_appeal_file() to authenticated;

drop policy if exists "anyone upload incident-appeals" on storage.objects;
drop policy if exists "signed-in upload own incident-appeals" on storage.objects;
create policy "signed-in upload own incident-appeals" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'incident-appeals'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name ~ '^[0-9a-f-]{36}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9]+-[^/]+$'
    and (select public.can_upload_incident_appeal_file())
  );

-- 4. Smaller per-file limit ---------------------------------------------------
update storage.buckets set file_size_limit = 5242880 where id = 'incident-appeals';
