-- Undo 0114_security_fixes_additive.sql
-- Run 0115's and 0116's down scripts first if they were applied. Puts back the
-- state left by 0051, 0077/0097, 0109 and 0111: no record_page_view(), the
-- dismissal-reason trigger function without a pinned search path, anon able to
-- EXECUTE the two interview RPCs (Supabase's default grant, as the audit found
-- live), the 0109 flat-path-only submit_race_interview, and no owner or
-- admin-read storage policies. Revert the app change in the same go: the old
-- app inserts page views directly and uploads interviews to "<id>.<ext>".

-- 5. imports: admin read
drop policy if exists "admin read imports" on storage.objects;

-- 4. Interview uploads
drop policy if exists "driver replace own unsubmitted race-interviews" on storage.objects;
drop policy if exists "driver read own race-interviews" on storage.objects;
drop function if exists public.is_race_interview_path_submitted(text);

create or replace function public.submit_race_interview(
  p_id uuid,
  p_subsession_id bigint,
  p_audio_path text,
  p_audio_type text,
  p_duration_seconds integer
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_driver uuid;
  v_start timestamptz;
begin
  if v_uid is null then raise exception 'sign in required'; end if;
  select driver_id into v_driver from profiles where id = v_uid;
  if v_driver is null then raise exception 'account is not linked to a driver'; end if;

  if p_id is null or p_subsession_id is null then raise exception 'invalid interview'; end if;
  if p_audio_path is null or p_audio_path !~ '^[0-9a-f-]{36}\.(webm|mp4|ogg)$' or left(p_audio_path, 36) <> p_id::text then
    raise exception 'invalid audio path';
  end if;
  if p_audio_type is null or p_audio_type !~ '^audio/(webm|mp4|ogg)' then raise exception 'invalid audio type'; end if;
  if p_duration_seconds is null or p_duration_seconds < 1 or p_duration_seconds > 75 then raise exception 'invalid duration'; end if;
  select start_time into v_start from curated_rounds where subsession_id = p_subsession_id;
  if v_start is null then raise exception 'unknown round'; end if;
  if v_start < now() - interval '7 days' then raise exception 'interview window closed'; end if;
  if exists (select 1 from race_interviews where subsession_id = p_subsession_id and driver_id = v_driver) then
    raise exception 'interview limit reached';
  end if;

  insert into race_interviews (id, subsession_id, driver_id, audio_path, audio_type, duration_seconds, submitter_id)
  values (p_id, p_subsession_id, v_driver, p_audio_path, p_audio_type, p_duration_seconds, v_uid);

  return p_id;
end;
$$;

-- 3. Interview RPC grants (live state before 0114)
grant execute on function public.submit_race_interview(uuid, bigint, text, text, integer) to anon, authenticated;
grant execute on function public.has_submitted_race_interview(bigint) to anon, authenticated;

-- 2. Search path
alter function public.clear_incident_report_dismissal_reason() reset search_path;

-- 1. Page views
drop function if exists public.record_page_view(text, text, text, integer);
drop index if exists public.page_views_visitor_hash_viewed_at_idx;
