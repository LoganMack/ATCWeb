-- 0116_security_fixes_followup.sql
-- Last step of the SEC-06 interview fix. 0114 let submit_race_interview accept
-- both the new "<driver id>/<subsession id>.<ext>" path and the old flat
-- "<interview id>.<ext>" one so uploads kept working while the app deploy
-- rolled out. Apply this once no upload uses the old form (any deploy after
-- 0115); from then on only the driver-scoped path is accepted.
-- Existing rows keep their old paths and stay playable for admins.
-- Undo script: supabase/down/0116_security_fixes_followup.down.sql

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
  -- "<caller's driver id>/<this round>.<ext>" only.
  if p_audio_path is null
     or p_audio_path !~ '^[0-9a-f-]{36}/[0-9]+\.(webm|mp4|ogg)$'
     or split_part(p_audio_path, '/', 1) <> v_driver::text
     or split_part(split_part(p_audio_path, '/', 2), '.', 1) <> p_subsession_id::text then
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
