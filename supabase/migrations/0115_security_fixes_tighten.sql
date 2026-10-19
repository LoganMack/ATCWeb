-- 0115_security_fixes_tighten.sql
-- Tightening half of the SEC-03..SEC-13 fixes. Apply only AFTER 0114 is in
-- place and the app deploy that records page views through record_page_view()
-- and uploads interviews to "<driver id>/<subsession id>.<ext>" is verified;
-- before that, these changes would break page-view logging and interview
-- uploads. Undo script: supabase/down/0115_security_fixes_tighten.down.sql
--
--  1. page_views (SEC-03): no more direct inserts with the anon key; the only
--     write path is record_page_view(), which rate-limits per visitor.
--  2. race-interviews uploads (SEC-06): a driver may only write inside their
--     own "<driver id>/" folder, the same foldername check the photos avatar
--     policy uses. Before this, any driver-linked login could write anywhere.
--  3. imports bucket (SEC-13): private. Admins download through signed links
--     (the "admin read imports" policy from 0114); the public read and listing
--     policy goes.

-- 1. page_views -----------------------------------------------------------------
drop policy if exists "public insert page_views" on public.page_views;

-- 2. race-interviews uploads -----------------------------------------------------
drop policy if exists "driver upload race-interviews" on storage.objects;
drop policy if exists "driver upload own race-interviews" on storage.objects;
create policy "driver upload own race-interviews" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'race-interviews'
    and (storage.foldername(name))[1] = (select p.driver_id::text from public.profiles p where p.id = (select auth.uid()))
  );

-- 3. imports bucket ------------------------------------------------------------------
update storage.buckets set public = false where id = 'imports';
drop policy if exists "public read imports" on storage.objects;
