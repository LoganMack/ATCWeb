-- Undoes 20261107120000_interviews_members_view.sql: drops the members' storage read policy on
-- race-interviews, then the race_interviews_shown view it reads.
--
-- No data is lost: the migration added no table or column. Revert the site code first, so nothing reads the
-- dropped view.

drop policy "members read shown race interviews" on storage.objects;
-- After the policy that reads it.
drop view public.race_interviews_shown;
