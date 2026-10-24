-- Account settings (U3 profile-settings, US5.4, US5.5, US6.1; contract C3).
--
-- What: one row per account in account_settings holding the two privacy choices (hide_profile,
-- hide_name) and the three email-notification choices (notify_*), all off by default; a missing row
-- means every choice is off. The row also records when the account last asked for an account email
-- (email change or password reset), and claim_email_action() allows at most one of those per minute.
-- A driver may also delete their own profile-photo files, so a save that uploaded a photo and then
-- failed can remove the file it left behind.
--
-- Why in the database: only the account itself (and admins) may read or change its settings, so that
-- is Row Level Security, not page code. The email limit lives here too: a cookie or a check in the
-- page could be skipped by clearing it or calling the endpoint directly, and Supabase Auth's own email
-- limit is shared by every account, so one account looping these emails could block sign-ups and
-- password resets for everyone. Owners can write only the five choices; last_email_action_at is
-- written only by claim_email_action().
--
-- Expand only: nothing existing changes. U4 will read the privacy flags through a definer function
-- and U7 the notification flags with the service role. Undo with
-- supabase/down/20261028120000_account_settings.down.sql.
--
-- claim_email_action raises '<CODE>: <message>' with errcode P0001 (src/lib/driverAccount.ts reads the
-- prefix).

-- 1. The settings row (BR5.5, BR6.1, NFR1.1, NFR3.3). The primary key serves the site's upsert
--    (on_conflict=profile_id); no other index is needed for one small row per account.
create table public.account_settings (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  hide_profile boolean not null default false,
  hide_name boolean not null default false,
  notify_appeal_reviewed boolean not null default false,
  notify_report_posted boolean not null default false,
  notify_event_reminders boolean not null default false,
  updated_at timestamptz not null default now(),
  last_email_action_at timestamptz
);

comment on table public.account_settings is
  'Privacy and email-notification choices per account (U3, contract C3). A missing row means every choice is off.';
comment on column public.account_settings.last_email_action_at is
  'When the account last asked for an email change or password reset; written only by claim_email_action().';

create trigger account_settings_set_updated_at
  before update on public.account_settings
  for each row execute function public.set_updated_at();

-- 2. Owner-only access (BR5.6). No delete policy: a row goes only with its profile (cascade).
alter table public.account_settings enable row level security;

create policy account_settings_select on public.account_settings
  for select to authenticated
  using ((select auth.uid()) = profile_id or public.is_admin());

create policy account_settings_insert on public.account_settings
  for insert to authenticated
  with check ((select auth.uid()) = profile_id or public.is_admin());

create policy account_settings_update on public.account_settings
  for update to authenticated
  using ((select auth.uid()) = profile_id or public.is_admin())
  with check ((select auth.uid()) = profile_id or public.is_admin());

-- Supabase grants every new public table to anon and authenticated by default, so start from nothing.
-- Inserts and updates are column grants, so nobody but claim_email_action() can move the email limit.
revoke all on table public.account_settings from public, anon, authenticated;
grant select on table public.account_settings to authenticated;
grant insert (profile_id, hide_profile, hide_name, notify_appeal_reviewed, notify_report_posted,
              notify_event_reminders)
  on table public.account_settings to authenticated;
-- profile_id is in the update list because PostgREST's merge-duplicates upsert sets every posted column;
-- the update policy's with check still pins it to the caller's own id.
grant update (profile_id, hide_profile, hide_name, notify_appeal_reviewed, notify_report_posted,
              notify_event_reminders)
  on table public.account_settings to authenticated;

-- 3. The per-account email limit (NFR1.4, NFR1.5). Called before every email change or password reset
--    the site sends. A call that gets through counts even if sending then fails, so failed attempts are
--    throttled too; a refused call changes nothing.
create function public.claim_email_action() returns boolean
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  v_uid uuid := auth.uid();
  v_previous timestamptz;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED: Sign in first' using errcode = 'P0001';
  end if;

  insert into public.account_settings (profile_id) values (v_uid)
  on conflict (profile_id) do nothing;

  -- The row lock makes two simultaneous calls take turns, so only one gets through.
  select last_email_action_at into v_previous
  from public.account_settings
  where profile_id = v_uid
  for update;

  if v_previous is not null and v_previous > now() - interval '60 seconds' then
    raise exception 'RATE_LIMITED: Too many requests. Try again in a minute' using errcode = 'P0001';
  end if;

  update public.account_settings set last_email_action_at = now() where profile_id = v_uid;
  return true;
end;
$$;

revoke all on function public.claim_email_action() from public, anon;
grant execute on function public.claim_email_action() to authenticated;

-- 4. A driver may delete files in their own avatar folder, the same folder the existing upload and
--    update policies let them write (NFR4.1: a failed save removes the photo it just uploaded).
create policy "driver delete own avatar" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = 'driver-avatars'
    and (storage.foldername(name))[2] = (
      select p.driver_id::text from public.profiles p where p.id = (select auth.uid())
    )
  );
