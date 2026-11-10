-- Undoes 20261115120001_polls.sql: drops the poll-images storage policies and bucket, the poll functions and
-- the polls, poll_sections and poll_options tables.
--
-- Data is lost: every poll, section and option goes with the tables. Empty the poll-images bucket first
-- (Storage > poll-images in the dashboard, or the Storage API), because the bucket row is removed here and
-- Storage refuses to drop a bucket that still holds objects. Revert the site code first, so nothing calls the
-- dropped functions or tables. If U3's notifications reference polls, undo that migration before this one.

drop policy "full admin read poll images" on storage.objects;
drop policy "full admin delete poll images" on storage.objects;
drop policy "full admin replace poll images" on storage.objects;
drop policy "full admin upload poll images" on storage.objects;

-- Storage blocks direct deletes from its tables unless asked; the bucket must already be empty.
set local storage.allow_delete_query = 'true';
delete from storage.buckets where id = 'poll-images';

drop function public.delete_poll(uuid);
drop function public.set_poll_posted(uuid, boolean);
drop function public.save_poll(uuid, timestamptz, jsonb);
drop function public.create_poll(text);
drop function private.poll_payload_structure(jsonb);
drop function private.poll_structure(uuid);
drop function private.poll_check_payload(uuid, jsonb, timestamptz);
drop function private.poll_trim(text);
drop function private.poll_has_votes(uuid);

drop table public.poll_options;
drop table public.poll_sections;
drop table public.polls;
