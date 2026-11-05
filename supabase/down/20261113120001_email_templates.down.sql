-- Undoes 20261113120001_email_templates.sql: drops email_templates (with its policies, index and trigger)
-- and the stamp function.
--
-- Every edited wording is lost, and the emails go back to the built-in wording. Revert the site code first,
-- so the admin panel and the scheduled sender stop reading the table (the sender already falls back to the
-- defaults when it cannot load it).

drop table public.email_templates;
drop function private.stamp_email_template();
