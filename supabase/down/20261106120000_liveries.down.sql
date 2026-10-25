-- Undoes 20261106120000_liveries.sql: drops the liveries storage policies, the bucket, the set-active
-- function, the write trigger and its function, and the liveries table.
--
-- Data is lost: every livery row goes with the table. Delete the stored files first (Storage > liveries
-- in the dashboard, or the Storage API), because the bucket row is removed here and Storage refuses to
-- drop a bucket that still holds objects. Revert the site code first, so nothing calls the dropped
-- function or table.

drop policy "admin read liveries" on storage.objects;
drop policy "owner delete own liveries" on storage.objects;
drop policy "owner replace own liveries" on storage.objects;
drop policy "owner read own liveries" on storage.objects;
drop policy "owner upload own liveries" on storage.objects;

-- Storage blocks direct deletes from its tables unless asked; the bucket must already be empty.
set local storage.allow_delete_query = 'true';
delete from storage.buckets where id = 'liveries';

drop function public.set_my_livery_active(uuid);
drop table public.liveries;
-- After the table, whose trigger uses it.
drop function private.liveries_before_write();
