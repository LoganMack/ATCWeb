-- 0114_security_fixes_additive.sql
-- Additive half of the SEC-03..SEC-13 security fixes (site audit). Apply this
-- BEFORE deploying the matching app change; nothing here takes anything away
-- that the current app relies on, so the old and new code both keep working.
-- 0115 tightens once the deploy is verified; 0116 removes the old interview
-- path form. Undo script: supabase/down/0114_security_fixes_additive.down.sql
--
--  1. Page views (SEC-03): anyone holding the public anon key could insert
--     page_views rows without limit. New record_page_view() does the insert
--     with the same field checks as the 0097 policy, and silently drops a
--     view once a visitor hash already has 30 in the last 60 s. The app moves
--     to it now; 0115 then drops the direct insert policy.
--  2. clear_incident_report_dismissal_reason (SEC-12): pin its search_path
--     (Supabase advisor "function_search_path_mutable"). The body references
--     no tables, so pinning it to '' needs no other change.
--  3. Interview RPCs (SEC-13): anon could EXECUTE submit_race_interview and
--     has_submitted_race_interview through Supabase's default grants. Both are
--     signed-in features, so anon loses EXECUTE.
--  4. Interview uploads (SEC-06): clips move to "<driver id>/<subsession id>.<ext>",
--     so each driver has one fixed name per round. submit_race_interview
--     accepts that form (folder must be the caller's driver, file name the
--     round) and, until 0116, the old "<interview id>.<ext>" form. Owners
--     can read and overwrite their own clip (the app uploads with x-upsert so
--     a retry after a failed record step works), but only until a
--     race_interviews row points at it, so a submitted clip can't be swapped.
--  5. imports bucket (SEC-13): an admin-only read policy, so signed download
--     links work once 0115 makes the bucket private.

-- 1. Page views ----------------------------------------------------------------
create index if not exists page_views_visitor_hash_viewed_at_idx
  on public.page_views (visitor_hash, viewed_at);

create or replace function public.record_page_view(
  p_path text,
  p_visitor_hash text,
  p_country text,
  p_status integer
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Same checks the 0097 insert policy applied.
  if p_path is null or char_length(p_path) not between 1 and 300 then raise exception 'invalid path'; end if;
  if p_visitor_hash is null or char_length(p_visitor_hash) not between 1 and 64 then raise exception 'invalid visitor'; end if;
  if p_country is not null and char_length(p_country) > 8 then raise exception 'invalid country'; end if;
  if p_status is null or p_status not between 100 and 599 then raise exception 'invalid status'; end if;

  -- Rate limit: drop quietly so a flood can't tell it is being limited.
  if (
    select count(*) from (
      select 1 from public.page_views
      where visitor_hash = p_visitor_hash and viewed_at > now() - interval '60 seconds'
      limit 30
    ) recent
  ) >= 30 then
    return;
  end if;

  insert into public.page_views (path, country, visitor_hash, status)
  values (p_path, p_country, p_visitor_hash, p_status);
end;
$$;

revoke all on function public.record_page_view(text, text, text, integer) from public;
grant execute on function public.record_page_view(text, text, text, integer) to anon, authenticated;

-- 2. Pinned search path ---------------------------------------------------------
alter function public.clear_incident_report_dismissal_reason() set search_path = '';

-- 3. Interview RPCs: signed-in only -----------------------------------------------
revoke execute on function public.submit_race_interview(uuid, bigint, text, text, integer) from public, anon;
revoke execute on function public.has_submitted_race_interview(bigint) from public, anon;
grant execute on function public.submit_race_interview(uuid, bigint, text, text, integer) to authenticated;
grant execute on function public.has_submitted_race_interview(bigint) to authenticated;

-- 4. Interview uploads ---------------------------------------------------------------
-- Only the path check changed from 0109.
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
  if p_audio_path is null then raise exception 'invalid audio path'; end if;
  if p_audio_path ~ '^[0-9a-f-]{36}/[0-9]+\.(webm|mp4|ogg)$' then
    -- New form: "<caller's driver id>/<this round>.<ext>".
    if split_part(p_audio_path, '/', 1) <> v_driver::text
       or split_part(split_part(p_audio_path, '/', 2), '.', 1) <> p_subsession_id::text then
      raise exception 'invalid audio path';
    end if;
  elsif p_audio_path ~ '^[0-9a-f-]{36}\.(webm|mp4|ogg)$' then
    -- Old form "<interview id>.<ext>", accepted until 0116.
    if left(p_audio_path, 36) <> p_id::text then raise exception 'invalid audio path'; end if;
  else
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

-- create or replace keeps the grants set in section 3.

-- Storage policies can't read race_interviews as the caller (admin-only RLS), so
-- this definer helper answers "is this object already a submitted interview?".
create or replace function public.is_race_interview_path_submitted(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.race_interviews where audio_path = p_name);
$$;

revoke all on function public.is_race_interview_path_submitted(text) from public, anon;
grant execute on function public.is_race_interview_path_submitted(text) to authenticated;

drop policy if exists "driver read own race-interviews" on storage.objects;
create policy "driver read own race-interviews" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'race-interviews'
    and (storage.foldername(name))[1] = (select p.driver_id::text from public.profiles p where p.id = (select auth.uid()))
  );

drop policy if exists "driver replace own unsubmitted race-interviews" on storage.objects;
create policy "driver replace own unsubmitted race-interviews" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'race-interviews'
    and (storage.foldername(name))[1] = (select p.driver_id::text from public.profiles p where p.id = (select auth.uid()))
    and not public.is_race_interview_path_submitted(name)
  )
  with check (
    bucket_id = 'race-interviews'
    and (storage.foldername(name))[1] = (select p.driver_id::text from public.profiles p where p.id = (select auth.uid()))
    and not public.is_race_interview_path_submitted(name)
  );

-- 5. imports: admin read --------------------------------------------------------------
drop policy if exists "admin read imports" on storage.objects;
create policy "admin read imports" on storage.objects
  for select using (bucket_id = 'imports' and (select public.is_admin()));
