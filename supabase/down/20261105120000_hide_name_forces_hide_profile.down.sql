-- Undoes 20261105120000_hide_name_forces_hide_profile.sql: drops the check constraint, the trigger and its
-- function, so hide_name and hide_profile are saved independently again.
--
-- No data is lost: rows keep the flags they have. Rows saved while the rule was in force keep hide_profile
-- on; change them by hand if that matters.

alter table public.account_settings drop constraint account_settings_hide_name_hides_profile;
drop trigger account_settings_hide_name_forces_hide_profile on public.account_settings;
drop function private.account_settings_force_hide_profile();
