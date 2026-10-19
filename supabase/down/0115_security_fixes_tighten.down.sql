-- Undo 0115_security_fixes_tighten.sql
-- Puts back the policies and bucket setting 0115 removed, exactly as 0051,
-- 0097 and 0109 left them: anonymous inserts into page_views (with the 0097
-- field checks), interview uploads at any path for a driver-linked login, and
-- a public imports bucket with its public read policy. The app from this
-- change keeps working against the restored state.

-- 3. imports bucket (as in 0051)
update storage.buckets set public = true where id = 'imports';
drop policy if exists "public read imports" on storage.objects;
create policy "public read imports" on storage.objects for select using (bucket_id = 'imports');

-- 2. race-interviews uploads (as in 0109)
drop policy if exists "driver upload own race-interviews" on storage.objects;
drop policy if exists "driver upload race-interviews" on storage.objects;
create policy "driver upload race-interviews" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'race-interviews'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.driver_id is not null)
  );

-- 1. page_views (as in 0097)
drop policy if exists "public insert page_views" on public.page_views;
create policy "public insert page_views" on public.page_views
  for insert
  with check (
    char_length(path) between 1 and 300
    and char_length(visitor_hash) between 1 and 64
    and (country is null or char_length(country) <= 8)
    and status between 100 and 599
  );
