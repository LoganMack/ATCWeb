-- Interviews on the own profile (U6 interviews, US8.1; contract C4; rules BR12.1-BR12.8 with their design
-- amendments; NFR1.1-NFR1.5, NFR8.1, NFR8.2).
--
-- What: a driver's "Interviews" tab lists the interviews their account uploaded, lets them download one and
-- delete one (the audio file first, then the record). This migration adds:
--   * the race_interviews policy "uploader read own race_interviews" (select, submitter_id = me);
--   * private.is_my_interview_object(name), true when a race_interviews row with that audio path was
--     submitted by the caller, and two storage policies on race-interviews that use it: the uploader may
--     read (sign a download link) and delete their own audio objects;
--   * public.my_interview_audio_exists(id), which tells a refused storage delete apart from a file that is
--     already gone, and public.delete_my_interview_record(id), the only way an uploader removes a record:
--     it refuses with NOT_OWNER unless the caller submitted it and with FILE_EXISTS while its audio object
--     still exists, so a record is never removed ahead of its file;
--   * the insert policy "driver upload own race-interviews", altered to the same check plus
--     `not is_race_interview_path_submitted(name)`, so once a clip is submitted its path cannot take a
--     different upload while the record exists (the update policy already refused an overwrite).
--
-- Why in the database: who may read or delete an interview is an access rule (team rule), so policies and
-- definer functions decide it, and ownership follows submitter_id everywhere, so an account that relinks to
-- another driver still manages what it uploaded. Refusals are raised as '<CODE>: <message>', which
-- src/lib/raceInterviews.ts reads.
--
-- Expand only: the recording flow uploads before it submits, so the altered insert policy never blocks it;
-- the folder-based read and replace policies, the admin policies and submit_race_interview are unchanged. No
-- index is added: race_interviews_submitter_id_idx (20261025120000) serves the list. Undo with
-- supabase/down/20261102120000_interviews_self_service.down.sql.

-- 1. The uploader reads their own rows (BR12.2; NFR1.1). No owner insert, update or delete policy: records
--    are removed only through delete_my_interview_record. The admin policies are unchanged.
create policy "uploader read own race_interviews" on public.race_interviews
  for select to authenticated
  using (submitter_id = (select auth.uid()));

-- 2. The storage helper (NFR1.2). Storage policies run as the caller, so authenticated must execute it; as a
--    definer it reads race_interviews whatever the caller's own policies allow.
create function private.is_my_interview_object(p_name text) returns boolean
  language sql stable security definer
  set search_path = ''
  as $$
  select exists (
    select 1 from public.race_interviews r
    where r.audio_path = p_name and r.submitter_id = (select auth.uid())
  );
$$;

comment on function private.is_my_interview_object(text) is
  'True when the caller submitted the race_interviews row whose audio_path is p_name (U6 storage policies).';

revoke all on function private.is_my_interview_object(text) from public, anon;
grant execute on function private.is_my_interview_object(text) to authenticated;

-- 3. The uploader reads (signs) and deletes their own audio objects (BR12.2; NFR1.3). The folder-based read
--    and replace policies stay for the recorder.
create policy "uploader read own interview audio" on storage.objects
  for select to authenticated
  using (bucket_id = 'race-interviews' and private.is_my_interview_object(name));

create policy "uploader delete own interview audio" on storage.objects
  for delete to authenticated
  using (bucket_id = 'race-interviews' and private.is_my_interview_object(name));

-- 4. No re-upload to a submitted path (BR12.8 amended): the original check plus the submitted-path test the
--    replace policy already uses. A new recording is possible again once the record is deleted.
alter policy "driver upload own race-interviews" on storage.objects
  with check (
    bucket_id = 'race-interviews'
    and (storage.foldername(name))[1] = (
      select p.driver_id::text from public.profiles p where p.id = (select auth.uid())
    )
    and not public.is_race_interview_path_submitted(name)
  );

-- 5. Whether the caller's interview still has its audio object (BR12.4 amended; NFR1.4): true or false for
--    the caller's own interview, null for any other id. Same bucket and name test as the record delete.
create function public.my_interview_audio_exists(p_id uuid) returns boolean
  language sql stable security definer
  set search_path = ''
  as $$
  select exists (
    select 1 from storage.objects o
    where o.bucket_id = 'race-interviews' and o.name = r.audio_path
  )
  from public.race_interviews r
  where r.id = p_id and r.submitter_id = (select auth.uid());
$$;

comment on function public.my_interview_audio_exists(uuid) is
  'Whether the caller''s interview p_id still has its audio object in race-interviews; null when p_id is not '
  'the caller''s interview (U6).';

-- 6. The uploader's record delete (BR12.4 amended; NFR1.5). The row is locked while its object is checked, so
--    the answer holds until the delete commits.
create function public.delete_my_interview_record(p_id uuid) returns void
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_path text;
begin
  select r.audio_path into v_path
  from public.race_interviews r
  where r.id = p_id and r.submitter_id = (select auth.uid())
  for update;
  if v_path is null then
    raise exception 'NOT_OWNER: this is not your interview';
  end if;
  if exists (
    select 1 from storage.objects o
    where o.bucket_id = 'race-interviews' and o.name = v_path
  ) then
    raise exception 'FILE_EXISTS: delete the audio file first';
  end if;
  delete from public.race_interviews r where r.id = p_id;
end;
$$;

comment on function public.delete_my_interview_record(uuid) is
  'Deletes the caller''s interview record once its audio object is gone; NOT_OWNER or FILE_EXISTS otherwise (U6).';

revoke all on function public.my_interview_audio_exists(uuid) from public, anon;
revoke all on function public.delete_my_interview_record(uuid) from public, anon;
grant execute on function public.my_interview_audio_exists(uuid) to authenticated;
grant execute on function public.delete_my_interview_record(uuid) to authenticated;
