-- Alpha Touring Challenge — post-race "media pen" INTERVIEWS
--
-- On a round's results page, a signed-in user whose login is linked to a roster
-- driver (profiles.driver_id) can press the microphone button, record up to 60
-- seconds of post-race comments in the browser, and submit them. Submissions
-- land in this table + the private 'race-interviews' storage bucket and are
-- listed for admins under Admin > Interviews (audio playback, delete).
--
-- Submission goes through a SECURITY DEFINER function so the driver link is
-- verified server-side (the client can't claim to be someone else). Only admins
-- can read or delete interviews and their audio. Each driver can submit one
-- interview per round (re-recording before submitting is free).

-- 1. The interviews --------------------------------------------------------------
create table if not exists race_interviews (
  id uuid primary key,
  subsession_id bigint not null,
  driver_id uuid not null references drivers (id) on delete cascade,
  -- Object path inside the 'race-interviews' bucket: "<id>.webm" (or .mp4 / .ogg).
  audio_path text not null,
  audio_type text not null,
  duration_seconds integer not null check (duration_seconds between 1 and 75),
  submitter_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists race_interviews_subsession_idx on race_interviews (subsession_id);
create index if not exists race_interviews_driver_idx on race_interviews (driver_id);
-- One interview per driver per round (also enforced in submit_race_interview below).
create unique index if not exists race_interviews_one_per_driver_round on race_interviews (subsession_id, driver_id);

alter table race_interviews enable row level security;

drop policy if exists "admin read race_interviews" on race_interviews;
create policy "admin read race_interviews" on race_interviews for select using (is_admin());
drop policy if exists "admin delete race_interviews" on race_interviews;
create policy "admin delete race_interviews" on race_interviews for delete using (is_admin());

-- 2. Submission function (signed-in, driver-linked users only) -------------------
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
  if not exists (select 1 from curated_rounds where subsession_id = p_subsession_id) then raise exception 'unknown round'; end if;
  if exists (select 1 from race_interviews where subsession_id = p_subsession_id and driver_id = v_driver) then
    raise exception 'interview limit reached';
  end if;

  insert into race_interviews (id, subsession_id, driver_id, audio_path, audio_type, duration_seconds, submitter_id)
  values (p_id, p_subsession_id, v_driver, p_audio_path, p_audio_type, p_duration_seconds, v_uid);

  return p_id;
end;
$$;

revoke all on function public.submit_race_interview(uuid, bigint, text, text, integer) from public;
grant execute on function public.submit_race_interview(uuid, bigint, text, text, integer) to authenticated;

-- Has the caller's linked driver already submitted an interview for this round?
-- (The results page uses it to disable the microphone button up front.)
create or replace function public.has_submitted_race_interview(p_subsession_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from race_interviews i
    join profiles p on p.driver_id = i.driver_id
    where p.id = auth.uid() and i.subsession_id = p_subsession_id
  );
$$;

revoke all on function public.has_submitted_race_interview(bigint) from public;
grant execute on function public.has_submitted_race_interview(bigint) to authenticated;

-- 3. Private audio bucket ----------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'race-interviews', 'race-interviews', false, 5242880,
  array['audio/webm', 'audio/mp4', 'audio/ogg', 'video/webm']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Only signed-in users linked to a driver may upload; only admins may read or delete.
drop policy if exists "driver upload race-interviews" on storage.objects;
create policy "driver upload race-interviews" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'race-interviews'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.driver_id is not null)
  );
drop policy if exists "admin read race-interviews" on storage.objects;
create policy "admin read race-interviews" on storage.objects
  for select using (bucket_id = 'race-interviews' and is_admin());
drop policy if exists "admin delete race-interviews" on storage.objects;
create policy "admin delete race-interviews" on storage.objects
  for delete using (bucket_id = 'race-interviews' and is_admin());
