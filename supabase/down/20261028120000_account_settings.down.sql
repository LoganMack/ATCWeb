-- Undoes 20261028120000_account_settings.sql: drops the avatar delete policy, claim_email_action()
-- and the account_settings table (its policies, grants and trigger go with it).
--
-- Every account's privacy and email-notification choices are lost. To keep them, first export the
-- table in the SQL editor (select * from public.account_settings, then download the result as CSV).

drop policy "driver delete own avatar" on storage.objects;
drop function public.claim_email_action();
drop table public.account_settings;
