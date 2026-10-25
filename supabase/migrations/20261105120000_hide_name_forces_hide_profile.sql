-- Hiding the name also hides the profile (profile-liveries FR2.5, FR2.6).
--
-- What: a saved account_settings row can never have hide_name on and hide_profile off. This migration
-- adds:
--   * private.account_settings_force_hide_profile(), a before insert or update trigger function that sets
--     hide_profile to true whenever hide_name is true;
--   * the trigger account_settings_hide_name_forces_hide_profile that runs it on every row write;
--   * the check constraint account_settings_hide_name_hides_profile (not hide_name or hide_profile).
--
-- Why in the database: the profile form shows the two toggles locked together, but which privacy flags
-- an account ends up with is a business rule (team rule), so the database guarantees it whatever a client
-- posts. The trigger corrects the row instead of refusing it, so the site code still on main (which saves
-- the two flags independently) keeps saving without an error; the constraint documents and backs the rule.
--
-- Expand only: no column changes and no data fix. Production had no account_settings rows on 2026-10-25;
-- if a row that breaks the rule exists when this applies, adding the constraint fails loudly and nothing
-- changes. Undo with supabase/down/20261105120000_hide_name_forces_hide_profile.down.sql.

-- 1. The coercion. Runs as the caller: it only reads the row being written.
create function private.account_settings_force_hide_profile() returns trigger
  language plpgsql
  set search_path = ''
  as $$
begin
  if new.hide_name then
    new.hide_profile := true;
  end if;
  return new;
end;
$$;

comment on function private.account_settings_force_hide_profile() is
  'Sets hide_profile when hide_name is on, so a saved account_settings row never hides the name only (FR2.6).';

revoke all on function private.account_settings_force_hide_profile() from public, anon;

create trigger account_settings_hide_name_forces_hide_profile
  before insert or update on public.account_settings
  for each row execute function private.account_settings_force_hide_profile();

-- 2. The rule itself, checked after the trigger has run.
alter table public.account_settings
  add constraint account_settings_hide_name_hides_profile check (not hide_name or hide_profile);
