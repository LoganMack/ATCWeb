-- Undoes 20261102120000_interviews_self_service.sql: drops the uploader's storage read and delete policies on
-- race-interviews, the uploader's race_interviews read policy, the record delete and existence functions and
-- the private storage helper, then restores the insert policy "driver upload own race-interviews" with its
-- baseline check (copied verbatim from 20261020120001_baseline_platform.sql), so a submitted path can again
-- take a new upload once its file is gone.
--
-- No data is lost: the migration added no table or column. Revert the site code first, so nothing calls the
-- dropped functions.

drop policy "uploader delete own interview audio" on storage.objects;
drop policy "uploader read own interview audio" on storage.objects;
drop policy "uploader read own race_interviews" on public.race_interviews;

ALTER POLICY "driver upload own race-interviews" ON storage.objects WITH CHECK (((bucket_id = 'race-interviews'::text) AND ((storage.foldername(name))[1] = ( SELECT (p.driver_id)::text AS driver_id
   FROM profiles p
  WHERE (p.id = ( SELECT auth.uid() AS uid))))));

drop function public.delete_my_interview_record(uuid);
drop function public.my_interview_audio_exists(uuid);
-- After the storage policies that call it.
drop function private.is_my_interview_object(text);
