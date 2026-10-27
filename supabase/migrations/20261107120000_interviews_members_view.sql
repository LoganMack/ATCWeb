-- Race interviews for signed-in members (driver-profile-polish FR8.2-FR8.4, NFR1).
--
-- What: the History > Interviews page lists every race interview to signed-in members and plays its audio.
-- This migration adds:
--   * public.race_interviews_shown, a definer, security-barrier view of race_interviews' public columns. It
--     returns rows only to a signed-in caller, and leaves out the interviews of drivers hidden from that
--     caller (private.hidden_drivers with name_hidden), like champion_photos_shown does;
--   * the storage policy "members read shown race interviews" on race-interviews: a signed-in caller may
--     read (sign a link for) an audio object only when the view shows that caller its interview.
--
-- Why in the database: who may see an interview is an access rule (team rule), so the view and the storage
-- policy decide it, not the page. Anonymous callers get no grant on the view at all, so the data is not
-- readable through the public API. The view runs as its owner (security_invoker = false), so the
-- admin-and-uploader policies on race_interviews stay as they are, and it is a security barrier, so a
-- caller's filter never runs before its own row filter. Audio is signed per play by the Worker with the
-- member's own token, so listing interviews downloads nothing.
--
-- Expand only: a new view and a new select policy; no table, column, existing policy or function changes,
-- and uploads and deletes are untouched. Undo with
-- supabase/down/20261107120000_interviews_members_view.down.sql.

-- 1. The members-only view (FR8.2, FR8.3). Hidden drivers are left out, not masked (Q2 A).
create view public.race_interviews_shown with (security_invoker = false, security_barrier = true) as
select
  r.id,
  r.subsession_id,
  r.driver_id,
  r.duration_seconds,
  r.audio_path,
  r.audio_type,
  r.created_at
from public.race_interviews r
where (select auth.uid()) is not null
  and r.driver_id <> all (array(
    select h.driver_id from private.hidden_drivers h where h.name_hidden
  ));

comment on view public.race_interviews_shown is
  'race_interviews for signed-in members (driver-profile-polish FR8): no rows for anon; drivers hidden from '
  'this caller are left out.';

-- Read-only, and not for anon: the default privileges would grant ALL to everyone, and a single-table view
-- is auto-updatable and would write as its owner.
revoke all on table public.race_interviews_shown from public, anon, authenticated, service_role;
grant select on table public.race_interviews_shown to authenticated, service_role;

-- 2. The members' audio read (FR8.4). Storage policies run as the caller, who can read the view; the existing
--    admin, recorder and uploader policies stay.
create policy "members read shown race interviews" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'race-interviews'
    and exists (select 1 from public.race_interviews_shown s where s.audio_path = objects.name)
  );
