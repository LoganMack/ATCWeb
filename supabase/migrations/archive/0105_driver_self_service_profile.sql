-- Alpha Touring Challenge — drivers editing their own profile
--
-- A signed-in user whose login is linked to a roster driver (profiles.driver_id) can
-- change their own profile photo and bio from their driver page. Everything else on
-- the drivers row stays admin-only (the "admin update drivers" policy from 0002 is
-- untouched). Two pieces:
--
--   1. update_my_driver_profile(): a SECURITY DEFINER function that only ever writes
--      `bio` and `photo_url` on the caller's OWN linked driver row, enforces the
--      500-character bio limit, and only accepts a photo URL inside the caller's own
--      folder of the public 'photos' bucket.
--   2. Storage policies letting a user upload/replace files ONLY under
--      photos/driver-avatars/<their driver id>/.
--
-- The 500-character limit lives in the function rather than a table constraint,
-- because existing admin-written bios (Hall of Fame) may already be longer.

create or replace function public.update_my_driver_profile(
  p_bio text,
  p_photo_url text default null,
  p_set_photo boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_driver_id uuid;
  v_bio text := nullif(btrim(coalesce(p_bio, '')), '');
begin
  select driver_id into v_driver_id from public.profiles where id = auth.uid();
  if v_driver_id is null then
    raise exception 'Your login is not linked to a driver.';
  end if;

  if v_bio is not null and char_length(v_bio) > 500 then
    raise exception 'Bio is limited to 500 characters.';
  end if;

  if p_set_photo and p_photo_url is not null
     and position('/storage/v1/object/public/photos/driver-avatars/' || v_driver_id::text || '/' in p_photo_url) = 0 then
    raise exception 'Invalid photo location.';
  end if;

  update public.drivers
     set bio = v_bio,
         photo_url = case when p_set_photo then p_photo_url else photo_url end
   where id = v_driver_id;
end;
$$;

revoke execute on function public.update_my_driver_profile(text, text, boolean) from public, anon;
grant execute on function public.update_my_driver_profile(text, text, boolean) to authenticated;

drop policy if exists "driver upload own avatar" on storage.objects;
create policy "driver upload own avatar" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = 'driver-avatars'
    and (storage.foldername(name))[2] = (select p.driver_id::text from public.profiles p where p.id = (select auth.uid()))
  );

drop policy if exists "driver update own avatar" on storage.objects;
create policy "driver update own avatar" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = 'driver-avatars'
    and (storage.foldername(name))[2] = (select p.driver_id::text from public.profiles p where p.id = (select auth.uid()))
  );
